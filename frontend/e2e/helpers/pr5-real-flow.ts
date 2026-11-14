// e2e/helpers/pr5-real-flow.ts
//
// PR5 S5「真实权限与业务闭环」的共享基建（专用隔离库 lithography_e2e + 专用后端 3100）：
//
// 1. 环境预检：只允许在专用隔离库上执行，且物理清理必须显式 opt-in
//    （复用 real-backend.assertPhysicalCleanupAllowed，不自建平行安全门）；
// 2. Mock Seed 前置数据就绪断言（账号 / 型号 / 预置申请 / 预置资料），
//    让「前置数据不齐」以硬失败暴露，而不是靠用例逐个 skip 掩盖；
// 3. 「DB 生成 ID」证据：创建前快照主键集合，创建后断言新 ID 不在快照内——
//    直接证明本轮写入没有复用任何既有主键（含 Mock Seed 的固定主键）；
// 4. 归属核验后的物理清理：维修申请按 id + request_no + customer_account_id 三因子绑定，
//    参考资料按 id + created_by_account_id + 本轮标题关键字三因子绑定；绑定断言与
//    DELETE + 残留核对在同一个事务内完成，绑定不匹配即中止（连接关闭触发回滚），
//    不存在「绑定失败仍按 ID 继续删除」的路径。
//
// 所有进入 SQL 的字符串都先过白名单校验；密码经 MYSQL_PWD 注入（见 real-backend.mysqlQuery）。

import { DEDICATED_E2E_DB_NAME } from '../../e2e-real/dedicated-e2e-environment';

import {
  assertPhysicalCleanupAllowed,
  deleteE2EReferenceDocumentStorageFileByReference,
  mysqlQuery,
  readBackendEnv,
  REQUEST_NO_PATTERN,
  STORAGE_REFERENCE_PATTERN,
} from './real-backend';

/** Mock Seed（backend/scripts/seed-mock.ts）预置账号：S5 各角色真实链路使用 */
export const PR5_SEED_LOGIN_NAMES = [
  'mock_super_admin',
  'mock_engineer_chen',
  'mock_engineer_li',
  'mock_customer_alpha',
  'mock_customer_beta',
] as const;

/** Mock Seed 预置的「客户甲已接单且已有回复」申请：只读断言目标 */
export const PR5_SEED_ACCEPTED_REQUEST_NO = 'MOCK-RR-2026-0003';

/** Mock Seed 预置的未软删资料（970001~970003）与已软删资料（970004） */
export const PR5_SEED_VISIBLE_DOCUMENT_IDS = [970001, 970002, 970003] as const;
export const PR5_SEED_SOFT_DELETED_DOCUMENT_ID = 970004;

/** 本轮自建资料标题前缀（与开发库 e2e 的前缀区分，互不干扰） */
export const PR5_DOC_TITLE_PREFIX = 'PR5真实链路验收行';

/** 运行级唯一标识并入标题后的完整关键字白名单 */
export const PR5_DOC_KEYWORD_PATTERN = /^PR5真实链路验收行·[a-z0-9]{8,32}$/;

/**
 * 本轮资料标题前缀白名单：关键字 + 中文括号后缀（用于 S5-5 越权前缀计数）。
 * 禁止 `%` / `_` / 引号 / 反斜杠 / 空白，杜绝 LIKE 通配符与 SQL 注入面。
 */
