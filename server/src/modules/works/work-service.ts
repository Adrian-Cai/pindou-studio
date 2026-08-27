import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createIdempotentWorkId } from "../../shared/identity";
import { AppError, forbidden, idempotencyConflict, notFound } from "../../shared/app-error";
import { validatePersistedPattern, type PersistedPattern, type ValidatedPattern } from "./pattern";

export type WorkStatus = "draft" | "completed";

export interface WorkSummary {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly width: number;
  readonly height: number;
  readonly beadCount: number;
  readonly colorCount: number;
  readonly brand: string;
  readonly status: WorkStatus;
  readonly isFavorite: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkDetail extends WorkSummary {
  readonly pattern: PersistedPattern;
}

export interface CreateWorkInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly coverFileId: string;
  readonly status: WorkStatus;
  readonly validatedPattern: ValidatedPattern;
}

export interface WorkListOptions {
  readonly userId: string;
  readonly status?: WorkStatus;
  readonly page: number;
  readonly pageSize: number;
  readonly query?: string;
}

export interface WorkListResponse {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly items: readonly WorkSummary[];
}

interface WorkRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly title: string;
  readonly cover_file_id: string;
  readonly cover_url: string | null;
  readonly width: number;
  readonly height: number;
  readonly bead_count: number;
  readonly color_count: number;
  readonly brand: string;
  readonly status: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly deleted_at: Date | null;
  readonly is_favorite?: boolean;
  readonly schema_version?: number;
  readonly color_limit?: number;
  readonly pattern_brand?: string;
  readonly palette_json?: unknown;
  readonly cells_json?: unknown;
  readonly total_count?: string | number;
}

interface OwnershipRow extends QueryResultRow {
  readonly user_id: string;
  readonly deleted_at: Date | null;
}

export interface WorkService {
  create(input: CreateWorkInput): Promise<WorkSummary>;
  list(options: WorkListOptions): Promise<WorkListResponse>;
  get(userId: string, workId: string): Promise<WorkDetail>;
  delete(userId: string, workId: string): Promise<void>;
}

