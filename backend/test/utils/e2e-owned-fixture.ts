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

/** 待核验记录的自然键：数据库生成主键尚未取得前，用创建输入中的明确业务键表达归属 */
export type PendingFixtureKey = Readonly<Record<string, string | number | null>>;

export interface PendingFixtureRow {
  readonly table: ControlledFixtureTable;
  readonly naturalKey: PendingFixtureKey;
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

const pendingKeyOf = (table: string, naturalKey: PendingFixtureKey): string => {
  const columns = Object.keys(naturalKey);
  return `${table}?${columns.map((column) => `${column}=${String(naturalKey[column])}`).join('&')}`;
};

const displayPendingOf = (table: string, naturalKey: PendingFixtureKey): string => {
  const columns = Object.keys(naturalKey);
  return `${table}(${columns.map((column) => `${column}=${String(naturalKey[column])}`).join(', ')})`;
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
 * 首次登记只使用创建输入或返回结果中的已知事实；回读仅用于比对，不重新认领整行。
 * 数据库生成主键尚未取得时，先按自然键登记为待核验记录，解析成功后才转为可删除行。
 */
export class OwnedFixtureLedger {
  private readonly rows = new Map<string, OwnedFixtureRow>();
  private readonly pending = new Map<string, PendingFixtureRow>();

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

  /**
   * 创建/提交成功后的首次登记：只接受调用方从**写入输入或返回结果**得到的已知事实。
   *
   * 这里刻意不做 SELECT：若成功写入后回读失败，资源仍必须留在账本中，否则清理与残留
   * 核对会漏掉已提交的行。无法从创建结果确定的字段不得用猜测值补齐，调用方应调整创建
   * 契约（例如使用驱动返回的 insertId）或只登记已知字段，待清理前由核验暴露差异。
   */
  registerCreated(
    table: ControlledFixtureTable,
    keyOrId: number | OwnedFixtureKey,
    expected: Readonly<Record<string, unknown>>,
  ): void {
    const key = normalizeKey(table, keyOrId);
    this.register({ table, key, expected: { ...key, ...expected } });
  }

  /**
   * 数据库生成主键尚未取得时，先按创建输入中明确的自然键登记。
   * 这些记录不属于可删除行，也不允许被清理与残留核对忽略：解析成功前必须保持可见。
   */
  registerPending(
    table: ControlledFixtureTable,
    naturalKey: PendingFixtureKey,
    expected: Readonly<Record<string, unknown>>,
  ): void {
    const columns = primaryKeyOf(table);
    if (columns.length !== 1 || columns[0] !== 'id') {
      throw new Error(`${table} 不是单列 id 主键，不能按自然键登记待核验记录`);
    }
    if (!isDeletableTable(table)) {
      throw new Error(`受控表 ${String(table)} 不允许登记为待核验夹具`);
    }
    const keys = Object.keys(naturalKey);
    if (keys.length === 0) {
      throw new Error(`待核验记录 ${String(table)} 缺少自然键`);
    }
    for (const column of keys) {
      if (!IDENTIFIER_PATTERN.test(column)) {
        throw new Error(`非法自然键字段名：${table}.${column}`);
      }
      if (column === 'id') {
        throw new Error(`自然键不能包含主键列 ${table}.id`);
      }
    }
    if (Object.keys(expected).length === 0) {
      throw new Error(`待核验记录 ${displayPendingOf(table, naturalKey)} 缺少预期字段`);
    }
    this.pending.set(pendingKeyOf(table, naturalKey), {
      table,
      naturalKey: { ...naturalKey },
      expected: { ...expected },
    });
  }

  pendingRows(): PendingFixtureRow[] {
    return [...this.pending.values()];
  }

  /**
   * 把待核验记录解析为实际主键：只按登记时的自然键查询，不扫描同一报告的其它子记录。
   * 未唯一命中或查询失败时抛出，待核验记录保留在账本中，清理与残留核对始终可见。
   */
  async resolvePending(
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>,
    table: ControlledFixtureTable,
    naturalKey: PendingFixtureKey,
  ): Promise<void> {
    const mapKey = pendingKeyOf(table, naturalKey);
    const entry = this.pending.get(mapKey);
    if (!entry) {
      throw new Error(`拒绝解析未登记的待核验记录：${displayPendingOf(table, naturalKey)}`);
    }
    const columns = Object.keys(naturalKey);
    const conditions = columns.map((column) => `${quoteIdentifier(column)} <=> ?`).join(' AND ');
    const parameters = columns.map((column) => naturalKey[column]);
    const rows: Array<{ id: number | string }> = await (query(
      `SELECT id FROM ${quoteIdentifier(table)} WHERE ${conditions} LIMIT 1`,
      parameters,
    ) as Promise<Array<{ id: number | string }>>);
    if (rows.length !== 1) {
      throw new Error(`待核验记录解析失败，未唯一命中：${displayPendingOf(table, naturalKey)}`);
    }
    const id = Number(rows[0].id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `待核验记录解析结果非法：${displayPendingOf(table, naturalKey)} id=${String(rows[0].id)}`,
      );
    }
    this.register({ table, key: { id }, expected: { ...entry.expected, id } });
    this.pending.delete(mapKey);
  }

  /**
   * 回读只用于比对：不新增、不覆盖账本预期，也不把查询到的整行认领为本轮资源。
   * 行缺失或已登记字段漂移时抛出，原始预期保持不变。
   */
  async verifyRegistered(
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>,
    table: ControlledFixtureTable,
    keyOrId: number | OwnedFixtureKey,
  ): Promise<void> {
    const key = normalizeKey(table, keyOrId);
    const entry = this.rows.get(keyOf(table, key));
    if (!entry) {
      throw new Error(`拒绝核验未登记资源：${displayOf(table, key)}`);
    }
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
      throw new Error(`回读核验失败，未找到 ${displayOf(table, key)}`);
    }
    for (const [column, expected] of Object.entries(entry.expected)) {
      if (VOLATILE_COLUMNS.has(column)) continue;
      if (!nullSafeEqual(actual[column], expected)) {
        throw new Error(
          `登记资源字段不符：${displayOf(table, key)}.${column} ` +
            `预期=${formatValue(expected)} 实际=${formatValue(actual[column])}`,
        );
      }
    }
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
      if (!knownColumns.has(column) && !VOLATILE_COLUMNS.has(column)) {
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

interface ExclusiveConnectionDestroyResult {
  readonly destroyed: boolean;
  readonly reason?: string;
}

/**
 * 销毁本轮独占连接（不回池）。
 *
 * 只允许销毁 `MysqlQueryRunner.databaseConnection` 这类单连接；检测到共享连接池特征
 * （`getConnection`）一律拒绝。驱动未暴露连接或实现不了安全销毁时返回明确原因，
 * 由调用方报告，绝不退化成普通 `release()`。
 */
export const destroyExclusiveQueryRunner = async (
  queryRunner: QueryRunner,
): Promise<ExclusiveConnectionDestroyResult> => {
  const connection = (
    queryRunner as unknown as {
      databaseConnection?: { destroy?: () => Promise<void>; getConnection?: unknown };
    }
  ).databaseConnection;

  if (connection === undefined || connection === null) {
    return {
      destroyed: false,
      reason: '驱动未暴露可销毁的独占连接，拒绝将活动事务连接回池',
    };
  }
  if (typeof connection.getConnection === 'function') {
    return { destroyed: false, reason: '拒绝销毁共享连接池：只允许销毁本轮独占连接' };
  }
  if (typeof connection.destroy !== 'function') {
    return { destroyed: false, reason: '当前驱动不支持 destroy，无法安全关闭本轮连接' };
  }
  try {
    await connection.destroy();
    return { destroyed: true };
  } catch (destroyError) {
    return { destroyed: false, reason: `销毁独占连接失败：${detailOf(destroyError)}` };
  }
};

/**
 * 受保护的单事务清理。
 * 空账本 → 零条 DELETE；否则先核验、再引用闭包、最后逐行删除，任一失败整批回滚。
 *
 * 收尾规则：
 * - 连接、启动事务、库名核验、行核验、引用闭包、删除、提交与关闭统一在保护范围内；
 * - 回滚依据驱动实际 `isTransactionActive`，不依赖 `startTransaction()` 是否成功返回；
 * - 回滚失败或事务仍活动时销毁本轮独占连接，禁止把活动事务以普通 `release()` 回池；
 * - 主错误、回滚、销毁与释放错误分别保留，提交成功但释放失败仍明确失败。
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
  let deletedRows = 0;
  let destroyAttempted = false;
  let connectionDestroyed = false;

  const destroyOnce = async (stage: string): Promise<void> => {
    if (destroyAttempted) return;
    destroyAttempted = true;
    const outcome = await destroyExclusiveQueryRunner(poolQuery);
    connectionDestroyed = outcome.destroyed;
    if (!connectionDestroyed) {
      errors.push(`${stage}销毁独占连接未完成：${outcome.reason ?? '未知原因'}`);
    }
  };

  try {
    await poolQuery.connect();
    await poolQuery.startTransaction();
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

    let rollbackFailed = false;
    if (poolQuery.isTransactionActive) {
      try {
        await poolQuery.rollbackTransaction();
      } catch (rollbackError) {
        rollbackFailed = true;
        errors.push(`回滚失败：${detailOf(rollbackError)}`);
      }
    }

    // 真实回滚失败与注入失败走同一路径：只要事务仍活动或回滚未成功，就销毁独占连接
    if (rollbackFailed || poolQuery.isTransactionActive) {
      await destroyOnce('回滚后');
    }
  } finally {
    if (!connectionDestroyed && !destroyAttempted) {
      if (poolQuery.isTransactionActive) {
        await destroyOnce('收尾时');
      } else {
        try {
          await poolQuery.release();
        } catch (closeError) {
          errors.push(`关闭清理连接失败：${detailOf(closeError)}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new OwnedFixtureCleanupError(errors);
  }
  return { performed: true, deletedRows };
};

export interface GuardedTransactionResult {
  readonly errors: readonly string[];
  /** 事务是否已成功提交；提交后的释放失败只让 errors 非空，不改变该事实 */
  readonly committed: boolean;
}

/**
 * 受保护的独占连接事务收尾（恢复写入等单事务场景复用）。
 *
 * - 连接、启动事务、业务写入、提交与关闭都在同一保护范围内；
 * - 回滚依据驱动实际 `isTransactionActive`，不依赖 `startTransaction()` 是否成功返回；
 * - 回滚失败或事务仍活动时销毁本轮独占连接，禁止把活动事务以普通 `release()` 回池；
 * - 不销毁共享连接池；主错误、回滚、销毁与释放错误分别保留；
 * - 提交成功但释放失败仍返回非空 errors，调用方不得据此宣称资源已释放。
 */
export const runGuardedQueryRunnerTransaction = async (params: {
  readonly createRunner: () => QueryRunner;
  readonly label: string;
  readonly work: (runner: QueryRunner) => Promise<void>;
}): Promise<GuardedTransactionResult> => {
  const { createRunner, label, work } = params;
  const errors: string[] = [];
  const runner = createRunner();
  let committed = false;
  let destroyAttempted = false;
  let connectionDestroyed = false;

  const destroyOnce = async (stage: string): Promise<void> => {
    if (destroyAttempted) return;
    destroyAttempted = true;
    const outcome = await destroyExclusiveQueryRunner(runner);
    connectionDestroyed = outcome.destroyed;
    if (!connectionDestroyed) {
      errors.push(`${stage}销毁独占连接未完成：${outcome.reason ?? '未知原因'}`);
    }
  };

  try {
    await runner.connect();
    await runner.startTransaction();
    await work(runner);
    await runner.commitTransaction();
    committed = true;
  } catch (error) {
    errors.push(`${label}失败：${detailOf(error)}`);

    let rollbackFailed = false;
    if (runner.isTransactionActive) {
      try {
        await runner.rollbackTransaction();
      } catch (rollbackError) {
        rollbackFailed = true;
        errors.push(`${label}回滚失败：${detailOf(rollbackError)}`);
      }
    }

    if (rollbackFailed || runner.isTransactionActive) {
      await destroyOnce(`${label}回滚后`);
    }
  } finally {
    if (!connectionDestroyed && !destroyAttempted) {
      if (runner.isTransactionActive) {
        await destroyOnce(`${label}收尾时`);
      } else {
        try {
          await runner.release();
        } catch (releaseError) {
          errors.push(`${label}释放失败：${detailOf(releaseError)}`);
        }
      }
    }
  }

  return { errors, committed };
};

/**
 * 只读残留核对：本轮登记行与待核验记录是否仍存在。
 * 待核验记录即使解析失败也参与核对，避免已提交资源因回读失败从结果中消失。
 */
export const assertRegisteredRowsAbsent = async (
  dataSource: DataSource,
  rows: readonly OwnedFixtureRow[],
  pending: readonly PendingFixtureRow[] = [],
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
  for (const row of pending) {
    const columns = Object.keys(row.naturalKey);
    const conditions = columns.map((column) => `${quoteIdentifier(column)} <=> ?`).join(' AND ');
    const parameters = columns.map((column) => row.naturalKey[column]);
    const result: Array<{ total: number | string }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM ${quoteIdentifier(row.table)} WHERE ${conditions}`,
      parameters,
    );
    if (Number(result[0]?.total ?? 0) > 0) {
      residue.push(`待核验 ${displayPendingOf(row.table, row.naturalKey)}`);
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
