/**
 * 混元（hunyuan）图生图 provider 封装。
 *
 * 职责：对 AI 生成主链路屏蔽混元 SDK / 云存储的差异，提供统一的
 *       createTask（提交生图）与 downloadOutput（取回产物）接口，
 *       并把上游各类异常归一化成 ProviderError（携带 kind，用于重试/失败判定）。
 * 调用方：ai-generation-service.ts（submit 调 createTask，completeOutputInternal 调 downloadOutput）。
 * 关键点：产物格式以「下载字节的真实魔数」判定（png/jpeg/webp），而非临时地址的
 *       content-type 头——历史上头缺失导致 JPEG 被误标成 PNG，进而整批任务失败。
 */
import { HUNYUAN_IMAGE_MODEL, type HunyuanImageConfig } from "../../config/env";
import { AppError } from "../../shared/app-error";
import cloudbase = require("@cloudbase/node-sdk");

export type ProviderFailureKind =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_OUTPUT"
  | "UNKNOWN";

export interface ProviderFailure {
  readonly provider: "hunyuan";
  readonly providerCode: string | null;
  readonly httpStatus: number | null;
  readonly kind: ProviderFailureKind;
}

/** 归一化后的 provider 异常；用 failure.kind 让上层区分额度/限流/超时/不可用/坏输出。 */
export class ProviderError extends AppError {
  public constructor(
    public readonly failure: ProviderFailure,
    code = providerErrorCode(failure.kind),
    message = "AI 图像服务请求失败",
  ) {
    super(providerErrorStatus(failure.kind), code, message, {
      providerCode: failure.providerCode,
      httpStatus: failure.httpStatus,
      kind: failure.kind,
    });
    this.name = "ProviderError";
  }
}

export interface ProviderTaskSubmission {
  readonly requestId: string;
  readonly outputUrl: string;
}

export interface AiGenerationProvider {
  readonly configured: boolean;
  readonly name: "hunyuan";
  readonly model: string;
  createTask(imageDataUrl: string, prompt: string): Promise<ProviderTaskSubmission>;
  downloadOutput(outputUrl: string): Promise<Buffer>;
}

type JsonObject = Record<string, unknown>;

interface HunyuanImageModel {
  generateImage(input: Record<string, unknown>): Promise<unknown>;
  downloadFile?(fileId: string): Promise<Buffer>;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 按失败种类构造一个 ProviderError 的小工具，默认 code/message 跟随 kind。 */
function providerFailure(
  kind: ProviderFailureKind = "UNKNOWN",
  providerCode: string | null = null,
  httpStatus: number | null = null,
  code = providerErrorCode(kind),
  message = "AI 图像服务请求失败",
): ProviderError {
  return new ProviderError({ provider: "hunyuan", providerCode, httpStatus, kind }, code, message);
}

export class HunyuanImageProvider implements AiGenerationProvider {
  public readonly name = "hunyuan" as const;

  public constructor(
    private readonly config: HunyuanImageConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly imageModel: HunyuanImageModel | null = createImageModel(config),
  ) {}

  public get configured(): boolean {
    return this.config.enabled;
  }

  public get model(): string {
    return this.config.enabled ? this.config.model : HUNYUAN_IMAGE_MODEL;
  }

