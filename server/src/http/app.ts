import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseHealthProvider } from "../db/database-runtime";
import type { AuthLoginService } from "../modules/auth/auth-service";
import type { RequestAuthenticator } from "../modules/auth/authenticator";
import type { AvatarStorage } from "../modules/users/avatar-storage";
import type { UserProfileService } from "../modules/users/user-profile-service";
import type { FileAssetService } from "../modules/files/file-asset-service";
import type { CoverStorage } from "../modules/files/cover-storage";
import type { AiFileStorage } from "../modules/files/ai-file-storage";
import type { ContentSecurityService } from "../modules/content-security/content-security-service";
import type {
  AiGenerationBackgroundMode,
  AiGenerationDetailLevel,
  AiGenerationStyle,
  PostgresAiGenerationService,
} from "../modules/ai/ai-generation-service";
import type {
  DownloadFileType,
  DownloadListOptions,
  PostgresQuotaDownloadService,
} from "../modules/downloads/quota-download-service";
import type { OrderListOptions, PaymentService } from "../modules/payments/payment-service";
import { getLegalDocument } from "../modules/legal/legal-document-service";
import type { PrivacyPreferencesPatch } from "../modules/users/user-profile-service";
import { validatePersistedPattern, type PersistedPattern } from "../modules/works/pattern";
import type { FavoriteListOptions, PostgresWorkService, UpdateWorkInput, WorkStatus } from "../modules/works/work-service";
import { AppError, invalidArgument } from "../shared/app-error";
import { readJsonObject, readRawJsonObject, readSingleUploadedFile } from "./request-body";

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
  return `req_${randomUUID().replace(/-/g, "")}`;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function sendImage(
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
  readonly files: FileAssetService;
  readonly covers: CoverStorage;
  readonly aiFiles: AiFileStorage;
  readonly works: PostgresWorkService;
  readonly quotaDownloads: PostgresQuotaDownloadService;
  readonly payments: PaymentService;
  readonly coverMaximumBytes: number;
  readonly aiFileMaximumBytes: number;
  readonly aiGenerations: PostgresAiGenerationService;
  /** 作品标题保存前必须经过内容安全校验；缺失时应 fail closed */
  readonly contentSecurity: ContentSecurityService;
  readonly contentSecurityMediaMaximumBytes?: number;
  readonly capabilities?: {
    readonly wechatPay: boolean;
    readonly aiGeneration: boolean;
    readonly persistentStorage: boolean;
    readonly httpsPublicUrls: boolean;
    readonly monitoringAlerts: boolean;
    readonly contentSecurity?: boolean;
  };
}

function sendText(response: ServerResponse, value: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(value);
}

function validateLoginBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "code" || typeof body.code !== "string") {
    throw invalidArgument("请求体只能包含字符串字段 code");
  }
  return body.code;
}

function validateContentSecurityTextBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "content" || typeof body.content !== "string") {
    throw invalidArgument("内容安全文本请求体只能包含字符串字段 content");
  }
  return body.content;
}

function requireContentSecurity(dependencies: HttpApplicationDependencies): ContentSecurityService {
  if (!dependencies.contentSecurity) {
    throw new AppError(503, "CONTENT_SECURITY_NOT_CONFIGURED", "内容安全服务尚未配置");
  }
  return dependencies.contentSecurity;
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

function validatePrivacyPatch(body: Record<string, unknown>): PrivacyPreferencesPatch {
  const allowed = [
    "localOnly",
    "cloudSync",
    "serviceNotices",
    "personalizedRecommendations",
  ] as const;
  const keys = Object.keys(body);
  if (keys.length < 1 || !keys.every((key) => allowed.includes(key as typeof allowed[number]))) {
    throw invalidArgument("隐私偏好只能包含允许的字段，且至少包含一项");
  }
  for (const key of keys) {
    if (typeof body[key] !== "boolean") throw invalidArgument(`隐私偏好字段 ${key} 必须是布尔值`);
  }
  return {
    ...(body.localOnly === undefined ? {} : { localOnly: body.localOnly }),
    ...(body.cloudSync === undefined ? {} : { cloudSync: body.cloudSync }),
    ...(body.serviceNotices === undefined ? {} : { serviceNotices: body.serviceNotices }),
    ...(body.personalizedRecommendations === undefined ? {} : { personalizedRecommendations: body.personalizedRecommendations }),
  } as PrivacyPreferencesPatch;
}

function idempotencyKey(request: IncomingMessage): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw invalidArgument("请求必须包含合法的 Idempotency-Key");
  }
  return value;
}

