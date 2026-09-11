import type { IncomingMessage } from "node:http";
import type {
  AiGenerationBackgroundMode,
  AiGenerationDetailLevel,
  AiGenerationStyle,
} from "../modules/ai/ai-generation-service";
import type { DownloadFileType } from "../modules/downloads/quota-download-service";
import type { PrivacyPreferencesPatch } from "../modules/users/user-profile-service";
import { invalidArgument } from "../shared/app-error";
import { validatePersistedPattern, type PersistedPattern } from "../modules/works/pattern";
import type { UpdateWorkInput, WorkStatus } from "../modules/works/work-service";

export function validateLoginBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "code" || typeof body.code !== "string") {
    throw invalidArgument("请求体只能包含字符串字段 code");
  }
  return body.code;
}

export function validateContentSecurityTextBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "content" || typeof body.content !== "string") {
    throw invalidArgument("内容安全文本请求体只能包含字符串字段 content");
  }
  return body.content;
}

export function validateNicknameBody(body: Record<string, unknown>): string {
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

export function validatePrivacyPatch(body: Record<string, unknown>): PrivacyPreferencesPatch {
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

export function idempotencyKey(request: IncomingMessage): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw invalidArgument("请求必须包含合法的 Idempotency-Key");
  }
  return value;
}

export function validateWorkBody(body: Record<string, unknown>): {
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

export function validateWorkUpdateBody(body: Record<string, unknown>): Omit<UpdateWorkInput, "userId" | "workId"> {
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

export function validateFavoriteBody(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "favorite" || typeof body.favorite !== "boolean") {
    throw invalidArgument("收藏请求体只能包含布尔字段 favorite");
  }
  return body.favorite;
}

export function validateDownloadBody(body: Record<string, unknown>): {
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

export function validateCreatePaymentBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "packageId" || typeof body.packageId !== "string") {
    throw invalidArgument("支付创建请求体只能包含字符串字段 packageId");
  }
  const packageId = body.packageId.trim();
  if (!packageId || packageId.length > 40) throw invalidArgument("packageId 无效");
  return packageId;
}

export function validateCreateAiGenerationBody(body: Record<string, unknown>): {
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
