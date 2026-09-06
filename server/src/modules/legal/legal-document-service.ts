import { AppError } from "../../shared/app-error";

export type LegalDocumentKey = "privacy-policy" | "personal-information" | "third-party-sharing";

export interface LegalDocument {
  readonly key: LegalDocumentKey;
  readonly title: string;
  readonly version: string;
  readonly effectiveAt: string;
  readonly contentType: "rich-text";
  readonly content: string;
}

const DOCUMENTS: Readonly<Record<LegalDocumentKey, LegalDocument>> = {
  "privacy-policy": {
    key: "privacy-policy",
    title: "隐私政策",
    version: "2026-09-01",
    effectiveAt: "2026-09-01T00:00:00+08:00",
    contentType: "rich-text",
    content: "<p>拼豆工作室仅为提供作品制作、保存、下载和账号服务所必需处理个人信息，并按照适用法律保护你的信息安全。</p><p>你可以在隐私设置中管理作品保存方式、服务通知和个性化推荐偏好。</p>",
  },
  "personal-information": {
    key: "personal-information",
    title: "个人信息收集清单",
    version: "2026-09-01",
    effectiveAt: "2026-09-01T00:00:00+08:00",
    contentType: "rich-text",
    content: "<p>账号信息：微信登录标识、昵称和头像，用于创建和维护账号。</p><p>作品信息：作品图案、封面和下载记录，用于提供作品制作、保存和下载服务。</p><p>支付信息：订单和必要的支付交易流水，用于完成购买、退款及财务审计。</p>",
  },
  "third-party-sharing": {
    key: "third-party-sharing",
    title: "第三方信息共享清单",
    version: "2026-09-01",
    effectiveAt: "2026-09-01T00:00:00+08:00",
    contentType: "rich-text",
    content: "<p>微信：用于微信登录、支付和依法合规的内容安全审核服务。</p><p>模型服务商：仅在你使用 AI 生成能力时，按服务需要处理上传的输入图片。</p><p>我们不会出售个人信息，也不会将隐私偏好用于未说明的目的。</p>",
  },
};

export function getLegalDocument(key: string): LegalDocument {
  if (!Object.prototype.hasOwnProperty.call(DOCUMENTS, key)) {
    throw new AppError(404, "DOCUMENT_NOT_FOUND", "隐私文档不存在");
  }
  return DOCUMENTS[key as LegalDocumentKey];
}
