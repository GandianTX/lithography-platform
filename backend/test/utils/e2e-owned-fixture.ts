import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import {
  assertAllowedE2eDatabase,
  assertDataSourceOnAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
  assertPhysicalCleanupConsent,
  resolveAllowedE2eDatabases,
  resolveExpectedE2eDatabase,
} from './e2e-db-guard';

/**
 * 受控夹具清理机制（测试基础设施）。
 *
 * 设计约束：
 * - 删除语句只能由「已登记、已核验」的表名与主键生成，调用方不能传入任意删除目标；
 * - 表名与主键结构来自下方受控定义，未受控表一律拒绝；
 * - 清理在单连接单事务内完成：先锁定并逐字段核验，再核验引用闭包，最后按子表→父表逐行精确删除；
 * - 任一失败立即回滚整批，不继续逐条删除；
 * - 清理入口自行校验显式许可、库名白名单与实际库，不依赖调用方是否已检查。
 */

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

const quoteIdentifier = (name: string): string => {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`非法标识符：${name}`);
  }
  return `\`${name}\``;
};

/**
 * 受控表定义：表名 → 主键列。
 * `engineer_response` 仅作为引用来源参与闭包核验，不允许登记为可删除夹具。
 */
export const FIXTURE_TABLE_PRIMARY_KEYS = {
  organization: ['id'],
  base_user_account: ['id'],
  equipment_model: ['id'],
  organization_membership: ['id'],
  repair_request: ['id'],
  maintenance_report: ['id'],
  maintenance_report_alarm: ['id'],
  maintenance_report_step: ['id'],
  maintenance_report_version: ['id'],
  maintenance_report_review: ['id'],
  maintenance_report_attachment: ['id'],
  maintenance_report_version_attachment: ['version_id', 'attachment_id'],
  local_upload_task: ['id'],
  engineer_response: ['id'],
} as const satisfies Record<string, readonly string[]>;

export type ControlledFixtureTable = keyof typeof FIXTURE_TABLE_PRIMARY_KEYS;

/**
 * 受控删除顺序：子表在前，父表在后。
 * 只包含允许登记为夹具的受控表；引用来源表不在其中。
 */
export const FIXTURE_TABLE_DELETE_ORDER = [
  'maintenance_report_version_attachment',
  'maintenance_report_review',
  'maintenance_report_version',
  'maintenance_report_attachment',
  'maintenance_report_alarm',
  'maintenance_report_step',
  'maintenance_report',
  'local_upload_task',
  'repair_request',
  'equipment_model',
  'organization_membership',
  'base_user_account',
  'organization',
] as const satisfies readonly ControlledFixtureTable[];

export type DeletableFixtureTable = (typeof FIXTURE_TABLE_DELETE_ORDER)[number];

/**
 * 数据库维护的时间列：核验时要求行存在并逐字段比较其余列，
 * 这些列不参与严格比较（需要时可经 applyExpectedChange 的受限读取登记）。
 */
const VOLATILE_COLUMNS = new Set(['updated_at']);

/** 所有权/身份列不允许通过预期变更改写 */
const PROTECTED_COLUMNS = new Set([
  'created_at',
  'created_by_account_id',
  'owner_organization_id',
  'organization_id',
  'customer_account_id',
  'account_id',
  'installation_id',
]);

const primaryKeyOf = (table: string): readonly string[] => {
  const definition = (FIXTURE_TABLE_PRIMARY_KEYS as Record<string, readonly string[]>)[table];
  if (!definition) {
    throw new Error(`拒绝使用未受控的夹具表：${table}`);
  }
  return definition;
};

const isDeletableTable = (table: string): table is DeletableFixtureTable =>
  (FIXTURE_TABLE_DELETE_ORDER as readonly string[]).includes(table);

export type OwnedFixtureKey = Readonly<Record<string, number>>;

export interface OwnedFixtureRow {
  readonly table: ControlledFixtureTable;
  readonly key: OwnedFixtureKey;
  readonly expected: Readonly<Record<string, unknown>>;
}

