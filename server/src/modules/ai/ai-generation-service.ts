/**
 * AI 生成任务服务（主链路服务端核心）。
 *
 * 职责：创建 AI 生图任务、驱动任务状态机（queued→processing→succeeded/failed/canceled）、
 *       扣减额度、落库产物文件、把 provider 异常归一为失败/重试，并批量清理过期任务。
 *       不直接调具体供应商，而是通过注入的 AiGenerationProvider 与 AiFileStorage 协作。
 * 调用方：HTTP 路由层（建任务、查询任务接口）；cleanupExpired 由进程启动 + 每小时定时器驱动。
 * 关键点：幂等靠 user + idempotencyKey 的 advisory 锁 + 唯一约束；产物格式按真实魔数判定，
 *       不依赖 provider 临时地址的 content-type 头（历史坑：JPEG 被误标 PNG 致整批失败）。
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { ServerConfig } from "../../config/env";
import { aiQuotaInsufficient, AppError, idempotencyConflict, notFound } from "../../shared/app-error";
import { toIso } from "../../shared/date-time";
import { createEntityId } from "../../shared/identity";
import { shanghaiDate } from "../../shared/shanghai-time";
import { rollbackTransaction } from "../../shared/transaction";
import type { AiFileStorage, StoredAiFile } from "../files/ai-file-storage";
import {
  availableQuota,
  debitBucket,
  ensureDailyGrant,
  lockQuotaUser,
  readQuota,
} from "../quota/quota-ledger";
import {
  detectOutputFormat,
  isSupportedOutputFormat,
  ProviderError,
  type AiGenerationProvider,
  type ProviderTaskInput,
  type ProviderTaskStatus,
  type SupportedOutputFormat,
} from "./provider";
import { aiPublicFailure, type AiPublicFailure } from "./error-contract";
import { AI_PROMPT_VERSION, buildAiPrompt } from "./prompt-template";

export type AiGenerationStatus = "queued" | "processing" | "succeeded" | "failed" | "canceled";
export type AiGenerationStyle = "natural" | "cartoon" | "minimal";
export type AiGenerationDetailLevel = "low" | "medium" | "high";
export type AiGenerationBackgroundMode = "keep" | "simplify" | "remove";

export interface CreateAiGenerationInput {
  readonly userId: string;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly inputFileId: string;
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
}

export interface AiGenerationResponse {
  readonly id: string;
  readonly generationMode: "ai";
  readonly status: AiGenerationStatus;
  readonly inputFileId: string;
  readonly outputFile: {
    readonly id: string;
    readonly url: string;
    readonly contentType: string;
    readonly size: number;
  } | null;
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
  readonly failure: AiPublicFailure | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface AiJobRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly input_file_id: string;
  readonly input_object_key: string | null;
  readonly input_content_type: string | null;
  readonly output_file_id: string | null;
  readonly output_public_url: string | null;
  readonly output_content_type: string | null;
  readonly output_byte_size: string | number | null;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly prompt_version: string;
  readonly style: string;
  readonly detail_level: string;
  readonly background_mode: string;
  readonly generation_mode?: string;
  readonly provider_request_id: string | null;
  readonly provider_output_url: string | null;
  readonly provider_next_poll_at: Date | string | null;
  readonly idempotency_key: string;
  readonly error_code: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly expires_at: Date | string;
}

/** pindou_file_assets 输入文件的精简投影，建任务时用于校验输入是否有效。 */
interface FileRow extends QueryResultRow {
  readonly user_id: string;
  readonly file_type: string;
  readonly object_key: string;
  readonly content_type: string;
  readonly deleted_at: Date | string | null;
}

const ACTIVE_STATUSES = ["queued", "processing"] as const;
const PROVIDER_SUBMISSION_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
/**
 * provider 提交的最大尝试次数（含首次）。
 *
 * 存在的理由：混元在账号维度限流时会直接回 EXCEED_REQUEST_LIMIT（线上实测 1 秒内返回，
 * 无 httpStatus），旧实现遇到它立刻 markFailed —— 任务永久失败、用户只能自己点重试，
 * 而重试又会撞上同一波限流。限流/瞬时不可用属于「等一会儿就好」的错误，
 * 这里先退避重试，耗尽才判失败；此时任务仍停在 processing，前端轮询能自然等到结果。
 */
const PROVIDER_SUBMISSION_MAX_ATTEMPTS = 3;
/** 重试退避基数：第 n 次重试前等 base * 2^(n-1)（1.5s / 3s），再叠加 ≤25% 抖动打散重试风暴。 */
const PROVIDER_RETRY_BASE_DELAY_MS = 1_500;
/** 两次 provider 提交之间的最小间隔：主动降速，从源头少撞 EXCEED_REQUEST_LIMIT。 */
const PROVIDER_SUBMISSION_MIN_INTERVAL_MS = 800;
/**
 * 撞到 provider 限流后的**全局冷却期**。
 *
 * 存在的理由：混元的 EXCEED_REQUEST_LIMIT 是**账号维度**限流 —— 一个任务被限流，
 * 说明此刻整个账号都进不去，其它任务此刻提交必然也被拒。此时正确做法是「全体停手等一会儿」，
 * 而旧实现让每个任务各自退避后继续撞：N 个任务 × 每个轮询请求各撞一次，
 * 等于把限流窗口自己拖长，最后全部耗尽重试一起失败（线上表现：任务 1 秒内判死，
 * 用户连点重试又撞同一波限流）。
 * 冷却期内任务停在 queued、请求立即返回（不调 provider、也不占用请求时间），
 * 冷却结束后由下一轮轮询自然重试。
 */
const PROVIDER_RATE_LIMIT_COOLDOWN_MS = 8_000;
/**
 * 冷却期上限。
 *
 * 存在的理由（2026-09-25 线上实测）：旧实现的 1.5s / 3.3s 两次退避**全部撞墙**，
 * 说明限流窗口明显长于 5s —— 固定 8s 很可能同样不够。所以冷却按撞墙次数指数增长
 * （8s → 16s → 32s → 60s 封顶）：撞得越多，说明这一波限流越久。
 * 封顶是为了不让用户在「排队中」无限等下去，超过总尝试次数后会拿到终态失败。
 */
