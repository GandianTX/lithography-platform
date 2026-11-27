// test/utils/task09-record-package-probe-safety.ts

/**
 * 任务 09 记录包链实库规格的探针对象生命周期守卫。
 *
 * 纪律：
 * - 物理清理许可、显式一次性专库声明、预期/实际库与服务器身份都是独立门禁；
 *   任一缺失都在任何 CREATE/DROP/DELETE 之前失败关闭；
 * - 对象名由本轮 runId 派生，创建前只读确认不存在；**绝不先 DROP IF EXISTS 清理同名对象**；
 * - 只有 CREATE 明确成功后才登记所有权；收尾先核验当前对象身份，再按依赖顺序精确删除；
 * - MySQL DDL 隐式提交，表与触发器不声称跨资源原子；部分创建/替换/缺失分别保留诊断。
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DataSource } from 'typeorm';

import { assertDataSourceOnAllowedE2eDatabase, assertPhysicalCleanupConsent } from './e2e-db-guard';

export const CHAIN_ENABLE_ENV = 'TASK09_RECORD_PACKAGE_CHAIN';
export const CHAIN_ENV_FILE_ENV = 'TASK09_RECORD_PACKAGE_ENV_FILE';
export const CHAIN_DATABASE_ENV = 'E2E_REAL_DB_NAME';
export const CHAIN_DISPOSABLE_ENV = 'TASK09_RECORD_PACKAGE_DISPOSABLE_DB';
export const CHAIN_SERVER_UUID_ENV = 'TASK09_RECORD_PACKAGE_EXPECTED_SERVER_UUID';
export const CHAIN_RUN_ID_ENV = 'TASK09_RECORD_PACKAGE_PROBE_RUN_ID';
/** 仅测试用：把本轮插入触发器替换成仍引用探针表的外部定义，驱动真实 afterAll 依赖保留。 */
export const INJECT_PROBE_TRIGGER_DISPOSAL_FAILURE_ENV =
  'TASK09_RECORD_PACKAGE_INJECT_PROBE_TRIGGER_DISPOSAL_FAILURE';
/** 仅测试用：把本轮探针表改成同列名不同类型，驱动真实 afterAll 对象核验失败。 */
export const INJECT_PROBE_TABLE_DISPOSAL_FAILURE_ENV =
  'TASK09_RECORD_PACKAGE_INJECT_PROBE_TABLE_DISPOSAL_FAILURE';