const PR5_DOC_TITLE_PREFIX_PATTERN = /^PR5真实链路验收行·[a-z0-9]{8,32}（[^%_\\'"\s]{0,32}$/;

// ---------------------------------------------------------------------------
// 完整行 canonical 列定义（P1-1 / 计划 §3.1、§3.2）
//
// 每张表**只保留一份** canonical 列清单，由它统一派生：
//   1) 行读取 SELECT 的列顺序；2) 快照解析顺序；3) 只读预检的逐字段比较；
//   4) 事务内精确 WHERE；5) schema 差集测试的预期集合；6) 失败信息中的字段名。
// 禁止 locator / reclaimer / delete helper 各自维护字段子集。
// ---------------------------------------------------------------------------

/** 本组清理与快照涉及的三张表（唯一表白名单） */
export type Pr5CleanupTable = 'engineer_response' | 'reference_document' | 'repair_request';

/** 每个 canonical 列的解析类型（正整数 / nullable 正整数 / 枚举 / 文本 / tinyint / timestamp） */
export type Pr5ColumnKind =
  | 'enumResolutionStatus'
  | 'nullablePositiveInteger'
  | 'nullableText'
  | 'nullableTimestamp'
  | 'positiveInteger'
  | 'text'
  | 'timestamp'
  | 'tinyint';

export interface Pr5ColumnSpec {
  readonly kind: Pr5ColumnKind;
  readonly name: string;
}

/** repair_request 13 列（与 1775201000000-create-repair-request-table.migration.ts 一致） */
export const PR5_REPAIR_REQUEST_COLUMN_SPECS = [
  { kind: 'positiveInteger', name: 'id' },
  { kind: 'text', name: 'request_no' },
  { kind: 'positiveInteger', name: 'customer_account_id' },
  { kind: 'positiveInteger', name: 'equipment_model_id' },
  { kind: 'text', name: 'error_code' },
  { kind: 'text', name: 'fault_description' },
  { kind: 'text', name: 'content_md' },
  { kind: 'timestamp', name: 'created_at' },
  { kind: 'tinyint', name: 'is_accepted' },
  { kind: 'nullablePositiveInteger', name: 'accepted_by_engineer_account_id' },
  { kind: 'nullableTimestamp', name: 'accepted_at' },
  { kind: 'tinyint', name: 'deprecated' },
  { kind: 'nullableTimestamp', name: 'deleted_at' },
] as const satisfies readonly Pr5ColumnSpec[];

/** engineer_response 7 列（与 1775201400000-create-engineer-response-table.migration.ts 一致） */
export const PR5_ENGINEER_RESPONSE_COLUMN_SPECS = [
  { kind: 'positiveInteger', name: 'id' },
  { kind: 'positiveInteger', name: 'request_id' },
  { kind: 'positiveInteger', name: 'engineer_account_id' },
  { kind: 'positiveInteger', name: 'customer_account_id' },
  { kind: 'enumResolutionStatus', name: 'resolution_status' },
  { kind: 'text', name: 'response_text' },
  { kind: 'timestamp', name: 'created_at' },
] as const satisfies readonly Pr5ColumnSpec[];

/** reference_document 15 列（与 1775201500000-create-reference-document-table.migration.ts 一致） */
export const PR5_REFERENCE_DOCUMENT_COLUMN_SPECS = [
  { kind: 'positiveInteger', name: 'id' },
  { kind: 'text', name: 'title' },
  { kind: 'text', name: 'document_type' },
  { kind: 'nullablePositiveInteger', name: 'equipment_model_id' },
  { kind: 'nullableText', name: 'description' },
  { kind: 'nullableText', name: 'original_filename' },
  { kind: 'nullableText', name: 'mime_type' },
  { kind: 'nullableText', name: 'content_text' },
  { kind: 'nullableText', name: 'storage_backend' },
  { kind: 'nullableText', name: 'storage_reference' },
  { kind: 'positiveInteger', name: 'created_by_account_id' },
  { kind: 'tinyint', name: 'deprecated' },
  { kind: 'nullableTimestamp', name: 'deleted_at' },
  { kind: 'timestamp', name: 'created_at' },
  { kind: 'timestamp', name: 'updated_at' },
] as const satisfies readonly Pr5ColumnSpec[];

const PR5_TABLE_COLUMN_SPECS: Readonly<Record<Pr5CleanupTable, readonly Pr5ColumnSpec[]>> = {
  engineer_response: PR5_ENGINEER_RESPONSE_COLUMN_SPECS,
  reference_document: PR5_REFERENCE_DOCUMENT_COLUMN_SPECS,
  repair_request: PR5_REPAIR_REQUEST_COLUMN_SPECS,
};

export function assertPr5CleanupTable(table: string): asserts table is Pr5CleanupTable {
  if (!(table in PR5_TABLE_COLUMN_SPECS)) {
    throw new Error(`PR5 完整行目标表未通过白名单校验，拒绝查询：${JSON.stringify(table)}`);
  }
}

/** 该表的 canonical 列定义（顺序即 SELECT / WHERE 顺序） */
export function readPr5ColumnSpecs(table: Pr5CleanupTable): readonly Pr5ColumnSpec[] {
  return PR5_TABLE_COLUMN_SPECS[table];
}

/** 该表的 canonical 列名清单（schema 差集测试的预期集合） */
export function readPr5CanonicalColumns(table: Pr5CleanupTable): readonly string[] {
  return PR5_TABLE_COLUMN_SPECS[table].map((spec) => spec.name);
}

export interface Pr5ColumnSetDiff {
  readonly duplicatesInCanonical: readonly string[];
  readonly missingInActual: readonly string[];
  readonly unexpectedInActual: readonly string[];
}

/**
 * canonical 与 information_schema 的**双向差集**（计划 §S0 第 4 项）。
 *
 * 纯函数：真实库比对与 unit 红/绿对照（故意删掉一个 canonical 字段）共用同一实现，
 * 避免「测试声称覆盖 schema 漂移、实际另有口径」。
 */
export function diffPr5ColumnSets(
  actual: readonly string[],
  canonical: readonly string[],
): Pr5ColumnSetDiff {
  const actualSet = new Set(actual);
  const canonicalSet = new Set(canonical);
  const seen = new Set<string>();
  const duplicatesInCanonical: string[] = [];

  for (const column of canonical) {
    if (seen.has(column)) {
      duplicatesInCanonical.push(column);
    }

    seen.add(column);
  }

  return {
    duplicatesInCanonical,
    missingInActual: canonical.filter((column) => !actualSet.has(column)),
    unexpectedInActual: actual.filter((column) => !canonicalSet.has(column)),
  };
}

const PR5_POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const PR5_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const PR5_RESOLUTION_STATUSES = ['PENDING', 'RESOLVED'] as const;

/**
 * 数据库读回文本的形态校验（P1-1）。
 *
 * 快照文本来自 `mysql -B` 的**单行**输出：TAB / LF / CR / NUL 已被 batch 模式转义为
 * `\t` / `\n` / `\r` / `\0`，因此合法的回读值**不得**含原始控制字符。出现原始 CR / LF /
 * TAB / NUL 说明取值不是规范回读结果，直接拒绝，避免悄悄破坏后续按行/制表符解析。
 *
 * 引号与反斜杠**允许**存在：它们由 batch 转义与 `encodePr5SqlStringLiteral` 一一对应地
 * 安全编码（计划 §3.3「安全编码」）。不再用窄白名单把真实业务文本（多行 Markdown 正文、
 * 历史资料说明等）误判为非法。
 */
export const PR5_BATCH_TEXT_PATTERN = /^[^\0\r\n\t]*$/;

/**
 * 把「数据库读回的文本」编码为安全 SQL 字符串字面量（计划 §3.3）。
 *
 * `mysql -B` 已把值中的 TAB / LF / CR / NUL / 反斜杠转义为 `\t` / `\n` / `\r` / `\0` / `\\`，
 * 这些序列正是 MySQL 字符串字面量的合法转义且与回读值一一对应，**再次转义会造成二次转义**。
 * 唯一需要处理的是 batch 模式**原样输出**的单引号：转义为 `\'` 后，字面量解析结果与数据库
 * 原值逐字节相等，杜绝拼接逃逸（已用真实 MySQL 往返验证）。
 */
export function encodePr5SqlStringLiteral(raw: string): string {
  return `'${raw.replace(/'/g, "\\'")}'`;
}

function isPr5NullableKind(kind: Pr5ColumnKind): boolean {
  return (
    kind === 'nullablePositiveInteger' || kind === 'nullableText' || kind === 'nullableTimestamp'
  );
}

/** 逐列的解析类型校验（快照取值合法性的唯一入口） */
export function assertPr5ColumnValueValid(spec: Pr5ColumnSpec, raw: string, context: string): void {
  const fail = (): never => {
    throw new Error(`${context} 字段 ${spec.name}（${spec.kind}）取值非法：${JSON.stringify(raw)}`);
  };

  switch (spec.kind) {
    case 'enumResolutionStatus':
      if (!(PR5_RESOLUTION_STATUSES as readonly string[]).includes(raw)) {
        fail();
      }

      return;
    case 'nullablePositiveInteger':
      if (raw === 'NULL') {
        return;
      }

      if (!PR5_POSITIVE_INTEGER_PATTERN.test(raw) || !Number.isSafeInteger(Number(raw))) {
        fail();
      }

      return;
    case 'nullableText':
      if (raw === 'NULL' || PR5_BATCH_TEXT_PATTERN.test(raw)) {
        return;
      }

      fail();

      return;
    case 'nullableTimestamp':
      if (raw === 'NULL' || PR5_TIMESTAMP_PATTERN.test(raw)) {
        return;
      }

      fail();

      return;
    case 'positiveInteger':
      if (!PR5_POSITIVE_INTEGER_PATTERN.test(raw) || !Number.isSafeInteger(Number(raw))) {
        fail();
      }

      return;
    case 'text':
      if (raw === 'NULL' || !PR5_BATCH_TEXT_PATTERN.test(raw)) {
        fail();
      }

      return;
    case 'timestamp':
      if (!PR5_TIMESTAMP_PATTERN.test(raw)) {
        fail();
      }

      return;
    case 'tinyint':
      if (raw !== '0' && raw !== '1') {
        fail();
      }

      return;
    default:
      fail();
  }
}

/**
 * 整行 canonical 快照：`values` 以 canonical 列名为键、以**数据库读回的规范字符串**为值
 * （SQL NULL 保持字面量 `NULL`，timestamp(3) 保持毫秒精度字符串）。
 */
export interface Pr5RowSnapshot {
  readonly table: Pr5CleanupTable;
  readonly values: Readonly<Record<string, string>>;
}

/** 快照结构校验：列名集合必须与 canonical 完全一致（不多、不少），且每列取值合法 */
export function assertPr5RowSnapshotShape(snapshot: Pr5RowSnapshot): void {
  const specs = readPr5ColumnSpecs(snapshot.table);
  const expected = new Set(specs.map((spec) => spec.name));

  for (const key of Object.keys(snapshot.values)) {
    if (!expected.has(key)) {
      throw new Error(`完整行快照含非 canonical 字段 ${snapshot.table}.${key}，拒绝使用`);
    }
  }

  for (const spec of specs) {
    const raw = snapshot.values[spec.name];

    if (raw === undefined) {
      throw new Error(
        `完整行快照缺少 canonical 字段 ${snapshot.table}.${spec.name}（禁止只绑定字段子集）`,
      );
    }

    assertPr5ColumnValueValid(spec, raw, `完整行快照 ${snapshot.table}`);
  }
}

/** 构造并校验整行快照（造数端与 unit 用例共用） */
export function createPr5RowSnapshot(
  table: Pr5CleanupTable,
  values: Readonly<Record<string, string>>,
): Pr5RowSnapshot {
  const snapshot: Pr5RowSnapshot = { table, values: { ...values } };
  assertPr5RowSnapshotShape(snapshot);

  return snapshot;
}

/** 读取快照某一 canonical 列（缺失即抛错，绝不静默当成空值） */
export function readPr5SnapshotColumn(snapshot: Pr5RowSnapshot, column: string): string {
  const value = snapshot.values[column];

  if (value === undefined) {
    throw new Error(`快照 ${snapshot.table}.${column} 不存在（非 canonical 列）`);
  }

  return value;
}

function buildPr5ColumnValueLiteral(spec: Pr5ColumnSpec, raw: string): string {
  switch (spec.kind) {
    case 'nullablePositiveInteger':
    case 'positiveInteger':
    case 'tinyint':
      return raw;
    default:
      // 文本 / 枚举 / 时间戳统一走安全编码（单引号转义），杜绝真实业务文本的拼接逃逸
      return encodePr5SqlStringLiteral(raw);
  }
}

/** 单列 WHERE 条件：nullable 列的 `NULL` 用 `IS NULL`，其余按类型生成字面量（白名单已校验） */
export function buildPr5ColumnCondition(spec: Pr5ColumnSpec, raw: string): string {
  if (isPr5NullableKind(spec.kind) && raw === 'NULL') {
    return `${spec.name} IS NULL`;
  }

  return `${spec.name} = ${buildPr5ColumnValueLiteral(spec, raw)}`;
}

/** 整行 WHERE 条件（canonical 顺序；只读预检与事务内 DELETE 的唯一口径） */
export function buildPr5RowConditions(snapshot: Pr5RowSnapshot): string {
  assertPr5RowSnapshotShape(snapshot);

  return readPr5ColumnSpecs(snapshot.table)
    .map((spec) => buildPr5ColumnCondition(spec, readPr5SnapshotColumn(snapshot, spec.name)))
    .join(' AND ');
}

/** 单列赋值（`UPDATE ... SET` 用；nullable 列显式 `= NULL`） */
export function buildPr5ColumnAssignment(spec: Pr5ColumnSpec, raw: string): string {
  return `${spec.name} = ${raw === 'NULL' ? 'NULL' : buildPr5ColumnValueLiteral(spec, raw)}`;
}

/**
 * 断言「显式定位因子」与「整行快照」一致：定位因子只用于参数白名单与失败信息，
 * 快照才是 WHERE 的唯一口径；两者不一致即拒绝（避免出现两套可漂移的口径）。
 */
export function assertPr5SnapshotFactorMatches(
  snapshot: Pr5RowSnapshot,
  column: string,
  expected: string,
  label: string,
): void {
  const actual = readPr5SnapshotColumn(snapshot, column);

  if (actual !== expected) {
    throw new Error(
      `${label} 定位因子与整行快照不一致（${snapshot.table}.${column}）：快照 ${JSON.stringify(actual)} 定位 ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * 按主键读取**整行 canonical 快照**（真源 = 数据库实际落库值，覆盖数据库默认与生命周期字段）。
 * 期望精确命中 1 行且列数等于 canonical 列数，否则抛错（不返回半残快照）。
 */
export function readPr5FullRowSnapshot(table: Pr5CleanupTable, id: number): Pr5RowSnapshot {
  assertPr5CleanupTable(table);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`完整行快照目标 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  const columns = readPr5CanonicalColumns(table);
  const rows = mysqlQuery(`SELECT ${columns.join(', ')} FROM ${table} WHERE id = ${id}`)
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');

  if (rows.length !== 1) {
    throw new Error(`完整行快照期望精确命中 1 行，实际 ${rows.length} 行（${table} id=${id}）`);
  }

  const rawValues = rows[0].split('\t');

  if (rawValues.length !== columns.length) {
    throw new Error(
      `完整行快照列数不符：期望 ${columns.length} 列，实际 ${rawValues.length} 列（${table} id=${id}）`,
    );
  }

  const values: Record<string, string> = {};

  columns.forEach((column, index) => {
    values[column] = rawValues[index] ?? 'NULL';
  });

  return createPr5RowSnapshot(table, values);
}

export function buildPr5DocKeyword(runId: string): string {
  return `${PR5_DOC_TITLE_PREFIX}·${runId}`;
}

type Pr5SnapshotTable = 'repair_request' | 'reference_document';

const PR5_SNAPSHOT_TABLES: readonly Pr5SnapshotTable[] = ['repair_request', 'reference_document'];

/**
 * 专用环境预检：物理清理授权 + 目标库必须是专用隔离库 lithography_e2e，
 * 且 SQL helper 实际连接的库与之完全一致。任何一条不满足都直接抛错（不 skip 掩盖）。
 */
export function assertPr5DedicatedEnvironment(env = readBackendEnv()): void {
  assertPhysicalCleanupAllowed(env);

  if (env.DB_NAME !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `PR5 真实链路只允许跑在专用隔离库 ${DEDICATED_E2E_DB_NAME} 上，当前 DB_NAME=${JSON.stringify(env.DB_NAME)}`,
    );
  }

  const actualDatabase = mysqlQuery('SELECT DATABASE()');

  if (actualDatabase !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `SQL helper 实际连接的库与专用隔离库不一致：实际 ${JSON.stringify(actualDatabase)}`,
    );
  }
}

function readSingleCount(sql: string, context: string): number {
  const value = Number(mysqlQuery(sql));

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} 计数结果异常：${JSON.stringify(value)}`);
  }

  return value;
}

/**
 * Mock Seed 前置数据就绪断言（S5-8）：账号、型号、预置申请状态、预置资料可见性
 * 全部按 SQL 事实核对；缺任何一项直接抛错，禁止用 skip 掩盖。
 */
export function assertPr5SeedDataReady(): void {
  const accountList = PR5_SEED_LOGIN_NAMES.map((loginName) => `'${loginName}'`).join(', ');
  const accountCount = readSingleCount(
    `SELECT COUNT(*) FROM base_user_account WHERE login_name IN (${accountList})`,
    'Mock Seed 账号',
  );

  if (accountCount !== PR5_SEED_LOGIN_NAMES.length) {
    throw new Error(
      `Mock Seed 账号不齐：期望 ${PR5_SEED_LOGIN_NAMES.length} 个，实际 ${accountCount} 个`,
    );
  }

  const enabledModelCount = readSingleCount(
    'SELECT COUNT(*) FROM equipment_model WHERE enabled = 1',
    '启用设备型号',
  );

  if (enabledModelCount < 10) {
    throw new Error(`启用设备型号不足：期望至少 10 个，实际 ${enabledModelCount} 个`);
  }

  const acceptedCount = readSingleCount(
    `SELECT COUNT(*) FROM repair_request WHERE request_no = '${PR5_SEED_ACCEPTED_REQUEST_NO}' AND is_accepted = 1 AND deprecated = 0`,
    'Mock Seed 已接单申请',
  );

  if (acceptedCount !== 1) {
    throw new Error('Mock Seed 已接单申请不齐：缺少 MOCK-RR-2026-0003 或状态不符');
  }

  const acceptedResponseCount = readSingleCount(
    `SELECT COUNT(*) FROM engineer_response WHERE request_id = (SELECT id FROM repair_request WHERE request_no = '${PR5_SEED_ACCEPTED_REQUEST_NO}')`,
    'Mock Seed 已接单申请回复',
  );

  if (acceptedResponseCount < 1) {
    throw new Error('Mock Seed 已接单申请缺少工程师回复，无法覆盖「有回复」真实数据');
  }

  const visibleDocumentIds = PR5_SEED_VISIBLE_DOCUMENT_IDS.join(', ');
  const visibleDocumentCount = readSingleCount(
    `SELECT COUNT(*) FROM reference_document WHERE id IN (${visibleDocumentIds}) AND deprecated = 0`,
    'Mock Seed 可见资料',
  );

  if (visibleDocumentCount !== PR5_SEED_VISIBLE_DOCUMENT_IDS.length) {
    throw new Error(
      `Mock Seed 可见资料不齐：期望 ${PR5_SEED_VISIBLE_DOCUMENT_IDS.length} 行，实际 ${visibleDocumentCount} 行`,
    );
  }

  const softDeletedDocumentCount = readSingleCount(
    `SELECT COUNT(*) FROM reference_document WHERE id = ${PR5_SEED_SOFT_DELETED_DOCUMENT_ID} AND deprecated = 1`,
    'Mock Seed 已软删资料',
  );

  if (softDeletedDocumentCount !== 1) {
    throw new Error('Mock Seed 已软删资料不齐：缺少 970004 或未标记软删');
  }
}

/** 创建前主键快照：用于证明本轮写入行使用了数据库生成的新主键 */
export function readPr5PrimaryKeySnapshot(table: Pr5SnapshotTable): ReadonlySet<number> {
  if (!PR5_SNAPSHOT_TABLES.includes(table)) {
    throw new Error(`主键快照目标表未通过白名单校验，拒绝查询：${JSON.stringify(table)}`);
  }

  const rows = mysqlQuery(`SELECT id FROM ${table}`)
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const snapshot = new Set<number>();

  for (const row of rows) {
    const id = Number(row);

    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`主键快照解析异常：${JSON.stringify(row)}`);
    }

    snapshot.add(id);
  }

  return snapshot;
}

/** 断言本轮创建行的 ID 由数据库生成（不命中创建前主键快照，即未复用任何既有主键） */
export function assertPr5GeneratedId(
  rowId: number,
  snapshot: ReadonlySet<number>,
  label: string,
): void {
  if (!Number.isSafeInteger(rowId) || rowId <= 0) {
    throw new Error(`${label} 的 ID 未通过正整数校验：${JSON.stringify(rowId)}`);
  }

  if (snapshot.has(rowId)) {
    throw new Error(
      `${label} 的 ID ${rowId} 命中创建前主键快照：复用了既有主键（禁止固定主键或种子主键）`,
    );
  }
}

/**
 * 维修申请**完整行绑定**（P1-1）：除三因子与本轮回复集合外，必须提供数据库读回的整行
 * canonical 快照（13/13 列）。只读预检、残留定位与事务内 DELETE 都由该快照生成同一 WHERE——
 * 任一非三因子字段（含 `created_at` / `is_accepted` / `accepted_by_engineer_account_id` /
 * `accepted_at` / `deprecated` / `deleted_at`）被外部改写即精确命中 0 行 → 零写入失败关闭。
 *
 * 快照为**必填**：类型系统直接阻止「缺完整快照仍走破坏性三因子删除」的误传路径。
 */
export interface Pr5RepairRequestBinding {
  /** 数据库生成的维修申请主键 */
  readonly id: number;
  readonly requestNo: string;
  readonly customerAccountId: number;
  /**
   * 本轮为该申请创建的工程师回复**完整绑定**（每条含 7/7 canonical 整行快照）。
   * 父事务内会逐条按完整 7/7 快照复核并在删除前失败关闭——禁止退回裸 ID 集合
   * （裸 ID 无法发现「阶段 A 后回复 resolution_status 等字段被改写」的 TOCTOU）。
   */
  readonly responses: readonly Pr5EngineerResponseBinding[];
  /** 建行时数据库实际落库的整行快照（13/13 列） */
  readonly snapshot: Pr5RowSnapshot;
}

/** 维修申请绑定 where 子句：canonical 整行快照（无字段子集、无三因子退回路径） */
function buildPr5RepairRequestWhere(binding: Pr5RepairRequestBinding): string {
  if (binding.snapshot.table !== 'repair_request') {
    throw new Error(
      `维修申请绑定快照表名不符：期望 repair_request，实际 ${JSON.stringify(binding.snapshot.table)}`,
    );
  }

  return buildPr5RowConditions(binding.snapshot);
}

/**
 * 归属核验后物理删除本轮自建维修申请（含其本轮工程师回复）。
 *
 * 事务内顺序（全部单事务，任一断言失败即整体回滚）：
 *   1) 父行**整行快照**绑定唯一断言（非三因子字段被改写即精确命中 0 行 → 失败关闭）；
 *   2) 子行集合闭包断言（实际回复集合必须与本轮回复集合完全一致，多一条外部回复即失败关闭）；
 *   3) **逐条回复按完整 7/7 快照复核**：每条回复的整行 WHERE 必须精确命中 1 行（任一字段被
 *      改写即命中 0 行、失败关闭），杜绝「阶段 A 后改回复字段仍被删除」的 TOCTOU；
 *   4) 逐条按同一完整 7/7 WHERE 删除，并核对精确影响行数为 1；
 *   5) 再按同一整行快照删主行；6) 父子残留核对为 0。
 */
/** 绑定参数白名单校验（删除原语、只读预检与 locator 共用同一口径，杜绝两套校验漂移） */
function assertPr5RepairRequestBindingParams(binding: Pr5RepairRequestBinding): void {
  const { id, requestNo, customerAccountId, responses } = binding;

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`维修申请清理目标 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  if (!REQUEST_NO_PATTERN.test(requestNo)) {
    throw new Error(`维修申请清理目标编号未通过白名单校验：${JSON.stringify(requestNo)}`);
  }

  if (!Number.isSafeInteger(customerAccountId) || customerAccountId <= 0) {
    throw new Error(
      `维修申请清理目标客户账号未通过正整数校验：${JSON.stringify(customerAccountId)}`,
    );
  }

  // 子回复必须是**完整绑定**（含 7/7 canonical 快照）：逐条复用回复自身的参数白名单，
  // 并强制 request_id 与父申请一致——杜绝「裸 ID 集合」或「挂到别的父申请」的误绑定。
  const seenResponseIds = new Set<number>();

  for (const response of responses) {
    assertPr5EngineerResponseBindingParams(response);

    if (response.requestId !== id) {
      throw new Error(
        `维修申请清理目标回复的父申请 ID 与绑定不一致：回复 ${response.id} 的 request_id=${response.requestId} ≠ 父申请 ${id}`,
      );
    }

    if (seenResponseIds.has(response.id)) {
      throw new Error(`维修申请清理目标回复 ID 重复：${JSON.stringify(response.id)}`);
    }

    seenResponseIds.add(response.id);
  }

  // 整行快照：列名集合与取值类型必须完整合法（缺任一 canonical 列即拒绝，杜绝字面量逃逸）
  assertPr5RowSnapshotShape(binding.snapshot);
  assertPr5SnapshotFactorMatches(binding.snapshot, 'id', String(id), '维修申请');
  assertPr5SnapshotFactorMatches(binding.snapshot, 'request_no', requestNo, '维修申请');
  assertPr5SnapshotFactorMatches(
    binding.snapshot,
    'customer_account_id',
    String(customerAccountId),
    '维修申请',
  );
}