const PROVIDER_RATE_LIMIT_MAX_COOLDOWN_MS = 60_000;
/**
 * 单个任务最多撞几次限流。
 *
 * 存在的理由：冷却重试必须有个终点 —— 限流持续数分钟时，用户不该无限期卡在「排队中」，
 * 也不该每小时被重试刷一次。超过次数才判失败（对外仍是 AI_SERVICE_BUSY / RETRY）。
 * 计数在进程内，进程重启会清零：那条路径由 advance 的提交超时判据兜底。
 */
const PROVIDER_RATE_LIMIT_MAX_ATTEMPTS = 6;
/**
 * 任务被领走（processing 且尚无 requestId）后的静置期。
 * 期间其它推进者（并发轮询）不再重复提交；超过则由下一个推进者接手，兼顾进程崩溃后的恢复。
 */
const PROVIDER_SUBMISSION_RECLAIM_DELAY_MS = 30 * 1_000;
/**
 * 失败任务被同一幂等键重新排队前的冷却期。
 * 没有它时，用户连点重试（或旧客户端沿用旧幂等键）会在限流窗口里不间断重投，把限流刷得更狠。
 */
const FAILED_JOB_REQUEUE_COOLDOWN_MS = 10 * 1_000;
function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mapJob(row: AiJobRow): AiGenerationResponse {
  if (
    !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])
    && row.status !== "succeeded"
    && row.status !== "failed"
    && row.status !== "canceled"
  ) throw new Error("数据库 AI 任务状态无效");
  if (row.style !== "natural" && row.style !== "cartoon" && row.style !== "minimal") {
    throw new Error("数据库 AI 任务风格无效");
  }
  if (row.detail_level !== "low" && row.detail_level !== "medium" && row.detail_level !== "high") {
    throw new Error("数据库 AI 任务细节等级无效");
  }
  if (row.background_mode !== "keep" && row.background_mode !== "simplify" && row.background_mode !== "remove") {
    throw new Error("数据库 AI 任务背景模式无效");
  }
  if (row.generation_mode !== undefined && row.generation_mode !== "ai") {
    throw new Error("数据库 AI 任务生成模式无效");
  }
  const hasOutput = row.output_file_id && row.output_public_url && row.output_content_type
    && row.output_byte_size !== null;
  if (row.status === "succeeded" && !hasOutput) throw new Error("成功 AI 任务缺少输出文件");
  const failure = row.status === "failed" || row.status === "canceled"
    ? (aiPublicFailure(row.error_code) ?? aiPublicFailure("AI_GENERATION_FAILED"))
    : null;
  return {
    id: row.id,
    generationMode: "ai",
    status: row.status as AiGenerationStatus,
    inputFileId: row.input_file_id,
    outputFile: hasOutput ? {
      id: row.output_file_id!,
      url: row.output_public_url!,
      contentType: row.output_content_type!,
      size: Number(row.output_byte_size),
    } : null,
    style: row.style,
    detailLevel: row.detail_level,
    backgroundMode: row.background_mode,
    failure,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: nullableIso(row.completed_at),
  };
}

/** 从异常取内部错误码；是 AppError 取其 code（截断 80 字符），否则兜底内部错误码。 */
function failureCode(error: unknown): string {
  if (error instanceof AppError) return error.code.slice(0, 80);
  return "AI_GENERATION_INTERNAL_ERROR";
}

/** 按真实检测到的产物格式决定落库文件名与 contentType（jpg/jpeg、webp、默认 png）。 */
function outputFileName(
  format: SupportedOutputFormat,
): { readonly filename: string; readonly contentType: string } {
  if (format === "jpeg") return { filename: "output.jpg", contentType: "image/jpeg" };
  if (format === "webp") return { filename: "output.webp", contentType: "image/webp" };
  return { filename: "output.png", contentType: "image/png" };
}

const JOB_SELECT = `SELECT jobs.id, jobs.user_id, jobs.input_file_id,
       input_file.object_key AS input_object_key,
       input_file.content_type AS input_content_type,
       jobs.output_file_id, output_file.public_url AS output_public_url,
       output_file.content_type AS output_content_type,
       output_file.byte_size AS output_byte_size,
       jobs.provider, jobs.model, jobs.status, jobs.prompt_version,
       jobs.style, jobs.detail_level, jobs.background_mode, jobs.generation_mode,
       jobs.provider_request_id, jobs.provider_output_url, jobs.provider_next_poll_at,
       jobs.idempotency_key, jobs.error_code,
       jobs.created_at, jobs.updated_at, jobs.started_at, jobs.completed_at, jobs.expires_at
  FROM pindou_ai_generation_jobs jobs
  JOIN pindou_file_assets input_file ON input_file.id = jobs.input_file_id
  LEFT JOIN pindou_file_assets output_file ON output_file.id = jobs.output_file_id`;

export class PostgresAiGenerationService {
  /** 同一 job 的收口去重：避免重复下载/落库产物。 */
  private readonly outputCompletions = new Map<string, Promise<AiGenerationResponse>>();
  /** 同一 job 的提交去重：轮询与后台推进会并发进入 submit，有它才不会重复调 provider（等于自己造限流）。 */
  private readonly submissions = new Map<string, Promise<AiJobRow>>();
  /** 提交闸门：串行推进「发起时刻」，保证相邻两次提交间隔不小于 PROVIDER_SUBMISSION_MIN_INTERVAL_MS。 */
  private submissionGate: Promise<unknown> = Promise.resolve();
  private lastSubmissionAt = 0;
  /** 限流冷却到期时刻（进程内）：此刻之前不再向 provider 提交；多副本部署时各副本各自生效。 */
  private rateLimitedUntil = 0;
  /** 每个任务已撞限流的次数，用于给「一直在限流」一个终点（见 PROVIDER_RATE_LIMIT_MAX_ATTEMPTS）。 */
  private readonly rateLimitAttempts = new Map<string, number>();
  private readonly providers: ReadonlyMap<string, AiGenerationProvider>;

  public constructor(
    private readonly pool: Pool,
    private readonly provider: AiGenerationProvider,
    private readonly storage: AiFileStorage,
    private readonly quotaConfig: ServerConfig["quota"],
    private readonly now: () => Date = () => new Date(),
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    providers: ReadonlyMap<string, AiGenerationProvider> = new Map([[provider.name, provider]]),
  ) {
    this.providers = providers;
  }

