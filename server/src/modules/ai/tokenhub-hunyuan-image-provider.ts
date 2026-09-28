import {
  TOKENHUB_HUNYUAN_IMAGE_MODEL,
  type TokenhubHunyuanImageConfig,
} from "../../config/env";
import { AppError } from "../../shared/app-error";
import {
  detectOutputFormat,
  isSupportedOutputFormat,
  ProviderError,
  providerFailure,
  type AiGenerationProvider,
  type ProviderTaskInput,
  type ProviderTaskSubmission,
} from "./provider";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function codeFromBody(body: JsonObject | null): string | null {
  const error = object(body?.error);
  const value = string(error?.code) ?? string(body?.code) ?? string(error?.type);
  return value?.slice(0, 80) ?? null;
}

function outputUrlFromBody(body: JsonObject): string | null {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = object(choices[0]);
  const delta = object(choice?.delta);
  const image = object(delta?.image);
  return string(image?.url);
}

/**
 * 产物下载地址是否被信任。
 *
 * 这里曾经写死 `aigc-output-image-file-*.cos.ap-guangzhou.myqcloud.com` 这条正则，
 * 于是上游换个桶名或换个地域就是 100% 必现的失败：调用早已成功（httpStatus 200、
 * 图已经躺在对象存储里），是我们在下载前把地址拒了，9 秒的生成时间全部白等；
 * 对外还被折叠成 AI_RESULT_INVALID（retryable），界面引导用户重试，而重试永远无效。
 * 现在改成「域名后缀匹配 + 环境变量可配」，默认放行腾讯云 COS 与接口域名本身。
 */
function trustedOutputUrl(value: string, allowedHosts: readonly string[]): URL | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
      ? url
      : null;
  } catch {
    return null;
  }
}

/**
 * 输出地址被白名单拒绝时留痕。
 *
 * 存在的意义：`AI_RESULT_INVALID` 对外只有单一码，线上无法区分「上游换了 COS 桶/地域」
 * （表现是 100% 失败、用户重试永远无效）与「单次返回空图/坏图」（真·可重试）。
 * 只记主机名，不记完整 URL——临时地址带签名 token，整条落日志等于把凭据写进日志。
 */
function logOutputUrlRejected(reason: string, value: string): void {
  let host: string | null = null;
  try {
    host = new URL(value).hostname.toLowerCase() || null;
  } catch {
    host = null;
  }
  console.error(JSON.stringify({
    event: "ai_provider_output_rejected",
    provider: "hunyuan-tokenhub-v35",
    reason,
    outputHost: host,
  }));
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 120_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(timestamp - Date.now(), 120_000)) : undefined;
}

/** TokenHub Hy-Image-3.5-preview: 同步生成后立即下载临时输出图。 */
export class TokenhubHunyuanImageProvider implements AiGenerationProvider {
  public readonly name = "hunyuan-tokenhub-v35" as const;

