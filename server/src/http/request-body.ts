import type { IncomingMessage } from "node:http";
import busboy from "busboy";
import { AppError, invalidArgument } from "../shared/app-error";

const MAX_JSON_BYTES = 64 * 1_024;

export async function readJsonObject(
  request: IncomingMessage,
  maximumBytes = MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
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

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw invalidArgument("JSON 请求体格式不正确");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument("请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
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
