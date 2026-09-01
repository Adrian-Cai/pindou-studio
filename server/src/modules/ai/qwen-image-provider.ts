import type { QwenImageConfig } from "../../config/env";
import { AppError } from "../../shared/app-error";

export type ProviderTaskResult =
  | { readonly status: "pending" }
  | { readonly status: "succeeded"; readonly outputUrl: string }
  | { readonly status: "failed"; readonly errorCode: string };

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

function providerErrorCode(body: JsonObject | null): string {
  const output = object(body?.output);
  const raw = string(output?.code) ?? string(body?.code) ?? "UNKNOWN";
  return raw.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 60) || "UNKNOWN";
}

function providerFailure(body: JsonObject | null, status: number): AppError {
  return new AppError(502, "AI_PROVIDER_ERROR", "AI 图像服务请求失败", {
    providerCode: providerErrorCode(body),
    providerStatus: status,
  });
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
    if (!taskId || taskId.length > 128) throw providerFailure(body, 200);
    return taskId;
  }

  public async getTask(taskId: string): Promise<ProviderTaskResult> {
    const config = this.requireConfig();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) {
      throw new AppError(500, "AI_PROVIDER_TASK_INVALID", "AI 服务任务标识无效");
    }
    const body = await this.request(
      `${config.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET", headers: { authorization: `Bearer ${config.apiKey}` } },
    );
    const output = object(body.output);
    const status = string(output?.task_status);
    if (status === "PENDING" || status === "RUNNING") return { status: "pending" };
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      return { status: "failed", errorCode: providerErrorCode(body) };
    }
    if (status !== "SUCCEEDED") throw providerFailure(body, 200);
    const choices = Array.isArray(output?.choices) ? output.choices : [];
    const firstChoice = object(choices[0]);
    const message = object(firstChoice?.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const outputUrl = string(object(content[0])?.image);
    if (!outputUrl) throw providerFailure(body, 200);
    return { status: "succeeded", outputUrl };
  }

  public async downloadOutput(outputUrl: string): Promise<Buffer> {
    const config = this.requireConfig();
    let parsed: URL;
    try {
      parsed = new URL(outputUrl);
    } catch {
      throw new AppError(502, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务返回了无效图片地址");
    }
    if (parsed.protocol !== "https:" || !parsed.hostname.toLowerCase().endsWith(".aliyuncs.com")) {
      throw new AppError(502, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务返回了不受信任的图片地址");
    }
    const response = await this.fetchWithTimeout(parsed.href, { method: "GET" });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "image/png") {
      throw new AppError(502, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片不可用");
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > config.maximumOutputBytes) {
      throw new AppError(502, "AI_PROVIDER_OUTPUT_TOO_LARGE", "AI 服务输出图片超过大小限制");
    }
    if (!response.body) throw new AppError(502, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片为空");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > config.maximumOutputBytes) {
        throw new AppError(502, "AI_PROVIDER_OUTPUT_TOO_LARGE", "AI 服务输出图片超过大小限制");
      }
      chunks.push(buffer);
    }
    if (size === 0) throw new AppError(502, "AI_PROVIDER_OUTPUT_INVALID", "AI 服务输出图片为空");
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
      // 非 JSON 响应统一映射为稳定的上游错误。
    }
    if (!response.ok || !body) throw providerFailure(body, response.status);
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
      if ((error as Error).name === "TimeoutError") {
        throw new AppError(504, "AI_PROVIDER_TIMEOUT", "AI 图像服务请求超时");
      }
      throw new AppError(502, "AI_PROVIDER_UNAVAILABLE", "AI 图像服务暂时不可用");
    }
  }
}
