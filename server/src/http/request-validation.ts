import type { IncomingMessage } from "node:http";
import { TEXT_IMAGE_SIZES, type TextImageSize } from '../modules/ai/text-image-options';
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
import type { AuthProvider } from "../modules/auth/types";

export interface LoginBody {
  readonly code: string;
  readonly provider: AuthProvider;
  readonly linkCode?: string;
}

export function validateLoginBody(body: Record<string, unknown>): LoginBody {
  const keys = Object.keys(body);
  if (
    !keys.includes("code")
    || keys.some((key) => key !== "code" && key !== "provider" && key !== "linkCode")
    || typeof body.code !== "string"
    || (body.provider !== undefined && body.provider !== "wechat" && body.provider !== "qq")
    || (body.linkCode !== undefined && typeof body.linkCode !== "string")
  ) {
    throw invalidArgument("登录请求仅接受 code、provider 和可选的 linkCode");
  }
  const provider = body.provider === "qq" ? "qq" : "wechat";
  if (provider === "wechat" && body.linkCode !== undefined) {
    throw invalidArgument("微信登录不接受 QQ 绑定码");
  }
  return {
    code: body.code,
    provider,
    ...(typeof body.linkCode === "string" ? { linkCode: body.linkCode } : {}),
  };
}

export function validateContentSecurityTextBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "content" || typeof body.content !== "string") {
    throw invalidArgument("内容安全文本请求体只能包含字符串字段 content");
  }
  return body.content;
}

export function validateCreateShareLinkBody(body: Record<string, unknown>): "home" | "projects" | "profile" {
  if (Object.keys(body).length !== 1 || (body.page !== "home" && body.page !== "projects" && body.page !== "profile")) {
    throw invalidArgument("分享链接页面只能是 home、projects 或 profile");
  }
  return body.page;
}

export function validateQueryShareLinkBody(body: Record<string, unknown>): string {
  if (Object.keys(body).length !== 1 || typeof body.urlLink !== "string") {
    throw invalidArgument("请求体只能包含字符串字段 urlLink");
  }
  const value = body.urlLink.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidArgument("urlLink 格式无效");
  }
  if (
    value.length > 2048
    || parsed.protocol !== "https:"
    || parsed.hostname !== "wxaurl.cn"
    || !parsed.pathname || parsed.pathname === "/"
    || parsed.username || parsed.password || parsed.port || parsed.hash
  ) {
    throw invalidArgument("urlLink 必须是微信生成的 HTTPS URL Link");
  }
  return value;
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
  readonly creationSource: "image" | "text";
  readonly sourcePrompt: string | null;
} {
  const allowed = ["title", "coverFileId", "status", "pattern", "creationSource", "sourcePrompt"];
  if (!Object.keys(body).every((key) => allowed.includes(key)) || typeof body.coverFileId !== "string" || !body.coverFileId.trim()) {
    throw invalidArgument("作品请求包含不支持的字段");
  }
  const title = body.title === undefined ? "未命名作品" : body.title;
  if (typeof title !== "string" || title.trim().length < 1 || Array.from(title.trim()).length > 120 || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw invalidArgument("作品标题长度必须为 1 到 120 个字符，且不能包含控制字符");
  }
  const status = body.status === undefined ? "completed" : body.status;
  if (status !== "draft" && status !== "completed") throw invalidArgument("作品 status 只能是 draft 或 completed");
  const validated = validatePersistedPattern(body.pattern);
  const creation = validateCreationSource(body.creationSource, body.sourcePrompt);
  return { title: title.trim(), coverFileId: body.coverFileId.trim(), status, pattern: validated.pattern, ...creation };
}

export function validateWorkUpdateBody(body: Record<string, unknown>): Omit<UpdateWorkInput, "userId" | "workId"> {
  const allowed = ["title", "coverFileId", "status", "pattern", "creationSource", "sourcePrompt"];
  const keys = Object.keys(body);
  if (keys.length < 1 || !keys.every((key) => allowed.includes(key))) {
    throw invalidArgument("作品更新只能包含 title、coverFileId、status 和 pattern，且至少包含一项");
  }
  const result: {
    title?: string;
    coverFileId?: string;
    status?: WorkStatus;
    validatedPattern?: ReturnType<typeof validatePersistedPattern>;
    creationSource?: "image" | "text";
    sourcePrompt?: string | null;
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
  if ("creationSource" in body || "sourcePrompt" in body) {
    if (!("creationSource" in body) || !("sourcePrompt" in body)) {
      throw invalidArgument("创作来源和描述必须同时提供");
    }
    Object.assign(result, validateCreationSource(body.creationSource, body.sourcePrompt));
  }
  return result;
}

function validateCreationSource(value: unknown, prompt: unknown): { readonly creationSource: "image" | "text"; readonly sourcePrompt: string | null } {
  const creationSource = value === undefined ? "image" : value;
  if (creationSource !== "image" && creationSource !== "text") throw invalidArgument("creationSource 只能是 image 或 text");
  if (creationSource === "image") {
    if (prompt !== undefined && prompt !== null) throw invalidArgument("图片创作不能包含 sourcePrompt");
    return { creationSource, sourcePrompt: null };
  }
  if (typeof prompt !== "string") throw invalidArgument("文字创作必须提供 sourcePrompt");
  const sourcePrompt = prompt.trim().normalize("NFC");
  const length = Array.from(sourcePrompt).length;
  if (length < 1 || length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(sourcePrompt)) {
    throw invalidArgument("sourcePrompt 长度必须为 1 到 500 个字符，且不能包含控制字符");
  }
  return { creationSource, sourcePrompt };
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
    || (body.style !== "kawaii" && body.style !== "natural" && body.style !== "cartoon" && body.style !== "minimal")
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

export function validateCreateTextImageGenerationBody(body: Record<string, unknown>): { readonly prompt: string; readonly size: TextImageSize } {
  if (!Object.keys(body).every(key => key === 'prompt' || key === 'size') || typeof body.prompt !== "string") {
    throw invalidArgument("文生图请求体只能包含 prompt 和 size");
  }
  const prompt = body.prompt.trim().normalize("NFC");
  const length = Array.from(prompt).length;
  if (length < 1 || length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt)) {
    throw invalidArgument("描述长度必须为 1 到 500 个字符，且不能包含控制字符");
  }
  const size = body.size === undefined ? '1024x1024' : body.size;
  if (!TEXT_IMAGE_SIZES.includes(size as TextImageSize)) throw invalidArgument('图片尺寸不受支持');
  return { prompt, size: size as TextImageSize };
}

/** 只接受服务端已登记的文生图任务 ID，不接受客户端指定作品或图片数据。 */
export function validateCreateTextImageWorkBody(body: Record<string, unknown>): { readonly sourceJobId: string } {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "sourceJobId"
    || typeof body.sourceJobId !== "string" || !/^txtjob_[A-Za-z0-9_-]{20}$/u.test(body.sourceJobId)) {
    throw invalidArgument("文生图作品保存请求必须包含合法的 sourceJobId");
  }
  return { sourceJobId: body.sourceJobId };
}