const normalizeKey = (table: string, keyOrId: number | OwnedFixtureKey): OwnedFixtureKey => {
  const columns = primaryKeyOf(table);
  if (typeof keyOrId === 'number') {
    if (columns.length !== 1) {
      throw new Error(`复合主键表 ${table} 必须显式提供各键列：${columns.join(', ')}`);
    }
    const key: Record<string, number> = {};
    key[columns[0]] = keyOrId;
    return key;
  }
  const provided = Object.keys(keyOrId);
  if (columns.length !== provided.length || !columns.every((column) => provided.includes(column))) {
    throw new Error(
      `主键结构不匹配：${table} 需要 ${columns.join(', ')}，实际 ${provided.join(', ')}`,
    );
  }
  const key: Record<string, number> = {};
  for (const column of columns) {
    const value = keyOrId[column];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`主键列 ${table}.${column} 必须为正整数，实际 ${String(value)}`);
    }
    key[column] = value;
  }
  return key;
};

const keyOf = (table: string, key: OwnedFixtureKey): string => {
  const columns = primaryKeyOf(table);
  return `${table}#${columns.map((column) => String(key[column])).join('/')}`;
};

const displayOf = (table: string, key: OwnedFixtureKey): string => {
  const columns = primaryKeyOf(table);
  return `${table}(${columns.map((column) => `${column}=${String(key[column])}`).join(', ')})`;
};

export const describeOwnedFixtureRows = (rows: readonly OwnedFixtureRow[]): string =>
  rows.map((row) => displayOf(row.table, row.key)).join('；');

const detailOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/**
 * 本轮夹具登记账本。
 * 只登记创建后回读的实际主键与完整预期；不提供整体 refresh，避免重新认领整行。
 */
export class OwnedFixtureLedger {
  private readonly rows = new Map<string, OwnedFixtureRow>();

  constructor(readonly roundTag: string) {}

  get size(): number {
    return this.rows.size;
  }

  isEmpty(): boolean {
    return this.rows.size === 0;
  }

  list(): OwnedFixtureRow[] {
    return [...this.rows.values()];
  }

  has(table: string, keyOrId: number | OwnedFixtureKey): boolean {
    const key = normalizeKey(table, keyOrId);
    return this.rows.has(keyOf(table, key));
  }

  register(row: OwnedFixtureRow): void {
    const key = normalizeKey(row.table, row.key);
    if (!isDeletableTable(row.table)) {
      throw new Error(`受控表 ${String(row.table)} 不允许登记为可删除夹具`);
    }
    if (Object.keys(row.expected).length === 0) {
      throw new Error(`登记 ${displayOf(row.table, key)} 缺少预期字段`);
    }
    for (const column of primaryKeyOf(row.table)) {
      if (row.expected[column] !== key[column]) {
        throw new Error(`登记 ${displayOf(row.table, key)} 的预期主键与键结构不一致`);
      }
    }
    this.rows.set(keyOf(row.table, key), {
      table: row.table,
      key,
      expected: { ...row.expected },
    });
  }

  /** 按实际主键回读整行并登记（仅用于创建成功后的首次登记） */
  async registerByKey(
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>,
    table: ControlledFixtureTable,
    keyOrId: number | OwnedFixtureKey,
  ): Promise<void> {
    const key = normalizeKey(table, keyOrId);
    const conditions = primaryKeyOf(table)
      .map((column) => `${quoteIdentifier(column)} = ?`)
      .join(' AND ');
    const parameters = primaryKeyOf(table).map((column) => key[column]);
    const rows: Array<Record<string, unknown>> = await (query(
      `SELECT * FROM ${quoteIdentifier(table)} WHERE ${conditions} LIMIT 1`,
      parameters,
    ) as Promise<Array<Record<string, unknown>>>);
    const actual = rows[0];
    if (!actual) {
      throw new Error(`创建后回读失败，未找到 ${displayOf(table, key)}，拒绝登记`);
    }
    this.register({ table, key, expected: actual });
  }

