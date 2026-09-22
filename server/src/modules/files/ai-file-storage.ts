import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, invalidArgument } from "../../shared/app-error";
import { validateCoverImage, type ValidatedImage } from "./image-validation";

export type AiFileKind = "ai_input" | "ai_output";

export interface StoredAiFile {
  readonly objectKey: string;
  readonly publicUrl: string;
  readonly contentType: ValidatedImage["contentType"];
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface AiFileStorage {
  save(
    kind: AiFileKind,
    buffer: Buffer,
    filename: string,
    declaredContentType: string,
  ): Promise<StoredAiFile>;
  read(publicPath: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null>;
  readObject(objectKey: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null>;
  remove(objectKey: string): Promise<void>;
}

export interface AiFileStorageLimits {
  readonly maximumBytes: number;
  readonly maximumWidth: number;
  readonly maximumHeight: number;
  readonly maximumPixels: number;
}

const ROUTE_PREFIX = "/api/media/ai/";
const FILE_PATTERN = /^(ai_input|ai_output)_[a-f0-9]{32}\.(jpg|png|webp)$/u;

export class FileSystemAiFileStorage implements AiFileStorage {
  public constructor(
    private readonly directory: string,
    private readonly publicBaseUrl: string,
    private readonly limits: AiFileStorageLimits = {
      maximumBytes: 10 * 1_024 * 1_024,
      maximumWidth: 4_096,
      maximumHeight: 4_096,
      maximumPixels: 16 * 1_024 * 1_024,
    },
  ) {
    if (!publicBaseUrl.trim()) throw invalidArgument("AI 文件公开地址未配置");
  }

  public async save(
    kind: AiFileKind,
    buffer: Buffer,
    filename: string,
    declaredContentType: string,
  ): Promise<StoredAiFile> {
    if (buffer.length > this.limits.maximumBytes) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "AI 图片超过大小限制");
    }
    const image = validateCoverImage(buffer, filename, declaredContentType);
    if (
      image.width > this.limits.maximumWidth
      || image.height > this.limits.maximumHeight
      || image.width * image.height > this.limits.maximumPixels
    ) {
      throw new AppError(413, "AI_IMAGE_DIMENSIONS_TOO_LARGE", "AI 图片尺寸超过限制");
    }
    const storedName = `${kind}_${randomUUID().replace(/-/g, "")}.${image.extension}`;
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(join(this.directory, storedName), buffer, { flag: "wx" });
    } catch {
      throw new AppError(500, "FILE_STORAGE_ERROR", "AI 文件存储失败");
    }
    return {
      objectKey: `ai/${storedName}`,
      publicUrl: `${this.publicBaseUrl.replace(/\/$/u, "")}/${storedName}`,
      contentType: image.contentType,
      byteSize: buffer.length,
      width: image.width,
      height: image.height,
    };
  }

  public async read(publicPath: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null> {
    if (!publicPath.startsWith(ROUTE_PREFIX)) return null;
    return this.readFilename(publicPath.slice(ROUTE_PREFIX.length));
  }

  public async readObject(objectKey: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null> {
    if (!objectKey.startsWith("ai/")) return null;
    return this.readFilename(objectKey.slice(3));
  }

  public async remove(objectKey: string): Promise<void> {
    if (!objectKey.startsWith("ai/")) return;
    const filename = objectKey.slice(3);
    if (!FILE_PATTERN.test(filename)) return;
    try {
      await unlink(join(this.directory, filename));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 已提交的数据库元数据不因异步清理失败而回滚
      }
    }
  }

  private async readFilename(
    filename: string,
  ): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null> {
    const extension = filename.match(FILE_PATTERN)?.[2];
    if (!extension) return null;
    try {
      const buffer = await readFile(join(this.directory, filename));
      if (buffer.length > this.limits.maximumBytes) {
        throw new AppError(413, "PAYLOAD_TOO_LARGE", "AI 图片超过大小限制");
      }
      const contentType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
      const image = validateCoverImage(buffer, filename, contentType);
      if (
        image.width > this.limits.maximumWidth
        || image.height > this.limits.maximumHeight
        || image.width * image.height > this.limits.maximumPixels
      ) {
        throw new AppError(413, "AI_IMAGE_DIMENSIONS_TOO_LARGE", "AI 图片尺寸超过限制");
      }
      return {
        buffer,
        contentType: image.contentType,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError(500, "FILE_STORAGE_ERROR", "AI 文件读取失败");
    }
  }
}