/** 按主键读取当前行并构造**完整行绑定**（S5 真实链路删除自建行时使用；不降低清理安全组口径） */
export function readPr5RepairRequestBindingFromDb(input: {
  id: number;
  requestNo: string;
  customerAccountId: number;
  responses: readonly Pr5EngineerResponseBinding[];
}): Pr5RepairRequestBinding {
  const binding: Pr5RepairRequestBinding = {
    ...input,
    snapshot: readPr5FullRowSnapshot('repair_request', input.id),
  };

  assertPr5RepairRequestBindingParams(binding);

  return binding;
}

/**
 * 单条回复的「事务内完整 7/7 快照复核」语句组：以该回复的整行 WHERE 精确命中 1 行。
 * 字段被改写 / 行被删除都会命中 0 行，哨兵名（含回复 ID，字面量出现在 SQL 文本中，可被
 * `toThrow` 直接匹配）用「未知列」错误失败关闭，绝不静默继续删除。
 */
function buildPr5EngineerResponseChildCheckStatements(
  response: Pr5EngineerResponseBinding,
): string[] {
  const { id } = response;
  const responseWhere = buildPr5EngineerResponseBindingWhere(response);

  return [
    `SET @pr5_rr_child_full_${id} = (SELECT COUNT(*) FROM engineer_response WHERE ${responseWhere})`,
    `SET @pr5_rr_child_full_check_${id} = IF(@pr5_rr_child_full_${id} = 1, 'SELECT 1', 'SELECT pr5_engineer_response_child_pk_${id}_full_snapshot_must_match_exactly_one')`,
    `PREPARE pr5_rr_child_full_check_stmt_${id} FROM @pr5_rr_child_full_check_${id}`,
    `EXECUTE pr5_rr_child_full_check_stmt_${id}`,
    `DEALLOCATE PREPARE pr5_rr_child_full_check_stmt_${id}`,
  ];
}