  async registerById(
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>,
    table: ControlledFixtureTable,
    id: number,
  ): Promise<void> {
    await this.registerByKey(query, table, id);
  }

  idsOf(table: ControlledFixtureTable): number[] {
    const columns = primaryKeyOf(table);
    if (columns.length !== 1 || columns[0] !== 'id') {
      throw new Error(`${table} 不是单列 id 主键，不能按 id 集合使用`);
    }
    return this.list()
      .filter((row) => row.table === table)
      .map((row) => row.key.id);
  }

  /**
   * 合法业务字段变化的显式预期变更。
   * 只允许改动登记行中已存在的非主键、非所有权列；数据库生成值可在受限列读取后登记。
   */
  async applyExpectedChange(
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>,
    table: ControlledFixtureTable,
    keyOrId: number | OwnedFixtureKey,
    patch: Readonly<Record<string, unknown>>,
    rereadColumns: readonly string[] = [],
  ): Promise<void> {
    const key = normalizeKey(table, keyOrId);
    const mapKey = keyOf(table, key);
    const entry = this.rows.get(mapKey);
    if (!entry) {
      throw new Error(`拒绝更新未登记资源：${displayOf(table, key)}`);
    }
    const primaryKey = primaryKeyOf(table);
    const knownColumns = new Set(Object.keys(entry.expected));
    const declared = [...Object.keys(patch), ...rereadColumns];
    for (const column of declared) {
      if (!IDENTIFIER_PATTERN.test(column)) {
        throw new Error(`非法字段名：${table}.${column}`);
      }
      if (!knownColumns.has(column)) {
        throw new Error(`字段 ${table}.${column} 不在登记预期内，拒绝接受整行变化`);
      }
      if (primaryKey.includes(column)) {
        throw new Error(`主键列 ${table}.${column} 不可通过预期变更改写`);
      }
      if (PROTECTED_COLUMNS.has(column)) {
        throw new Error(`所有权字段 ${table}.${column} 必须保持原始预期`);
      }
    }

    let reread: Record<string, unknown> = {};
    if (rereadColumns.length > 0) {
      const conditions = primaryKey.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
      const parameters = primaryKey.map((column) => key[column]);
      const select = rereadColumns.map((column) => quoteIdentifier(column)).join(', ');
      const rows: Array<Record<string, unknown>> = await (query(
        `SELECT ${select} FROM ${quoteIdentifier(table)} WHERE ${conditions} LIMIT 1`,
        parameters,
      ) as Promise<Array<Record<string, unknown>>>);
      const actual = rows[0];
      if (!actual) {
        throw new Error(`受限字段读取失败：${displayOf(table, key)} 已不存在`);
      }
      reread = actual;
    }

    this.rows.set(mapKey, {
      table,
      key,
      expected: { ...entry.expected, ...patch, ...reread },
    });
  }
}

export interface FixtureSetupGate {
  readonly allowed: boolean;
  readonly database: string;
}

/**
 * setup 前置检查：显式许可、声明库白名单、实际连接库与预期一致；
 * 全部通过后才返回允许创建的状态，失败时不留下“已创建”的假状态。
 */
export const prepareFixtureSetup = async (
  dataSource: DataSource,
  roundTag: string,
  declaredDatabase?: string,
): Promise<FixtureSetupGate> => {
  assertPhysicalCleanupConsent();
  const declared = declaredDatabase ?? resolveAllowedE2eDatabases()[0] ?? '';
  if (!declared.trim()) {
    throw new Error(`缺少声明数据库名，拒绝为 ${roundTag} 创建夹具`);
  }
  assertAllowedE2eDatabase(declared);
  const expected = resolveExpectedE2eDatabase(dataSource, declaredDatabase);
  const database = await assertDataSourceOnAllowedE2eDatabase(dataSource, expected);
  return { allowed: true, database };
};

