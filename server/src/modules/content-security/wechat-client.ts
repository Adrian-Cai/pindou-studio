import { AppError } from "../../shared/app-error";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface WeChatResponse {
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly trace_id?: unknown;
  readonly result?: unknown;
}

export interface SecurityCheckResult {
  readonly safe: boolean;
  readonly suggest: "pass" | "review" | "risky";
  readonly label: number | null;
  readonly traceId: string | null;
}

export interface WeChatContentSecurityClient {
  checkText(input: { readonly openid: string; readonly content: string; readonly scene: number }): Promise<SecurityCheckResult>;
  checkImage(buffer: Buffer, filename: string, contentType: string): Promise<SecurityCheckResult>;
  submitMedia(input: { readonly openid: string; readonly mediaUrl: string; readonly scene: number }): Promise<{ readonly traceId: string }>;
}

const ACCESS_TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const MSG_CHECK_URL = "https://api.weixin.qq.com/wxa/msg_sec_check";
const IMG_CHECK_URL = "https://api.weixin.qq.com/wxa/img_sec_check";
const MEDIA_CHECK_URL = "https://api.weixin.qq.com/wxa/media_check_async";
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001, 42007, 42009]);

export class OfficialWeChatContentSecurityClient implements WeChatContentSecurityClient {
  private cachedToken: { readonly value: string; readonly expiresAt: number } | null = null;
  private tokenTask: Promise<string> | null = null;

  public constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly timeoutMs: number,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  public async checkText(input: { readonly openid: string; readonly content: string; readonly scene: number }): Promise<SecurityCheckResult> {
    const payload = await this.postJson(MSG_CHECK_URL, {
      openid: input.openid,
      scene: input.scene,
      version: 2,
      content: input.content,
    });
    return parseCheckResult(payload);
  }

  public async checkImage(buffer: Buffer, filename: string, contentType: string): Promise<SecurityCheckResult> {
    const call = async (token: string): Promise<WeChatResponse> => {
      const form = new FormData();
      form.append("media", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
      return this.requestJson(`${IMG_CHECK_URL}?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        body: form,
      }, "图片内容安全检测");
    };
    const payload = await this.withToken(call);
    return parseCheckResult(payload);
  }

  public async submitMedia(input: { readonly openid: string; readonly mediaUrl: string; readonly scene: number }): Promise<{ readonly traceId: string }> {
    const payload = await this.postJson(MEDIA_CHECK_URL, {
      openid: input.openid,
      scene: input.scene,
      version: 2,
      media_type: 2,
      media_url: input.mediaUrl,
    });
    const traceId = typeof payload.trace_id === "string" ? payload.trace_id : "";
    if (!traceId) throw new AppError(502, "WECHAT_CONTENT_SECURITY_INVALID_RESPONSE", "微信图片审核服务返回异常");
    return { traceId };
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<WeChatResponse> {
    return this.withToken((token) => this.requestJson(`${path}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }, "微信内容安全检测"));
  }

  private async withToken(call: (token: string) => Promise<WeChatResponse>): Promise<WeChatResponse> {
    let token = await this.accessToken();
    let payload = await call(token);
    if (isTokenError(payload)) {
      this.cachedToken = null;
      token = await this.accessToken();
      payload = await call(token);
    }
    const errcode = numeric(payload.errcode);
    if (errcode !== null && errcode !== 0) {
      if (errcode === 87014) return payload;
      throw new AppError(502, "WECHAT_CONTENT_SECURITY_ERROR", "微信内容安全服务处理失败");
    }
    return payload;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) return this.cachedToken.value;
    if (this.tokenTask) return this.tokenTask;
    this.tokenTask = this.requestJson(
      `${ACCESS_TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(this.appId)}&secret=${encodeURIComponent(this.appSecret)}`,
      { method: "GET", headers: { accept: "application/json" } },
      "微信访问令牌",
    ).then((payload) => {
      const value = typeof payload.access_token === "string" ? payload.access_token : "";
      const expiresIn = numeric(payload.expires_in) ?? 0;
      if (!value || expiresIn <= 0) throw new AppError(502, "WECHAT_CONTENT_SECURITY_INVALID_RESPONSE", "微信访问令牌返回异常");
      this.cachedToken = { value, expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1_000 };
      return value;
    }).finally(() => { this.tokenTask = null; });
    return this.tokenTask;
  }

  private async requestJson(url: string, init: RequestInit, label: string): Promise<WeChatResponse> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new AppError(503, "WECHAT_CONTENT_SECURITY_UNAVAILABLE", `${label}暂时不可用`);
    }
    if (!response.ok) throw new AppError(503, "WECHAT_CONTENT_SECURITY_UNAVAILABLE", `${label}暂时不可用`);
    try {
      return (await response.json()) as WeChatResponse;
    } catch {
      throw new AppError(502, "WECHAT_CONTENT_SECURITY_INVALID_RESPONSE", `${label}返回异常`);
    }
  }
}

function parseCheckResult(payload: WeChatResponse): SecurityCheckResult {
  const result = isRecord(payload.result) ? payload.result : {};
  const suggest = result.suggest === "risky" || result.suggest === "review" ? result.suggest : "pass";
  const resultLabel = numeric(result.label);
  return {
    safe: suggest === "pass" && (numeric(payload.errcode) ?? 0) === 0,
    suggest,
    label: resultLabel,
    traceId: typeof payload.trace_id === "string" ? payload.trace_id : null,
  };
}

function isTokenError(payload: WeChatResponse): boolean {
  const errcode = numeric(payload.errcode);
  return errcode !== null && TOKEN_ERROR_CODES.has(errcode);
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