/** 单条回复的「按完整 7/7 WHERE 删除 + 精确影响行数核对」语句组（影响行数 ≠ 1 即失败关闭） */
function buildPr5EngineerResponseChildDeleteStatements(
  response: Pr5EngineerResponseBinding,
): string[] {
  const { id } = response;
  const responseWhere = buildPr5EngineerResponseBindingWhere(response);

  return [
    `DELETE FROM engineer_response WHERE ${responseWhere}`,
    `SET @pr5_rr_child_deleted_${id} = ROW_COUNT()`,
    `SET @pr5_rr_child_delete_${id} = IF(@pr5_rr_child_deleted_${id} = 1, 'SELECT 1', 'SELECT pr5_engineer_response_child_delete_must_affect_exactly_one_row')`,
    `PREPARE pr5_rr_child_delete_check_${id} FROM @pr5_rr_child_delete_${id}`,
    `EXECUTE pr5_rr_child_delete_check_${id}`,
    `DEALLOCATE PREPARE pr5_rr_child_delete_check_${id}`,
  ];
}

export function deletePr5RepairRequestBound(binding: Pr5RepairRequestBinding): void {
  const { id, responses } = binding;

  assertPr5RepairRequestBindingParams(binding);

  assertPhysicalCleanupAllowed(readBackendEnv());

  const where = buildPr5RepairRequestWhere(binding);
  // 无回复时以 0 占位：IN (0) 不匹配任何行，等价于「本轮允许的回复集合为空」
  const expectedResponseIds = responses.length === 0 ? '0' : responses.map((r) => r.id).join(', ');

  mysqlQuery(
    [
      'START TRANSACTION',
      `SET @pr5_rr_bound = (SELECT COUNT(*) FROM repair_request WHERE ${where})`,
      "SET @pr5_rr_binding = IF(@pr5_rr_bound = 1, 'SELECT 1', 'SELECT pr5_repair_request_binding_id_request_no_customer_must_match_exactly_one')",
      'PREPARE pr5_rr_binding_check FROM @pr5_rr_binding',
      'EXECUTE pr5_rr_binding_check',
      'DEALLOCATE PREPARE pr5_rr_binding_check',
      `SET @pr5_rr_child_total = (SELECT COUNT(*) FROM engineer_response WHERE request_id = ${id})`,
      `SET @pr5_rr_child_matched = (SELECT COUNT(*) FROM engineer_response WHERE request_id = ${id} AND id IN (${expectedResponseIds}))`,
      `SET @pr5_rr_child_binding = IF(@pr5_rr_child_total = ${responses.length} AND @pr5_rr_child_matched = ${responses.length}, 'SELECT 1', 'SELECT pr5_engineer_response_child_binding_must_match_this_run')`,
      'PREPARE pr5_rr_child_check FROM @pr5_rr_child_binding',
      'EXECUTE pr5_rr_child_check',
      'DEALLOCATE PREPARE pr5_rr_child_check',
      // 逐条回复完整 7/7 快照复核（子回复完整 bindings 进入父事务的核心证据）
      ...responses.flatMap((response) => buildPr5EngineerResponseChildCheckStatements(response)),
      // 逐条按同一完整 7/7 WHERE 删除，并核对精确影响行数为 1
      ...responses.flatMap((response) => buildPr5EngineerResponseChildDeleteStatements(response)),
      `DELETE FROM repair_request WHERE ${where}`,
      `SET @pr5_rr_residue = (SELECT COUNT(*) FROM repair_request WHERE id = ${id}) + (SELECT COUNT(*) FROM engineer_response WHERE request_id = ${id})`,
      "SET @pr5_rr_assertion = IF(@pr5_rr_residue = 0, 'SELECT 1', 'SELECT pr5_repair_request_residue_must_be_zero')",
      'PREPARE pr5_rr_residue_check FROM @pr5_rr_assertion',
      'EXECUTE pr5_rr_residue_check',
      'DEALLOCATE PREPARE pr5_rr_residue_check',
      'COMMIT',
    ].join('; '),
  );
}