/** 固定 ID 创建前查重：已占用立即失败并保留原数据 */
export const assertFixtureIdsAvailable = async (
  source: DataSource | ((sql: string, parameters?: unknown[]) => Promise<unknown>),
  table: ControlledFixtureTable,
  ids: readonly number[],
  roundTag = '',
): Promise<void> => {
  const normalized = ids.filter((id) => Number.isInteger(id) && id > 0);
  if (normalized.length === 0) return;
  const columns = primaryKeyOf(table);
  if (columns.length !== 1 || columns[0] !== 'id') {
    throw new Error(`${table} 不支持按 id 集合查重`);
  }
  const query: (sql: string, parameters?: unknown[]) => Promise<unknown> =
    typeof source === 'function' ? source : (sql, parameters) => source.query(sql, parameters);
  const rows: Array<{ id: number }> = await (query(
    `SELECT id FROM ${quoteIdentifier(table)} WHERE id IN (${normalized.map(() => '?').join(', ')})`,
    [...normalized],
  ) as Promise<Array<{ id: number }>>);
  if (rows.length > 0) {
    throw new Error(
      `固定 ID 已被占用（${roundTag ? `${roundTag} ` : ''}${table}：` +
        `${rows.map((row) => row.id).join(', ')}），拒绝创建并保留原数据。`,
    );
  }
};

/** 引用闭包：引用行必须是本账本已登记行，账本外任何引用都拒绝清理 */
export interface ReferenceGuard {
  readonly table: string;
  readonly column: string;
  readonly ids: readonly number[];
  readonly label?: string;
}

const buildKeyConditions = (table: string): string =>
  primaryKeyOf(table)
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(' AND ');

const countReferences = async (
  manager: EntityManager,
  guard: ReferenceGuard,
  rows: readonly OwnedFixtureRow[],
): Promise<number> => {
  if (guard.ids.length === 0) return 0;
  primaryKeyOf(guard.table);
  const owned = rows.filter((row) => row.table === guard.table);
  const parameters: unknown[] = [...guard.ids];
  let sql =
    `SELECT COUNT(*) AS total FROM ${quoteIdentifier(guard.table)} ` +
    `WHERE ${quoteIdentifier(guard.column)} IN (${guard.ids.map(() => '?').join(', ')})`;
  if (owned.length > 0) {
    const exclusions = owned.map(() => `(${buildKeyConditions(guard.table)})`);
    sql += ` AND NOT (${exclusions.join(' OR ')})`;
    for (const row of owned) {
      for (const column of primaryKeyOf(guard.table)) {
        parameters.push(row.key[column]);
      }
    }
  }
  const result: Array<{ total: number | string }> = await manager.query(sql, parameters);
  return Number(result[0]?.total ?? 0);
};

const verifyRegisteredRows = async (
  manager: EntityManager,
  rows: readonly OwnedFixtureRow[],
): Promise<void> => {
  for (const row of rows) {
    const conditions = buildKeyConditions(row.table);
    const parameters = primaryKeyOf(row.table).map((column) => row.key[column]);
    const actualRows: Array<Record<string, unknown>> = await manager.query(
      `SELECT * FROM ${quoteIdentifier(row.table)} WHERE ${conditions} FOR UPDATE`,
      parameters,
    );
    const actual = actualRows[0];
    if (!actual) {
      throw new Error(`登记资源已不存在：${displayOf(row.table, row.key)}`);
    }
    for (const [column, expected] of Object.entries(row.expected)) {
      if (VOLATILE_COLUMNS.has(column)) continue;
      if (!nullSafeEqual(actual[column], expected)) {
        throw new Error(
          `登记资源字段不符：${displayOf(row.table, row.key)}.${column} ` +
            `预期=${formatValue(expected)} 实际=${formatValue(actual[column])}`,
        );
      }
    }
  }
};

