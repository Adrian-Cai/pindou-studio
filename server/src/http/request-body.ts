import type { IncomingMessage } from "node:http";
import busboy from "busboy";
import { AppError, invalidArgument } from "../shared/app-error";

const MAX_JSON_BYTES = 64 * 1_024;
const MAX_XML_BYTES = 64 * 1_024;

export async function readJsonObject(
  request: IncomingMessage,
  maximumBytes = MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  return (await readRawJsonObject(request, maximumBytes)).value;
}

export interface RawJsonObject {
  readonly rawBody: string;
  readonly value: Record<string, unknown>;
}

export async function readRawJsonObject(
  request: IncomingMessage,
  maximumBytes = MAX_JSON_BYTES,
): Promise<RawJsonObject> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(rawBody) as unknown;
  } catch {
    throw invalidArgument("JSON 请求体格式不正确");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument("请求体必须是 JSON 对象");
  }
  return { rawBody, value: value as Record<string, unknown> };
}

/**
 * 读取原始请求体（不限 Content-Type）。
 *
 * 虚拟支付发货推送可能以 XML 或 JSON 送达，无法像普通接口那样先校验 media type，
 * 因此这里只做读取与大小限制，格式判定交给 parseDeliveryNotification。
 */
export async function readRawBody(
  request: IncomingMessage,
  maximumBytes = MAX_XML_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function stripCdata(value: string): string {
  const matched = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value.trim());
  return matched?.[1] ?? value;
}

/**
 * 极简 XML 单值提取：按标签名取首个节点的文本内容。
 *
 * 只覆盖发货推送这种扁平结构，**不是通用 XML 解析器**。不引第三方依赖是因为
 * 这里需要的只是十来个已知字段的取值，引入完整 XML 栈会显著放大攻击面而收益为零。
 */
export function xmlValue(rawBody: string, tag: string): string | null {
  const matched = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(rawBody);
  return matched ? stripCdata(decodeXmlEntities(matched[1] ?? "")).trim() : null;
}

export interface UploadedFile {
  readonly buffer: Buffer;
  readonly declaredContentType: string;
  readonly filename: string;
  readonly fields: Readonly<Record<string, string>>;
}

export function readSingleUploadedFile(
  request: IncomingMessage,
  fieldName: string,
  maximumBytes: number,
  allowedFields: readonly string[] = [],
  label = "文件",
): Promise<UploadedFile> {
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return Promise.reject(
      new AppError(415, "UNSUPPORTED_MEDIA_TYPE", `${label}上传必须使用 multipart/form-data`),
    );
  }

  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({
        headers: request.headers,
        limits: {
          fileSize: maximumBytes,
          files: 1,
          fields: allowedFields.length,
          fieldSize: 320,
          parts: 2 + allowedFields.length,
        },
      });
    } catch {
      reject(invalidArgument(`${label}上传请求格式不正确`));
      return;
    }

    let settled = false;
    let uploaded: UploadedFile | null = null;
    let rejectedFile = false;
    let rejectedField = false;
    const fields: Record<string, string> = {};
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    parser.on("file", (name, stream, info) => {
      if (name !== fieldName) {
        rejectedFile = true;
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", () => fail(invalidArgument(`${label}读取失败`)));
      stream.on("close", () => {
        if (stream.truncated) {
          fail(new AppError(413, "PAYLOAD_TOO_LARGE", `${label}超过大小限制`));
          return;
        }
        uploaded = {
          buffer: Buffer.concat(chunks),
          declaredContentType: info.mimeType.toLowerCase(),
          filename: info.filename,
          fields,
        };
      });
    });
    parser.on("field", (name, value) => {
      if (!allowedFields.includes(name) || name in fields) {
        rejectedField = true;
        return;
      }
      fields[name] = value;
    });
    parser.on("filesLimit", () => fail(invalidArgument(`每次只能上传一个${label}`)));
    parser.on("partsLimit", () => fail(invalidArgument(`${label}上传包含过多表单字段`)));
    parser.on("error", () => fail(invalidArgument(`${label}上传请求格式不正确`)));
    parser.on("close", () => {
      if (settled) return;
      if (rejectedField) {
        fail(invalidArgument(`${label}上传包含不支持的表单字段`));
        return;
      }
      if (rejectedFile || !uploaded || uploaded.buffer.length === 0) {
        fail(invalidArgument(`缺少${label}字段 ${fieldName}`));
        return;
      }
      settled = true;
      resolve(uploaded);
    });
    request.on("aborted", () => fail(invalidArgument(`${label}上传已中断`)));
    request.pipe(parser);
  });
}