/**
 * 只读预检维修申请的三因子绑定与「本轮回复集合精确一致」（**不写库**）。
 * 供清理编排在**任何 DELETE 之前**整体预检：发现未知子行 / 同标识异主即抛错，
 * 保证「发现冲突后零写入失败关闭」；与 deletePr5RepairRequestBound 共用同一 where 口径。
 */
export function assertPr5RepairRequestBindingBound(binding: Pr5RepairRequestBinding): void {
  assertPr5RepairRequestBindingParams(binding);

  const { id, responses } = binding;
  const where = buildPr5RepairRequestWhere(binding);
  const expectedResponseIds = responses.length === 0 ? '0' : responses.map((r) => r.id).join(', ');
  const raw = mysqlQuery(
    'SELECT CONCAT(' +
      `(SELECT COUNT(*) FROM repair_request WHERE ${where}), '|', ` +
      `(SELECT COUNT(*) FROM engineer_response WHERE request_id = ${id}), '|', ` +
      `(SELECT COUNT(*) FROM engineer_response WHERE request_id = ${id} AND id IN (${expectedResponseIds})))`,
  ).trim();
  const columns = raw.split('|');

  if (columns.length !== 3) {
    throw new Error(`维修申请只读预检结果异常：${JSON.stringify(raw)}`);
  }

  const [bound, childTotal, childMatched] = columns.map(Number);

  if (bound !== 1) {
    throw new Error(
      `pr5_repair_request_binding_id_request_no_customer_must_match_exactly_one：维修申请三因子绑定未精确命中 1 行（实际 ${JSON.stringify(columns[0])}）：${JSON.stringify(binding)}`,
    );
  }

  if (childTotal !== responses.length || childMatched !== responses.length) {
    throw new Error(
      `pr5_engineer_response_child_binding_must_match_this_run：本轮回复集合与父申请子行不一致（子行 ${childTotal} / 命中 ${childMatched} / 期望 ${responses.length}）：${JSON.stringify(binding)}`,
    );
  }

  // 逐条回复完整 7/7 快照只读核验：任一字段被改写即精确命中 0 行 → 零写入失败关闭
  for (const response of responses) {
    assertPr5EngineerResponseBindingBound(response);
  }
}

/** 只读读取维修申请状态三要素：用于「拒绝删除后数据不变」的前后快照比对（按编号 + 客户双重绑定） */
export function readPr5RepairRequestState(
  requestNo: string,
  customerAccountId: number,
): {
  isAccepted: string;
  deprecated: string;
  deletedAtIsNotNull: string;
} {
  if (!REQUEST_NO_PATTERN.test(requestNo)) {
    throw new Error(`维修申请状态读取编号未通过白名单校验：${JSON.stringify(requestNo)}`);
  }

  if (!Number.isSafeInteger(customerAccountId) || customerAccountId <= 0) {
    throw new Error(
      `维修申请状态读取客户账号未通过正整数校验：${JSON.stringify(customerAccountId)}`,
    );
  }

  const [row] = mysqlQuery(
    `SELECT is_accepted, deprecated, deleted_at IS NOT NULL FROM repair_request WHERE request_no = '${requestNo}' AND customer_account_id = ${customerAccountId}`,
  )
    .split('\n')
    .map((value) => value.trim());

  const columns = row?.split('\t');

  if (columns === undefined || columns.length !== 3) {
    throw new Error(`维修申请状态读取结果异常：${JSON.stringify(row)}`);
  }

  return { deletedAtIsNotNull: columns[2], deprecated: columns[1], isAccepted: columns[0] };
}

