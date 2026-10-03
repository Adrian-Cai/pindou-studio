import { AppError } from "../../shared/app-error";
import {
  providerFailure,
  ProviderError,
  type AiGenerationProvider,
  type ProviderTaskInput,
  type ProviderTaskStatus,
  type ProviderTaskSubmission,
} from "./provider";

type JsonObject = Record<string, unknown>;
type ToapisImageConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model: "gpt-image-2.5-flare" | "gpt-image-2.5-sunburst";
      readonly size: string;
      readonly resolution: "1K" | "2K" | "4K";
      readonly quality: "high";
      readonly timeoutMs: number;
      readonly pollIntervalMs: number;
      readonly maximumOutputBytes: number;
      readonly outputHosts: readonly string[];
    };

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** ToAPIs GPT-Image 普通接口：提交异步任务、查询任务状态、下载完成图片。 */
export class ToapisImageProvider implements AiGenerationProvider {
  public readonly name = "toapis" as const;

  public constructor(
    private readonly config: ToapisImageConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public get configured(): boolean {
    return this.config.enabled;
  }

  public get model(): string {
    return this.config.enabled ? this.config.model : "gpt-image-2.5-sunburst";
  }

  public get pollIntervalMs(): number {
    return this.config.enabled ? this.config.pollIntervalMs : 7_000;
  }

  public async createTask(input: ProviderTaskInput): Promise<ProviderTaskSubmission> {
    const config = this.requireConfig();
    const body: JsonObject = {
      model: config.model,
      prompt: input.prompt,
      quality: config.quality,
      size: config.size,
      resolution: config.resolution,
      n: 1,
      client_business_id: input.clientBusinessId,
    };
    if (input.referenceImageUrl) body.reference_images = [this.validateReferenceImageUrl(input.referenceImageUrl)];
    const response = await this.request("POST", "/v1/images/generations", body);
    const requestId = taskId(response.body);
    if (!requestId || requestId.length > 128) {
      throw providerFailure("toapis", "UNKNOWN", codeFromBody(response.body), response.status, undefined, "ToAPIs 未返回有效任务 ID");
    }
    const outputUrl = outputUrlFromBody(response.body);
    console.log(JSON.stringify({
      event: "ai_provider_task_submitted",
      provider: this.name,
      model: config.model,
      requestId,
      asynchronous: !outputUrl,
    }));
    return { requestId, outputUrl };
  }

  public async getTask(requestId: string): Promise<ProviderTaskStatus> {
    const response = await this.request(
      "GET",
      `/v1/images/generations/${encodeURIComponent(requestId)}`,
    );
    const status = taskStatus(response.body);
    if (status === "failed") {
      const providerMessage = messageFromBody(response.body);
      throw providerFailure(
        "toapis",
        "UNKNOWN",
        codeFromBody(response.body),
        response.status,
        "AI_PROVIDER_TASK_FAILED",
        `ToAPIs 图片生成失败${providerMessage ? `: ${providerMessage}` : ""}`,
      );
    }
    if (!status) {
      throw providerFailure("toapis", "UNKNOWN", codeFromBody(response.body), response.status, undefined, "ToAPIs 返回了未知任务状态");
    }
    const outputUrl = outputUrlFromBody(response.body);
    if (status === "completed" && !outputUrl) {
      throw providerFailure("toapis", "INVALID_OUTPUT", codeFromBody(response.body), response.status, "AI_PROVIDER_OUTPUT_INVALID", "ToAPIs 已完成任务缺少图片地址");
    }
    return { status, outputUrl };
  }

  public async downloadOutput(outputUrl: string): Promise<Buffer> {
    const config = this.requireConfig();
    let parsed: URL;
    try {
      parsed = new URL(outputUrl);
    } catch {
      throw providerFailure("toapis", "INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "ToAPIs 返回了无效图片地址");
    }
    if (!isTrustedOutputUrl(parsed, config.outputHosts)) {
      throw providerFailure("toapis", "INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "ToAPIs 返回了不受信任的图片地址");
    }
    const response = await this.fetchWithTimeout(parsed.href, { method: "GET", redirect: "error" });
    if (response.url) {
      try {
        if (!isTrustedOutputUrl(new URL(response.url), config.outputHosts)) {
          throw providerFailure("toapis", "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "ToAPIs 输出图片地址不受信任");
        }
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw providerFailure("toapis", "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "ToAPIs 输出图片地址不受信任");
      }
    }
    if (!response.ok) throw responseFailure("toapis", response.status, response.headers);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > config.maximumOutputBytes) {
      throw providerFailure("toapis", "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_TOO_LARGE", "ToAPIs 输出图片超过大小限制");
    }
    if (!response.body) throw providerFailure("toapis", "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "ToAPIs 输出图片为空");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > config.maximumOutputBytes) {
        throw providerFailure("toapis", "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_TOO_LARGE", "ToAPIs 输出图片超过大小限制");
      }
      chunks.push(buffer);
    }
    if (size === 0) throw providerFailure("toapis", "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "ToAPIs 输出图片为空");
    return Buffer.concat(chunks);
  }

  private async request(method: "GET" | "POST", path: string, body?: JsonObject): Promise<{ readonly body: JsonObject; readonly status: number }> {
    const config = this.requireConfig();
    let response: Response;
    try {
      response = await this.fetchImplementation(`${config.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw providerFailure("toapis", "TIMEOUT", null, null, "AI_PROVIDER_TIMEOUT", "ToAPIs 请求超时");
      }
      throw providerFailure("toapis", "UNAVAILABLE", null, null, "AI_PROVIDER_UNAVAILABLE", "ToAPIs 服务暂时不可用");
    }
    const parsed = await readJson(response);
    if (!response.ok) throw responseFailure("toapis", response.status, response.headers, parsed);
    if (!parsed) throw providerFailure("toapis", "UNKNOWN", null, response.status, undefined, "ToAPIs 返回格式无效");
    return { body: parsed, status: response.status };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const config = this.requireConfig();
    try {
      return await this.fetchImplementation(url, {
        ...init,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw providerFailure("toapis", "TIMEOUT", null, null, "AI_PROVIDER_TIMEOUT", "ToAPIs 输出下载超时");
      }
      throw providerFailure("toapis", "UNAVAILABLE", null, null, "AI_PROVIDER_UNAVAILABLE", "ToAPIs 输出下载暂时不可用");
    }
  }

  private validateReferenceImageUrl(value: string): string {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) throw new Error("invalid");
      return parsed.href;
    } catch {
      throw new AppError(500, "AI_INPUT_FILE_UNAVAILABLE", "AI 输入图片地址不可公开访问");
    }
  }

  private requireConfig(): Extract<ToapisImageConfig, { readonly enabled: true }> {
    if (!this.config.enabled) throw new AppError(503, "AI_PROVIDER_NOT_CONFIGURED", "AI 图像服务尚未完成配置");
    return this.config;
  }
}

async function readJson(response: Response): Promise<JsonObject | null> {
  try {
    return object(await response.json());
  } catch {
    return null;
  }
}

function taskId(body: JsonObject): string | null {
  return string(body.id) ?? string(body.task_id) ?? string(body.request_id);
}

function resultObject(body: JsonObject): JsonObject | null {
  return object(body.result) ?? body;
}

function outputUrlFromBody(body: JsonObject): string | null {
  const result = resultObject(body);
  const data = Array.isArray(result?.data) ? result.data : Array.isArray(body.data) ? body.data : [];
  return string(object(data[0])?.url) ?? string(result?.url) ?? string(body.url);
}

function taskStatus(body: JsonObject): ProviderTaskStatus["status"] | null {
  const raw = string(body.status) ?? string(body.state);
  if (raw === "pending" || raw === "queued" || raw === "in_progress" || raw === "completed" || raw === "failed") return raw;
  return null;
}

function codeFromBody(body: JsonObject | null): string | null {
  return scalarCode(body?.code) ?? scalarCode(body?.error_code) ?? scalarCode(object(body?.error)?.code);
}

function messageFromBody(body: JsonObject | null): string | null {
  const error = object(body?.error);
  const value = string(error?.message) ?? string(body?.message);
  return value ? value.slice(0, 240) : null;
}

function scalarCode(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return string(value);
}

function responseFailure(
  provider: "toapis",
  status: number,
  headers: Headers,
  body: JsonObject | null = null,
): ProviderError {
  const retryAfterMs = retryAfter(headers.get("retry-after"));
  const code = codeFromBody(body);
  const detail = messageFromBody(body);
  const message = (fallback: string) => `${fallback}${detail ? `: ${detail}` : ""}`;
  if (status === 429) return providerFailure(provider, "RATE_LIMITED", code, status, "AI_PROVIDER_RATE_LIMITED", message("ToAPIs 请求繁忙"), retryAfterMs);
  if (status === 408 || status === 504) return providerFailure(provider, "TIMEOUT", code, status, "AI_PROVIDER_TIMEOUT", message("ToAPIs 请求超时"), retryAfterMs);
  if (status === 401 || status === 403) return providerFailure(provider, "UNAVAILABLE", code, status, "AI_SERVICE_UNAVAILABLE", message("ToAPIs 服务暂时不可用"));
  if (status >= 500) return providerFailure(provider, "UNAVAILABLE", code, status, "AI_PROVIDER_UNAVAILABLE", message("ToAPIs 服务暂时不可用"), retryAfterMs);
  return providerFailure(provider, "UNKNOWN", code, status, undefined, message("ToAPIs 请求失败"));
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 120_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.min(timestamp - Date.now(), 120_000));
}

function isTrustedOutputUrl(value: URL, allowedHosts: readonly string[]): boolean {
  const hostname = value.hostname.toLowerCase();
  return value.protocol === "https:"
    && !value.username
    && !value.password
    && !value.port
    && allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}
