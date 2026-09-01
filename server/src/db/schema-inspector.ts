import type { Pool, PoolClient, QueryResultRow } from "pg";
import { rollbackTransaction } from "../shared/transaction";
import {
  EXPECTED_SCHEMA,
  EXPECTED_TABLES,
  REQUIRED_CONSTRAINTS,
  REQUIRED_INDEXES,
  type ExpectedColumn,
  type ExpectedTableName,
  type RequiredDatabaseObject,
} from "./schema-contract";

interface VersionRow extends QueryResultRow {
  readonly server_version: string;
  readonly database_version: string;
}

interface TableRow extends QueryResultRow {
  readonly table_name: string;
  readonly table_comment: string | null;
}

interface ColumnRow extends QueryResultRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly udt_name: string;
  readonly is_nullable: "YES" | "NO";
  readonly character_maximum_length: number | null;
  readonly column_comment: string | null;
}

interface IndexRow extends QueryResultRow {
  readonly table_name: string;
  readonly definition: string;
}

interface ConstraintRow extends QueryResultRow {
  readonly table_name: string;
  readonly type: "p" | "u" | "f" | "c";
  readonly definition: string;
}

export interface DatabaseInspection {
  readonly product: "PostgreSQL";
  readonly version: string;
  readonly schema: string;
  readonly tableCount: number;
  readonly columnCount: number;
  readonly indexCount: number;
  readonly foreignKeyCount: number;
  readonly checkConstraintCount: number;
  readonly tableCommentCount: number;
  readonly columnCommentCount: number;
  readonly valid: boolean;
  readonly differences: readonly string[];
}

export class SchemaMismatchError extends Error {
  public readonly inspection: DatabaseInspection;