/**
 * 参考资料**完整行绑定**（P1-1）：除三因子外必须提供数据库读回的整行 canonical 快照（15/15 列）。
 * 只读预检、存储引用读取与事务内 DELETE 都由该快照生成同一 WHERE——
 * 任一非三因子字段（含 `description` / `original_filename` / `mime_type` / `content_text` /
 * `equipment_model_id` / `storage_*` / `deprecated` / `deleted_at` / `created_at` / `updated_at`）
 * 被外部改写即精确命中 0 行 → 零写入失败关闭（`updated_at` 亦用于识别「改动后又改回」）。
 *
 * 快照为**必填**：类型系统直接阻止「缺完整快照仍走破坏性三因子删除」的误传路径。
 */
export interface Pr5ReferenceDocumentBinding {
  /** 数据库生成的参考资料主键 */
  readonly id: number;
  readonly createdByAccountId: number;
  /** 本轮运行唯一标题关键字（残留反查 locator 使用；不再单独参与破坏性 WHERE） */
  readonly titleKeyword: string;
  /** 建行时数据库实际落库的整行快照（15/15 列） */
  readonly snapshot: Pr5RowSnapshot;
}

/** 资料绑定 where 子句：canonical 整行快照（无字段子集、无三因子退回路径） */
function buildPr5ReferenceDocumentWhere(binding: Pr5ReferenceDocumentBinding): string {
  if (binding.snapshot.table !== 'reference_document') {
    throw new Error(
      `参考资料绑定快照表名不符：期望 reference_document，实际 ${JSON.stringify(binding.snapshot.table)}`,
    );
  }

  return buildPr5RowConditions(binding.snapshot);
}

/** 绑定参数白名单校验（删除原语、只读核验与 locator 共用同一口径，杜绝两套校验漂移） */
function assertPr5ReferenceDocumentBinding(binding: Pr5ReferenceDocumentBinding): void {
  const { id, createdByAccountId, titleKeyword } = binding;

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`参考资料清理目标 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  if (!Number.isSafeInteger(createdByAccountId) || createdByAccountId <= 0) {
    throw new Error(
      `参考资料清理目标创建人账号未通过正整数校验：${JSON.stringify(createdByAccountId)}`,
    );
  }

  if (!PR5_DOC_KEYWORD_PATTERN.test(titleKeyword)) {
    throw new Error(`参考资料清理目标标题关键字未通过白名单校验：${JSON.stringify(titleKeyword)}`);
  }

  // 整行快照：列名集合与取值类型必须完整合法（缺任一 canonical 列即拒绝，杜绝字面量逃逸）
  assertPr5RowSnapshotShape(binding.snapshot);
  assertPr5SnapshotFactorMatches(binding.snapshot, 'id', String(id), '参考资料');
  assertPr5SnapshotFactorMatches(
    binding.snapshot,
    'created_by_account_id',
    String(createdByAccountId),
    '参考资料',
  );

  // 残留 locator 仍按本轮标题关键字反查，故快照标题必须包含该关键字
  if (!readPr5SnapshotColumn(binding.snapshot, 'title').includes(titleKeyword)) {
    throw new Error(
      `参考资料快照标题未包含本轮标题关键字（${titleKeyword}）：${JSON.stringify(readPr5SnapshotColumn(binding.snapshot, 'title'))}`,
    );
  }
}

/** 按主键读取当前行并构造**完整行绑定**（S5 真实链路清理自建资料时使用；不降低清理安全组口径） */
export function readPr5ReferenceDocumentBindingFromDb(input: {
  id: number;
  createdByAccountId: number;
  titleKeyword: string;
}): Pr5ReferenceDocumentBinding {
  const binding: Pr5ReferenceDocumentBinding = {
    ...input,
    snapshot: readPr5FullRowSnapshot('reference_document', input.id),
  };

  assertPr5ReferenceDocumentBinding(binding);

  return binding;
}

/**
 * 归属核验并读取本行精确存储引用（P1-2）：调用方必须先经本函数核验三因子绑定唯一命中，
 * 再按返回的精确引用删除物理文件——绑定不唯一或引用非法即抛错（失败关闭），
 * 绝不删除未完成归属核验的文件。无存储引用（纯文本资料）返回 null。
 */
export function readPr5ReferenceDocumentStorageReferenceBound(
  binding: Pr5ReferenceDocumentBinding,
): string | null {
  assertPr5ReferenceDocumentBinding(binding);

  const where = buildPr5ReferenceDocumentWhere(binding);

  // COUNT 与引用用 '|' 拼接成单列返回：mysql -N -B 的空列是行尾制表符，读回后被 trim 吃掉，
  // 无法区分「引用为空」与「列缺失」；'|' 不可能出现在引用白名单（hex + 扩展名）内，天然安全。
  const raw = mysqlQuery(
    `SELECT CONCAT(COUNT(*), '|', IFNULL(MAX(storage_reference), '')) FROM reference_document WHERE ${where}`,
  ).trim();
  const columns = raw.split('|');

  if (columns.length !== 2) {
    throw new Error(`参考资料存储引用读取结果异常：${JSON.stringify(raw)}`);
  }

  const boundCount = Number(columns[0]);

  if (!Number.isSafeInteger(boundCount) || boundCount !== 1) {
    throw new Error(
      `参考资料归属核验未精确命中 1 行（实际 ${JSON.stringify(columns[0])} 行），拒绝删除物理文件：${JSON.stringify(binding)}`,
    );
  }

  const reference = columns[1];

  if (reference === '' || reference === 'NULL') {
    return null;
  }

  if (!STORAGE_REFERENCE_PATTERN.test(reference)) {
    throw new Error(`参考资料存储引用未通过白名单校验，拒绝删除：${JSON.stringify(reference)}`);
  }

  return reference;
}

/**
 * 归属核验后物理删除本轮自建参考资料行。
 *
 * 事务内顺序：三因子绑定唯一断言（id + 创建人账号 + 本轮标题关键字）→ 精确删除 → 残留核对为 0。
 * 物理文件删除必须以 readPr5ReferenceDocumentStorageReferenceBound 事先取到的精确引用为准，
 * 且必须先于删行取引用（删行后反查将空转）；顺序由 spec 的清理编排保证。
 */
export function deletePr5ReferenceDocumentBound(binding: Pr5ReferenceDocumentBinding): void {
  assertPr5ReferenceDocumentBinding(binding);

  const { id } = binding;

  assertPhysicalCleanupAllowed(readBackendEnv());

  const where = buildPr5ReferenceDocumentWhere(binding);

  mysqlQuery(
    [
      'START TRANSACTION',
      `SET @pr5_rd_bound = (SELECT COUNT(*) FROM reference_document WHERE ${where})`,
      "SET @pr5_rd_binding = IF(@pr5_rd_bound = 1, 'SELECT 1', 'SELECT pr5_reference_document_binding_id_creator_keyword_must_match_exactly_one')",
      'PREPARE pr5_rd_binding_check FROM @pr5_rd_binding',
      'EXECUTE pr5_rd_binding_check',
      'DEALLOCATE PREPARE pr5_rd_binding_check',
      `DELETE FROM reference_document WHERE ${where}`,
      `SET @pr5_rd_residue = (SELECT COUNT(*) FROM reference_document WHERE id = ${id})`,
      "SET @pr5_rd_assertion = IF(@pr5_rd_residue = 0, 'SELECT 1', 'SELECT pr5_reference_document_residue_must_be_zero')",
      'PREPARE pr5_rd_residue_check FROM @pr5_rd_assertion',
      'EXECUTE pr5_rd_residue_check',
      'DEALLOCATE PREPARE pr5_rd_residue_check',
      'COMMIT',
    ].join('; '),
  );
}

/**
 * 按本轮标题关键字反查资料 ID（兜底清理用；只匹配本轮运行的自建行）。
 * 不按 deprecated 过滤：软删行同样属于本轮自建行，兜底必须能回收（D4-1）。
 */
export function findPr5ReferenceDocumentIdsByKeyword(titleKeyword: string): number[] {
  if (!PR5_DOC_KEYWORD_PATTERN.test(titleKeyword)) {
    throw new Error(`资料反查关键字未通过白名单校验：${JSON.stringify(titleKeyword)}`);
  }

  return mysqlQuery(`SELECT id FROM reference_document WHERE title LIKE '%${titleKeyword}%'`)
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

/**
 * 按本轮标题前缀统计资料行数（S5-5「越权新建未落库」只读计数）。
 * 前缀须过白名单（禁止 % / _ / 引号 / 反斜杠 / 空白），杜绝运行关键字直接拼 SQL。
 */
export function countPr5ReferenceDocumentsByTitlePrefix(titlePrefix: string): number {
  if (!PR5_DOC_TITLE_PREFIX_PATTERN.test(titlePrefix)) {
    throw new Error(`资料标题前缀未通过白名单校验：${JSON.stringify(titlePrefix)}`);
  }

  return readSingleCount(
    `SELECT COUNT(*) FROM reference_document WHERE title LIKE '${titlePrefix}%'`,
    '资料标题前缀',
  );
}

/** 按精确 ID 读取软删标记（「软删后不可见」的 DB 级证据；无行返回 null） */
export function readPr5ReferenceDocumentDeprecatedById(id: number): string | null {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`资料软删标记查询目标 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  const value = mysqlQuery(`SELECT deprecated FROM reference_document WHERE id = ${id}`);

  return value.length > 0 ? value : null;
}

