import type { PoolClient } from "pg";

export async function rollbackTransaction(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // 保留触发回滚的原始错误
  }
}