function validateWorkBody(body: Record<string, unknown>): {
  readonly title: string;
  readonly coverFileId: string;
  readonly status: WorkStatus;
  readonly pattern: PersistedPattern;
} {
  const allowed = ["title", "coverFileId", "status", "pattern"];
  if (!Object.keys(body).every((key) => allowed.includes(key)) || typeof body.coverFileId !== "string" || !body.coverFileId.trim()) {
    throw invalidArgument("作品请求只能包含 title、coverFileId、status 和 pattern");
  }
  const title = body.title === undefined ? "未命名作品" : body.title;
  if (typeof title !== "string" || title.trim().length < 1 || Array.from(title.trim()).length > 120 || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw invalidArgument("作品标题长度必须为 1 到 120 个字符，且不能包含控制字符");
  }
  const status = body.status === undefined ? "completed" : body.status;
  if (status !== "draft" && status !== "completed") throw invalidArgument("作品 status 只能是 draft 或 completed");
  const validated = validatePersistedPattern(body.pattern);
  return { title: title.trim(), coverFileId: body.coverFileId.trim(), status, pattern: validated.pattern };
}

function validateWorkUpdateBody(body: Record<string, unknown>): Omit<UpdateWorkInput, "userId" | "workId"> {
  const allowed = ["title", "coverFileId", "status", "pattern"];
  const keys = Object.keys(body);
  if (keys.length < 1 || !keys.every((key) => allowed.includes(key))) {
    throw invalidArgument("作品更新只能包含 title、coverFileId、status 和 pattern，且至少包含一项");
  }
  const result: {
    title?: string;
    coverFileId?: string;
    status?: WorkStatus;
    validatedPattern?: ReturnType<typeof validatePersistedPattern>;
  } = {};
  if ("title" in body) {
    if (typeof body.title !== "string" || body.title.trim().length < 1 || Array.from(body.title.trim()).length > 120 || /[\u0000-\u001f\u007f]/u.test(body.title)) {
      throw invalidArgument("作品标题长度必须为 1 到 120 个字符，且不能包含控制字符");
    }
    result.title = body.title.trim();
  }
  if ("coverFileId" in body) {
    if (typeof body.coverFileId !== "string" || !body.coverFileId.trim()) {
      throw invalidArgument("coverFileId 必须是非空字符串");
    }
    result.coverFileId = body.coverFileId.trim();
  }
  if ("status" in body) {
    if (body.status !== "draft" && body.status !== "completed") {
      throw invalidArgument("作品 status 只能是 draft 或 completed");
    }
    result.status = body.status;
  }
  if ("pattern" in body) result.validatedPattern = validatePersistedPattern(body.pattern);
  return result;
}

function validateFavoriteBody(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "favorite" || typeof body.favorite !== "boolean") {
    throw invalidArgument("收藏请求体只能包含布尔字段 favorite");
  }
  return body.favorite;
}

function validateDownloadBody(body: Record<string, unknown>): {
  readonly workId: string;
  readonly fileType: DownloadFileType;
} {
  const keys = Object.keys(body);
  if (
    keys.length !== 2
    || !keys.every((key) => key === "workId" || key === "fileType")
    || typeof body.workId !== "string"
    || !body.workId.trim()
    || (body.fileType !== "preview" && body.fileType !== "chart" && body.fileType !== "materials" && body.fileType !== "palette")
  ) {
    throw invalidArgument("下载请求体只能包含非空 workId 和合法 fileType");
  }
  return { workId: body.workId.trim(), fileType: body.fileType };
}

function validateCreatePaymentBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "packageId" || typeof body.packageId !== "string") {
    throw invalidArgument("支付创建请求体只能包含字符串字段 packageId");
  }
  const packageId = body.packageId.trim();
  if (!packageId || packageId.length > 40) throw invalidArgument("packageId 无效");
  return packageId;
}

function validateCreateAiGenerationBody(body: Record<string, unknown>): {
  readonly inputFileId: string;
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
} {
  const keys = Object.keys(body);
  if (
    keys.length !== 4
    || !keys.every((key) => ["inputFileId", "style", "detailLevel", "backgroundMode"].includes(key))
    || typeof body.inputFileId !== "string"
    || !body.inputFileId.trim()
    || (body.style !== "natural" && body.style !== "cartoon" && body.style !== "minimal")
    || (body.detailLevel !== "low" && body.detailLevel !== "medium" && body.detailLevel !== "high")
    || (body.backgroundMode !== "keep" && body.backgroundMode !== "simplify" && body.backgroundMode !== "remove")
  ) {
    throw invalidArgument("AI 生成请求必须包含合法的 inputFileId、style、detailLevel 和 backgroundMode");
  }
  return {
    inputFileId: body.inputFileId.trim(),
    style: body.style,
    detailLevel: body.detailLevel,
    backgroundMode: body.backgroundMode,
  };
}

function wechatPaymentHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const names = [
    "wechatpay-timestamp",
    "wechatpay-nonce",
    "wechatpay-serial",
    "wechatpay-signature",
  ] as const;
  return Object.fromEntries(names.map((name) => {
    const value = request.headers[name];
    return [name, typeof value === "string" ? value : undefined];
  }));
}