const SAFE_DB_NAME = /^lithography_task09_[a-z0-9_]+_(?:test|drill|ci)_[a-z0-9_]+$/u;
const SAFE_RUN_ID = /^[A-Za-z0-9_]{1,16}$/u;
const SAFE_OBJECT_SUFFIX = /^[A-Za-z0-9_]{1,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FORBIDDEN_DATABASES = new Set([
  'lithography_task09',
  'lithography_task09_dev',
  'lithography_task09_test',
  'lithography_task09_test_e2e',
  'lithography_e2e',
]);

export type ChainProbeRunScope = {
  readonly runId: string;
  readonly database: string;
  readonly serverUuid: string;
  readonly envFile: string;
  readonly probeTable: string;
  readonly probeTrigger: string;
  readonly faultTrigger: string;
};

export type ChainProbeEnv = Readonly<Record<string, string | undefined>>;

const envValue = (env: ChainProbeEnv, key: string): string =>
  typeof env[key] === 'string' ? env[key].trim() : '';

/**
 * 在任何 DDL、业务写入或删除之前执行的纯前置守卫。
 * 只读取环境变量与文件系统，不连接数据库、不产生副作用。
 */
export const assertChainProbePreflight = (env: ChainProbeEnv = process.env): ChainProbeRunScope => {
  assertPhysicalCleanupConsent();

  if (envValue(env, CHAIN_ENABLE_ENV) !== '1') {
    throw new Error(`[记录包探针守卫] 拒绝启动：必须显式设置 ${CHAIN_ENABLE_ENV}=1`);
  }

  const rawEnvFile = envValue(env, CHAIN_ENV_FILE_ENV);
  if (rawEnvFile === '') {
    throw new Error(
      `[记录包探针守卫] 拒绝启动：必须显式设置 ${CHAIN_ENV_FILE_ENV}，不得回落默认 e2e 环境文件`,
    );
  }
  const envFile = resolve(rawEnvFile);
  if (!existsSync(envFile)) {
    throw new Error(`[记录包探针守卫] 拒绝启动：指定环境文件不存在 ${envFile}`);
  }

  const database = envValue(env, CHAIN_DATABASE_ENV).toLowerCase();
  if (database === '' || FORBIDDEN_DATABASES.has(database) || !SAFE_DB_NAME.test(database)) {
    throw new Error(
      `[记录包探针守卫] 拒绝启动：${CHAIN_DATABASE_ENV}="${database}" 不是明确授权的一次性专库名` +
        '（必须包含 test/drill/ci 段且不得是任何保留库）',
    );
  }
  if (envValue(env, CHAIN_DISPOSABLE_ENV) !== '1') {
    throw new Error(
      `[记录包探针守卫] 拒绝启动：缺少明确的可丢弃专库声明 ${CHAIN_DISPOSABLE_ENV}=1；库名白名单不能替代该声明`,
    );
  }

  const serverUuid = envValue(env, CHAIN_SERVER_UUID_ENV).toLowerCase();
  if (!UUID.test(serverUuid)) {
    throw new Error(
      `[记录包探针守卫] 拒绝启动：${CHAIN_SERVER_UUID_ENV} 必须是明确的服务器 UUID，实际="${serverUuid}"`,
    );
  }

  const configuredRunId = envValue(env, CHAIN_RUN_ID_ENV);
  const runId = configuredRunId === '' ? randomBytes(6).toString('hex') : configuredRunId;
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`[记录包探针守卫] 拒绝启动：本轮运行标识不合法 "${runId}"`);
  }

  return {
    runId,
    database,
    serverUuid,
    envFile,
    probeTable: `task09_receipt_probe_${runId}`,
    probeTrigger: `trg_task09_receipt_probe_${runId}`,
    faultTrigger: `trg_task09_block_batch_delete_${runId}`,
  };
};

/** 声明的库/服务器必须与实际连接逐项一致；只做 SELECT，不写库。 */
export const assertChainProbeTarget = async (
  dataSource: DataSource,
  scope: ChainProbeRunScope,
): Promise<void> => {
  await assertDataSourceOnAllowedE2eDatabase(dataSource, scope.database);
  const rows: unknown = await dataSource.query(
    'SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid',
  );
  const actual = (Array.isArray(rows) ? rows[0] : undefined) as
    { databaseName?: unknown; serverUuid?: unknown } | undefined;
  const databaseName =
    typeof actual?.databaseName === 'string' ? actual.databaseName.toLowerCase() : '';
  const serverUuid = typeof actual?.serverUuid === 'string' ? actual.serverUuid.toLowerCase() : '';
  if (databaseName !== scope.database) {
    throw new Error(
      `[记录包探针守卫] 拒绝 DDL：声明库 ${scope.database} 与实际连接库 ${databaseName || '(未知)'} 不一致`,
    );
  }
  if (serverUuid !== scope.serverUuid) {
    throw new Error(
      `[记录包探针守卫] 拒绝 DDL：声明服务器 ${scope.serverUuid} 与实际服务器 ${serverUuid || '(未知)'} 不一致`,
    );
  }
};

export const assertSafeProbeObjectName = (name: string): string => {
  if (!SAFE_OBJECT_SUFFIX.test(name ?? '')) {
    throw new Error(`[记录包探针守卫] 不合规的对象名 "${name}"：只允许安全标识符字符且长度 1-64`);
  }
  return name;
};

const PROBE_COLUMNS = [
  'receipt_id',
  'connection_id',
  'organization_id',
  'record_uuid',
  'version_no',
  'source_installation_id',
  'created_at',
] as const;

