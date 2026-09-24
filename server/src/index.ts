import { ConfigError, loadLocalEnv, readConfig, type ServerConfig } from "./config/env";
import { DatabaseRuntime } from "./db/database-runtime";
import { createPool } from "./db/pool";
import {
  SchemaMismatchError,
  assertValidSchema,
  inspectDatabaseSchema,
  type DatabaseInspection,
} from "./db/schema-inspector";
import { createHttpApplication } from "./http/app";
import { startHttpServer, type RunningHttpServer } from "./http/server";
import { InMemoryRateLimiter } from "./http/rate-limit";
import { PostgresAuthRepository } from "./modules/auth/auth-repository";
import { AuthService } from "./modules/auth/auth-service";
import { BearerTokenAuthenticator } from "./modules/auth/authenticator";
import { OfficialWeChatLoginClient } from "./modules/auth/wechat-client";
import { FileSystemAvatarStorage } from "./modules/users/avatar-storage";
import { PostgresUserProfileService } from "./modules/users/user-profile-service";
import { FileSystemCoverStorage } from "./modules/files/cover-storage";
import { PostgresFileAssetService } from "./modules/files/file-asset-service";
import { FileSystemAiFileStorage } from "./modules/files/ai-file-storage";
import { HunyuanImageProvider } from "./modules/ai/hunyuan-image-provider";
import { PostgresAiGenerationService } from "./modules/ai/ai-generation-service";
import { PostgresQuotaDownloadService } from "./modules/downloads/quota-download-service";
import { PostgresPaymentService } from "./modules/payments/payment-service";
import { createWeChatPaymentGateway } from "./modules/payments/wechat-pay-client";
import { createVirtualPayGateway } from "./modules/payments/virtual-pay-client";
import { PostgresWorkService } from "./modules/works/work-service";
import { FileSystemContentSecurityMediaStorage } from "./modules/content-security/media-storage";
import { OfficialWeChatContentSecurityClient } from "./modules/content-security/wechat-client";
import { PostgresContentSecurityService } from "./modules/content-security/content-security-service";

export interface RunningApplication {
  readonly inspection: DatabaseInspection;
  readonly http: RunningHttpServer;
  close(): Promise<void>;
}