  /**
   * 创建（或幂等复用）一个 AI 生成任务。
   * 流程：校验 provider 可用 → advisory 锁 + 幂等键去重 → 校验输入文件 → 检查当日额度/并发上限
   *      → 落库 queued 任务 → 后台异步 advance 推进到 processing/产出。
   * @param input 入参见 CreateAiGenerationInput；requestId 仅用于日志追踪。
   */
  public async create(input: CreateAiGenerationInput): Promise<AiGenerationResponse> {
    if (!this.provider.configured) {
      console.error(JSON.stringify({
        event: "ai_generation_provider_not_configured",
        requestId: input.requestId ?? null,
        provider: this.provider.name,
        model: this.provider.model,
      }));
      throw new AppError(503, "AI_SERVICE_UNAVAILABLE", "AI 生成暂时不可用");
    }
    const currentTime = this.now();
    const client = await this.pool.connect();
    let job: AiJobRow;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-ai:${input.userId}:${input.idempotencyKey}`,
      ]);
      await lockQuotaUser(client, input.userId);
      const existingResult = await client.query<AiJobRow>(
        `${JOB_SELECT}
          WHERE jobs.user_id = $1 AND jobs.idempotency_key = $2
          LIMIT 1`,
        [input.userId, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (
          existing.input_file_id !== input.inputFileId
          || existing.style !== input.style
          || existing.detail_level !== input.detailLevel
          || existing.background_mode !== input.backgroundMode
        ) throw idempotencyConflict("AI 生成幂等键已用于另一份请求");
        // 命中已失败的同幂等键任务时重新排队（过了冷却期才允许）：failed 是终态，
        // 直接返回它意味着客户端用旧幂等键重试永远拿回同一个失败结果、重试按钮形同虚设。
        job = this.canRequeueFailed(existing, currentTime)
          ? await this.requeueFailedJob(client, existing, currentTime)
          : existing;
      } else {
        const fileResult = await client.query<FileRow>(
          `SELECT user_id, file_type, object_key, content_type, deleted_at
             FROM pindou_file_assets
            WHERE id = $1
            LIMIT 1
            FOR SHARE`,
          [input.inputFileId],
        );
        const file = fileResult.rows[0];
        if (!file || file.deleted_at || file.file_type !== "ai_input" || file.user_id !== input.userId) {
          throw notFound("AI 输入文件不存在");
        }
        await this.ensureSubmissionQuota(client, input.userId, currentTime);

        const id = createEntityId("aijob");
        // 任务保留期：过期后由 cleanupExpired 统一判失败并清理关联文件。
        const expiresAt = new Date(currentTime.getTime() + this.retentionMs);
        const inserted = await client.query<AiJobRow>(
          `INSERT INTO pindou_ai_generation_jobs (
             id, user_id, input_file_id, output_file_id, provider, model, status,
             prompt_version, style, detail_level, background_mode, generation_mode, provider_request_id,
             provider_output_url,
             idempotency_key, error_code, created_at, updated_at, started_at,
             completed_at, expires_at
           ) VALUES ($1, $2, $3, NULL, $4, $5, 'queued', $6, $7, $8, $9, 'ai', NULL, NULL,
                     $10, NULL, $11, $11, NULL, NULL, $12)
           RETURNING *, $13::text AS input_object_key, $14::text AS input_content_type,
                     NULL::text AS output_public_url, NULL::text AS output_content_type,
                     NULL::bigint AS output_byte_size`,
          [
            id, input.userId, input.inputFileId, this.provider.name, this.provider.model,
            AI_PROMPT_VERSION, input.style, input.detailLevel, input.backgroundMode,
            input.idempotencyKey, currentTime, expiresAt, file.object_key, file.content_type,
          ],
        );
        job = inserted.rows[0]!;
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    if (job.status === "queued") {
      void this.advance(job, input.requestId).catch((error: unknown) => {
        console.error(JSON.stringify({
          event: "ai_generation_background_failed",
          requestId: input.requestId ?? null,
          jobId: job.id,
          errorCode: failureCode(error),
        }));
      });
    }
    return mapJob(job);
  }

  /** 查询任务：读取后顺带推进状态机（处理中的任务会尝试收口产出）。 */
  public async get(userId: string, jobId: string, requestId?: string): Promise<AiGenerationResponse> {
    const job = await this.readJob(this.pool, userId, jobId);
    return this.advance(job, requestId);
  }

  /**
   * 状态机推进：根据当前状态决定下一步。
   * - queued：提交给 provider（submit），拿到产出地址则进入收口；
   * - processing 无 requestId：超过提交超时则判失败；
   * - processing 已过期：判失败；已有产出地址：收口落库；
   * - 终态：直接映射返回。
   */
  private async advance(job: AiJobRow, requestId: string | undefined = undefined): Promise<AiGenerationResponse> {
    if (job.status === "queued") {
      // 限流回退过的 queued 任务会被反复重试，started_at 是它的首次提交时刻 ——
      // 拿它兜底给一个终点：内存里的限流计数会在进程重启时清零，只有这里能挡住
      // 「provider 长时间不可用 → 任务无限排队到 24 小时保留期结束」。
      if (
        job.started_at
        && this.now().getTime() - new Date(job.started_at).getTime() > PROVIDER_SUBMISSION_TIMEOUT_MS
      ) {
        return mapJob(await this.markFailed(job.user_id, job.id, "AI_SUBMISSION_TIMEOUT"));
      }
      const submitted = await this.submitOnce(job.user_id, job.id, requestId);
      if (submitted.provider_output_url) {
        return this.completeOutput(submitted, submitted.provider_output_url, requestId);
      }
      return mapJob(submitted);
    }
    if (job.status !== "processing") return mapJob(job);
    if (!job.provider_request_id) {
      // 已置 processing 但 provider 没回 requestId，且超过提交超时 → 判定提交超时失败。
      if (
        job.started_at
        && this.now().getTime() - new Date(job.started_at).getTime() > PROVIDER_SUBMISSION_TIMEOUT_MS
      ) {
        return mapJob(await this.markFailed(job.user_id, job.id, "AI_SUBMISSION_TIMEOUT"));
      }
      return mapJob(job);
    }
    // 任务整体保留期（expires_at）已过 → 过期失败。
    if (new Date(job.expires_at).getTime() <= this.now().getTime()) {
      return mapJob(await this.markFailed(job.user_id, job.id, "AI_TASK_EXPIRED"));
    }
    if (!job.provider_output_url) {
      const provider = this.providerFor(job);
      if (!provider.getTask) return mapJob(job);
      if (job.provider_next_poll_at && new Date(job.provider_next_poll_at).getTime() > this.now().getTime()) {
        return mapJob(job);
      }
      const polled = await this.pollTask(job, provider, requestId);
      if (polled.provider_output_url) return this.completeOutput(polled, polled.provider_output_url, requestId);
      return mapJob(polled);
    }
    return this.completeOutput(job, job.provider_output_url, requestId);
  }

  private providerFor(job: Pick<AiJobRow, "provider">): AiGenerationProvider {
    return this.providers.get(job.provider) ?? this.provider;
  }

  private async pollTask(
    job: AiJobRow,
    provider: AiGenerationProvider,
    requestId?: string,
  ): Promise<AiJobRow> {
    if (!job.provider_request_id || !provider.getTask) return job;
    const startedAt = Date.now();
    let status: ProviderTaskStatus;
    try {
      status = await provider.getTask(job.provider_request_id);
    } catch (error: unknown) {
      if (isProviderError(error)) {
        logProviderFailure(job, error, requestId, "poll", providerPublicCode(error), Date.now() - startedAt);
      }
      if (isTransientProviderError(error)) {
        return this.scheduleNextPoll(job, provider, isProviderError(error) ? error.failure.retryAfterMs : undefined);
      }
      return this.markFailed(job.user_id, job.id, failureCode(error));
    }
    if (status.status === "completed") {
      return this.setProviderOutput(job, status.outputUrl);
    }
    return this.scheduleNextPoll(job, provider);
  }

  private async setProviderOutput(job: AiJobRow, outputUrl: string | null): Promise<AiJobRow> {
    const currentTime = this.now();
    const result = await this.pool.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET provider_output_url = $2, provider_next_poll_at = NULL, updated_at = $3
        WHERE id = $1 AND user_id = $4 AND status = 'processing'
        RETURNING *, $5::text AS input_object_key, $6::text AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [job.id, outputUrl, currentTime, job.user_id, job.input_object_key, job.input_content_type],
    );
    return result.rows[0] ?? this.readJob(this.pool, job.user_id, job.id);
  }

  private async scheduleNextPoll(
    job: AiJobRow,
    provider: AiGenerationProvider,
    retryAfterMs?: number,
  ): Promise<AiJobRow> {
    const currentTime = this.now();
    const delayMs = Math.max(provider.pollIntervalMs ?? 7_000, retryAfterMs ?? 0);
    const nextPollAt = new Date(currentTime.getTime() + delayMs);
    const result = await this.pool.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET provider_next_poll_at = $2, updated_at = $3
        WHERE id = $1 AND user_id = $4 AND status = 'processing'
        RETURNING *, $5::text AS input_object_key, $6::text AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [job.id, nextPollAt, currentTime, job.user_id, job.input_object_key, job.input_content_type],
    );
    return result.rows[0] ?? this.readJob(this.pool, job.user_id, job.id);
  }

  /**
   * 收口产物的并发去重壳：同一 job 同时只跑一次 completeOutputInternal，
   * 完成后从 Map 移除，避免重复下载/落库。
   */
  private async completeOutput(
    job: AiJobRow,
    outputUrl: string,
    requestId?: string,
  ): Promise<AiGenerationResponse> {
    const existing = this.outputCompletions.get(job.id);
    if (existing) return existing;
    const completion = this.completeOutputInternal(job, outputUrl, requestId);
    this.outputCompletions.set(job.id, completion);
    try {
      return await completion;
    } finally {
      if (this.outputCompletions.get(job.id) === completion) this.outputCompletions.delete(job.id);
    }
  }

  /**
   * 实际收口：下载产物字节 → 按真实魔数判定格式（png/jpeg/webp）→ 落库文件 → 标记成功。
   * 下载失败区分可重试（限流/超时/不可用，保留任务）与不可重试（直接判失败）。
   */
  private async completeOutputInternal(
    job: AiJobRow,
    outputUrl: string,
    requestId?: string,
  ): Promise<AiGenerationResponse> {
    let output: Buffer;
    const downloadStartedAt = Date.now();
    try {
      output = await this.providerFor(job).downloadOutput(outputUrl);
    } catch (error: unknown) {
      if (isProviderError(error)) {
        logProviderFailure(
          job,
          error,
          requestId,
          "download",
          providerPublicCode(error),
          Date.now() - downloadStartedAt,
          outputHost(outputUrl),
        );
      }
      if (isTransientProviderError(error)) {
        if (!isProviderError(error)) {
          logProviderFailure(job, null, requestId, "download", "AI_SERVICE_BUSY", Date.now() - downloadStartedAt, outputHost(outputUrl));
        }
        return mapJob(job);
      }
      return mapJob(await this.markFailed(job.user_id, job.id, failureCode(error)));
    }
    const detectedFormat = detectOutputFormat(output);
    if (!isSupportedOutputFormat(detectedFormat)) {
      console.error(JSON.stringify({
        event: "ai_provider_output_rejected",
        jobId: job.id,
        requestId: requestId ?? null,
        provider: job.provider,
        model: job.model,
        reason: "unsupported_format",
        detectedFormat,
        byteSize: output.length,
        signatureHex: output.subarray(0, 16).toString("hex"),
      }));
      return mapJob(await this.markFailed(job.user_id, job.id, "AI_PROVIDER_OUTPUT_INVALID"));
    }
    const outputName = outputFileName(detectedFormat);
    let stored: StoredAiFile;
    try {
      stored = await this.storage.save(
        "ai_output",
        output,
        outputName.filename,
        outputName.contentType,
      );
    } catch (error: unknown) {
      return mapJob(await this.markFailed(job.user_id, job.id, failureCode(error)));
    }
    return mapJob(await this.complete(job.user_id, job.id, stored));
  }

  /**
   * 提交入口：同一 job 并发去重。
   * 轮询（get）与 create 后的后台推进会同时进入 submit，不去重就等于同一个任务重复调 provider，
   * 既浪费额度也自己制造限流。
   */
  private async submitOnce(userId: string, jobId: string, requestId?: string): Promise<AiJobRow> {
    const existing = this.submissions.get(jobId);
    if (existing) return existing;
    const run = this.submitWithRetry(userId, jobId, requestId);
    this.submissions.set(jobId, run);
    try {
      return await run;
    } finally {
      if (this.submissions.get(jobId) === run) this.submissions.delete(jobId);
    }
  }

  /**
   * 把 queued 任务推进到 processing 并向 provider 提交生图；写入 requestId + 产出地址。
   * 并发安全：FOR UPDATE 锁 + 乐观条件（status='processing' AND provider_request_id IS NULL），
   * 重复提交只会用首次结果覆盖/复用。
   * 关键点：provider 的限流/瞬时不可用**不立刻判失败**——按 PROVIDER_SUBMISSION_MAX_ATTEMPTS
   * 退避重试，期间任务停在 processing，前端轮询自然等到结果；只有耗尽重试才 markFailed。
   */
  private async submitWithRetry(userId: string, jobId: string, requestId?: string): Promise<AiJobRow> {
    // 冷却期内不提交，直接把 queued 状态原样返回。
    // 这里刻意**不**原地等待冷却结束：等待会压在一次 HTTP 请求里，而小程序侧请求超时是 10s，
    // 把「等一会儿就好」判成网络失败，用户反而更早看到错误、还会再发一次请求。
    if (this.isRateLimited()) return this.readJob(this.pool, userId, jobId);
    const claim = await this.claimQueuedJob(userId, jobId);
    const claimed = claim.job;
    if (claimed.status !== "processing" || claimed.provider_request_id) return claimed;
    // 任务已被别的推进者领走且还在新鲜期内：交给对方，绝不重复调 provider
    // ——重复提交既浪费付费额度，本身就是在制造限流（混元限流是账号维度的）。
    if (!claim.claimed && this.submissionAgeMs(claimed) < PROVIDER_SUBMISSION_RECLAIM_DELAY_MS) {
      return claimed;
    }
    const provider = this.providerFor(claimed);
    let imageDataUrl: string | null = null;
    if (provider.name === "hunyuan") {
      let input: Awaited<ReturnType<AiFileStorage["readObject"]>>;
      try {
        input = claimed.input_object_key
          ? await this.storage.readObject(claimed.input_object_key)
          : null;
      } catch (error: unknown) {
        return this.markFailed(userId, jobId, failureCode(error));
      }
      if (!input || !claimed.input_content_type) {
        return this.markFailed(userId, jobId, "AI_INPUT_FILE_UNAVAILABLE");
      }
      imageDataUrl = `data:${claimed.input_content_type};base64,${input.buffer.toString("base64")}`;
    }
    // ToAPIs 与 TokenHub 使用服务端 AI 媒体路由提供的 HTTPS 参考图地址；
    // CloudBase 混元历史任务仍使用 data URL。
    const referenceImageUrl = provider.name !== "hunyuan" && claimed.input_object_key
      ? this.storage.publicUrl(claimed.input_object_key)
      : null;
    if (provider.name !== "hunyuan" && !referenceImageUrl) {
      return this.markFailed(userId, jobId, "AI_INPUT_FILE_UNAVAILABLE");
    }
    const prompt = buildAiPrompt({
      style: claimed.style as AiGenerationStyle,
      detailLevel: claimed.detail_level as AiGenerationDetailLevel,
      backgroundMode: claimed.background_mode as AiGenerationBackgroundMode,
    }).text;

    const providerInput: ProviderTaskInput = {
      imageDataUrl,
      referenceImageUrl,
      prompt,
      clientBusinessId: claimed.id,
    };
    let providerSubmission: Awaited<ReturnType<AiGenerationProvider["createTask"]>> | null = null;
    for (let attempt = 1; attempt <= PROVIDER_SUBMISSION_MAX_ATTEMPTS; attempt += 1) {
      const submissionStartedAt = Date.now();
      try {
        await this.waitForSubmissionSlot();
        providerSubmission = await provider.createTask(providerInput);
        break;
      } catch (error: unknown) {
        if (isProviderError(error)) {
          logProviderFailure(claimed, error, requestId, "submit", providerPublicCode(error), Date.now() - submissionStartedAt);
        }
        // 限流单独立一条路：不原地退避重试，而是开启全局冷却并把任务退回 queued。
        // 原地重试的问题见 PROVIDER_RATE_LIMIT_COOLDOWN_MS 的注释 —— 账号维度限流下，
        // 「各自退避后继续撞」比「一起等一会儿」更容易把整批任务一起拖死。
        if (isProviderError(error) && error.failure.kind === "RATE_LIMITED") {
          return this.handleRateLimited(userId, jobId);
        }
        if (isTransientProviderError(error) && attempt < PROVIDER_SUBMISSION_MAX_ATTEMPTS) {
          const delayMs = this.retryDelayMs(attempt);
          console.error(JSON.stringify({
            event: "ai_provider_submit_retry_scheduled",
            requestId: requestId ?? null,
            jobId: claimed.id,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            internalCode: failureCode(error),
          }));
          await this.sleep(delayMs);
          continue;
        }
        if (error instanceof ProviderError && error.failure.kind === "TIMEOUT") {
          return this.markFailed(userId, jobId, "AI_SUBMISSION_UNKNOWN");
        }
        return this.markFailed(userId, jobId, failureCode(error));
      }
    }
    if (!providerSubmission) return this.readJob(this.pool, userId, jobId);
    const submission = providerSubmission;

    const updatedAt = this.now();
    const nextPollAt = submission.outputUrl
      ? null
      : new Date(updatedAt.getTime() + (provider.pollIntervalMs ?? 7_000));
    const updated = await this.pool.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET provider_request_id = $2, provider_output_url = $3, provider_next_poll_at = $4, updated_at = $5
        WHERE id = $1 AND user_id = $6
          AND status = 'processing' AND provider_request_id IS NULL
        RETURNING *, $7::text AS input_object_key, $8::text AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [jobId, submission.requestId, submission.outputUrl, nextPollAt, updatedAt, userId, claimed.input_object_key, claimed.input_content_type],
    );
    this.rateLimitAttempts.delete(jobId);
    return updated.rows[0] ?? this.readJob(this.pool, userId, jobId);
  }

  /** 是否处于限流冷却期：冷却用注入时钟（this.now）而非墙钟，便于测试推进时间。 */
  private isRateLimited(): boolean {
    return this.now().getTime() < this.rateLimitedUntil;
  }

  /**
   * 撞到 provider 限流：开启全局冷却，并把任务退回 queued 等下一轮轮询重试。
   * 累计撞墙次数超过 PROVIDER_RATE_LIMIT_MAX_ATTEMPTS 才判失败（对外仍是「服务繁忙 / 可重试」）。
   */
  private async handleRateLimited(userId: string, jobId: string): Promise<AiJobRow> {
    const attempt = (this.rateLimitAttempts.get(jobId) ?? 0) + 1;
    this.rateLimitAttempts.set(jobId, attempt);
    // 指数增长：8s → 16s → 32s → 60s 封顶。撞墙次数越多，说明这一波限流窗口越长。
    const cooldownMs = Math.min(
      PROVIDER_RATE_LIMIT_COOLDOWN_MS * 2 ** (attempt - 1),
      PROVIDER_RATE_LIMIT_MAX_COOLDOWN_MS,
    );
    this.rateLimitedUntil = this.now().getTime() + cooldownMs;
    console.error(JSON.stringify({
      event: "ai_provider_rate_limited",
      jobId,
      attempt,
      maxAttempts: PROVIDER_RATE_LIMIT_MAX_ATTEMPTS,
      cooldownMs,
    }));
    if (attempt >= PROVIDER_RATE_LIMIT_MAX_ATTEMPTS) {
      this.rateLimitAttempts.delete(jobId);
      return this.markFailed(userId, jobId, "AI_PROVIDER_RATE_LIMITED");
    }
    return this.requeueAfterRateLimit(userId, jobId);
  }

  /**
   * 限流后把任务退回 queued（清掉半截的 provider 引用）。
   * 保留 started_at：它是首次提交时刻，advance 靠它给反复重试的任务一个超时终点。
   */
  private async requeueAfterRateLimit(userId: string, jobId: string): Promise<AiJobRow> {
    const result = await this.pool.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET status = 'queued', provider_request_id = NULL, provider_output_url = NULL,
              provider_next_poll_at = NULL, error_code = NULL, updated_at = $2
        WHERE id = $1 AND user_id = $3 AND status = 'processing'
        RETURNING *, NULL::text AS input_object_key, NULL::text AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [jobId, this.now(), userId],
    );
    return result.rows[0] ?? this.readJob(this.pool, userId, jobId);
  }

  /**
   * 提交闸门：把「发起提交的时刻」串成一条链，保证相邻两次提交间隔不小于
   * PROVIDER_SUBMISSION_MIN_INTERVAL_MS。混元的 EXCEED_REQUEST_LIMIT 是账号维度限流，
   * 主动降速比撞墙再退避更省事。注意只在单进程内生效，多副本部署时是「每副本各自降速」。
   */
  private async waitForSubmissionSlot(): Promise<void> {
    const run = this.submissionGate.then(async () => {
      const elapsed = Date.now() - this.lastSubmissionAt;
      const waitMs = PROVIDER_SUBMISSION_MIN_INTERVAL_MS - elapsed;
      if (waitMs > 0) await this.sleep(waitMs);
      this.lastSubmissionAt = Date.now();
    });
    this.submissionGate = run.catch(() => undefined);
    await run;
  }

  /** 第 attempt 次失败后的退避时长：base * 2^(attempt-1)，叠加 ≤25% 抖动打散同时重试的任务。 */
  private retryDelayMs(attempt: number): number {
    const base = PROVIDER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    return Math.round(base * (1 + Math.random() * 0.25));
  }

  /**
   * 抢占 queued 任务：事务内置 processing。
   * @returns job 当前行 + claimed（本次是否由自己从 queued 抢占成功）。
   *          claimed=false 表示别人/上一轮已经领走过，用于避免重复调用 provider。
   */
  private async claimQueuedJob(userId: string, jobId: string): Promise<{ job: AiJobRow; claimed: boolean }> {
    const client = await this.pool.connect();
    let claimed: AiJobRow;
    let claimedByMe = false;
    try {
      await client.query("BEGIN");
      const result = await client.query<AiJobRow>(
        `${JOB_SELECT} WHERE jobs.id = $1 AND jobs.user_id = $2 LIMIT 1 FOR UPDATE OF jobs`,
        [jobId, userId],
      );
      const current = result.rows[0];
      if (!current) throw notFound("AI 生成任务不存在");
      if (current.status !== "queued") {
        await client.query("COMMIT");
        return { job: current, claimed: false };
      }
      const updated = await client.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
            SET status = 'processing', provider_next_poll_at = NULL, started_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'queued'
          RETURNING *, $3::text AS input_object_key, $4::text AS input_content_type,
                    NULL::text AS output_public_url, NULL::text AS output_content_type,
                    NULL::bigint AS output_byte_size`,
        [current.id, this.now(), current.input_object_key, current.input_content_type],
      );
      await client.query("COMMIT");
      claimed = updated.rows[0] ?? current;
      claimedByMe = updated.rows.length > 0;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    return { job: claimed, claimed: claimedByMe };
  }

  /** 任务被领走至今的毫秒数；没有 started_at 视为无限久（允许接手）。 */
  private submissionAgeMs(job: AiJobRow): number {
    if (!job.started_at) return Number.POSITIVE_INFINITY;
    return this.now().getTime() - new Date(job.started_at).getTime();
  }

  /** 提交前校验额度：当日额度已用完（活跃任务数占满可用额度）则不允许再占一个坑。 */
  private async ensureSubmissionQuota(
    client: PoolClient,
    userId: string,
    currentTime: Date,
  ): Promise<void> {
    const quotaDate = shanghaiDate(currentTime);
    await ensureDailyGrant(
      client,
      userId,
      "ai_generation",
      quotaDate,
      this.quotaConfig.dailyAiGenerations,
      currentTime,
    );
    const quota = await readQuota(client, userId, "ai_generation", quotaDate);
    const activeResult = await client.query<{ readonly active_count: string }>(
      `SELECT COUNT(*)::text AS active_count
         FROM pindou_ai_generation_jobs
        WHERE user_id = $1
          AND status IN ('queued', 'processing')
          AND expires_at > $2`,
      [userId, currentTime],
    );
    const active = Number(activeResult.rows[0]?.active_count ?? "0");
    if (availableQuota(quota) <= active) throw aiQuotaInsufficient();
  }

  /** 冷却期内不重新排队：刚失败就重投大概率再撞同一波限流，反而把失败拖得更久。 */
  private canRequeueFailed(job: AiJobRow, currentTime: Date): boolean {
    if (job.status !== "failed") return false;
    if (!job.completed_at) return true;
    return currentTime.getTime() - new Date(job.completed_at).getTime() >= FAILED_JOB_REQUEUE_COOLDOWN_MS;
  }

  /**
   * 把已失败的同一幂等键任务重新排队（清错误码/产出引用、延长保留期）。
   * 客户端重试若沿用旧幂等键，靠它才能真的重跑（否则只会拿回旧失败结果）。
   */
  private async requeueFailedJob(client: PoolClient, job: AiJobRow, currentTime: Date): Promise<AiJobRow> {
    await this.ensureSubmissionQuota(client, job.user_id, currentTime);
    const expiresAt = new Date(currentTime.getTime() + this.retentionMs);
    const result = await client.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET status = 'queued', error_code = NULL, provider_request_id = NULL, provider_output_url = NULL,
              provider_next_poll_at = NULL,
              started_at = NULL, completed_at = NULL, expires_at = $2, updated_at = $2
        WHERE id = $1 AND status = 'failed'
        RETURNING *,
                  (SELECT object_key FROM pindou_file_assets WHERE id = input_file_id) AS input_object_key,
                  (SELECT content_type FROM pindou_file_assets WHERE id = input_file_id) AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [job.id, expiresAt],
    );
    console.error(JSON.stringify({
      event: "ai_generation_requeued",
      jobId: job.id,
      previousErrorCode: job.error_code,
    }));
    return result.rows[0] ?? job;
  }

  private async complete(userId: string, jobId: string, stored: StoredAiFile): Promise<AiJobRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockQuotaUser(client, userId);
      const currentResult = await client.query<AiJobRow>(
        `${JOB_SELECT} WHERE jobs.id = $1 AND jobs.user_id = $2 LIMIT 1 FOR UPDATE OF jobs`,
        [jobId, userId],
      );
      const current = currentResult.rows[0];
      if (!current) throw notFound("AI 生成任务不存在");
      if (current.status !== "processing") {
        await client.query("COMMIT");
        await this.storage.remove(stored.objectKey);
        return current;
      }
      const currentTime = this.now();
      const quotaDate = shanghaiDate(currentTime);
      await ensureDailyGrant(
        client, userId, "ai_generation", quotaDate,
        this.quotaConfig.dailyAiGenerations, currentTime,
      );
      const quota = await readQuota(client, userId, "ai_generation", quotaDate);
      // 扣一次额度；若当日额度已用尽则判失败并清理落库产物（避免产生无法计费的产出）。
      const bucket = debitBucket(quota);
      if (!bucket) {
        const failed = await this.updateFailed(client, current.id, "AI_QUOTA_UNAVAILABLE_AT_COMPLETION");
        await client.query("COMMIT");
        await this.storage.remove(stored.objectKey);
        return failed;
      }
      const outputFileId = createEntityId("file");
      await client.query(
        `INSERT INTO pindou_file_assets (
           id, user_id, file_type, object_key, public_url, content_type, byte_size,
           width, height, created_at, deleted_at
         ) VALUES ($1, $2, 'ai_output', $3, $4, $5, $6, $7, $8, $9, NULL)`,
        [
          outputFileId, userId, stored.objectKey, stored.publicUrl, stored.contentType,
          stored.byteSize, stored.width, stored.height, currentTime,
        ],
      );
      await client.query(
        `INSERT INTO pindou_quota_transactions (
           id, user_id, quota_kind, type, amount, source, bucket, quota_date, order_id,
           download_record_id, idempotency_key, note, created_at
         ) VALUES ($1, $2, 'ai_generation', 'usage_debit', -1, 'ai_generation', $3,
                   $4::date, NULL, NULL, $5, NULL, $6)`,
        [
          createEntityId("qt"), userId, bucket,
          bucket === "daily_free" ? quotaDate : null,
          `ai-generation:${jobId}`, currentTime,
        ],
      );
      const updated = await client.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
            SET status = 'succeeded', output_file_id = $2, provider_output_url = NULL, provider_next_poll_at = NULL, error_code = NULL,
                completed_at = $3, updated_at = $3
          WHERE id = $1
          RETURNING *, NULL::text AS input_object_key, NULL::text AS input_content_type,
                    $4::text AS output_public_url, $5::text AS output_content_type,
                    $6::bigint AS output_byte_size`,
        [jobId, outputFileId, currentTime, stored.publicUrl, stored.contentType, stored.byteSize],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ event: "ai_generation_succeeded", jobId, userId }));
      return updated.rows[0]!;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      await this.storage.remove(stored.objectKey);
      throw error;
    } finally {
      client.release();
    }
  }

  private async readJob(
    conn: Pick<Pool, "query"> | Pick<PoolClient, "query">,
    userId: string,
    jobId: string,
    forUpdate = false,
  ): Promise<AiJobRow> {
    const result = await conn.query<AiJobRow>(
      `${JOB_SELECT} WHERE jobs.id = $1 AND jobs.user_id = $2 LIMIT 1${forUpdate ? " FOR UPDATE OF jobs" : ""}`,
      [jobId, userId],
    );
    const job = result.rows[0];
    if (!job) throw notFound("AI 生成任务不存在");
    return job;
  }

  private async markFailed(userId: string, jobId: string, errorCode: string): Promise<AiJobRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.readJob(client, userId, jobId, true);
      if (current.status !== "queued" && current.status !== "processing") {
        await client.query("COMMIT");
        return current;
      }
      const failed = await this.updateFailed(client, jobId, errorCode);
      await client.query("COMMIT");
      return failed;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 实际写入 failed 状态 + error_code（截断 80 字符）+ completed_at，并打失败日志。 */
  private async updateFailed(client: PoolClient, jobId: string, errorCode: string): Promise<AiJobRow> {
    const currentTime = this.now();
    const result = await client.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET status = 'failed', provider_output_url = NULL, provider_next_poll_at = NULL, error_code = $2, completed_at = $3, updated_at = $3
        WHERE id = $1
        RETURNING *, NULL::text AS input_object_key, NULL::text AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [jobId, errorCode.slice(0, 80), currentTime],
    );
    console.error(JSON.stringify({ event: "ai_generation_failed", jobId, errorCode: errorCode.slice(0, 80) }));
    return result.rows[0]!;
  }

  /**
   * 批量清理过期任务：由进程启动 + 每小时定时器驱动。
   * 1) 把已到 expires_at 的未终结任务（及已 succeeded 的过期结果）置失败并软删关联文件；
   * 2) 清理从未被任何任务引用的孤儿输入文件。
   * 用 FOR UPDATE SKIP LOCKED 避免与其它清理/推进事务互相阻塞。
   */
  public async cleanupExpired(): Promise<void> {
    const currentTime = this.now();
    const client = await this.pool.connect();
    let objectKeys: string[] = [];
    try {
      await client.query("BEGIN");
      const expired = await client.query<{
        readonly id: string;
        readonly input_file_id: string;
        readonly input_object_key: string;
        readonly output_file_id: string | null;
        readonly output_object_key: string | null;
        readonly status: string;
      }>(
        `SELECT jobs.id, jobs.input_file_id, input_file.object_key AS input_object_key,
                jobs.output_file_id, output_file.object_key AS output_object_key, jobs.status
           FROM pindou_ai_generation_jobs jobs
           JOIN pindou_file_assets input_file ON input_file.id = jobs.input_file_id
           LEFT JOIN pindou_file_assets output_file ON output_file.id = jobs.output_file_id
          WHERE jobs.expires_at <= $1
            -- 一次性守卫：已终结的任务（completed_at 已写入）不再命中，
            -- 只有 succeeded 还需再走一轮，把过期结果置为 AI_RESULT_EXPIRED。
            -- 缺了这行守卫时，每轮清理都会把整批过期历史重新选中、重写一遍 updated_at，
            -- 表现为整表 updated_at 被周期性刷新，失去"最后业务变更时间"的意义。
            AND (jobs.completed_at IS NULL OR jobs.status = 'succeeded')
          FOR UPDATE OF jobs SKIP LOCKED`,
        [currentTime],
      );
      if (expired.rows.length > 0) {
        const jobIds = expired.rows.map((row) => row.id);
        const fileIds = expired.rows.flatMap((row) => [row.input_file_id, row.output_file_id]
          .filter((value): value is string => value !== null));
        await client.query(
          `UPDATE pindou_ai_generation_jobs
              SET status = 'failed',
                  error_code = CASE
                    WHEN status = 'succeeded' THEN 'AI_RESULT_EXPIRED'
                    ELSE COALESCE(error_code, 'AI_TASK_EXPIRED')
                  END,
                  completed_at = COALESCE(completed_at, $2), updated_at = $2
            WHERE id = ANY($1::varchar[])`,
          [jobIds, currentTime],
        );
        await client.query(
          `UPDATE pindou_file_assets
              SET deleted_at = COALESCE(deleted_at, $2)
            WHERE id = ANY($1::varchar[]) AND file_type IN ('ai_input', 'ai_output')`,
          [fileIds, currentTime],
        );
        objectKeys.push(...expired.rows.flatMap((row) => [row.input_object_key, row.output_object_key]
          .filter((value): value is string => value !== null)));
      }

      const orphanedInputs = await client.query<{ readonly id: string; readonly object_key: string }>(
        `SELECT files.id, files.object_key
           FROM pindou_file_assets files
          WHERE files.file_type = 'ai_input'
            AND files.deleted_at IS NULL
            AND files.created_at <= $1
            AND NOT EXISTS (
              SELECT 1 FROM pindou_ai_generation_jobs jobs
               WHERE jobs.input_file_id = files.id
            )
          FOR UPDATE SKIP LOCKED`,
        [new Date(currentTime.getTime() - this.retentionMs)],
      );
      if (orphanedInputs.rows.length > 0) {
        const fileIds = orphanedInputs.rows.map((row) => row.id);
        await client.query(
          `UPDATE pindou_file_assets
              SET deleted_at = $2
            WHERE id = ANY($1::varchar[]) AND file_type = 'ai_input'`,
          [fileIds, currentTime],
        );
        objectKeys.push(...orphanedInputs.rows.map((row) => row.object_key));
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    await Promise.all(objectKeys.map((objectKey) => this.storage.remove(objectKey)));
  }
}

function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

function isTransientProviderError(error: unknown): boolean {
  if (isProviderError(error)) {
    return error.failure.kind === "RATE_LIMITED"
      || error.failure.kind === "TIMEOUT"
      || (error.failure.kind === "UNAVAILABLE"
        && error.failure.httpStatus !== 401
        && error.failure.httpStatus !== 403
        && error.code !== "AI_SERVICE_UNAVAILABLE");
  }
  if (error instanceof AppError) {
    return error.code === "AI_PROVIDER_RATE_LIMITED"
      || error.code === "AI_PROVIDER_TIMEOUT"
      || error.code === "AI_PROVIDER_UNAVAILABLE";
  }
  return false;
}

/** 把 ProviderError 的失败种类翻译成对外公开的错误码（配额/超时/繁忙/失败等）。 */
function providerPublicCode(error: ProviderError): string {
  if (error.code === "CONTENT_REJECTED") return "CONTENT_REJECTED";
  if (error.failure.kind === "QUOTA_EXHAUSTED") return "AI_SERVICE_UNAVAILABLE";
  if (error.failure.kind === "TIMEOUT") return "AI_TIMEOUT";
  if (error.failure.kind === "INVALID_OUTPUT") return "AI_RESULT_INVALID";
  if (error.failure.kind === "UNAVAILABLE"
    && (error.failure.httpStatus === 401 || error.failure.httpStatus === 403
      || error.code === "AI_SERVICE_UNAVAILABLE")) return "AI_SERVICE_UNAVAILABLE";
  if (error.failure.kind === "RATE_LIMITED" || error.failure.kind === "UNAVAILABLE") {
    return "AI_SERVICE_BUSY";
  }
  return "AI_GENERATION_FAILED";
}

function logProviderFailure(
  job: AiJobRow,
  error: ProviderError | null,
  requestId: string | undefined,
  stage: "submit" | "poll" | "download",
  publicCode: string,
  duration: number,
  outputHostValue?: string | null,
): void {
  console.error(JSON.stringify({
    event: "ai_provider_failure",
    requestId: requestId ?? null,
    jobId: job.id,
    provider: job.provider,
    model: job.model,
    stage,
    promptVersion: job.prompt_version,
    publicErrorCode: aiPublicFailure(publicCode)?.code ?? "AI_GENERATION_FAILED",
    internalProviderCode: error?.failure.providerCode ?? null,
    providerFailureKind: error?.failure.kind ?? null,
    httpStatus: error?.failure.httpStatus ?? null,
    message: error?.message ? error.message.slice(0, 240) : null,
    ...(outputHostValue ? { outputHost: outputHostValue } : {}),
    duration,
  }));
}

function outputHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