export type OwnedReceiptProbeTableFact = {
  readonly tableName: string;
  readonly runId: string;
  readonly database: string;
  readonly serverUuid: string;
  readonly columns: readonly string[];
  readonly definition: string;
};

export type OwnedReceiptProbeTableRecord = {
  readonly tableName: string;
  readonly runId: string;
  readonly database: string;
  readonly serverUuid: string;
  readonly expectedColumns: readonly string[];
  /** CREATE 明确成功后首次回读的定义；收尾只与此预期比对，不用当前事实回填。 */
  expectedDefinition: string;
  fact: OwnedReceiptProbeTableFact | null;
};

export type ReceiptProbeTableTracker = {
  records(): readonly OwnedReceiptProbeTableRecord[];
  remaining(): readonly OwnedReceiptProbeTableRecord[];
  register(record: OwnedReceiptProbeTableRecord): void;
  settle(tableName: string): void;
  ownsRecord(record: OwnedReceiptProbeTableRecord): boolean;
  pendingRecordFor(tableName: string): OwnedReceiptProbeTableRecord | null;
};

const tableRecords = new WeakSet<OwnedReceiptProbeTableRecord>();

export const createReceiptProbeTableTracker = (): ReceiptProbeTableTracker => {
  const registered: OwnedReceiptProbeTableRecord[] = [];
  const pending = new Set<OwnedReceiptProbeTableRecord>();
  return {
    records: () => [...registered],
    remaining: () => registered.filter((record) => pending.has(record)),
    register: (record) => {
      if (!tableRecords.has(record)) {
        throw new Error('[记录包探针台账] 拒绝登记：记录不是 CREATE 成功后构造的本轮创建事实');
      }
      if (registered.includes(record)) return;
      if (registered.some((entry) => entry.tableName === record.tableName)) {
        throw new Error(`[记录包探针台账] 拒绝重复登记同名表 ${record.tableName}`);
      }
      registered.push(record);
      pending.add(record);
    },
    settle: (tableName) => {
      for (const record of [...pending]) {
        if (record.tableName === tableName) pending.delete(record);
      }
    },
    ownsRecord: (record) => record !== null && typeof record === 'object' && pending.has(record),
    pendingRecordFor: (tableName) =>
      registered.find((record) => pending.has(record) && record.tableName === tableName) ?? null,
  };
};

type TableFactRow = {
  dbName: string;
  tableName: string;
  columnName: string;
  columnType: string;
  nullable: string;
  columnDefault: unknown;
  columnKey: string;
  extra: string;
  engine: string;
  tableCollation: string;
};

const buildTableDefinition = (list: readonly TableFactRow[]): string =>
  [
    String(list[0].engine),
    String(list[0].tableCollation),
    ...list.map((row) =>
      [
        String(row.columnName),
        String(row.columnType),
        String(row.nullable),
        row.columnDefault === null || row.columnDefault === undefined
          ? 'NULL'
          : typeof row.columnDefault === 'string' || typeof row.columnDefault === 'number'
            ? String(row.columnDefault)
            : 'EXPRESSION',
        String(row.columnKey ?? ''),
        String(row.extra ?? ''),
      ].join(':'),
    ),
  ].join('|');

const readProbeTableFact = async (
  dataSource: DataSource,
  tableName: string,
): Promise<OwnedReceiptProbeTableFact | null> => {
  assertSafeProbeObjectName(tableName);
  const rows: unknown = await dataSource.query(
    'SELECT c.TABLE_SCHEMA AS dbName, c.TABLE_NAME AS tableName, c.COLUMN_NAME AS columnName, ' +
      'c.COLUMN_TYPE AS columnType, c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS columnDefault, ' +
      'c.COLUMN_KEY AS columnKey, c.EXTRA AS extra, t.ENGINE AS engine, ' +
      't.TABLE_COLLATION AS tableCollation ' +
      'FROM information_schema.COLUMNS c ' +
      'JOIN information_schema.TABLES t ' +
      'ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME ' +
      'WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION',
    [tableName],
  );
  const list = (Array.isArray(rows) ? rows : []) as TableFactRow[];
  if (list.length === 0) return null;
  return {
    tableName: String(list[0].tableName),
    runId: '',
    database: String(list[0].dbName),
    serverUuid: '',
    columns: list.map((row) => String(row.columnName)),
    definition: buildTableDefinition(list),
  };
};