/**
 * 按精确 ID 读取资料行**整行 canonical 快照**（P2-3/D2-1）：用于「越权写被拒后目标行未被改写」的
 * 前后比对。列集合即 canonical 列清单（唯一口径，不再维护第二份静态字段子集）；无行返回 null。
 */
export function readPr5ReferenceDocumentSnapshot(id: number): string | null {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`资料快照查询目标 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  const columns = readPr5CanonicalColumns('reference_document');
  const value = mysqlQuery(`SELECT ${columns.join(', ')} FROM reference_document WHERE id = ${id}`);

  return value.length > 0 ? value : null;
}

/** 回复正文白名单：非空、无引号/反斜杠/通配符/换行（正文同时是本轮正文绑定因子） */
export const PR5_RESPONSE_TEXT_PATTERN = /^[^'\\%\r\n]{1,200}$/;

/**
 * 工程师回复**完整行绑定**（P1-1）：除五因子外必须提供数据库读回的整行 canonical 快照（7/7 列）。
 * 只读预检与事务内 DELETE 都由该快照生成同一 WHERE——任一非五因子字段（含 `resolution_status` /
 * `created_at`）被外部改写即精确命中 0 行 → 零写入失败关闭。
 *
 * 快照为**必填**：类型系统直接阻止「缺完整快照仍走破坏性五因子删除」的误传路径。
 */
export interface Pr5EngineerResponseBinding {
  /** 工程师回复主键 */
  readonly id: number;
  /** 父维修申请主键 */
  readonly requestId: number;
  readonly engineerAccountId: number;
  readonly customerAccountId: number;
  /** 本轮写入的回复正文（白名单内；同时作为运行级正文绑定因子，按精确相等核验） */
  readonly responseText: string;
  /** 建行时数据库实际落库的整行快照（7/7 列） */
  readonly snapshot: Pr5RowSnapshot;
}

/** 回复绑定参数白名单校验（删除原语、只读预检与 locator 共用，杜绝两套校验漂移） */
function assertPr5EngineerResponseBindingParams(binding: Pr5EngineerResponseBinding): void {
  const { id, requestId, engineerAccountId, customerAccountId, responseText } = binding;

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`工程师回复清理目标 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    throw new Error(`工程师回复父申请 ID 未通过正整数校验：${JSON.stringify(requestId)}`);
  }

  if (!Number.isSafeInteger(engineerAccountId) || engineerAccountId <= 0) {
    throw new Error(`工程师回复工程师账号未通过正整数校验：${JSON.stringify(engineerAccountId)}`);
  }

  if (!Number.isSafeInteger(customerAccountId) || customerAccountId <= 0) {
    throw new Error(`工程师回复客户账号未通过正整数校验：${JSON.stringify(customerAccountId)}`);
  }

  if (!PR5_RESPONSE_TEXT_PATTERN.test(responseText)) {
    throw new Error(`工程师回复正文未通过白名单校验：${JSON.stringify(responseText)}`);
  }

  // 整行快照：列名集合与取值类型必须完整合法（缺任一 canonical 列即拒绝）
  assertPr5RowSnapshotShape(binding.snapshot);
  assertPr5SnapshotFactorMatches(binding.snapshot, 'id', String(id), '工程师回复');
  assertPr5SnapshotFactorMatches(binding.snapshot, 'request_id', String(requestId), '工程师回复');
  assertPr5SnapshotFactorMatches(
    binding.snapshot,
    'engineer_account_id',
    String(engineerAccountId),
    '工程师回复',
  );
  assertPr5SnapshotFactorMatches(
    binding.snapshot,
    'customer_account_id',
    String(customerAccountId),
    '工程师回复',
  );
  assertPr5SnapshotFactorMatches(binding.snapshot, 'response_text', responseText, '工程师回复');
}

/** 回复绑定 where 子句：canonical 整行快照（删除与只读预检共用同一口径） */
function buildPr5EngineerResponseBindingWhere(binding: Pr5EngineerResponseBinding): string {
  if (binding.snapshot.table !== 'engineer_response') {
    throw new Error(
      `工程师回复绑定快照表名不符：期望 engineer_response，实际 ${JSON.stringify(binding.snapshot.table)}`,
    );
  }

  return buildPr5RowConditions(binding.snapshot);
}

/** 按主键读取当前行并构造**完整行绑定**（本轮外回复的精确回收也用此构造，非裸 ID） */
export function readPr5EngineerResponseBindingFromDb(input: {
  id: number;
  requestId: number;
  engineerAccountId: number;
  customerAccountId: number;
  responseText: string;
}): Pr5EngineerResponseBinding {
  const binding: Pr5EngineerResponseBinding = {
    ...input,
    snapshot: readPr5FullRowSnapshot('engineer_response', input.id),
  };

  assertPr5EngineerResponseBindingParams(binding);

  return binding;
}

/**
 * 按主键读取回复**完整绑定**：五因子直接从数据库整行快照（7/7）派生，再统一走参数白名单校验。
 * 供真实链路 teardown 用「当前库行」重建捕捉于创建时的回复集合（父行同样按当前行走
 * readPr5RepairRequestBindingFromDb 重建），使父事务内逐条 7/7 复核仍能在删除前失败关闭。
 */
