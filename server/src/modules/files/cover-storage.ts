import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { invalidArgument, AppError } from "../../shared/app-error";
import { validateCoverImage, type ValidatedImage } from "./image-validation";

export interface StoredCover {
  readonly objectKey: string;
  readonly publicUrl: string;
  readonly contentType: ValidatedImage["contentType"];
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface CoverStorage {
  save(buffer: Buffer, filename: string, declaredContentType: string): Promise<StoredCover>;
  remove(objectKey: string): Promise<void>;
}

export class FileSystemCoverStorage implements CoverStorage {
  public constructor(
    private readonly directory: string,
    private readonly publicBaseUrl: string,
  ) {
    if (!publicBaseUrl.trim()) throw invalidArgument("封面对象存储公开地址未配置");
  }

  public async save(buffer: Buffer, filename: string, declaredContentType: string): Promise<StoredCover> {
    const image = validateCoverImage(buffer, filename, declaredContentType);
    const storedName = `cover_${randomUUID().replace(/-/g, "")}.${image.extension}`;
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(join(this.directory, storedName), buffer, { flag: "wx" });
    } catch {
      throw new AppError(500, "FILE_STORAGE_ERROR", "封面存储失败");
    }
    return {
      objectKey: `covers/${storedName}`,
      publicUrl: `${this.publicBaseUrl.replace(/\/$/u, "")}/${storedName}`,
      contentType: image.contentType,
      byteSize: buffer.length,
      width: image.width,
      height: image.height,
    };
  }

  public async remove(objectKey: string): Promise<void> {
    const prefix = "covers/";
    if (!objectKey.startsWith(prefix)) return;
    const filename = objectKey.slice(prefix.length);
    if (!/^cover_[a-f0-9]{32}\.(jpg|png|webp)$/u.test(filename)) return;
    try {
      await unlink(join(this.directory, filename));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 数据库元数据已经提交时，清理失败交给后续存储清理任务。
      }
    }
  }
}