export async function startApplication(config: ServerConfig): Promise<RunningApplication> {
  const pool = createPool(config.database);
  try {
    const inspection = await inspectDatabaseSchema(pool, config.database.schema);
    assertValidSchema(inspection);
    const database = new DatabaseRuntime(pool, inspection);
    const authRepository = new PostgresAuthRepository(pool);
    const avatars = new FileSystemAvatarStorage(config.avatars.storageDirectory);
    const covers = new FileSystemCoverStorage(
      config.covers.storageDirectory,
      config.covers.publicBaseUrl,
    );
    const paymentGateway = await createWeChatPaymentGateway(config.wechatPay);
    const virtualPayGateway = createVirtualPayGateway(config.virtualPay, config.wechat.appSecret);
    const aiFiles = new FileSystemAiFileStorage(
      config.aiFiles.storageDirectory,
      config.aiFiles.publicBaseUrl,
      config.aiFiles,
    );
    const users = new PostgresUserProfileService(pool, config.quota, () => new Date(), {
      avatars,
      covers,
      aiFiles,
    });
    const contentSecurity = new PostgresContentSecurityService(
      pool,
      new OfficialWeChatContentSecurityClient(
        config.wechat.appId,
        config.wechat.appSecret,
        config.wechat.timeoutMs,
      ),
      new FileSystemContentSecurityMediaStorage(
        config.contentSecurity.mediaStorageDirectory,
        config.contentSecurity.mediaPublicBaseUrl,
      ),
      config.wechat.appId,
      config.contentSecurity.messageToken,
      config.auth.openidHashSecret,
      () => new Date(),
      config.contentSecurity.asyncMediaCheckEnabled,
    );
    const hunyuanImage = new HunyuanImageProvider(config.hunyuanImage);
    const aiGenerations = new PostgresAiGenerationService(
      pool,
      hunyuanImage,
      aiFiles,
      config.quota,
      () => new Date(),
      config.aiFiles.retentionMs,
    );
    const aiRateLimiter = new InMemoryRateLimiter(
      config.aiRateLimit.maximumRequests,
      config.aiRateLimit.windowMs,
    );
    void aiGenerations.cleanupExpired().catch(() => undefined);
    const aiCleanupTimer = setInterval(() => {
      void aiGenerations.cleanupExpired().catch(() => undefined);
    }, Math.min(config.aiFiles.retentionMs, 60 * 60 * 1_000));
    aiCleanupTimer.unref();
    /**
     * 虚拟支付发货补单轮询。
     *
     * 官方把「发货推送」与「发货轮询」并列为两条必选支路：推送会丢、success 回调会丢，
     * 少了轮询就等于默许「用户扣了款、次数没到账」且系统毫无告警。
     * 启动先跑一次是为了重启期间丢掉的推送能被立刻捞回来，而不是白等一个间隔。
     *
     * reconcilePendingOrders 内部已吞掉所有异常（单笔失败记告警后继续），
     * 这里的 catch 只是防止将来漏网的错误打穿进程。
     */
    const payments = new PostgresPaymentService(
      pool,
      virtualPayGateway,
      paymentGateway,
      config.auth.openidHashSecret,
      () => new Date(),
      config.virtualPayReconcile,
      config.newUserPackageGateEnabled,
    );
    void payments.reconcilePendingOrders().catch(() => undefined);
    const paymentReconcileTimer = setInterval(() => {
      void payments.reconcilePendingOrders().catch(() => undefined);
    }, config.virtualPayReconcile.intervalMs);
    paymentReconcileTimer.unref();
    const http = await startHttpServer(
      createHttpApplication({
        database,
        auth: new AuthService(
          authRepository,
          new OfficialWeChatLoginClient(config.wechat),
          config.auth,
        ),
        authenticator: new BearerTokenAuthenticator(authRepository),
        users,
        avatars,
        avatarMaximumBytes: config.avatars.maximumBytes,
        files: new PostgresFileAssetService(pool, covers, () => new Date(), aiFiles),
        covers,
        aiFiles,
        works: new PostgresWorkService(pool),
        quotaDownloads: new PostgresQuotaDownloadService(pool, config.quota),
        payments,
        coverMaximumBytes: config.covers.maximumBytes,
        aiFileMaximumBytes: config.aiFiles.maximumBytes,
        aiRateLimiter,
        contentSecurity,
        contentSecurityMediaMaximumBytes: config.contentSecurity.mediaMaximumBytes,
        virtualPayPush: config.virtualPayPush,
        aiGenerations,
        capabilities: {
          wechatPay: paymentGateway.configured,
          aiGeneration: hunyuanImage.configured,
          persistentStorage: config.deployment.persistentStorageMounted,
          httpsPublicUrls: config.covers.publicBaseUrl.startsWith("https://")
            && config.aiFiles.publicBaseUrl.startsWith("https://"),
          monitoringAlerts: config.deployment.monitoringAlertsConfigured,
          contentSecurity: Boolean(config.contentSecurity.messageToken),
        },
      }),
      config.host,
      config.port,
    );
    return {
      inspection,
      http,
      close: async () => {
        clearInterval(aiCleanupTimer);
        clearInterval(paymentReconcileTimer);
        await http.close();
        await database.close();
      },
    };
  } catch (error: unknown) {
    await pool.end();
    throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const config = readConfig();
  const running = await startApplication(config);
  console.log(
    JSON.stringify({
      event: "server_started",
      host: config.host,
      port: running.http.port,
      database: {
        product: running.inspection.product,
        version: running.inspection.version,
        schema: running.inspection.schema,
        schemaStatus: "valid",
        tableCount: running.inspection.tableCount,
      },
    }),
  );

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: "server_stopping", signal }));
    await running.close();
    console.log(JSON.stringify({ event: "server_stopped" }));
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(JSON.stringify({ event: "configuration_invalid", issues: error.issues }));
    } else if (error instanceof SchemaMismatchError) {
      console.error(
        JSON.stringify({ event: "database_schema_mismatch", differences: error.inspection.differences }),
      );
    } else {
      console.error(JSON.stringify({ event: "server_start_failed", message: (error as Error).message }));
    }
    process.exitCode = 1;
  });
}
