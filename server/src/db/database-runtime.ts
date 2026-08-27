import type { Pool } from "pg";
import type { DatabaseInspection } from "./schema-inspector";

export interface DatabaseHealth {
  readonly status: "up" | "down";
  readonly product: "PostgreSQL";
  readonly version: string;
  readonly schemaStatus: "valid";
}

export interface DatabaseHealthProvider {
  check(): Promise<DatabaseHealth>;
}

export class DatabaseRuntime implements DatabaseHealthProvider {
  public constructor(
    private readonly pool: Pool,
    private readonly inspection: DatabaseInspection,
  ) {}

  public async check(): Promise<DatabaseHealth> {
    await this.pool.query("SELECT 1 AS healthy");
    return {
      status: "up",
      product: this.inspection.product,
      version: this.inspection.version,
      schemaStatus: "valid",
    };
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
