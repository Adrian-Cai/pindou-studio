import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createEntityId } from "../../shared/identity";
import { AppError, notFound } from "../../shared/app-error";
import { rollbackTransaction } from "../../shared/transaction";
import { toIso } from "../../shared/date-time";
import type { AiFileStorage } from "../files/ai-file-storage";
import type { CoverStorage } from "../files/cover-storage";

/** 已持久化的文生图原图作品，不含拼豆网格。 */
export interface TextImageWork {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly coverUrl: string;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 文生图作品分页参数。 */
export interface TextImageWorkListOptions {
  readonly userId: string;
  readonly page: number;
  readonly pageSize: number;
}

/** 文生图作品列表及分页信息。 */
export interface TextImageWorkListResponse {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly items: readonly TextImageWork[];
}

interface TextImageWorkRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly cover_url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface SourceJobRow extends QueryResultRow {
  readonly id: string;
  readonly prompt: string;
  readonly status: string;
  readonly expires_at: Date | string;
  readonly output_object_key: string | null;
  readonly output_content_type: string | null;
}

interface CoverAssetRow extends QueryResultRow {
  readonly id: string;
  readonly object_key: string;
}

const TEXT_IMAGE_TITLE = "文生图作品";

/** 以独立表保存文生图原图，并处理归属、幂等、分页和删除。 */
export class PostgresTextImageWorkService {
  public constructor(
    private readonly pool: Pool,
    private readonly covers: CoverStorage,
    private readonly aiFiles: AiFileStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(userId: string, sourceJobId: string): Promise<TextImageWork> {
    const client = await this.pool.connect();
    let storedObjectKey: string | null = null;
    try {
      await client.query("BEGIN");
      const deletedWork = await client.query<{ readonly id: string }>(
        `SELECT id FROM pindou_text_image_works
          WHERE user_id = $1 AND source_job_id = $2 AND deleted_at IS NOT NULL
          LIMIT 1`,
        [userId, sourceJobId],
      );
      if (deletedWork.rowCount) {
        throw new AppError(409, "TEXT_IMAGE_WORK_DELETED", "这张文生图作品已删除，不能重新保存");
      }
      const source = await client.query<SourceJobRow>(
        `SELECT jobs.id, jobs.prompt, jobs.status, jobs.expires_at,
                files.object_key AS output_object_key, files.content_type AS output_content_type
           FROM pindou_text_image_generation_jobs jobs
           JOIN pindou_file_assets files ON files.id = jobs.output_file_id
          WHERE jobs.id = $1 AND jobs.user_id = $2 AND files.file_type = 'ai_output'
            AND files.deleted_at IS NULL
          FOR UPDATE OF jobs`,
        [sourceJobId, userId],
      );
      const job = source.rows[0];
      if (!job || job.status !== "succeeded" || new Date(job.expires_at).getTime() <= this.now().getTime()
        || !job.output_object_key || !job.output_content_type) {
        const existing = await this.findBySourceJob(client, userId, sourceJobId);
        if (existing) {
          await client.query("COMMIT");
          return mapTextImageWork(existing);
        }
        throw notFound("文生图结果不存在或已过期");
      }

      const existing = await this.findBySourceJob(client, userId, sourceJobId);
      if (existing) {
        await client.query("COMMIT");
        return mapTextImageWork(existing);
      }

      const generated = await this.aiFiles.readObject(job.output_object_key);
      if (!generated) throw notFound("文生图临时图片不存在或已过期");
      const extension = generated.contentType === "image/jpeg" ? "jpg"
        : generated.contentType === "image/webp" ? "webp" : "png";
      const stored = await this.covers.save(generated.buffer, `text-image.${extension}`, generated.contentType);
      storedObjectKey = stored.objectKey;
      const currentTime = this.now();
      const fileId = createEntityId("file");
      await client.query(
        `INSERT INTO pindou_file_assets (
           id, user_id, file_type, object_key, public_url, content_type, byte_size,
           width, height, created_at, deleted_at
         ) VALUES ($1, $2, 'cover', $3, $4, $5, $6, $7, $8, $9, NULL)`,
        [fileId, userId, stored.objectKey, stored.publicUrl, stored.contentType, stored.byteSize, stored.width, stored.height, currentTime],
      );
      const inserted = await client.query<TextImageWorkRow>(
        `INSERT INTO pindou_text_image_works (
           id, user_id, source_job_id, image_file_id, prompt, created_at, updated_at, deleted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, NULL)
         RETURNING id, prompt, created_at, updated_at,
                   $7::text AS title, $8::text AS cover_url, $9::int AS width, $10::int AS height`,
        [createEntityId("txtwork"), userId, sourceJobId, fileId, job.prompt, currentTime, TEXT_IMAGE_TITLE, stored.publicUrl, stored.width, stored.height],
      );
      await client.query(
        `UPDATE pindou_text_image_generation_jobs
            SET consumed_at = COALESCE(consumed_at, $3), updated_at = $3
          WHERE id = $1 AND user_id = $2`,
        [sourceJobId, userId, currentTime],
      );
      await client.query("COMMIT");
      storedObjectKey = null;
      return mapTextImageWork(inserted.rows[0]!);
    } catch (error: unknown) {
      await rollbackTransaction(client);
      if (storedObjectKey) await this.covers.remove(storedObjectKey);
      throw error;
    } finally {
      client.release();
    }
  }

  public async list(options: TextImageWorkListOptions): Promise<TextImageWorkListResponse> {
    const count = await this.pool.query<{ readonly total: string }>(
      `SELECT COUNT(*)::text AS total FROM pindou_text_image_works
        WHERE user_id = $1 AND deleted_at IS NULL`,
      [options.userId],
    );
    const result = await this.pool.query<TextImageWorkRow>(
      `SELECT works.id, works.prompt, works.created_at, works.updated_at,
              files.public_url AS cover_url, files.width, files.height,
              $4::text AS title
         FROM pindou_text_image_works works
         JOIN pindou_file_assets files ON files.id = works.image_file_id AND files.deleted_at IS NULL
        WHERE works.user_id = $1 AND works.deleted_at IS NULL
        ORDER BY works.created_at DESC, works.id DESC
        LIMIT $2 OFFSET $3`,
      [options.userId, options.pageSize, (options.page - 1) * options.pageSize, TEXT_IMAGE_TITLE],
    );
    return {
      total: Number(count.rows[0]?.total ?? 0),
      page: options.page,
      pageSize: options.pageSize,
      items: result.rows.map(mapTextImageWork),
    };
  }

  public async get(userId: string, workId: string): Promise<TextImageWork> {
    const result = await this.pool.query<TextImageWorkRow>(
      `SELECT works.id, works.prompt, works.created_at, works.updated_at,
              files.public_url AS cover_url, files.width, files.height,
              $3::text AS title
         FROM pindou_text_image_works works
         JOIN pindou_file_assets files ON files.id = works.image_file_id AND files.deleted_at IS NULL
        WHERE works.user_id = $1 AND works.id = $2 AND works.deleted_at IS NULL
        LIMIT 1`,
      [userId, workId, TEXT_IMAGE_TITLE],
    );
    const row = result.rows[0];
    if (!row) throw notFound("文生图作品不存在");
    return mapTextImageWork(row);
  }

  public async delete(userId: string, workId: string): Promise<void> {
    const client = await this.pool.connect();
    let cover: CoverAssetRow | undefined;
    try {
      await client.query("BEGIN");
      const result = await client.query<CoverAssetRow>(
        `SELECT files.id, files.object_key
           FROM pindou_text_image_works works
           JOIN pindou_file_assets files ON files.id = works.image_file_id
          WHERE works.user_id = $1 AND works.id = $2 AND works.deleted_at IS NULL
          FOR UPDATE OF works, files`,
        [userId, workId],
      );
      cover = result.rows[0];
      if (!cover) throw notFound("文生图作品不存在");
      const currentTime = this.now();
      await client.query(
        `UPDATE pindou_text_image_works SET deleted_at = $3, updated_at = $3
          WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [userId, workId, currentTime],
      );
      await client.query("UPDATE pindou_file_assets SET deleted_at = $2 WHERE id = $1 AND deleted_at IS NULL", [cover.id, currentTime]);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    if (cover) {
      try {
        await this.covers.remove(cover.object_key);
      } catch (error: unknown) {
        console.error(JSON.stringify({ event: "text_image_work_file_cleanup_failed", userId, workId,
          message: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  private async findBySourceJob(client: PoolClient, userId: string, sourceJobId: string): Promise<TextImageWorkRow | null> {
    const result = await client.query<TextImageWorkRow>(
      `SELECT works.id, works.prompt, works.created_at, works.updated_at,
              files.public_url AS cover_url, files.width, files.height,
              $3::text AS title
         FROM pindou_text_image_works works
         JOIN pindou_file_assets files ON files.id = works.image_file_id AND files.deleted_at IS NULL
        WHERE works.user_id = $1 AND works.source_job_id = $2 AND works.deleted_at IS NULL
        LIMIT 1`,
      [userId, sourceJobId, TEXT_IMAGE_TITLE],
    );
    return result.rows[0] ?? null;
  }
}

function mapTextImageWork(row: TextImageWorkRow): TextImageWork {
  if (!row.cover_url || !Number.isSafeInteger(row.width) || !Number.isSafeInteger(row.height)) {
    throw new AppError(500, "INTERNAL_ERROR", "文生图作品图片数据无效");
  }
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    coverUrl: row.cover_url,
    width: row.width!,
    height: row.height!,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