export function readPr5EngineerResponseBindingById(id: number): Pr5EngineerResponseBinding {
  const snapshot = readPr5FullRowSnapshot('engineer_response', id);
  const binding: Pr5EngineerResponseBinding = {
    customerAccountId: Number(readPr5SnapshotColumn(snapshot, 'customer_account_id')),
    engineerAccountId: Number(readPr5SnapshotColumn(snapshot, 'engineer_account_id')),
    id,
    requestId: Number(readPr5SnapshotColumn(snapshot, 'request_id')),
    responseText: readPr5SnapshotColumn(snapshot, 'response_text'),
    snapshot,
  };

  assertPr5EngineerResponseBindingParams(binding);

  return binding;
}

/**
 * 只读核验回复的完整 binding（**不写库**）：五因子必须精确命中 1 行，否则失败关闭。
 * 供清理编排在**任何 DELETE 之前**做整体预检；发现同 ID 异主 / 正文不符即零写入抛错。
 */
export function assertPr5EngineerResponseBindingBound(binding: Pr5EngineerResponseBinding): void {
  assertPr5EngineerResponseBindingParams(binding);

  const where = buildPr5EngineerResponseBindingWhere(binding);
  const raw = mysqlQuery(`SELECT COUNT(*) FROM engineer_response WHERE ${where}`).trim();
  const matched = Number(raw);

  if (!Number.isSafeInteger(matched) || matched !== 1) {
    throw new Error(
      `pr5_engineer_response_binding_must_match_exactly_one：回复完整绑定核验未精确命中 1 行（实际 ${JSON.stringify(raw)}）：${JSON.stringify(binding)}`,
    );
  }
}

/**
 * 回复删除按**完整 binding** 绑定（id + request_id + engineer_account_id + customer_account_id
 * + 本轮正文），事务内先断言精确命中 1 行，再删除并核对精确影响行数为 1；任一不符即失败关闭
 * （无 DELETE 发生，连接关闭触发回滚）。**已不存在**（父行删除时已连带删除）视为幂等跳过。
 * 拒绝任何「仅凭 ID」的兜底删除。
 */
export function deletePr5EngineerResponseRowsBound(binding: Pr5EngineerResponseBinding): void {
  assertPr5EngineerResponseBindingParams(binding);

  assertPhysicalCleanupAllowed(readBackendEnv());

  const { id } = binding;
  const where = buildPr5EngineerResponseBindingWhere(binding);

  mysqlQuery(
    [
      'START TRANSACTION',
      `SET @pr5_er_present = (SELECT COUNT(*) FROM engineer_response WHERE id = ${id})`,
      `SET @pr5_er_bound = (SELECT COUNT(*) FROM engineer_response WHERE ${where})`,
      "SET @pr5_er_binding = IF(@pr5_er_present = 0 OR @pr5_er_bound = 1, 'SELECT 1', 'SELECT pr5_engineer_response_binding_must_match_exactly_one')",
      'PREPARE pr5_er_binding_check FROM @pr5_er_binding',
      'EXECUTE pr5_er_binding_check',
      'DEALLOCATE PREPARE pr5_er_binding_check',
      `DELETE FROM engineer_response WHERE ${where}`,
      // 预检已保证 bound ∈ {0,1}，删除后按 id 残留必须为 0 ⇒ 精确影响行数等于 bound
      `SET @pr5_er_residue = (SELECT COUNT(*) FROM engineer_response WHERE id = ${id})`,
      "SET @pr5_er_assertion = IF(@pr5_er_residue = 0, 'SELECT 1', 'SELECT pr5_engineer_response_residue_must_be_zero')",
      'PREPARE pr5_er_residue_check FROM @pr5_er_assertion',
      'EXECUTE pr5_er_residue_check',
      'DEALLOCATE PREPARE pr5_er_residue_check',
      'COMMIT',
    ].join('; '),
  );
}

/** 物理文件删除器：显式注入，使「文件删除失败只留可回收孤儿」可被失败注入与断言 */
export type Pr5StorageFileDeleter = (reference: string) => void;

/**
 * 可恢复残留回执（S4）：精确记录本轮清理中「已删 / 残留」的行与文件引用。
 * 只含本轮 ID 与存储引用，不含连接串、账号、密码等任何凭据。
 */
export interface Pr5CleanupReceipt {
  readonly deletedRowIds: readonly number[];
  readonly deletedFileReferences: readonly string[];
  readonly residualRowIds: readonly number[];
  readonly residualFileReferences: readonly string[];
  /** 逐项失败原因（来自受保护 helper 的脱敏错误文本），供调用方诊断且不吞错误 */
  readonly failureMessages: readonly string[];
}

export interface Pr5DocumentCleanupOptions {
  /** 行删除器（默认受保护的三因子绑定删除）；注入后可对指定行制造删除失败 */
  readonly deleteRow?: (binding: Pr5ReferenceDocumentBinding) => void;
  /** 文件删除器（默认真实存储文件删除）；注入后可对指定引用制造删除失败 */
  readonly deleteFile?: Pr5StorageFileDeleter;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 本轮自建参考资料的统一清理编排（S4）：**全量预检 → 精确删行 → 按已核验引用删文件**。
 *
 * 1. 先对全部绑定做三因子归属核验并取精确存储引用：任一不唯一 / 引用非法即抛错，
 *    此时行与文件均未改动（失败发生在任何 DELETE 之前）；
 * 2. 再逐行精确删除，逐文件按已核验引用删除；
 * 3. 任一行删除失败：该行计入残留，**并跳过其文件删除**（行未删即不得删文件），
 *    不扩大删除范围；任一文件删除失败：该引用计入残留，只留下可被下一轮精确回收的孤儿文件；
 * 4. 返回可恢复残留回执，绝不吞掉任何失败（调用方据回执或 assertPr5CleanupReceiptClean 判红）。
 */
export function cleanupPr5ReferenceDocumentsBound(
  bindings: readonly Pr5ReferenceDocumentBinding[],
  options: Pr5DocumentCleanupOptions = {},
): Pr5CleanupReceipt {
  const deleteRow = options.deleteRow ?? deletePr5ReferenceDocumentBound;
  const deleteFile = options.deleteFile ?? deleteE2EReferenceDocumentStorageFileByReference;

  // 第一步：全量预检（不通过即抛错，未删任何行/文件）
  const resolved = bindings.map((binding) => ({
    binding,
    reference: readPr5ReferenceDocumentStorageReferenceBound(binding),
  }));

  const deletedRowIds: number[] = [];
  const deletedFileReferences: string[] = [];
  const residualRowIds: number[] = [];
  const residualFileReferences: string[] = [];
  const failureMessages: string[] = [];

  // 第二步：逐行精确删行；第三步：按已核验引用删文件（只删成功删行的那一行文件）
  for (const { binding, reference } of resolved) {
    try {
      deleteRow(binding);
      deletedRowIds.push(binding.id);
    } catch (error) {
      residualRowIds.push(binding.id);
      failureMessages.push(`删行失败 id=${binding.id}：${failureMessage(error)}`);
      continue;
    }

    if (reference === null) {
      continue;
    }

    try {
      deleteFile(reference);
      deletedFileReferences.push(reference);
    } catch (error) {
      residualFileReferences.push(reference);
      failureMessages.push(`删文件失败 reference=${reference}：${failureMessage(error)}`);
    }
  }

  return {
    deletedFileReferences,
    deletedRowIds,
    failureMessages,
    residualFileReferences,
    residualRowIds,
  };
}

/** 回执断言：存在任何行/文件残留即抛错（残留必须可观测，绝不静默通过） */
export function assertPr5CleanupReceiptClean(receipt: Pr5CleanupReceipt): void {
  if (receipt.residualRowIds.length === 0 && receipt.residualFileReferences.length === 0) {
    return;
  }

  throw new Error(
    `PR5 清理存在残留：行=${JSON.stringify(receipt.residualRowIds)} 文件=${JSON.stringify(receipt.residualFileReferences)}` +
      (receipt.failureMessages.length === 0
        ? ''
        : `；失败原因：${receipt.failureMessages.join('；')}`),
  );
}