  /**
   * 提交一次图生图任务。
   * @param imageDataUrl 输入图（data URL 形式）交给混元做参考图。
   * @param prompt 由 prompt-template 拼好的生图提示词。
   * @returns requestId（幂等/对账用）+ outputUrl（云文件引用或临时下载地址）。
   */
  public async createTask(imageDataUrl: string, prompt: string): Promise<ProviderTaskSubmission> {
    const config = this.requireConfig();
    if (!this.imageModel) throw new AppError(503, "AI_PROVIDER_NOT_CONFIGURED", "AI 图像服务尚未完成配置");
    let response: unknown;
    try {
      response = await this.imageModel.generateImage({
        model: config.model,
        prompt,
        images: [imageDataUrl],
        size: "1024x1024",
        revise: { value: false },
      });
    } catch (error: unknown) {
      throw providerFailureFromSdk(error);
    }
    const body = object(response);
    if (!body) throw providerFailure();
    const requestId = string(body.request_id) ?? string(body.id);
    const data = Array.isArray(body.data) ? body.data : [];
    const first = object(data[0]);
    const outputUrl = string(first?.url);
    const outputFileId = string(body.fileID) ?? string(first?.fileID);
    const outputReference = outputFileId ? `cloud-file:${outputFileId}` : outputUrl;
    if (!requestId || requestId.length > 128 || !outputReference) throw providerFailure();
    console.log(JSON.stringify({
      event: "ai_provider_output_declared",
      provider: this.name,
      model: this.model,
      requestId,
      outputReferenceKind: outputFileId ? "cloud-file" : "url",
      declaredContentType: string(body.contentType) ?? string(first?.contentType) ?? null,
      declaredFileExtension: outputFileId ? outputFileExtension(outputFileId) : "none",
      declaredByteSize: number(body.size) ?? null,
    }));
    return { requestId, outputUrl: outputReference };
  }

  public async downloadOutput(outputUrl: string): Promise<Buffer> {
    if (outputUrl.startsWith("cloud-file:")) {
      return this.downloadCloudFile(outputUrl.slice("cloud-file:".length));
    }
    const config = this.requireConfig();
    let parsed: URL;
    try {
      parsed = new URL(outputUrl);
    } catch {
      throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务返回了无效图片地址");
    }
    if (!isTrustedOutputUrl(parsed, config.baseUrl)) {
      throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务返回了不受信任的图片地址");
    }
    const response = await this.fetchWithTimeout(parsed.href, { method: "GET", redirect: "error" });
    if (response.url) {
      try {
        if (!isTrustedOutputUrl(new URL(response.url), config.baseUrl)) {
          throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片地址不受信任");
        }
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片地址不受信任");
      }
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw providerFailure("RATE_LIMITED", null, response.status, "AI_PROVIDER_RATE_LIMITED", "AI 服务输出读取繁忙");
      }
      if (response.status >= 500) {
        throw providerFailure("UNAVAILABLE", null, response.status, "AI_PROVIDER_UNAVAILABLE", "AI 服务输出暂时不可用");
      }
      throw providerFailure("INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片不可用");
    }
    // URL 直链分支：仍按 provider 返回的 content-type 头做 PNG 校验（直链场景上游带正确头）。
    // 注意：常见的 "cloud-file:" 分支走 downloadCloudFile，改按真实魔数判定，不受此头影响。
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "image/png") {
      throw providerFailure("INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片不可用");
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > config.maximumOutputBytes) {
      throw providerFailure("INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_TOO_LARGE", "AI 服务输出图片超过大小限制");
    }
    if (!response.body) throw providerFailure("INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片为空");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > config.maximumOutputBytes) {
        throw providerFailure("INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_TOO_LARGE", "AI 服务输出图片超过大小限制");
      }
      chunks.push(buffer);
    }
    if (size === 0) throw providerFailure("INVALID_OUTPUT", null, response.status, "AI 服务输出图片为空");
    return Buffer.concat(chunks);
  }

  private async downloadCloudFile(fileId: string): Promise<Buffer> {
    if (!fileId || !this.imageModel?.downloadFile) {
      logOutputRejected({
        reason: "missing_file_reference",
        fileId,
        byteSize: 0,
        detectedFormat: "unknown",
        signatureHex: "",
        maximumOutputBytes: null,
      });
      throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务返回了无效图片文件");
    }
    try {
      const output = await this.imageModel.downloadFile(fileId);
      const maximumOutputBytes = this.requireConfig().maximumOutputBytes;
      const format = detectOutputFormat(output);
      // 云函数落盘时可能把上游返回的 JPEG 误标成 PNG，因此按真实字节魔数识别，
      // 接受 png / jpeg / webp，而不是只认 PNG。
      if (output.length === 0 || output.length > maximumOutputBytes || !isSupportedOutputFormat(format)) {
        logOutputRejected({
          reason: "output_format_rejected",
          fileId,
          byteSize: output.length,
          detectedFormat: format,
          signatureHex: output.subarray(0, 16).toString("hex"),
          maximumOutputBytes,
        });
        throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片不可用");
      }
      return output;
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      logOutputRejected({
        reason: "download_failed",
        fileId,
        byteSize: null,
        detectedFormat: "unknown",
        signatureHex: "",
        maximumOutputBytes: null,
        message: error instanceof Error ? error.message : String(error),
      });
      throw providerFailure("UNAVAILABLE", null, null, "AI_PROVIDER_UNAVAILABLE", "AI 服务输出暂时不可用");
    }
  }

  private requireConfig(): Extract<HunyuanImageConfig, { readonly enabled: true }> {
    if (!this.config.enabled) {
      throw new AppError(503, "AI_PROVIDER_NOT_CONFIGURED", "AI 图像服务尚未完成配置");
    }
    return this.config;
  }

  /** 带 AbortSignal 超时的 fetch 封装；超时归一为 TIMEOUT，其它网络错误归一为 UNAVAILABLE。 */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const config = this.requireConfig();
    try {
      return await this.fetchImplementation(url, {
        ...init,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw providerFailure("TIMEOUT", null, null, "AI_PROVIDER_TIMEOUT", "AI 图像服务请求超时");
      }
      throw providerFailure("UNAVAILABLE", null, null, "AI_PROVIDER_UNAVAILABLE", "AI 图像服务暂时不可用");
    }
  }
}

