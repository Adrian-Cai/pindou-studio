import { loadLocalEnv, readDatabaseConfig } from "../config/env";
import { createPool } from "./pool";
import { inspectDatabaseSchema } from "./schema-inspector";

async function main(): Promise<void> {
  loadLocalEnv();
  const databaseConfig = readDatabaseConfig();
  const pool = createPool(databaseConfig);
  try {
    const inspection = await inspectDatabaseSchema(pool, databaseConfig.schema);
    console.log(JSON.stringify(inspection, null, 2));
    if (!inspection.valid) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "database_inspection_failed", message: (error as Error).message }));
  process.exitCode = 1;
});
