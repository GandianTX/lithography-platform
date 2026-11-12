// scripts/mock-v13/db.ts

/**
 * 极简 SQL 访问层：只做参数化查询、按稳定键查重与插入。
 * 不修改 Entity、不建表、不改约束；表结构必须由正式迁移预先部署。
 */

import type { ResultSetHeader } from 'mysql2/promise';

import { MockWriteError } from './errors';

export interface MockQueryRunner {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/u;

export function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new MockWriteError(`非法标识符: ${identifier}`);
  }
  return `\`${identifier}\``;
}

type Scalar = string | number | boolean | Date | null;

export type Row = Record<string, unknown>;

export function asRows(result: unknown): Row[] {
  return Array.isArray(result) ? (result as Row[]) : [];
}

export function asInsertId(result: unknown): number {
  const header = result as ResultSetHeader;
  if (!header || typeof header.insertId !== 'number') {
    throw new MockWriteError('INSERT 未返回 insertId');
  }
  return header.insertId;
}

export function asAffectedRows(result: unknown): number {
  const header = result as ResultSetHeader;
  return typeof header?.affectedRows === 'number' ? header.affectedRows : 0;
}

export async function findOne(
  queryRunner: MockQueryRunner,
  table: string,
  where: Readonly<Record<string, Scalar>>,
): Promise<Row | null> {
  const entries = Object.entries(where);
  if (entries.length === 0) {
    throw new MockWriteError('findOne 不允许空条件');
  }
  const clauses = entries.map(([column, value]) =>
    value === null ? `${quoteIdentifier(column)} IS NULL` : `${quoteIdentifier(column)} = ?`,
  );
  const parameters = entries.filter(([, value]) => value !== null).map(([, value]) => value);
  const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${clauses.join(' AND ')} LIMIT 1`;
  const rows = asRows(await queryRunner.query(sql, parameters));
  return rows[0] ?? null;
}

export async function findMany(
  queryRunner: MockQueryRunner,
  table: string,
  where: Readonly<Record<string, Scalar>>,
  orderBy = 'id ASC',
  limit = 50,
): Promise<Row[]> {
  const entries = Object.entries(where);
  const clauses = entries.map(([column, value]) =>
    value === null ? `${quoteIdentifier(column)} IS NULL` : `${quoteIdentifier(column)} = ?`,
  );
  const parameters = entries.filter(([, value]) => value !== null).map(([, value]) => value);
  const sql = `SELECT * FROM ${quoteIdentifier(table)}${
    clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  } ORDER BY ${orderBy} LIMIT ${Number(limit)}`;
  return asRows(await queryRunner.query(sql, parameters));
}

/** 列出当前库全部表及其列名，用于在写入前核对 V13 结构是否补齐。 */
export async function listTableColumns(
  queryRunner: MockQueryRunner,
): Promise<Map<string, Set<string>>> {
  const rows = asRows(
    await queryRunner.query(
      'SELECT table_name AS tableName, column_name AS columnName FROM information_schema.columns WHERE table_schema = DATABASE()',
    ),
  );
  const tableColumns = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = toText(row.tableName ?? row.TABLE_NAME);
    const column = toText(row.columnName ?? row.COLUMN_NAME);
    if (!table || !column) continue;
    const columns = tableColumns.get(table) ?? new Set<string>();
    columns.add(column);
    tableColumns.set(table, columns);
  }
  return tableColumns;
}

export async function insertRow(
  queryRunner: MockQueryRunner,
  table: string,
  data: Readonly<Record<string, Scalar>>,
): Promise<number> {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    throw new MockWriteError(`拒绝向 ${table} 插入空行`);
  }
  const columns = entries.map(([column]) => quoteIdentifier(column)).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  const values = entries.map(([, value]) => value);
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${placeholders})`;
  try {
    return asInsertId(await queryRunner.query(sql, values));
  } catch (error) {
    throw new MockWriteError(`写入 ${table} 失败: ${(error as Error).message}`);
  }
}

export async function updateRow(
  queryRunner: MockQueryRunner,
  table: string,
  where: Readonly<Record<string, Scalar>>,
  data: Readonly<Record<string, Scalar>>,
): Promise<number> {
  const whereEntries = Object.entries(where);
  const dataEntries = Object.entries(data);
  if (whereEntries.length === 0 || dataEntries.length === 0) {
    throw new MockWriteError('updateRow 需要非空条件与非空赋值');
  }
  const whereClauses = whereEntries.map(([column, value]) =>
    value === null ? `${quoteIdentifier(column)} IS NULL` : `${quoteIdentifier(column)} = ?`,
  );
  const whereParameters = whereEntries
    .filter(([, value]) => value !== null)
    .map(([, value]) => value);
  const setClause = dataEntries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ');
  const setParameters = dataEntries.map(([, value]) => value);
  const sql = `UPDATE ${quoteIdentifier(table)} SET ${setClause} WHERE ${whereClauses.join(' AND ')}`;
  try {
    return asAffectedRows(await queryRunner.query(sql, [...setParameters, ...whereParameters]));
  } catch (error) {
    throw new MockWriteError(`更新 ${table} 失败: ${(error as Error).message}`);
  }
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function listTableNames(queryRunner: MockQueryRunner): Promise<string[]> {
  const rows = asRows(
    await queryRunner.query(
      'SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE()',
    ),
  );
  return rows.map((row) => toText(row.tableName ?? row.TABLE_NAME));
}

export async function readTargetFacts(queryRunner: MockQueryRunner): Promise<{
  database: string;
  instanceUuid: string;
  readOnly: number;
}> {
  const rows = asRows(
    await queryRunner.query('SELECT DATABASE() AS db, @@server_uuid AS uuid, @@read_only AS ro'),
  );
  const row = rows[0] ?? {};
  return {
    database: toText(row.db),
    instanceUuid: toText(row.uuid),
    readOnly: Number(row.ro ?? 1),
  };
}

/** 同一目标库内串行化，避免并发执行产生同义行。 */
export async function acquireRunLock(
  queryRunner: MockQueryRunner,
  database: string,
  timeoutSeconds = 30,
): Promise<boolean> {
  const rows = asRows(
    await queryRunner.query('SELECT GET_LOCK(?, ?) AS acquired', [
      `${'mock-v13'}:${database}`,
      timeoutSeconds,
    ]),
  );
  return Number(rows[0]?.acquired ?? 0) === 1;
}

export async function releaseRunLock(
  queryRunner: MockQueryRunner,
  database: string,
): Promise<void> {
  await queryRunner.query('SELECT RELEASE_LOCK(?)', [`${'mock-v13'}:${database}`]);
}