/** 创建本轮唯一探针表：只读同名预检 → CREATE → 立即登记 → 回读核对。 */
export const createOwnedReceiptProbeTable = async (params: {
  dataSource: DataSource;
  scope: ChainProbeRunScope;
  tracker: ReceiptProbeTableTracker;
}): Promise<OwnedReceiptProbeTableFact> => {
  const helper = 'createOwnedReceiptProbeTable';
  assertPhysicalCleanupConsent();
  await assertChainProbeTarget(params.dataSource, params.scope);
  const tableName = assertSafeProbeObjectName(params.scope.probeTable);

  const existing = await readProbeTableFact(params.dataSource, tableName);
  if (existing !== null) {
    throw new Error(
      `[${helper}] 阶段=同名预检 拒绝创建：表 ${tableName} 已存在，归属不明确；本轮未执行任何 DROP`,
    );
  }

  await params.dataSource.query(`
    CREATE TABLE \`${tableName}\` (
      receipt_id CHAR(36) NOT NULL,
      connection_id BIGINT UNSIGNED NOT NULL,
      organization_id INT NOT NULL,
      record_uuid CHAR(36) NOT NULL,
      version_no INT UNSIGNED NOT NULL,
      source_installation_id CHAR(36) NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (receipt_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const record: OwnedReceiptProbeTableRecord = {
    tableName,
    runId: params.scope.runId,
    database: params.scope.database,
    serverUuid: params.scope.serverUuid,
    expectedColumns: [...PROBE_COLUMNS],
    expectedDefinition: '',
    fact: null,
  };
  tableRecords.add(record);
  params.tracker.register(record);

  const current = await readProbeTableFact(params.dataSource, tableName);
  if (
    current === null ||
    current.tableName !== tableName ||
    current.database !== params.scope.database ||
    current.columns.join(',') !== [...PROBE_COLUMNS].join(',')
  ) {
    throw new Error(
      `[${helper}] 阶段=创建核验 拒绝继续：表 ${tableName} 的回读事实与登记不一致，保留待收尾记录`,
    );
  }
  const fact: OwnedReceiptProbeTableFact = {
    tableName,
    runId: params.scope.runId,
    database: params.scope.database,
    serverUuid: params.scope.serverUuid,
    columns: current.columns,
    definition: current.definition,
  };
  record.fact = fact;
  record.expectedDefinition = current.definition;
  return fact;
};

/** 收尾只删除本轮登记且数据库/服务器/列定义仍匹配的表；缺失或替换都失败关闭。 */
export const disposeOwnedReceiptProbeTable = async (params: {
  dataSource: DataSource;
  fact: OwnedReceiptProbeTableFact;
  tracker: ReceiptProbeTableTracker;
}): Promise<void> => {
  const helper = 'disposeOwnedReceiptProbeTable';
  const record = params.tracker.pendingRecordFor(params.fact.tableName);
  if (record === null || !params.tracker.ownsRecord(record)) {
    throw new Error(
      `[${helper}] 阶段=归属校验 拒绝收尾：表 ${params.fact.tableName} 不在本轮待收尾台账内`,
    );
  }
  assertPhysicalCleanupConsent();
  await assertDataSourceOnAllowedE2eDatabase(params.dataSource, record.database);
  const identityRows: unknown = await params.dataSource.query(
    'SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid',
  );
  const identity = (Array.isArray(identityRows) ? identityRows[0] : undefined) as
    { databaseName?: unknown; serverUuid?: unknown } | undefined;
  const actualDatabase =
    typeof identity?.databaseName === 'string' ? identity.databaseName.toLowerCase() : '';
  const actualServer =
    typeof identity?.serverUuid === 'string' ? identity.serverUuid.toLowerCase() : '';
  if (actualDatabase !== record.database || actualServer !== record.serverUuid) {
    throw new Error(
      `[${helper}] 阶段=目标核验 拒绝删除：当前 ${actualDatabase}@${actualServer} 与本轮登记 ${record.database}@${record.serverUuid} 不一致`,
    );
  }

  const current = await readProbeTableFact(params.dataSource, record.tableName);
  if (current === null) {
    throw new Error(
      `[${helper}] 阶段=对象核验 拒绝完成收尾：表 ${record.tableName} 已缺失，保留现场诊断`,
    );
  }
  if (record.expectedDefinition === '') {
    throw new Error(
      `[${helper}] 阶段=对象核验 拒绝删除：表 ${record.tableName} 缺少创建阶段固化的定义，无法证明归属`,
    );
  }
  if (
    current.tableName !== record.tableName ||
    current.database !== record.database ||
    current.columns.join(',') !== [...record.expectedColumns].join(',') ||
    current.definition !== record.expectedDefinition
  ) {
    throw new Error(`[${helper}] 阶段=对象核验 拒绝删除：表 ${record.tableName} 的定义已被替换`);
  }
  await params.dataSource.query(`DROP TABLE \`${record.tableName}\``);
  params.tracker.settle(record.tableName);
};

