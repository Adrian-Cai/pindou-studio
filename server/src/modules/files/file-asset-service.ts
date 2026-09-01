import type { Pool, QueryResultRow } from "pg";
import { createEntityId } from "../../shared/identity";
import { AppError, forbidden, notFound } from "../../shared/app-error";
import { toIso } from "../../shared/date-time";
import type { CoverStorage } from "./cover-storage";
import type { AiFileStorage } from "./ai-file-storage";

export interface FileUploadInput {
  readonly type: "cover" | "ai_input";
  readonly buffer: Buffer;
  readonly filename: string;
  readonly declaredContentType: string;
}

export interface FileAssetResponse {
  readonly id: string;
  readonly type: "cover" | "ai_input" | "ai_output";
  readonly url: string;
  readonly contentType: string;
  readonly size: number;
  readonly createdAt: string;
}

interface FileAssetRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly file_type: string;
  readonly object_key: string;
  readonly public_url: string;
  readonly content_type: string;
  readonly byte_size: string | number;
  readonly created_at: Date | string;
  readonly deleted_at: Date | null;
}

export interface FileAssetService {
  upload(userId: string, input: FileUploadInput): Promise<FileAssetResponse>;
}

export class PostgresFileAssetService implements FileAssetService {
  public constructor(
    private readonly pool: Pool,
    private readonly storage: CoverStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly aiStorage?: AiFileStorage,
  ) {}

  public async upload(userId: string, input: FileUploadInput): Promise<FileAssetResponse> {
    if (input.type !== "cover" && input.type !== "ai_input") {
      throw new AppError(400, "INVALID_ARGUMENT", "文件类型只能是 cover 或 ai_input");
    }
    if (input.type === "ai_input" && !this.aiStorage) {
      throw new AppError(503, "AI_STORAGE_NOT_CONFIGURED", "AI 文件存储尚未配置");
    }
    const targetStorage = input.type === "cover" ? this.storage : this.aiStorage!;
    const stored = input.type === "cover"
      ? await this.storage.save(input.buffer, input.filename, input.declaredContentType)
      : await this.aiStorage!.save("ai_input", input.buffer, input.filename, input.declaredContentType);
    const id = createEntityId("file");
    const createdAt = this.now();
    try {
      const result = await this.pool.query<FileAssetRow>(
        `INSERT INTO pindou_file_assets (
           id, user_id, file_type, object_key, public_url, content_type, byte_size,
           width, height, created_at, deleted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
         RETURNING id, user_id, file_type, object_key, public_url, content_type,
                   byte_size, created_at, deleted_at`,
        [id, userId, input.type, stored.objectKey, stored.publicUrl, stored.contentType, stored.byteSize, stored.width, stored.height, createdAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error("文件资产写入后无法读取记录");
      return mapFileAsset(row);
    } catch (error: unknown) {
      await targetStorage.remove(stored.objectKey);
      throw error;
    }
  }
}

export function assertOwnedCover(row: FileAssetRow | undefined, userId: string): void {
  if (!row) throw notFound("封面文件不存在");
  if (row.user_id !== userId) throw forbidden("封面文件不属于当前用户");
  if (row.file_type !== "cover" || row.deleted_at) throw notFound("封面文件不可用");
}

function mapFileAsset(row: FileAssetRow): FileAssetResponse {
  if (row.file_type !== "cover" && row.file_type !== "ai_input" && row.file_type !== "ai_output") {
    throw new Error("数据库中的文件类型不受支持");
  }
  return {
    id: row.id,
    type: row.file_type,
    url: row.public_url,
    contentType: row.content_type,
    size: Number(row.byte_size),
    createdAt: toIso(row.created_at),
  };
}