const deleteRegisteredRows = async (
  manager: EntityManager,
  rows: readonly OwnedFixtureRow[],
): Promise<number> => {
  const ordered: OwnedFixtureRow[] = [];
  for (const table of FIXTURE_TABLE_DELETE_ORDER) {
    for (const row of rows) {
      if (row.table === table) ordered.push(row);
    }
  }
  if (ordered.length !== rows.length) {
    throw new Error('存在未受控的删除目标，拒绝清理');
  }
  let deleted = 0;
  for (const row of ordered) {
    const conditions = buildKeyConditions(row.table);
    const parameters = primaryKeyOf(row.table).map((column) => row.key[column]);
    const result: { affectedRows?: number } = await manager.query(
      `DELETE FROM ${quoteIdentifier(row.table)} WHERE ${conditions}`,
      parameters,
    );
    const affected = Number(result?.affectedRows ?? 0);
    if (affected !== 1) {
      throw new Error(
        `精确删除未命中唯一登记行：${displayOf(row.table, row.key)}，实际影响 ${affected} 行`,
      );
    }
    deleted += affected;
  }
  if (deleted !== rows.length) {
    throw new Error(`删除数量与核验目标不一致：核验 ${rows.length} 行，删除 ${deleted} 行`);
  }
  return deleted;
};

export interface FixtureCleanupRequest {
  readonly dataSource: DataSource;
  readonly expectedDatabase?: string;
  readonly rows: readonly OwnedFixtureRow[];
  readonly referenceGuards?: readonly ReferenceGuard[];
}

export interface FixtureCleanupResult {
  readonly performed: boolean;
  readonly deletedRows: number;
}

export class OwnedFixtureCleanupError extends Error {
  constructor(readonly details: readonly string[]) {
    super(details.join('；'));
    this.name = 'OwnedFixtureCleanupError';
  }
}

const dedupeRows = (rows: readonly OwnedFixtureRow[]): OwnedFixtureRow[] => {
  const unique = new Map<string, OwnedFixtureRow>();
  for (const row of rows) {
    const key = normalizeKey(row.table, row.key);
    unique.set(keyOf(row.table, key), { ...row, key });
  }
  return [...unique.values()];
};

/**
 * 受保护的单事务清理。
 * 空账本 → 零条 DELETE；否则先核验、再引用闭包、最后逐行删除，任一失败整批回滚。
 */
