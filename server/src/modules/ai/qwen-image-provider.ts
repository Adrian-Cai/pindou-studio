import type { QwenImageConfig } from "../../config/env";
import { AppError } from "../../shared/app-error";

export type ProviderTaskResult =
  | { readonly status: "pending" }
  | { readonly status: "succeeded"; readonly outputUrl: string }
  | { readonly status: "failed" };

export type ProviderFailureKind =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_OUTPUT"
  | "UNKNOWN";

export interface ProviderFailure {
  readonly provider: "qwen";
  readonly providerCode: string | null;
  readonly httpStatus: number | null;
  readonly kind: ProviderFailureKind;
}

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

export interface AiGenerationProvider {
  readonly configured: boolean;
  readonly name: "qwen";
  readonly model: string;
  createTask(imageDataUrl: string, prompt: string): Promise<string>;
  getTask(taskId: string): Promise<ProviderTaskResult>;
  downloadOutput(outputUrl: string): Promise<Buffer>;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerFailure(
  kind: ProviderFailureKind = "UNKNOWN",
  providerCode: string | null = null,
  httpStatus: number | null = null,
  code = providerErrorCode(kind),
  message = "AI 图像服务请求失败",
): ProviderError {
  return new ProviderError({ provider: "qwen", providerCode, httpStatus, kind }, code, message);
}

export class QwenImageProvider implements AiGenerationProvider {
  public readonly name = "qwen" as const;

  public constructor(
    private readonly config: QwenImageConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public get configured(): boolean {
    return this.config.enabled;
  }

  public get model(): string {
    return this.config.enabled ? this.config.model : "qwen-image-3.0";
  }

  public async createTask(imageDataUrl: string, prompt: string): Promise<string> {
    const config = this.requireConfig();
    const body = await this.request(
      `${config.baseUrl}/api/v1/services/aigc/image-generation/generation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "x-dashscope-async": "enable",
        },
        body: JSON.stringify({
          model: config.model,
          input: {
            messages: [{ role: "user", content: [{ image: imageDataUrl }, { text: prompt }] }],
          },
          parameters: {
            prompt_extend: true,
            prompt_extend_mode: "direct",
            enable_thinking: true,
            n: 1,
            watermark: false,
          },
        }),
      },
    );
    const taskId = string(object(body.output)?.task_id);
    if (!taskId || taskId.length > 128) throw providerFailure();
    return taskId;
  }

  public async getTask(taskId: string): Promise<ProviderTaskResult> {
    const config = this.requireConfig();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) {
      throw providerFailure("UNKNOWN", null, null, "AI_PROVIDER_TASK_INVALID", "AI 服务任务标识无效");
    }
    const body = await this.request(
      `${config.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET", headers: { authorization: `Bearer ${config.apiKey}` } },
    );
    const output = object(body.output);
    const status = string(output?.task_status);
    if (status === "PENDING" || status === "RUNNING") return { status: "pending" };
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      return { status: "failed" };
    }
    if (status !== "SUCCEEDED") throw providerFailure();
    const choices = Array.isArray(output?.choices) ? output.choices : [];
    const firstChoice = object(choices[0]);
    const message = object(firstChoice?.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const outputUrl = string(object(content[0])?.image);
    if (!outputUrl) throw providerFailure();
    return { status: "succeeded", outputUrl };
  }

  public async downloadOutput(outputUrl: string): Promise<Buffer> {
    const config = this.requireConfig();
    let parsed: URL;
    try {
      parsed = new URL(outputUrl);
    } catch {
      throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务返回了无效图片地址");
    }
    if (!isTrustedOutputUrl(parsed)) {
      throw providerFailure("INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务返回了不受信任的图片地址");
    }
    const response = await this.fetchWithTimeout(parsed.href, { method: "GET", redirect: "error" });
    if (response.url) {
      try {
        if (!isTrustedOutputUrl(new URL(response.url))) {
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
    if (size === 0) throw providerFailure("INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片为空");
    return Buffer.concat(chunks);
  }

  private requireConfig(): Extract<QwenImageConfig, { readonly enabled: true }> {
    if (!this.config.enabled) {
      throw new AppError(503, "AI_PROVIDER_NOT_CONFIGURED", "AI 图像服务尚未完成配置");
    }
    return this.config;
  }

  private async request(url: string, init: RequestInit): Promise<JsonObject> {
    const response = await this.fetchWithTimeout(url, init);
    let body: JsonObject | null = null;
    try {
      body = object(await response.json());
    } catch {
      // 非 JSON 响应统一映射为稳定的上游错误
    }
    if (!response.ok || !body) {
      if (response.status === 403 && isAllocationQuotaError(body)) {
        throw providerFailure(
          "QUOTA_EXHAUSTED",
          providerCode(body),
          response.status,
          "AI_SERVICE_UNAVAILABLE",
          "AI 生成服务暂时不可用",
        );
      }
      if (response.status === 429) {
        throw providerFailure("RATE_LIMITED", providerCode(body), response.status, "AI_PROVIDER_RATE_LIMITED", "AI 图像服务请求繁忙");
      }
      if (response.status === 408 || response.status === 504) {
        throw providerFailure("TIMEOUT", providerCode(body), response.status, "AI_PROVIDER_TIMEOUT", "AI 图像服务请求超时");
      }
      if (response.status === 401 || response.status === 403) {
        throw providerFailure("UNAVAILABLE", providerCode(body), response.status, "AI_SERVICE_UNAVAILABLE", "AI 生成服务暂时不可用");
      }
      if (response.status >= 500) {
        throw providerFailure("UNAVAILABLE", providerCode(body), response.status, "AI_PROVIDER_UNAVAILABLE", "AI 图像服务暂时不可用");
      }
      throw providerFailure("UNKNOWN", providerCode(body), response.status);
    }
    return body;
  }

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

function isTrustedOutputUrl(value: URL): boolean {
  const hostname = value.hostname.toLowerCase();
  return value.protocol === "https:"
    && !value.username
    && !value.password
    && !value.port
    && hostname.endsWith(".aliyuncs.com")
    && hostname.length > ".aliyuncs.com".length;
}

function isAllocationQuotaError(body: JsonObject | null): boolean {
  return providerCode(body) === "AllocationQuota.FreeTierOnly";
}

function providerCode(body: JsonObject | null): string | null {
  const nestedError = object(body?.error);
  const code = body?.code ?? body?.error_code ?? nestedError?.code;
  return typeof code === "string" && code.trim() ? code.trim().slice(0, 160) : null;
}

function providerErrorCode(kind: ProviderFailureKind): string {
  if (kind === "TIMEOUT") return "AI_PROVIDER_TIMEOUT";
  if (kind === "UNAVAILABLE") return "AI_PROVIDER_UNAVAILABLE";
  if (kind === "INVALID_OUTPUT") return "AI_PROVIDER_OUTPUT_INVALID";
  if (kind === "RATE_LIMITED") return "AI_PROVIDER_RATE_LIMITED";
  return "AI_PROVIDER_ERROR";
}

function providerErrorStatus(kind: ProviderFailureKind): number {
  if (kind === "TIMEOUT") return 504;
  if (kind === "UNAVAILABLE" || kind === "QUOTA_EXHAUSTED" || kind === "RATE_LIMITED") return 503;
  return 502;
}
