import { AppError } from "../../shared/app-error";
import { LEGAL_DOCUMENT_CONTENT } from "./legal-document-content";

export type LegalDocumentKey = "paid-service" | "user-agreement" | "privacy-policy" | "personal-information" | "third-party-sharing";

export interface LegalDocument {
  readonly key: LegalDocumentKey;
  readonly title: string;
  readonly version: string;
  readonly effectiveAt: string;
  readonly contentType: "rich-text";
  readonly content: string;
}

const DOCUMENTS: Readonly<Record<LegalDocumentKey, LegalDocument>> = {
  "paid-service": {
    key: "paid-service",
    title: "小露拼豆付费服务协议",
    version: "2026-09-11",
    effectiveAt: "2026-09-11T00:00:00+08:00",
    contentType: "rich-text",
    content: LEGAL_DOCUMENT_CONTENT["paid-service"],
  },
  "user-agreement": {
    key: "user-agreement",
    title: "小露拼豆用户协议",
    version: "2026-09-07",
    effectiveAt: "2026-09-07T00:00:00+08:00",
    contentType: "rich-text",
    content: LEGAL_DOCUMENT_CONTENT["user-agreement"],
  },
  "privacy-policy": {
    key: "privacy-policy",
    title: "小露拼豆隐私政策",
    version: "2026-09-07",
    effectiveAt: "2026-09-07T00:00:00+08:00",
    contentType: "rich-text",
    content: LEGAL_DOCUMENT_CONTENT["privacy-policy"],
  },
  "personal-information": {
    key: "personal-information",
    title: "个人信息收集清单",
    version: "2026-09-07",
    effectiveAt: "2026-09-07T00:00:00+08:00",
    contentType: "rich-text",
    content: LEGAL_DOCUMENT_CONTENT["personal-information"],
  },
  "third-party-sharing": {
    key: "third-party-sharing",
    title: "第三方信息共享清单",
    version: "2026-09-07",
    effectiveAt: "2026-09-07T00:00:00+08:00",
    contentType: "rich-text",
    content: LEGAL_DOCUMENT_CONTENT["third-party-sharing"],
  },
};

export function getLegalDocument(key: string): LegalDocument {
  if (!Object.prototype.hasOwnProperty.call(DOCUMENTS, key)) {
    throw new AppError(404, "DOCUMENT_NOT_FOUND", "法律文档不存在");
  }
  return DOCUMENTS[key as LegalDocumentKey];
}
