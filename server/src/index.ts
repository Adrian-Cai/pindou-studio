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
import { PostgresAuthRepository } from "./modules/auth/auth-repository";
import { AuthService } from "./modules/auth/auth-service";
import { BearerTokenAuthenticator } from "./modules/auth/authenticator";
import { OfficialWeChatLoginClient } from "./modules/auth/wechat-client";
import { FileSystemAvatarStorage } from "./modules/users/avatar-storage";
import { PostgresUserProfileService } from "./modules/users/user-profile-service";

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
    const http = await startHttpServer(
      createHttpApplication({
        database,
        auth: new AuthService(
          authRepository,
          new OfficialWeChatLoginClient(config.wechat),
          config.auth,
        ),
        authenticator: new BearerTokenAuthenticator(authRepository),
        users: new PostgresUserProfileService(pool, config.quota),
        avatars,
        avatarMaximumBytes: config.avatars.maximumBytes,
      }),
      config.host,
      config.port,
    );
    return {
      inspection,
      http,
      close: async () => {
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
