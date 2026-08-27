import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseHealthProvider } from "../db/database-runtime";
import type { AuthLoginService } from "../modules/auth/auth-service";
import type { RequestAuthenticator } from "../modules/auth/authenticator";
import type { AvatarStorage } from "../modules/users/avatar-storage";
import type { UserProfileService } from "../modules/users/user-profile-service";
import { AppError, invalidArgument } from "../shared/app-error";
import { readJsonObject, readSingleUploadedFile } from "./request-body";

const SERVICE_NAME = "pindou-studio-server";

interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

function requestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function sendAvatar(
  response: ServerResponse,
  avatar: { readonly buffer: Buffer; readonly contentType: string },
): void {
  response.statusCode = 200;
  response.setHeader("content-type", avatar.contentType);
  response.setHeader("content-length", avatar.buffer.length);
  response.setHeader("cache-control", "public, max-age=31536000, immutable");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(avatar.buffer);
}

function errorPayload(
  code: string,
  message: string,
  id: string,
  details: Readonly<Record<string, unknown>> = {},
): ErrorResponse {
  return { error: { code, message, requestId: id, details } };
}

export type HttpApplication = (request: IncomingMessage, response: ServerResponse) => void;

export interface HttpApplicationDependencies {
  readonly database: DatabaseHealthProvider;
  readonly auth: AuthLoginService;
  readonly authenticator: RequestAuthenticator;
  readonly users: UserProfileService;
  readonly avatars: AvatarStorage;
  readonly avatarMaximumBytes: number;
}

function validateLoginBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "code" || typeof body.code !== "string") {
    throw invalidArgument("请求体只能包含字符串字段 code");
  }
  return body.code;
}

function validateNicknameBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "nickname" || typeof body.nickname !== "string") {
    throw invalidArgument("请求体只能包含字符串字段 nickname");
  }
  const nickname = body.nickname.trim().normalize("NFC");
  const length = Array.from(nickname).length;
  if (length < 1 || length > 80 || /[\u0000-\u001f\u007f]/u.test(nickname)) {
    throw invalidArgument("昵称长度必须为 1 到 80 个字符，且不能包含控制字符");
  }
  return nickname;
}

export function createHttpApplication(dependencies: HttpApplicationDependencies): HttpApplication {
  return (request, response) => {
    const id = requestId();
    response.setHeader("x-request-id", id);

    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        try {
          const databaseHealth = await dependencies.database.check();
          sendJson(response, 200, {
            status: "ok",
            service: SERVICE_NAME,
            timestamp: new Date().toISOString(),
            database: databaseHealth,
          });
        } catch {
          sendJson(response, 503, {
            status: "degraded",
            service: SERVICE_NAME,
            timestamp: new Date().toISOString(),
            database: { status: "down" },
          });
        }
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/media/avatars/")) {
        if (url.searchParams.size > 0) throw invalidArgument("头像地址不接受查询参数");
        const avatar = await dependencies.avatars.read(url.pathname);
        if (avatar) {
          sendAvatar(response, avatar);
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJsonObject(request);
        const result = await dependencies.auth.login(validateLoginBody(body));
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/users/me") {
        if (url.searchParams.size > 0) throw invalidArgument("当前用户接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        sendJson(response, 200, await dependencies.users.getCurrentUser(currentUser.id));
        return;
      }


      if ((request.method === "PATCH" || request.method === "PUT") && url.pathname === "/api/users/me") {
        if (url.searchParams.size > 0) throw invalidArgument("当前用户接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        const nickname = validateNicknameBody(await readJsonObject(request));
        sendJson(response, 200, { user: await dependencies.users.updateNickname(currentUser.id, nickname) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/users/me/avatar") {
        if (url.searchParams.size > 0) throw invalidArgument("头像上传接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        const upload = await readSingleUploadedFile(
          request,
          "file",
          dependencies.avatarMaximumBytes,
          ["nickname"],
        );
        const nickname = validateNicknameBody({ nickname: upload.fields.nickname });
        const avatar = await dependencies.avatars.save(upload.buffer, upload.declaredContentType);
        try {
          const updated = await dependencies.users.updateProfileWithAvatar(
            currentUser.id,
            nickname,
            avatar.publicPath,
          );
          await dependencies.avatars.remove(updated.previousAvatarUrl);
          sendJson(response, 200, { user: updated.user });
        } catch (error: unknown) {
          await dependencies.avatars.remove(avatar.publicPath);
          throw error;
        }
        return;
      }

      sendJson(response, 404, errorPayload("NOT_FOUND", "接口不存在", id));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        if (error instanceof AppError) {
          sendJson(
            response,
            error.statusCode,
            errorPayload(error.code, error.message, id, error.details),
          );
        } else {
          sendJson(response, 500, errorPayload("INTERNAL_ERROR", "服务内部错误", id));
        }
      } else {
        response.destroy();
      }
    });
  };
}