  public constructor(inspection: DatabaseInspection) {
    super(`数据库结构与 docs/DATABASE_DESIGN.md 不一致（${inspection.differences.length} 项差异）`);
    this.name = "SchemaMismatchError";
    this.inspection = inspection;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasRequiredObject(
  required: RequiredDatabaseObject,
  actual: readonly (IndexRow | ConstraintRow)[],
): boolean {
  return actual.some((item) => {
    if (item.table_name !== required.table) return false;
    if (required.type !== undefined && "type" in item && item.type !== required.type) return false;
    const definition = normalize(item.definition);
    return required.includes.every((part) => definition.includes(normalize(part)));
  });
}

function compareColumns(columns: readonly ColumnRow[], differences: string[]): void {
  const schema = EXPECTED_SCHEMA as Record<ExpectedTableName, Record<string, ExpectedColumn>>;

  for (const table of EXPECTED_TABLES) {
    const expectedColumns = schema[table];
    const actualColumns = columns.filter((item) => item.table_name === table);
    const actualByName = new Map(actualColumns.map((item) => [item.column_name, item]));

    for (const [name, expected] of Object.entries(expectedColumns)) {
      const actual = actualByName.get(name);
      if (!actual) {
        differences.push(`${table}.${name} 字段缺失`);
        continue;
      }
      if (actual.udt_name !== expected.type) {
        differences.push(`${table}.${name} 类型应为 ${expected.type}，实际为 ${actual.udt_name}`);
      }
      const actualNullable = actual.is_nullable === "YES";
      if (actualNullable !== expected.nullable) {
        differences.push(`${table}.${name} 可空性应为 ${expected.nullable ? "NULL" : "NOT NULL"}`);
      }
      if (expected.length !== undefined && actual.character_maximum_length !== expected.length) {
        differences.push(`${table}.${name} 长度应为 ${expected.length}，实际为 ${actual.character_maximum_length ?? "无限制"}`);
      }
    }

    for (const actual of actualColumns) {
      if (!(actual.column_name in expectedColumns)) {
        differences.push(`${table}.${actual.column_name} 是设计文档未定义的字段`);
      }
    }
  }
}

async function readMetadata(client: PoolClient, schema: string): Promise<{
  version: VersionRow;
  tables: TableRow[];
  columns: ColumnRow[];
  indexes: IndexRow[];
  constraints: ConstraintRow[];
}> {
  const versionResult = await client.query<VersionRow>(
    "SELECT current_setting('server_version') AS server_version, version() AS database_version",
  );
  const version = versionResult.rows[0];
  if (!version || !version.database_version.startsWith("PostgreSQL")) {
    throw new Error("数据库产品不是 PostgreSQL");
  }

  const tables = await client.query<TableRow>(
    `SELECT t.table_name, obj_description(c.oid, 'pg_class') AS table_comment
       FROM information_schema.tables t
       JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema
       JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
      WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name`,
    [schema],
  );
  const columns = await client.query<ColumnRow>(
    `SELECT col.table_name,
            col.column_name,
            col.udt_name,
            col.is_nullable,
            col.character_maximum_length,
            description.description AS column_comment
       FROM information_schema.columns col
       JOIN pg_catalog.pg_namespace n ON n.nspname = col.table_schema
       JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = col.table_name
       LEFT JOIN pg_catalog.pg_description description
         ON description.objoid = c.oid AND description.objsubid = col.ordinal_position
      WHERE col.table_schema = $1
      ORDER BY col.table_name, col.ordinal_position`,
    [schema],
  );
  const indexes = await client.query<IndexRow>(
    `SELECT tablename AS table_name, indexdef AS definition
       FROM pg_catalog.pg_indexes
      WHERE schemaname = $1
      ORDER BY tablename, indexname`,
    [schema],
  );
  const constraints = await client.query<ConstraintRow>(
    `SELECT relation.relname AS table_name,
            constraint_record.contype::text AS type,
            pg_get_constraintdef(constraint_record.oid, true) AS definition
       FROM pg_catalog.pg_constraint constraint_record
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_record.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND constraint_record.contype IN ('p', 'u', 'f', 'c')
      ORDER BY relation.relname, constraint_record.contype, constraint_record.conname`,
    [schema],
  );

  return {
    version,
    tables: tables.rows,
    columns: columns.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
  };
}

export async function inspectDatabaseSchema(pool: Pool, schema: string): Promise<DatabaseInspection> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const metadata = await readMetadata(client, schema);
    const differences: string[] = [];
    const actualTables = new Set(metadata.tables.map((item) => item.table_name));

    for (const table of EXPECTED_TABLES) {
      if (!actualTables.has(table)) differences.push(`${schema}.${table} 表缺失`);
    }
    for (const table of actualTables) {
      if (!EXPECTED_TABLES.includes(table as ExpectedTableName)) {
        differences.push(`${schema}.${table} 是设计文档未定义的表`);
      }
    }

    compareColumns(metadata.columns, differences);

    for (const table of metadata.tables) {
      if (!table.table_comment?.trim()) differences.push(`${table.table_name} 缺少表注释`);
    }
    for (const column of metadata.columns) {
      if (!column.column_comment?.trim()) differences.push(`${column.table_name}.${column.column_name} 缺少字段注释`);
    }
    for (const required of REQUIRED_INDEXES) {
      if (!hasRequiredObject(required, metadata.indexes)) {
        differences.push(`${required.table} 缺少${required.label}`);
      }
    }
    for (const required of REQUIRED_CONSTRAINTS) {
      if (!hasRequiredObject(required, metadata.constraints)) {
        differences.push(`${required.table} 缺少${required.label}`);
      }
    }

    const report: DatabaseInspection = {
      product: "PostgreSQL",
      version: metadata.version.server_version,
      schema,
      tableCount: metadata.tables.length,
      columnCount: metadata.columns.length,
      indexCount: metadata.indexes.length,
      foreignKeyCount: metadata.constraints.filter((item) => item.type === "f").length,
      checkConstraintCount: metadata.constraints.filter((item) => item.type === "c").length,
      tableCommentCount: metadata.tables.filter((item) => Boolean(item.table_comment?.trim())).length,
      columnCommentCount: metadata.columns.filter((item) => Boolean(item.column_comment?.trim())).length,
      valid: differences.length === 0,
      differences,
    };
    await client.query("ROLLBACK");
    return report;
  } catch (error: unknown) {
    try {
      await rollbackTransaction(client);
    } catch {
      // 原始错误更有诊断价值；连接关闭时回滚失败不覆盖它。
    }
    throw error;
  } finally {
    client.release();
  }
}

export function assertValidSchema(inspection: DatabaseInspection): void {
  if (!inspection.valid) throw new SchemaMismatchError(inspection);
}