function listOptions(url: URL, userId: string): { userId: string; status?: WorkStatus; page: number; pageSize: number; query?: string } {
  for (const key of url.searchParams.keys()) {
    if (!["status", "page", "pageSize", "query"].includes(key)) throw invalidArgument("作品列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page");
  const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize");
  const statusValue = url.searchParams.get("status");
  if (statusValue !== null && statusValue !== "draft" && statusValue !== "completed") throw invalidArgument("status 只能是 draft 或 completed");
  const query = url.searchParams.get("query")?.trim() || undefined;
  if (query && Array.from(query).length > 120) throw invalidArgument("query 不能超过 120 个字符");
  return { userId, page, pageSize, ...(statusValue ? { status: statusValue } : {}), ...(query ? { query } : {}) };
}

function favoriteListOptions(url: URL, userId: string): FavoriteListOptions {
  for (const key of url.searchParams.keys()) {
    if (!["page", "pageSize", "query"].includes(key)) throw invalidArgument("收藏列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page");
  const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize");
  const query = url.searchParams.get("query")?.trim() || undefined;
  if (query && Array.from(query).length > 120) throw invalidArgument("query 不能超过 120 个字符");
  return { userId, page, pageSize, ...(query ? { query } : {}) };
}

function downloadListOptions(url: URL, userId: string): DownloadListOptions {
  for (const key of url.searchParams.keys()) {
    if (!["fileType", "page", "pageSize", "query"].includes(key)) throw invalidArgument("下载记录列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page");
  const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize");
  const fileType = url.searchParams.get("fileType");
  if (fileType !== null && fileType !== "preview" && fileType !== "chart" && fileType !== "materials" && fileType !== "palette") {
    throw invalidArgument("fileType 只能是 preview、chart、materials 或 palette");
  }
  const query = url.searchParams.get("query")?.trim() || undefined;
  if (query && Array.from(query).length > 120) throw invalidArgument("query 不能超过 120 个字符");
  return {
    userId,
    page,
    pageSize,
    ...(fileType ? { fileType } : {}),
    ...(query ? { query } : {}),
  };
}

function orderListOptions(url: URL, userId: string): OrderListOptions {
  for (const key of url.searchParams.keys()) {
    if (!["page", "pageSize"].includes(key)) throw invalidArgument("订单列表包含不支持的查询参数");
    if (url.searchParams.getAll(key).length > 1) throw invalidArgument(`查询参数 ${key} 不能重复`);
  }
  return {
    userId,
    page: positiveQueryInteger(url.searchParams.get("page"), 1, 1_000_000, "page"),
    pageSize: positiveQueryInteger(url.searchParams.get("pageSize"), 20, 50, "pageSize"),
  };
}

function positiveQueryInteger(value: string | null, fallback: number, maximum: number, name: string): number {
  if (value === null) return fallback;
  if (!/^[0-9]+$/u.test(value)) throw invalidArgument(`${name} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw invalidArgument(`${name} 超出允许范围`);
  return parsed;
}

function workId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/works\/([^/]+)$/u);
  return match?.[1] ?? null;
}

function favoriteWorkId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/works\/([^/]+)\/favorite$/u);
  return match?.[1] ?? null;
}

function aiGenerationId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/ai\/generations\/([^/]+)$/u);
  return match?.[1] ?? null;
}

function sendNoContent(response: ServerResponse): void {
  response.statusCode = 204;
  response.removeHeader("content-type");
  response.removeHeader("cache-control");
  response.end();
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
            capabilities: dependencies.capabilities ?? {
              wechatPay: false,
              aiGeneration: false,
              persistentStorage: false,
              httpsPublicUrls: false,
              monitoringAlerts: false,
            },
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
          sendImage(response, avatar);
          return;
        }
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/media/covers/")) {
        if (url.searchParams.size > 0) throw invalidArgument("封面地址不接受查询参数");
        const cover = await dependencies.covers.read(url.pathname);
        if (cover) {
          sendImage(response, cover);
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJsonObject(request);
        const result = await dependencies.auth.login(validateLoginBody(body));
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/media/ai/")) {
        if (url.searchParams.size > 0) throw invalidArgument("AI 文件地址不接受查询参数");
        const file = await dependencies.aiFiles.read(url.pathname);
        if (file) {
          sendImage(response, file);
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/files/upload") {
        if (url.searchParams.size > 0) throw invalidArgument("文件上传接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const upload = await readSingleUploadedFile(
          request,
          "file",
          Math.max(
            dependencies.coverMaximumBytes,
            dependencies.aiFileMaximumBytes ?? dependencies.coverMaximumBytes,
          ),
          ["type"],
          "图片文件",
        );
        const type = upload.fields.type;
        if ((type !== "cover" && type !== "ai_input") || Object.keys(upload.fields).length !== 1) {
          throw invalidArgument("文件上传的 type 只能是 cover 或 ai_input");
        }
        const maximumBytes = type === "cover"
          ? dependencies.coverMaximumBytes
          : dependencies.aiFileMaximumBytes;
        if (upload.buffer.length > maximumBytes) {
          throw new AppError(413, "PAYLOAD_TOO_LARGE", "图片文件超过大小限制");
        }
        sendJson(response, 201, {
          file: await dependencies.files.upload(currentUser.id, {
            type,
            buffer: upload.buffer,
            filename: upload.filename,
            declaredContentType: upload.declaredContentType,
          }),
        });
        return;
      }

      const legalDocumentMatch = url.pathname.match(/^\/api\/legal-documents\/([^/]+)$/u);
      if (legalDocumentMatch && request.method === "GET") {
        if (url.searchParams.size > 0) throw invalidArgument("法律文档接口不接受查询参数");
        const key = legalDocumentMatch[1];
        if (!key) throw invalidArgument("法律文档 key 无效");
        sendJson(response, 200, { document: getLegalDocument(key) });
        return;
      }

      if (url.pathname.startsWith("/api/content-security/media/")) {
        if (request.method !== "GET" || url.searchParams.size > 0 || !dependencies.contentSecurity) {
          throw invalidArgument("内容安全媒体地址无效");
        }
        const media = await dependencies.contentSecurity.readMedia(url.pathname);
        if (media) {
          sendImage(response, media);
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/wechat/content-security/callback") {
        if (!dependencies.contentSecurity?.verifyCallback(
          url.searchParams.get("signature") ?? undefined,
          url.searchParams.get("timestamp") ?? undefined,
          url.searchParams.get("nonce") ?? undefined,
        )) {
          throw new AppError(403, "INVALID_CALLBACK_SIGNATURE", "微信回调校验失败");
        }
        sendText(response, url.searchParams.get("echostr") ?? "success");
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/wechat/content-security/callback") {
        if (!dependencies.contentSecurity?.verifyCallback(
          url.searchParams.get("signature") ?? undefined,
          url.searchParams.get("timestamp") ?? undefined,
          url.searchParams.get("nonce") ?? undefined,
        )) {
          throw new AppError(403, "INVALID_CALLBACK_SIGNATURE", "微信回调校验失败");
        }
        await dependencies.contentSecurity.handleCallback(await readJsonObject(request));
        sendText(response, "success");
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/content-security/text") {
        if (url.searchParams.size > 0) throw new AppError(503, "CONTENT_SECURITY_NOT_CONFIGURED", "内容安全服务尚未配置");
        const contentSecurity = requireContentSecurity(dependencies);
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const trace = await contentSecurity.checkText(
          currentUser.id,
          validateContentSecurityTextBody(await readJsonObject(request)),
        );
        sendJson(response, 200, trace);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/content-security/media") {
        if (!dependencies.contentSecurity || url.searchParams.size > 0) {
          throw new AppError(503, "CONTENT_SECURITY_NOT_CONFIGURED", "内容安全服务尚未配置");
        }
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const upload = await readSingleUploadedFile(
          request,
          "file",
          dependencies.contentSecurityMediaMaximumBytes ?? 10 * 1_024 * 1_024,
          [],
          "待审核图片",
        );
        sendJson(response, 201, {
          check: await dependencies.contentSecurity.checkMedia(currentUser.id, {
            buffer: upload.buffer,
            filename: upload.filename,
            contentType: upload.declaredContentType,
          }),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/works") {
        if (url.searchParams.size > 0) throw invalidArgument("作品保存接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const validated = validateWorkBody(await readJsonObject(request, 2 * 1024 * 1024));
        await requireContentSecurity(dependencies).checkText(currentUser.id, validated.title);
        sendJson(response, 201, await dependencies.works.create({
          userId: currentUser.id,
          idempotencyKey: idempotencyKey(request),
          title: validated.title,
          coverFileId: validated.coverFileId,
          status: validated.status,
          validatedPattern: validatePersistedPattern(validated.pattern),
        }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/works") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.works.list(listOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/favorites") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.works.listFavorites(favoriteListOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/quota/me") {
        if (url.searchParams.size > 0) throw invalidArgument("额度接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.quotaDownloads.getQuota(currentUser.id));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/downloads") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.quotaDownloads.listDownloads(downloadListOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/downloads") {
        if (url.searchParams.size > 0) throw invalidArgument("下载记录接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const body = validateDownloadBody(await readJsonObject(request));
        sendJson(response, 201, await dependencies.quotaDownloads.createDownload({
          userId: currentUser.id,
          idempotencyKey: idempotencyKey(request),
          workId: body.workId,
          fileType: body.fileType,
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ai/generations") {
        if (url.searchParams.size > 0) throw invalidArgument("AI 生成接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const body = validateCreateAiGenerationBody(await readJsonObject(request));
        sendJson(response, 201, await dependencies.aiGenerations.create({
          userId: currentUser.id,
          idempotencyKey: idempotencyKey(request),
          ...body,
        }));
        return;
      }

      const requestedAiGenerationId = aiGenerationId(url.pathname);
      if (requestedAiGenerationId && request.method === "GET") {
        if (url.searchParams.size > 0) throw invalidArgument("AI 生成任务接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.aiGenerations.get(currentUser.id, requestedAiGenerationId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/packages") {
        if (url.searchParams.size > 0) throw invalidArgument("套餐接口不接受查询参数");
        sendJson(response, 200, await dependencies.payments.listPackages());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/orders") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.payments.listOrders(orderListOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/payments/create") {
        if (url.searchParams.size > 0) throw invalidArgument("支付创建接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const packageId = validateCreatePaymentBody(await readJsonObject(request));
        sendJson(response, 201, await dependencies.payments.createPayment({
          userId: currentUser.id,
          packageId,
          idempotencyKey: idempotencyKey(request),
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/payments/notify") {
        if (url.searchParams.size > 0) throw invalidArgument("微信支付回调接口不接受查询参数");
        try {
          const notification = await readRawJsonObject(request);
          await dependencies.payments.handleNotification({
            rawBody: notification.rawBody,
            headers: wechatPaymentHeaders(request),
          });
          sendJson(response, 200, { code: "SUCCESS", message: "成功" });
        } catch (error: unknown) {
          if (error instanceof AppError) {
            console.warn(JSON.stringify({
              event: "wechat_payment_notification_rejected",
              requestId: id,
              errorCode: error.code,
            }));
            sendJson(response, error.statusCode, { code: "FAIL", message: error.message });
          } else {
            console.error(JSON.stringify({ event: "wechat_payment_notification_failed", requestId: id }));
            sendJson(response, 500, { code: "FAIL", message: "服务内部错误" });
          }
        }
        return;
      }

      const requestedFavoriteWorkId = favoriteWorkId(url.pathname);
      if (requestedFavoriteWorkId && request.method === "PATCH") {
        if (url.searchParams.size > 0) throw invalidArgument("收藏操作接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const favorite = validateFavoriteBody(await readJsonObject(request));
        sendJson(response, 200, await dependencies.works.setFavorite(currentUser.id, requestedFavoriteWorkId, favorite));
        return;
      }

      const requestedWorkId = workId(url.pathname);
      if (requestedWorkId && (request.method === "GET" || request.method === "DELETE" || request.method === "PATCH" || request.method === "PUT")) {
        if (url.searchParams.size > 0) throw invalidArgument("作品详情接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        if (request.method === "GET") {
          sendJson(response, 200, await dependencies.works.get(currentUser.id, requestedWorkId));
        } else if (request.method === "DELETE") {
          await dependencies.works.delete(currentUser.id, requestedWorkId);
          sendNoContent(response);
        } else {
          const update = validateWorkUpdateBody(await readJsonObject(request, 2 * 1024 * 1024));
          if (update.title !== undefined) {
            await requireContentSecurity(dependencies).checkText(currentUser.id, update.title);
          }
          sendJson(response, 200, await dependencies.works.update({
            userId: currentUser.id,
            workId: requestedWorkId,
            ...update,
          }));
        }
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

      if (request.method === "GET" && url.pathname === "/api/users/me/privacy") {
        if (url.searchParams.size > 0) throw invalidArgument("隐私偏好接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        sendJson(response, 200, { privacy: await dependencies.users.getPrivacyPreferences(currentUser.id) });
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/users/me/privacy") {
        if (url.searchParams.size > 0) throw invalidArgument("隐私偏好接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        const privacy = await dependencies.users.updatePrivacyPreferences(
          currentUser.id,
          validatePrivacyPatch(await readJsonObject(request)),
        );
        sendJson(response, 200, { privacy });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/users/me") {
        if (url.searchParams.size > 0) throw invalidArgument("账号注销接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        await dependencies.users.deleteAccount(currentUser.id);
        sendNoContent(response);
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
          "头像文件",
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
          console.error(JSON.stringify({
            event: "request_failed",
            requestId: id,
            method: request.method,
            pathname: new URL(request.url ?? "/", "http://localhost").pathname,
          }));
          sendJson(response, 500, errorPayload("INTERNAL_ERROR", "服务内部错误", id));
        }
      } else {
        response.destroy();
      }
    });
  };
}