/** 按配置初始化混元云 SDK 并包裹出 imageModel；disabled 时返回 null（provider 即不可用）。 */
function createImageModel(config: HunyuanImageConfig): HunyuanImageModel | null {
  if (!config.enabled) return null;
  const app = cloudbase.init({
    env: config.environmentId,
    accessKey: config.apiKey,
    timeout: config.timeoutMs,
  });
  return {
    async generateImage(input: Record<string, unknown>): Promise<unknown> {
      const images = Array.isArray(input.images) ? input.images : [];
      const imageDataUrl = typeof images[0] === "string" ? images[0] : "";
      const result = await app.callFunction<
        { prompt: unknown; imageDataUrl: string; size: unknown },
        unknown
      >({
        name: "generateImage",
        data: {
          prompt: input.prompt,
          imageDataUrl,
          size: input.size,
        },
      });
      const body = object(result.result);
      if (body?.error) {
        const error = new Error(string(body.error) ?? "图片生成失败");
        Object.assign(error, {
          code: string(body.code),
          statusCode: number(body.statusCode),
        });
        throw error;
      }
      return {
        ...(body ?? {}),
        request_id: string(body?.requestId) ?? string(body?.request_id) ?? string(result.requestId),
        data: body?.fileID ? [{ fileID: body.fileID }] : [],
      };
    },
    async downloadFile(fileId: string): Promise<Buffer> {
      const result = await app.downloadFile({ fileID: fileId });
      if (!Buffer.isBuffer(result.fileContent)) throw new Error("云存储文件内容无效");
      return result.fileContent;
    },
  };
}

function isPng(value: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return value.subarray(0, signature.length).equals(signature);
}

export type ProviderOutputFormat = "png" | "jpeg" | "webp" | "empty" | "unknown";

export type SupportedOutputFormat = "png" | "jpeg" | "webp";

export function isSupportedOutputFormat(value: ProviderOutputFormat): value is SupportedOutputFormat {
  return value === "png" || value === "jpeg" || value === "webp";
}