export const buildReceiptProbeTriggerBody = (tableName: string): string => {
  const safe = assertSafeProbeObjectName(tableName);
  return (
    `INSERT INTO \`${safe}\` ` +
    '(receipt_id, connection_id, organization_id, record_uuid, version_no, source_installation_id) ' +
    'VALUES (NEW.receipt_id, CONNECTION_ID(), NEW.organization_id, NEW.record_uuid, ' +
    'NEW.version_no, NEW.source_installation_id)'
  );
};

export const EXTERNAL_PROBE_TRIGGER_MARKER = 'task09_external_owner';
export const ALTERED_PROBE_COLUMN_TYPE = 'varchar(64)';

/** 仅测试注入：外部定义仍引用同一探针表，但不再是本轮 CREATE 的定义。 */
export const buildExternalProbeTriggerBody = (tableName: string): string => {
  const safe = assertSafeProbeObjectName(tableName);
  return (
    `BEGIN SET @${EXTERNAL_PROBE_TRIGGER_MARKER} = 1; ` +
    `INSERT INTO \`${safe}\` ` +
    '(receipt_id, connection_id, organization_id, record_uuid, version_no, source_installation_id) ' +
    'VALUES (NEW.receipt_id, CONNECTION_ID(), NEW.organization_id, NEW.record_uuid, ' +
    'NEW.version_no, NEW.source_installation_id); END'
  );
};

/** 仅测试注入：同列名但类型变化，用于证明完整定义核验生效。 */
export const buildAlteredProbeTableSql = (tableName: string): string => {
  const safe = assertSafeProbeObjectName(tableName);
  return `ALTER TABLE \`${safe}\` MODIFY source_installation_id ${ALTERED_PROBE_COLUMN_TYPE} NULL`;
};

export interface ProbeQueryable {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/** 从探针表读取提交后的真实 INSERT 证据；连接号可选，用于区分本事务与并发赢家。 */
export const readReceiptProbeRows = async (
  queryable: ProbeQueryable,
  tableName: string,
  receiptId: string,
  connectionId?: string,
): Promise<unknown[]> => {
  const safe = assertSafeProbeObjectName(tableName);
  const sql =
    connectionId === undefined
      ? `SELECT receipt_id FROM \`${safe}\` WHERE receipt_id = ?`
      : `SELECT receipt_id FROM \`${safe}\` WHERE receipt_id = ? AND connection_id = ?`;
  const rows = await queryable.query(
    sql,
    connectionId === undefined ? [receiptId] : [receiptId, connectionId],
  );
  return Array.isArray(rows) ? rows : [];
};
