import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createIdempotentWorkId } from "../../shared/identity";
import { AppError, forbidden, idempotencyConflict, notFound } from "../../shared/app-error";
import { toIso } from "../../shared/date-time";
import { rollbackTransaction } from "../../shared/transaction";
import { validatePersistedPattern, type GenerationMode, type PersistedPattern, type ValidatedPattern } from "./pattern";

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
  readonly generationMode: GenerationMode;
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

export interface UpdateWorkInput {
  readonly userId: string;
  readonly workId: string;
  readonly title?: string;
  readonly coverFileId?: string;
  readonly status?: WorkStatus;
  readonly validatedPattern?: ValidatedPattern;
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

export interface FavoriteWorkSummary extends WorkSummary {
  readonly favoritedAt: string;
}

export interface FavoriteListResponse {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly items: readonly FavoriteWorkSummary[];
}

export interface FavoriteListOptions {
  readonly userId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly query?: string;
}

export interface FavoriteUpdateResponse {
  readonly workId: string;
  readonly isFavorite: boolean;
  readonly favoritedAt: string | null;
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
  readonly generation_mode?: string;
  readonly status: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly deleted_at: Date | null;
  readonly favorited_at?: Date | string;
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

export class PostgresWorkService {
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
           brand, generation_mode, status, created_at, updated_at, deleted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, NULL)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, user_id, title, cover_file_id, width, height, bead_count,
                   color_count, brand, generation_mode, status, created_at, updated_at, deleted_at`,
        [workId, input.userId, input.title, input.coverFileId, pattern.width, pattern.height, beadCount, colorCount, pattern.settings.brand, pattern.generationMode, input.status, currentTime],
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
        generationMode: pattern.generationMode,
        status: input.status,
        isFavorite: false,
        createdAt: currentTime.toISOString(),
        updatedAt: currentTime.toISOString(),
      };
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async update(input: UpdateWorkInput): Promise<WorkSummary> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await readWorkSummary(client, input.workId, true);
      if (!existing || existing.deleted_at) throw notFound("作品不存在");
      if (existing.user_id !== input.userId) throw forbidden("作品不属于当前用户");

      let coverUrl = existing.cover_url;
      if (input.coverFileId !== undefined) {
        const cover = await client.query<OwnershipRow & { readonly file_type: string; readonly public_url: string }>(
          `SELECT user_id, deleted_at, file_type, public_url
             FROM pindou_file_assets
            WHERE id = $1
            LIMIT 1`,
          [input.coverFileId],
        );
        const coverRow = cover.rows[0];
        if (!coverRow) throw notFound("封面文件不存在");
        if (coverRow.user_id !== input.userId) throw forbidden("封面文件不属于当前用户");
        if (coverRow.file_type !== "cover" || coverRow.deleted_at) throw notFound("封面文件不可用");
        coverUrl = coverRow.public_url;
      }

      const validatedPattern = input.validatedPattern;
      const pattern = validatedPattern?.pattern;
      const currentTime = this.now();
      const updated = await client.query<WorkRow>(
        `UPDATE pindou_works
            SET title = $3, cover_file_id = $4, width = $5, height = $6,
                bead_count = $7, color_count = $8, brand = $9, generation_mode = $10,
                status = $11, updated_at = $12
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          RETURNING id, user_id, title, cover_file_id, width, height, bead_count,
                    color_count, brand, generation_mode, status, created_at, updated_at, deleted_at`,
        [
          input.workId,
          input.userId,
          input.title ?? existing.title,
          input.coverFileId ?? existing.cover_file_id,
          pattern?.width ?? existing.width,
          pattern?.height ?? existing.height,
          validatedPattern?.beadCount ?? existing.bead_count,
          validatedPattern?.colorCount ?? existing.color_count,
          pattern?.settings.brand ?? existing.brand,
          pattern?.generationMode ?? generationModeFromRow(existing),
          input.status ?? existing.status,
          currentTime,
        ],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw notFound("作品不存在");

      if (validatedPattern !== undefined) {
        const { pattern } = validatedPattern;
        await client.query(
          `UPDATE pindou_work_patterns
              SET schema_version = $2, width = $3, height = $4, color_limit = $5,
                  brand = $6, palette_json = $7::jsonb, cells_json = $8::jsonb,
                  updated_at = $9
            WHERE work_id = $1`,
          [
            input.workId,
            pattern.schemaVersion,
            pattern.width,
            pattern.height,
            pattern.settings.colorLimit,
            pattern.settings.brand,
            JSON.stringify(pattern.palette),
            JSON.stringify(pattern.cells),
            currentTime,
          ],
        );
      }

      await client.query("COMMIT");
      return mapSummary({ ...updatedRow, cover_url: coverUrl, is_favorite: existing.is_favorite === true });
    } catch (error: unknown) {
      await rollbackTransaction(client);
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
              works.bead_count, works.color_count, works.brand, works.generation_mode, works.status,
              works.created_at, works.updated_at, works.deleted_at,
              EXISTS (
                SELECT 1 FROM pindou_favorites favorites
                 WHERE favorites.user_id = $1 AND favorites.work_id = works.id
                   AND favorites.deleted_at IS NULL
              ) AS is_favorite
         FROM pindou_works works
         LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
        WHERE ${conditions.join(" AND ")}
        ORDER BY works.updated_at DESC, works.id DESC
        LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    return mapListResponse(options, countResult.rows[0]?.total_count, result.rows, mapSummary);
  }

  public async get(userId: string, workId: string): Promise<WorkDetail> {
    const result = await this.pool.query<WorkRow>(
      `SELECT works.id, works.user_id, works.title, works.cover_file_id,
              files.public_url AS cover_url, works.width, works.height,
              works.bead_count, works.color_count, works.brand, works.generation_mode, works.status,
              works.created_at, works.updated_at, works.deleted_at,
              patterns.schema_version, patterns.color_limit,
              patterns.brand AS pattern_brand, patterns.palette_json, patterns.cells_json,
              EXISTS (
                SELECT 1 FROM pindou_favorites favorites
                 WHERE favorites.user_id = $1 AND favorites.work_id = works.id
                   AND favorites.deleted_at IS NULL
              ) AS is_favorite
         FROM pindou_works works
         JOIN pindou_work_patterns patterns ON patterns.work_id = works.id
         LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
        WHERE works.id = $2 AND works.user_id = $1 AND works.deleted_at IS NULL
        LIMIT 1`,
      [userId, workId],
    );
    const row = result.rows[0];
    if (!row) await assertWorkOwner(this.pool, workId, userId);
    return mapDetail(row as WorkRow);
  }

  public async delete(userId: string, workId: string): Promise<void> {
    await assertWorkOwner(this.pool, workId, userId);
    await this.pool.query(
      `UPDATE pindou_works SET deleted_at = $3, updated_at = $3
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [workId, userId, this.now()],
    );
  }

  public async setFavorite(userId: string, workId: string, favorite: boolean): Promise<FavoriteUpdateResponse> {
    await assertWorkOwner(this.pool, workId, userId);
    if (!favorite) {
      await this.pool.query(
        `UPDATE pindou_favorites
            SET deleted_at = $3
          WHERE user_id = $1 AND work_id = $2 AND deleted_at IS NULL`,
        [userId, workId, this.now()],
      );
      return { workId, isFavorite: false, favoritedAt: null };
    }

    const result = await this.pool.query<{ readonly favorited_at: Date | string }>(
      `WITH changed AS (
         INSERT INTO pindou_favorites (user_id, work_id, created_at, favorited_at, deleted_at)
         SELECT $1::varchar, $2::varchar, $3::timestamptz, $3::timestamptz, NULL::timestamptz
            FROM pindou_works
           WHERE id = $2::varchar AND user_id = $1::varchar AND deleted_at IS NULL
         ON CONFLICT (user_id, work_id) DO UPDATE
         SET favorited_at = EXCLUDED.favorited_at,
             deleted_at = NULL
         WHERE pindou_favorites.deleted_at IS NOT NULL
         RETURNING favorited_at
       )
       SELECT favorited_at FROM changed
       UNION ALL
       SELECT favorited_at
         FROM pindou_favorites
         WHERE user_id = $1::varchar AND work_id = $2::varchar AND deleted_at IS NULL
       LIMIT 1`,
      [userId, workId, this.now()],
    );
    let favoritedAt = result.rows[0]?.favorited_at;
    if (!favoritedAt) {
      const current = await this.pool.query<{ readonly favorited_at: Date | string }>(
        `SELECT favorites.favorited_at
           FROM pindou_favorites favorites
           JOIN pindou_works works
             ON works.id = favorites.work_id AND works.user_id = favorites.user_id
          WHERE favorites.user_id = $1 AND favorites.work_id = $2
            AND favorites.deleted_at IS NULL AND works.deleted_at IS NULL
          LIMIT 1`,
        [userId, workId],
      );
      favoritedAt = current.rows[0]?.favorited_at;
    }
    if (!favoritedAt) await assertWorkOwner(this.pool, workId, userId);
    if (!favoritedAt) throw new AppError(500, "INTERNAL_ERROR", "收藏关系写入失败");
    return { workId, isFavorite: true, favoritedAt: toIso(favoritedAt) };
  }

  public async listFavorites(options: FavoriteListOptions): Promise<FavoriteListResponse> {
    const conditions = ["favorites.user_id = $1", "favorites.deleted_at IS NULL", "works.deleted_at IS NULL"];
    const parameters: unknown[] = [options.userId];
    if (options.query) {
      parameters.push(`%${options.query}%`);
      conditions.push(`works.title ILIKE $${parameters.length}`);
    }
    const countResult = await this.pool.query<{ readonly total_count: string }>(
      `SELECT COUNT(*)::text AS total_count
         FROM pindou_favorites favorites
         JOIN pindou_works works
           ON works.id = favorites.work_id AND works.user_id = favorites.user_id
        WHERE ${conditions.join(" AND ")}`,
      [...parameters],
    );
    parameters.push(options.pageSize, (options.page - 1) * options.pageSize);
    const result = await this.pool.query<WorkRow>(
      `SELECT works.id, works.user_id, works.title, works.cover_file_id,
              files.public_url AS cover_url, works.width, works.height,
              works.bead_count, works.color_count, works.brand, works.generation_mode, works.status,
              works.created_at, works.updated_at, works.deleted_at,
              favorites.favorited_at,
              TRUE AS is_favorite
         FROM pindou_favorites favorites
         JOIN pindou_works works
           ON works.id = favorites.work_id AND works.user_id = favorites.user_id
         LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
        WHERE ${conditions.join(" AND ")}
        ORDER BY favorites.favorited_at DESC, works.id DESC
        LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    return mapListResponse(options, countResult.rows[0]?.total_count, result.rows, mapFavoriteSummary);
  }
}

async function readWorkDetail(
  client: PoolClient,
  workId: string,
  lock = false,
): Promise<WorkRow | null> {
  const result = await client.query<WorkRow>(
    `SELECT works.id, works.user_id, works.title, works.cover_file_id,
            files.public_url AS cover_url, works.width, works.height,
            works.bead_count, works.color_count, works.brand, works.generation_mode, works.status,
            works.created_at, works.updated_at, works.deleted_at,
            EXISTS (
              SELECT 1 FROM pindou_favorites favorites
               WHERE favorites.user_id = works.user_id AND favorites.work_id = works.id
                 AND favorites.deleted_at IS NULL
            ) AS is_favorite,
            patterns.schema_version, patterns.color_limit,
            patterns.brand AS pattern_brand, patterns.palette_json, patterns.cells_json
       FROM pindou_works works
       JOIN pindou_work_patterns patterns ON patterns.work_id = works.id
       LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
      WHERE works.id = $1 LIMIT 1${lock ? " FOR UPDATE OF works" : ""}`,
    [workId],
  );
  return result.rows[0] ?? null;
}

async function readWorkSummary(
  client: PoolClient,
  workId: string,
  lock = false,
): Promise<WorkRow | null> {
  const result = await client.query<WorkRow>(
    `SELECT works.id, works.user_id, works.title, works.cover_file_id,
            files.public_url AS cover_url, works.width, works.height,
            works.bead_count, works.color_count, works.brand, works.generation_mode, works.status,
            works.created_at, works.updated_at, works.deleted_at,
            EXISTS (
              SELECT 1 FROM pindou_favorites favorites
               WHERE favorites.user_id = works.user_id AND favorites.work_id = works.id
                 AND favorites.deleted_at IS NULL
            ) AS is_favorite
       FROM pindou_works works
       LEFT JOIN pindou_file_assets files ON files.id = works.cover_file_id AND files.deleted_at IS NULL
      WHERE works.id = $1 LIMIT 1${lock ? " FOR UPDATE OF works" : ""}`,
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
    generationMode: generationModeFromRow(row),
    status: row.status,
    isFavorite: row.is_favorite === true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapDetail(row: WorkRow): WorkDetail {
  return { ...mapSummary(row), pattern: mapPattern(row) };
}

function mapFavoriteSummary(row: WorkRow): FavoriteWorkSummary {
  if (!row.favorited_at) throw new AppError(500, "INTERNAL_ERROR", "收藏时间缺失");
  return { ...mapSummary(row), favoritedAt: toIso(row.favorited_at) };
}

function mapPattern(row: WorkRow): PersistedPattern {
  const pattern = {
    schemaVersion: row.schema_version,
    generationMode: generationModeFromRow(row),
    width: row.width,
    height: row.height,
    settings: { colorLimit: row.color_limit, brand: row.pattern_brand },
    palette: parseJson(row.palette_json),
    cells: parseJson(row.cells_json),
  };
  return validatePersistedPattern(pattern).pattern;
}

function generationModeFromRow(row: Pick<WorkRow, "generation_mode">): GenerationMode {
  if (row.generation_mode === "ai") return "ai";
  return "standard";
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AppError(500, "INTERNAL_ERROR", "作品图案数据损坏");
  }
}

async function assertWorkOwner(pool: Pool, workId: string, userId: string): Promise<void> {
  const result = await pool.query<OwnershipRow>(
    "SELECT user_id, deleted_at FROM pindou_works WHERE id = $1 LIMIT 1",
    [workId],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at) throw notFound("作品不存在");
  if (row.user_id !== userId) throw forbidden("作品不属于当前用户");
}

function mapListResponse<T>(
  options: Pick<WorkListOptions, "page" | "pageSize">,
  totalCount: string | number | undefined,
  rows: readonly WorkRow[],
  mapRow: (row: WorkRow) => T,
): { readonly total: number; readonly page: number; readonly pageSize: number; readonly items: readonly T[] } {
  const total = Number(totalCount ?? 0);
  return {
    total: Number.isSafeInteger(total) ? total : 0,
    page: options.page,
    pageSize: options.pageSize,
    items: rows.map(mapRow),
  };
}
