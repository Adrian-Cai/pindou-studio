import { AppError } from "../../shared/app-error";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type SharePage = "home" | "projects" | "profile";

export interface ShareLinkInfo {
  readonly appId: string;
  readonly path: string;
  readonly query: string;
  readonly createTime: number;
  readonly expireTime: number;
  readonly envVersion: string;
}

export interface WeChatUrlLinkClient {
  generate(page: SharePage): Promise<{ readonly urlLink: string }>;
  query(urlLink: string): Promise<{ readonly urlLinkInfo: ShareLinkInfo }>;
}

interface WeChatResponse {
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly url_link?: unknown;
  readonly url_link_info?: unknown;
}

const ACCESS_TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const URL_LINK_API = "https://api.weixin.qq.com/wxa";
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001, 42007, 42009]);
const SHARE_PATHS: Record<SharePage, string> = {
  home: "/pages/home/index",
  projects: "/pages/projects/index",
  profile: "/pages/profile/index",
};

export class OfficialWeChatUrlLinkClient implements WeChatUrlLinkClient {
  private cachedToken: { readonly value: string; readonly expiresAt: number } | null = null;
  private tokenTask: Promise<string> | null = null;

  public constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly timeoutMs: number,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  public async generate(page: SharePage): Promise<{ readonly urlLink: string }> {
    const payload = await this.withToken("generate_urllink", {
      path: SHARE_PATHS[page],
      expire_type: 1,
      expire_interval: 30,
      env_version: "release",
    });
    const urlLink = typeof payload.url_link === "string" ? payload.url_link : "";
    if (!urlLink) throw new AppError(502, "WECHAT_URL_LINK_INVALID_RESPONSE", "微信分享链接服务返回异常");
    return { urlLink };
  }

  public async query(urlLink: string): Promise<{ readonly urlLinkInfo: ShareLinkInfo }> {
    const payload = await this.withToken("query_urllink", { url_link: urlLink, query_type: 0 });
    const raw = isRecord(payload.url_link_info) ? payload.url_link_info : null;
    if (!raw) throw new AppError(502, "WECHAT_URL_LINK_INVALID_RESPONSE", "微信分享链接服务返回异常");
    const appId = stringValue(raw.appid);
    const createTime = numeric(raw.create_time);
    const expireTime = numeric(raw.expire_time);
    if (!appId || createTime === null || expireTime === null) {
      throw new AppError(502, "WECHAT_URL_LINK_INVALID_RESPONSE", "微信分享链接服务返回异常");
    }
    return {
      urlLinkInfo: {
        appId,
        path: stringValue(raw.path),
        query: stringValue(raw.query),
        createTime,
        expireTime,
        envVersion: stringValue(raw.env_version),
      },
    };
  }

  private async withToken(path: string, body: Record<string, unknown>): Promise<WeChatResponse> {
    let token = await this.accessToken();
    let payload = await this.post(`${URL_LINK_API}/${path}`, token, body);
    if (TOKEN_ERROR_CODES.has(numeric(payload.errcode) ?? -1)) {
      this.cachedToken = null;
      token = await this.accessToken();
      payload = await this.post(`${URL_LINK_API}/${path}`, token, body);
    }
    if ((numeric(payload.errcode) ?? 0) !== 0) {
      throw new AppError(502, "WECHAT_URL_LINK_FAILED", "微信分享链接服务暂时不可用");
    }
    return payload;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) return this.cachedToken.value;
    if (this.tokenTask) return this.tokenTask;
    this.tokenTask = this.requestJson(
      `${ACCESS_TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(this.appId)}&secret=${encodeURIComponent(this.appSecret)}`,
      { method: "GET", headers: { accept: "application/json" } },
    ).then((payload) => {
      const value = typeof payload.access_token === "string" ? payload.access_token : "";
      const expiresIn = numeric(payload.expires_in) ?? 0;
      if (!value || expiresIn <= 0 || (numeric(payload.errcode) ?? 0) !== 0) {
        throw new AppError(502, "WECHAT_URL_LINK_INVALID_RESPONSE", "微信访问令牌返回异常");
      }
      this.cachedToken = { value, expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1_000 };
      return value;
    }).finally(() => { this.tokenTask = null; });
    return this.tokenTask;
  }

  private async post(path: string, token: string, body: Record<string, unknown>): Promise<WeChatResponse> {
    return this.requestJson(`${path}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async requestJson(url: string, init: RequestInit): Promise<WeChatResponse> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new AppError(503, "WECHAT_URL_LINK_UNAVAILABLE", "微信分享链接服务暂时不可用");
    }
    if (!response.ok) throw new AppError(503, "WECHAT_URL_LINK_UNAVAILABLE", "微信分享链接服务暂时不可用");
    try {
      return (await response.json()) as WeChatResponse;
    } catch {
      throw new AppError(502, "WECHAT_URL_LINK_INVALID_RESPONSE", "微信分享链接服务返回异常");
    }
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
