import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, invalidArgument } from "../../shared/app-error";

const AVATAR_ROUTE_PREFIX = "/api/media/avatars/";
const AVATAR_FILE_PATTERN = /^avatar_[a-f0-9]{32}\.(jpg|png|webp)$/;

interface AvatarFormat {
  readonly extension: "jpg" | "png" | "webp";
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
}

export interface StoredAvatar {
  readonly publicPath: string;
  readonly contentType: AvatarFormat["contentType"];
}

export interface AvatarStorage {
  save(buffer: Buffer, declaredContentType: string): Promise<StoredAvatar>;
  read(publicPath: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null>;
  remove(publicPath: string | null): Promise<void>;
}

export class FileSystemAvatarStorage implements AvatarStorage {
  public constructor(private readonly directory: string) {}

  public async save(buffer: Buffer, declaredContentType: string): Promise<StoredAvatar> {
    const format = detectAvatarFormat(buffer);
    if (!format || (declaredContentType && declaredContentType !== format.contentType)) {
      throw invalidArgument("头像必须是有效的 JPG、PNG 或 WEBP 图片");
    }

    await mkdir(this.directory, { recursive: true });
    const filename = `avatar_${randomUUID().replaceAll("-", "")}.${format.extension}`;
    await writeFile(join(this.directory, filename), buffer, { flag: "wx" });
    return { publicPath: `${AVATAR_ROUTE_PREFIX}${filename}`, contentType: format.contentType };
  }

  public async read(
    publicPath: string,
  ): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null> {
    const file = avatarFile(publicPath);
    if (!file) return null;
    try {
      return {
        buffer: await readFile(join(this.directory, file.filename)),
        contentType: file.contentType,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError(500, "AVATAR_STORAGE_ERROR", "头像读取失败");
    }
  }

  public async remove(publicPath: string | null): Promise<void> {
    if (!publicPath) return;
    const file = avatarFile(publicPath);
    if (!file) return;
    try {
      await unlink(join(this.directory, file.filename));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 资料已经更新成功，旧头像清理失败不应回滚用户操作。
      }
    }
  }
}

function avatarFile(
  publicPath: string,
): { readonly filename: string; readonly contentType: AvatarFormat["contentType"] } | null {
  if (!publicPath.startsWith(AVATAR_ROUTE_PREFIX)) return null;
  const filename = publicPath.slice(AVATAR_ROUTE_PREFIX.length);
  const match = filename.match(AVATAR_FILE_PATTERN);
  const extension = match?.[1];
  if (extension === "jpg") return { filename, contentType: "image/jpeg" };
  if (extension === "png") return { filename, contentType: "image/png" };
  if (extension === "webp") return { filename, contentType: "image/webp" };
  return null;
}

function detectAvatarFormat(buffer: Buffer): AvatarFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { extension: "png", contentType: "image/png" };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}