export class PostgresWorkService implements WorkService {
  public constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  public async create(input: CreateWorkInput): Promise<WorkSummary> {
    const workId = createIdempotentWorkId(input.userId, input.idempotencyKey);
    const currentTime = this.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await readWorkDetail(client, workId);
      if (existing) {
        if (existing.user_id !== input.userId || existing.deleted_at) throw idempotencyConflict();
        if (!sameRequest(existing, input)) throw idempotencyConflict();
        await client.query("COMMIT");
        return mapSummary(existing);
      }

      const cover = await client.query<OwnershipRow & { readonly file_type: string; readonly object_key: string; readonly public_url: string }>(
        `SELECT user_id, deleted_at, file_type, object_key, public_url
           FROM pindou_file_assets
          WHERE id = $1
          LIMIT 1`,
        [input.coverFileId],
      );
      const coverRow = cover.rows[0];
      if (!coverRow) throw notFound("封面文件不存在");
      if (coverRow.user_id !== input.userId) throw forbidden("封面文件不属于当前用户");
      if (coverRow.file_type !== "cover" || coverRow.deleted_at) throw notFound("封面文件不可用");

      const { pattern, beadCount, colorCount } = input.validatedPattern;
      const workInsert = await client.query<WorkRow>(
        `INSERT INTO pindou_works (
           id, user_id, title, cover_file_id, width, height, bead_count, color_count,
           brand, status, created_at, updated_at, deleted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, NULL)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, user_id, title, cover_file_id, width, height, bead_count,
                   color_count, brand, status, created_at, updated_at, deleted_at`,
        [workId, input.userId, input.title, input.coverFileId, pattern.width, pattern.height, beadCount, colorCount, pattern.settings.brand, input.status, currentTime],
      );
      const inserted = workInsert.rows[0];
      if (!inserted) {
        const concurrent = await readWorkDetail(client, workId);
        if (!concurrent || concurrent.user_id !== input.userId || concurrent.deleted_at || !sameRequest(concurrent, input)) {
          throw idempotencyConflict();
        }
        await client.query("COMMIT");
        return mapSummary(concurrent);
      }

      await client.query(
        `INSERT INTO pindou_work_patterns (
           work_id, schema_version, width, height, color_limit, brand,
           palette_json, cells_json, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $9)`,
        [workId, pattern.schemaVersion, pattern.width, pattern.height, pattern.settings.colorLimit, pattern.settings.brand, JSON.stringify(pattern.palette), JSON.stringify(pattern.cells), currentTime],
      );
      await client.query("COMMIT");
      return {
        id: workId,
        title: input.title,
        coverUrl: coverRow.public_url,
        width: pattern.width,
        height: pattern.height,
        beadCount,
        colorCount,
        brand: pattern.settings.brand,
        status: input.status,
        isFavorite: false,
        createdAt: currentTime.toISOString(),
        updatedAt: currentTime.toISOString(),
      };
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async list(options: WorkListOptions): Promise<WorkListResponse> {
    const conditions = ["works.user_id = $1", "works.deleted_at IS NULL"];
    const parameters: unknown[] = [options.userId];
    if (options.status) {
      parameters.push(options.status);
      conditions.push(`works.status = $${parameters.length}`);
    }
    if (options.query) {
      parameters.push(`%${options.query}%`);
      conditions.push(`works.title ILIKE $${parameters.length}`);
    }
    const filterParameters = [...parameters];
    const countResult = await this.pool.query<{ readonly total_count: string }>(
      `SELECT COUNT(*)::text AS total_count
         FROM pindou_works works
        WHERE ${conditions.join(" AND ")}`,
      filterParameters,
    );
    parameters.push(options.pageSize, (options.page - 1) * options.pageSize);
    const result = await this.pool.query<WorkRow>(
      `SELECT works.id, works.user_id, works.title, works.cover_file_id,
              files.public_url AS cover_url, works.width, works.height,
              works.bead_count, works.color_count, works.brand, works.status,
              works.created_at, works.updated_at, works.deleted_at,
              EXISTS (
                SELECT 1 FROM pindou_favorites favorites
                 WHERE favorites.user_id = $1 AND favorites.work_id = works.id
              ) AS is_favorite
         FROM pindou_works works
         LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
        WHERE ${conditions.join(" AND ")}
        ORDER BY works.updated_at DESC, works.id DESC
        LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    const total = Number(countResult.rows[0]?.total_count ?? 0);
    return { total: Number.isSafeInteger(total) ? total : 0, page: options.page, pageSize: options.pageSize, items: result.rows.map(mapSummary) };
  }

  public async get(userId: string, workId: string): Promise<WorkDetail> {
    const result = await this.pool.query<WorkRow>(
      `SELECT works.id, works.user_id, works.title, works.cover_file_id,
              files.public_url AS cover_url, works.width, works.height,
              works.bead_count, works.color_count, works.brand, works.status,
              works.created_at, works.updated_at, works.deleted_at,
              patterns.schema_version, patterns.color_limit,
              patterns.brand AS pattern_brand, patterns.palette_json, patterns.cells_json,
              EXISTS (
                SELECT 1 FROM pindou_favorites favorites
                 WHERE favorites.user_id = $1 AND favorites.work_id = works.id
              ) AS is_favorite
         FROM pindou_works works
         JOIN pindou_work_patterns patterns ON patterns.work_id = works.id
         LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
        WHERE works.id = $2 AND works.user_id = $1 AND works.deleted_at IS NULL
        LIMIT 1`,
      [userId, workId],
    );
    const row = result.rows[0];
    if (!row) await throwOwnershipAwareNotFound(this.pool, workId, userId);
    return mapDetail(row as WorkRow);
  }

  public async delete(userId: string, workId: string): Promise<void> {
    const ownership = await this.pool.query<OwnershipRow>(
      `SELECT user_id, deleted_at FROM pindou_works WHERE id = $1 LIMIT 1`,
      [workId],
    );
    const row = ownership.rows[0];
    if (!row || row.deleted_at) throw notFound("作品不存在");
    if (row.user_id !== userId) throw forbidden("作品不属于当前用户");
    await this.pool.query(
      `UPDATE pindou_works SET deleted_at = $3, updated_at = $3
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [workId, userId, this.now()],
    );
  }
}

async function readWorkDetail(client: PoolClient, workId: string): Promise<WorkRow | null> {
  const result = await client.query<WorkRow>(
    `SELECT works.id, works.user_id, works.title, works.cover_file_id,
            files.public_url AS cover_url, works.width, works.height,
            works.bead_count, works.color_count, works.brand, works.status,
            works.created_at, works.updated_at, works.deleted_at,
            patterns.schema_version, patterns.color_limit,
            patterns.brand AS pattern_brand, patterns.palette_json, patterns.cells_json
       FROM pindou_works works
       JOIN pindou_work_patterns patterns ON patterns.work_id = works.id
       LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
      WHERE works.id = $1 LIMIT 1`,
    [workId],
  );
  return result.rows[0] ?? null;
}

function sameRequest(existing: WorkRow, input: CreateWorkInput): boolean {
  if (existing.title !== input.title || existing.cover_file_id !== input.coverFileId || existing.status !== input.status) return false;
  const existingPattern = mapPattern(existing);
  return JSON.stringify(existingPattern) === JSON.stringify(input.validatedPattern.pattern);
}

function mapSummary(row: WorkRow): WorkSummary {
  if (row.status !== "draft" && row.status !== "completed") throw new AppError(500, "INTERNAL_ERROR", "数据库中的作品状态不合法");
  return {
    id: row.id,
    title: row.title,
    coverUrl: row.cover_url,
    width: row.width,
    height: row.height,
    beadCount: row.bead_count,
    colorCount: row.color_count,
    brand: row.brand,
    status: row.status,
    isFavorite: row.is_favorite === true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapDetail(row: WorkRow): WorkDetail {
  return { ...mapSummary(row), pattern: mapPattern(row) };
}

function mapPattern(row: WorkRow): PersistedPattern {
  const pattern = {
    schemaVersion: row.schema_version,
    width: row.width,
    height: row.height,
    settings: { colorLimit: row.color_limit, brand: row.pattern_brand },
    palette: parseJson(row.palette_json),
    cells: parseJson(row.cells_json),
  };
  return validatePersistedPattern(pattern).pattern;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AppError(500, "INTERNAL_ERROR", "作品图案数据损坏");
  }
}

async function throwOwnershipAwareNotFound(pool: Pool, workId: string, userId: string): Promise<never> {
  const result = await pool.query<OwnershipRow>("SELECT user_id, deleted_at FROM pindou_works WHERE id = $1 LIMIT 1", [workId]);
  const row = result.rows[0];
  if (row && !row.deleted_at && row.user_id !== userId) throw forbidden("作品不属于当前用户");
  throw notFound("作品不存在");
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* 保留原始异常。 */ }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