export const runOwnedFixtureCleanup = async (
  request: FixtureCleanupRequest,
): Promise<FixtureCleanupResult> => {
  const rows = dedupeRows(request.rows);
  if (rows.length === 0) {
    return { performed: false, deletedRows: 0 };
  }

  const errors: string[] = [];
  assertPhysicalCleanupConsent();
  const expectedDatabase = request.expectedDatabase ?? resolveAllowedE2eDatabases()[0] ?? '';
  const normalizedExpectedDatabase = expectedDatabase.trim();
  if (!normalizedExpectedDatabase) {
    throw new OwnedFixtureCleanupError(['缺少预期数据库名，拒绝执行清理']);
  }

  const poolQuery: QueryRunner = request.dataSource.createQueryRunner();
  try {
    await poolQuery.connect();
  } catch (error) {
    await poolQuery.release().catch(() => undefined);
    throw new OwnedFixtureCleanupError([`清理连接建立失败：${detailOf(error)}`]);
  }

  let transactionStarted = false;
  let cleanupError: OwnedFixtureCleanupError | null = null;
  let deletedRows = 0;
  try {
    await poolQuery.startTransaction();
    transactionStarted = true;
    await assertManagerOnExpectedE2eDatabase(poolQuery.manager, normalizedExpectedDatabase);
    await verifyRegisteredRows(poolQuery.manager, rows);
    for (const guard of request.referenceGuards ?? []) {
      const count = await countReferences(poolQuery.manager, guard, rows);
      if (count > 0) {
        throw new Error(
          `引用闭包存在账本外记录：${guard.label ?? `${guard.table}.${guard.column}`} 计数 ${count}`,
        );
      }
    }
    deletedRows = await deleteRegisteredRows(poolQuery.manager, rows);
    await poolQuery.commitTransaction();
  } catch (error) {
    errors.push(`清理失败：${detailOf(error)}`);
    if (transactionStarted && poolQuery.isTransactionActive) {
      try {
        await poolQuery.rollbackTransaction();
      } catch (rollbackError) {
        errors.push(`回滚失败：${detailOf(rollbackError)}`);
      }
    }
    cleanupError = new OwnedFixtureCleanupError(errors);
  } finally {
    try {
      await poolQuery.release();
    } catch (closeError) {
      errors.push(`关闭清理连接失败：${detailOf(closeError)}`);
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (errors.length > 0) {
    throw new OwnedFixtureCleanupError(errors);
  }
  return { performed: true, deletedRows };
};

/** 只读残留核对：本轮登记行是否仍存在 */
export const assertRegisteredRowsAbsent = async (
  dataSource: DataSource,
  rows: readonly OwnedFixtureRow[],
): Promise<string[]> => {
  const residue: string[] = [];
  for (const row of rows) {
    const conditions = buildKeyConditions(row.table);
    const parameters = primaryKeyOf(row.table).map((column) => row.key[column]);
    const result: Array<{ total: number | string }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM ${quoteIdentifier(row.table)} WHERE ${conditions}`,
      parameters,
    );
    if (Number(result[0]?.total ?? 0) > 0) {
      residue.push(displayOf(row.table, row.key));
    }
  }
  return residue;
};

/* -------------------------------------------------------------------------- */
/* 统一收尾                                                                    */
/* -------------------------------------------------------------------------- */

export interface TeardownStep {
  readonly label: string;
  readonly run: () => unknown;
}

/**
 * 顺序执行全部收尾步骤，任一失败不阻断后续步骤。
 * 用于保证清理、残留查询、资源关闭分别执行且错误全部保留。
 */
export const runTeardownSteps = async (steps: readonly TeardownStep[]): Promise<string[]> => {
  const errors: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push(`${step.label}失败：${detailOf(error)}`);
    }
  }
  return errors;
};

export interface TeardownFailureReport {
  readonly primaryError?: unknown;
  readonly teardownErrors: readonly string[];
}

export const describeTeardownFailure = (report: TeardownFailureReport): string | null => {
  const parts: string[] = [];
  if (report.primaryError !== undefined && report.primaryError !== null) {
    parts.push(`主流程失败：${detailOf(report.primaryError)}`);
  }
  if (report.teardownErrors.length > 0) {
    parts.push(`此外清理失败——${report.teardownErrors.join('；')}`);
  }
  return parts.length > 0 ? parts.join('；') : null;
};

/**
 * 执行统一收尾并聚合错误：主流程错误与全部收尾错误同时保留，不相互覆盖。
 */
export const finalizeFixtureTeardown = async (request: {
  readonly primaryError?: unknown;
  readonly steps: readonly TeardownStep[];
}): Promise<void> => {
  const teardownErrors = await runTeardownSteps(request.steps);
  const message = describeTeardownFailure({
    primaryError: request.primaryError,
    teardownErrors,
  });
  if (message) {
    throw new Error(message);
  }
};

/* -------------------------------------------------------------------------- */
/* 内部比较工具                                                                 */
/* -------------------------------------------------------------------------- */

const normalizeValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Buffer.isBuffer(value)) return `buffer:${value.toString('hex')}`;
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number' || typeof value === 'boolean')
    return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `array:${value.map((item) => normalizeValue(item)).join(',')}`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted = Object.keys(record)
      .sort()
      .map((key) => `${key}=${normalizeValue(record[key])}`)
      .join(',');
    return `object:${sorted}`;
  }
  if (typeof value === 'symbol') return `symbol:${value.toString()}`;
  return `unhandled:${typeof value}`;
};

function nullSafeEqual(actual: unknown, expected: unknown): boolean {
  return normalizeValue(actual) === normalizeValue(expected);
}

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<buffer:${value.length}>`;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'symbol') return value.toString();
  return `unhandled:${typeof value}`;
};
