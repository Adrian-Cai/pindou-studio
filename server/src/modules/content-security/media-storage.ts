import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, invalidArgument } from "../../shared/app-error";

export interface StoredSecurityMedia {
  readonly objectKey: string;
  readonly publicUrl: string;
  readonly contentType: "image/jpeg" | "image/png";
}

export interface ContentSecurityMediaStorage {
  save(buffer: Buffer, filename: string, declaredContentType: string): Promise<StoredSecurityMedia>;
  read(publicPath: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null>;
  remove(objectKey: string): Promise<void>;
}

const ROUTE_PREFIX = "/api/content-security/media/";
const FILE_PATTERN = /^security_[a-f0-9]{32}\.(jpg|png)$/u;

export class FileSystemContentSecurityMediaStorage implements ContentSecurityMediaStorage {
  public constructor(
    private readonly directory: string,
    private readonly publicBaseUrl: string,
  ) {
    if (!publicBaseUrl.trim()) throw invalidArgument("内容安全媒体公开地址未配置");
  }

  public async save(
    buffer: Buffer,
    filename: string,
    declaredContentType: string,
  ): Promise<StoredSecurityMedia> {
    const extension = extensionForImage(buffer, filename, declaredContentType);
    const storedName = `security_${randomUUID().replace(/-/g, "")}.${extension}`;
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(join(this.directory, storedName), buffer, { flag: "wx" });
    } catch {
      throw new AppError(500, "FILE_STORAGE_ERROR", "内容安全图片存储失败");
    }
    return {
      objectKey: `content-security/${storedName}`,
      publicUrl: `${this.publicBaseUrl.replace(/\/$/u, "")}/${storedName}`,
      contentType: extension === "jpg" ? "image/jpeg" : "image/png",
    };
  }

  public async read(
    publicPath: string,
  ): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null> {
    if (!publicPath.startsWith(ROUTE_PREFIX)) return null;
    const filename = publicPath.slice(ROUTE_PREFIX.length);
    const extension = filename.match(FILE_PATTERN)?.[1];
    if (!extension) return null;
    try {
      return {
        buffer: await readFile(join(this.directory, filename)),
        contentType: extension === "jpg" ? "image/jpeg" : "image/png",
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError(500, "FILE_STORAGE_ERROR", "内容安全图片读取失败");
    }
  }

  public async remove(objectKey: string): Promise<void> {
    const prefix = "content-security/";
    if (!objectKey.startsWith(prefix)) return;
    const filename = objectKey.slice(prefix.length);
    if (!FILE_PATTERN.test(filename)) return;
    try {
      await unlink(join(this.directory, filename));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 审核记录已经落库时，清理失败交给后续过期清理任务
      }
    }
  }
}

function extensionForImage(
  buffer: Buffer,
  filename: string,
  declaredContentType: string,
): "jpg" | "png" {
  const extension = filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")
    ? "jpg"
    : filename.toLowerCase().endsWith(".png") ? "png" : null;
  const actual = isPng(buffer) ? "png" : isJpeg(buffer) ? "jpg" : null;
  if (!actual || !extension || actual !== extension) {
    throw invalidArgument("内容安全图片仅支持真实格式匹配的 JPG 或 PNG 图片");
  }
  const declared = declaredContentType.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== `image/${actual === "jpg" ? "jpeg" : "png"}`) {
    throw invalidArgument("内容安全图片 MIME 类型与真实格式不匹配");
  }
  return actual;
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}
