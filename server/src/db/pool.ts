import { Pool, type PoolConfig } from "pg";
import type { DatabaseConfig } from "../config/env";

function sslConfig(mode: DatabaseConfig["sslMode"]): PoolConfig["ssl"] {
  if (mode === "disable") return false;
  return { rejectUnauthorized: mode === "verify-full" };
}

export function createPool(config: DatabaseConfig): Pool {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    ssl: sslConfig(config.sslMode),
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    application_name: "pindou-studio-server",
  });
  pool.on("error", () => {
    console.error(JSON.stringify({ event: "database_pool_idle_client_error" }));
  });
  return pool;
}