  public constructor(
    private readonly config: TokenhubHunyuanImageConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public get configured(): boolean {
    return this.config.enabled;
  }

  public get model(): string {
    return this.config.enabled ? this.config.model : TOKENHUB_HUNYUAN_IMAGE_MODEL;
  }

  public async createTask(input: ProviderTaskInput): Promise<ProviderTaskSubmission> {
    const config = this.requireConfig();
    if (!input.referenceImageUrl) {
      throw new AppError(400, "AI_INPUT_FILE_UNAVAILABLE", "AI 输入图片不可用");
    }

    const response = await this.fetchWithTimeout(
      `${config.baseUrl}/v1/wand/hunyuan-image/v35-generation`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          session: input.clientBusinessId,
          size: "1024x1024",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: input.prompt },
              { type: "image_url", image_url: { url: input.referenceImageUrl } },
            ],
          }],
        }),
      },
    );

    let body: JsonObject | null = null;
    try {
      body = object(await response.json());
    } catch {
      if (response.ok) {
        throw providerFailure(this.name, "UNKNOWN", null, response.status, "AI_PROVIDER_TASK_FAILED", "TokenHub 返回格式无效");
      }
    }
    if (!response.ok) throw this.responseFailure(response, body);
    if (!body) {
      throw providerFailure(this.name, "UNKNOWN", null, response.status, "AI_PROVIDER_TASK_FAILED", "TokenHub 返回格式无效");
    }

    const outputUrl = outputUrlFromBody(body);
    if (!outputUrl) {
      const code = codeFromBody(body);
      if (code?.toLowerCase() === "content_filter") {
        throw providerFailure(this.name, "UNKNOWN", code, response.status, "CONTENT_REJECTED", "图片内容不符合生成要求");
      }
      throw providerFailure(this.name, "UNKNOWN", code, response.status, "AI_PROVIDER_TASK_FAILED", "TokenHub 未返回生成图片");
    }
    if (!trustedOutputUrl(outputUrl, config.outputHosts)) {
      logOutputUrlRejected("submit_untrusted_output_url", outputUrl);
      throw providerFailure(this.name, "INVALID_OUTPUT", codeFromBody(body), response.status, "AI_PROVIDER_OUTPUT_INVALID", "TokenHub 返回了不受信任的图片地址");
    }

    const requestId = string(body.request_id) ?? string(body.id) ?? input.clientBusinessId;
    const usage = object(body.tokenhub_usage);
    console.log(JSON.stringify({
      event: "ai_provider_output_declared",
      provider: this.name,
      model: config.model,
      requestId,
      usageTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : null,
    }));
    return { requestId, outputUrl };
  }

  public async downloadOutput(outputUrl: string): Promise<Buffer> {
    const config = this.requireConfig();
    const parsed = trustedOutputUrl(outputUrl, config.outputHosts);
    if (!parsed) {
      logOutputUrlRejected("download_untrusted_output_url", outputUrl);
      throw providerFailure(this.name, "INVALID_OUTPUT", null, null, "AI_PROVIDER_OUTPUT_INVALID", "TokenHub 输出图片地址不受信任");
    }

    const response = await this.fetchWithTimeout(parsed.href, { method: "GET", redirect: "error" });
    if (response.url && !trustedOutputUrl(response.url, config.outputHosts)) {
      logOutputUrlRejected("download_redirect_untrusted_output_url", response.url);
      throw providerFailure(this.name, "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "TokenHub 输出图片地址不受信任");
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw providerFailure(this.name, "RATE_LIMITED", null, response.status, "AI_PROVIDER_RATE_LIMITED", "TokenHub 输出读取繁忙");
      }
      if (response.status >= 500) {
        throw providerFailure(this.name, "UNAVAILABLE", null, response.status, "AI_PROVIDER_UNAVAILABLE", "TokenHub 输出暂时不可用");
      }
      throw providerFailure(this.name, "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "TokenHub 输出图片不可用");
    }

    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > config.maximumOutputBytes) {
      throw providerFailure(this.name, "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_TOO_LARGE", "TokenHub 输出图片超过大小限制");
    }
    if (!response.body) {
      throw providerFailure(this.name, "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "TokenHub 输出图片为空");
    }

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > config.maximumOutputBytes) {
          throw providerFailure(this.name, "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_TOO_LARGE", "TokenHub 输出图片超过大小限制");
        }
        chunks.push(buffer);
      }
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw providerFailure(this.name, "UNAVAILABLE", null, response.status, "AI_PROVIDER_UNAVAILABLE", "TokenHub 输出下载暂时不可用");
    }

    const output = Buffer.concat(chunks);
    if (output.length === 0 || !isSupportedOutputFormat(detectOutputFormat(output))) {
      throw providerFailure(this.name, "INVALID_OUTPUT", null, response.status, "AI_PROVIDER_OUTPUT_INVALID", "TokenHub 输出图片格式无效");
    }
    return output;
  }

  private responseFailure(response: Response, body: JsonObject | null) {
    const code = codeFromBody(body);
    const retryAfterMs = retryAfter(response.headers.get("retry-after"));
    if (response.status === 401 || response.status === 403) {
      return providerFailure(this.name, "UNAVAILABLE", code, response.status, "AI_SERVICE_UNAVAILABLE", "TokenHub 鉴权失败");
    }
    if (response.status === 422) {
      return providerFailure(this.name, "UNKNOWN", code, response.status, "CONTENT_REJECTED", "图片内容不符合生成要求");
    }
    if (response.status === 429) {
      return providerFailure(this.name, "RATE_LIMITED", code, response.status, "AI_PROVIDER_RATE_LIMITED", "TokenHub 请求繁忙", retryAfterMs);
    }
    if (response.status === 408 || response.status === 504) {
      return providerFailure(this.name, "TIMEOUT", code, response.status, "AI_PROVIDER_TIMEOUT", "TokenHub 请求超时", retryAfterMs);
    }
    if (response.status >= 500) {
      return providerFailure(this.name, "UNAVAILABLE", code, response.status, "AI_PROVIDER_UNAVAILABLE", "TokenHub 服务暂时不可用", retryAfterMs);
    }
    return providerFailure(this.name, "UNKNOWN", code, response.status, "AI_PROVIDER_TASK_FAILED", "TokenHub 请求失败");
  }

  private requireConfig(): Extract<TokenhubHunyuanImageConfig, { readonly enabled: true }> {
    if (!this.config.enabled) {
      throw new AppError(503, "AI_PROVIDER_NOT_CONFIGURED", "TokenHub 混元图像服务尚未完成配置");
    }
    return this.config;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImplementation(url, {
        ...init,
        signal: AbortSignal.timeout(this.requireConfig().timeoutMs),
      });
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw providerFailure(this.name, "TIMEOUT", null, null, "AI_PROVIDER_TIMEOUT", "TokenHub 请求超时");
      }
      throw providerFailure(this.name, "UNAVAILABLE", null, null, "AI_PROVIDER_UNAVAILABLE", "TokenHub 服务暂时不可用");
    }
  }
}