export function detectOutputFormat(value: Buffer): ProviderOutputFormat {
  if (value.length === 0) return "empty";
  if (isPng(value)) return "png";
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "jpeg";
  if (
    value.length >= 12
    && value.subarray(0, 4).toString("ascii") === "RIFF"
    && value.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "webp";
  return "unknown";
}

/** 从云文件 ID 的尾缀提取扩展名（小写），诊断用；无扩展名时返回 "none"。 */
function outputFileExtension(fileId: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/u.exec(fileId.trim());
  return match ? match[1]!.toLowerCase() : "none";
}

interface OutputRejectionDiagnostic {
  readonly reason: string;
  readonly fileId: string;
  readonly byteSize: number | null;
  readonly detectedFormat: ProviderOutputFormat;
  readonly signatureHex: string;
  readonly maximumOutputBytes: number | null;
  readonly message?: string;
}

function logOutputRejected(diagnostic: OutputRejectionDiagnostic): void {
  console.error(JSON.stringify({
    event: "ai_provider_output_rejected",
    provider: "hunyuan",
    reason: diagnostic.reason,
    fileIdSuffix: diagnostic.fileId ? diagnostic.fileId.slice(-96) : null,
    declaredFileExtension: diagnostic.fileId ? outputFileExtension(diagnostic.fileId) : "none",
    byteSize: diagnostic.byteSize,
    detectedFormat: diagnostic.detectedFormat,
    signatureHex: diagnostic.signatureHex,
    maximumOutputBytes: diagnostic.maximumOutputBytes,
    ...(diagnostic.message ? { message: diagnostic.message.slice(0, 300) } : {}),
  }));
}

function isTrustedOutputUrl(value: URL, baseUrl: string): boolean {
  const hostname = value.hostname.toLowerCase();
  const configuredHostname = new URL(baseUrl).hostname.toLowerCase();
  return value.protocol === "https:"
    && !value.username
    && !value.password
    && !value.port
    && (hostname === configuredHostname
      || hostname === "myqcloud.com"
      || hostname.endsWith(".myqcloud.com"));
}

function providerFailureFromSdk(error: unknown): ProviderError {
  const details = object(error);
  const message = error instanceof Error ? error.message : String(error);
  const providerCode = string(details?.code) ?? string(details?.error_code) ?? codeFromMessage(message);
  const status = number(details?.statusCode) ?? number(details?.status) ?? null;
  if (providerCode?.includes("QUOTA") || providerCode?.includes("TOKEN_QUOTA") || /quota|额度/u.test(message)) {
    return providerFailure("QUOTA_EXHAUSTED", providerCode, status, "AI_PROVIDER_QUOTA_EXHAUSTED", "AI 图像服务额度不足");
  }
  if (providerCode === "RATE_LIMITED") {
    return providerFailure("RATE_LIMITED", providerCode, status, "AI_PROVIDER_RATE_LIMITED", "AI 图像服务请求繁忙");
  }
  if (status === 429 || providerCode === "429") {
    return providerFailure("QUOTA_EXHAUSTED", providerCode, status, "AI_PROVIDER_QUOTA_EXHAUSTED", "AI 图像服务额度不足");
  }
  if (status === 408 || status === 504 || /timeout|timed out|超时/iu.test(message)) {
    return providerFailure("TIMEOUT", providerCode, status, "AI_PROVIDER_TIMEOUT", "AI 图像服务请求超时");
  }
  if (status === 401 || status === 403) {
    return providerFailure("UNAVAILABLE", providerCode, status, "AI_SERVICE_UNAVAILABLE", "AI 生成服务暂时不可用");
  }
  if (status !== null && status >= 500) {
    return providerFailure("UNAVAILABLE", providerCode, status, "AI_PROVIDER_UNAVAILABLE", "AI 图像服务暂时不可用");
  }
  return providerFailure("UNKNOWN", providerCode, status);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function codeFromMessage(message: string): string | null {
  const match = /\b[A-Z][A-Z0-9_]{4,}\b/u.exec(message);
  return match?.[0] ?? null;
}

function providerErrorCode(kind: ProviderFailureKind): string {
  if (kind === "TIMEOUT") return "AI_PROVIDER_TIMEOUT";
  if (kind === "UNAVAILABLE") return "AI_PROVIDER_UNAVAILABLE";
  if (kind === "INVALID_OUTPUT") return "AI_PROVIDER_OUTPUT_INVALID";
  if (kind === "RATE_LIMITED") return "AI_PROVIDER_RATE_LIMITED";
  return "AI_PROVIDER_ERROR";
}

/** 把失败种类翻译成 HTTP 状态码（超时 504、不可用/限流 503、其余 502）。 */
function providerErrorStatus(kind: ProviderFailureKind): number {
  if (kind === "TIMEOUT") return 504;
  if (kind === "UNAVAILABLE" || kind === "QUOTA_EXHAUSTED" || kind === "RATE_LIMITED") return 503;
  return 502;
}
