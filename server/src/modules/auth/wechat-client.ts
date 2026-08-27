import type { ServerConfig } from "../../config/env";
import { AppError } from "../../shared/app-error";

const CODE_TO_SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session";

interface WeChatResponse {
  readonly openid?: unknown;
  readonly session_key?: unknown;
  readonly errcode?: unknown;
}

export interface WeChatSession {
  readonly openid: string;
}

export interface WeChatLoginClient {
  exchangeCode(code: string): Promise<WeChatSession>;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export class OfficialWeChatLoginClient implements WeChatLoginClient {
  public constructor(
    private readonly config: ServerConfig["wechat"],
    private readonly fetcher: Fetcher = fetch,
  ) {}

  public async exchangeCode(code: string): Promise<WeChatSession> {
    const query = new URLSearchParams({
      appid: this.config.appId,
      secret: this.config.appSecret,
      js_code: code,
      grant_type: "authorization_code",
    });

    let response: Response;
    try {
      response = await this.fetcher(`${CODE_TO_SESSION_URL}?${query.toString()}`, {
        method: "GET",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { accept: "application/json" },
      });
    } catch {
      throw new AppError(502, "WECHAT_SERVICE_UNAVAILABLE", "微信登录服务暂时不可用");
    }

    if (!response.ok) {
      throw new AppError(502, "WECHAT_SERVICE_UNAVAILABLE", "微信登录服务暂时不可用");
    }

    let payload: WeChatResponse;
    try {
      payload = (await response.json()) as WeChatResponse;
    } catch {
      throw new AppError(502, "WECHAT_INVALID_RESPONSE", "微信登录服务返回异常");
    }

    if (typeof payload.errcode === "number" && payload.errcode !== 0) {
      if (payload.errcode === 40029 || payload.errcode === 40163) {
        throw new AppError(400, "INVALID_WX_CODE", "微信登录凭证无效或已使用");
      }
      if (payload.errcode === 45011) {
        throw new AppError(429, "RATE_LIMITED", "登录请求过于频繁，请稍后重试");
      }
      throw new AppError(502, "WECHAT_SERVICE_ERROR", "微信登录服务处理失败");
    }

    if (typeof payload.openid !== "string" || typeof payload.session_key !== "string") {
      throw new AppError(502, "WECHAT_INVALID_RESPONSE", "微信登录服务返回异常");
    }
    return { openid: payload.openid };
  }
}
