// src/infrastructure/database/record-package-state.migration.realdb.spec.ts
//
// 第 39 条迁移（记录包检查/导入状态）在“非空 38 态”上的受控实库验收规格。
//
// 本文件默认不启用、不连接、不写库：全部 describe 为 skip，不创建 DataSource。
// 只有同时满足以下条件才会执行：
//   E2E_REAL_DB_SPECS=1                       显式启用实库规格
//   E2E_ALLOW_MIGRATION_39_UPGRADE=1          显式授权执行第 39 条正式升级
//   E2E_ALLOW_PHYSICAL_CLEANUP=1              显式授权清理本轮合成夹具
//   E2E_REAL_DB_NAME=<目标库>                 精确目标库，由本轮授权显式指定（不再硬编码 a/b/c）
//   E2E_ALLOWED_DB_NAMES=<同一个库>           白名单必须且只能包含该库
//   E2E_REAL_DB_CONFIG_FILE=<绝对路径>        显式 env 文件，DB_NAME 必须与目标一致
//   E2E_EXPECTED_SERVER_UUID=<uuid>           实例 server_uuid 必须一致
//   E2E_M39_SCENARIO=A|B|C                    本轮只执行一个隔离场景
//
// 显式设置 E2E_REAL_DB_SPECS=1 但上述许可不全时，模块加载即抛错拒绝，不静默跳过。
//
// 目标库必须由管理员预先创建为空库；本规格：
//   - 不建库、不 DROP 库、不清表、不 down 迁移；
//   - 用冻结的 38 个迁移文件从空库正向构建 38 态（不从 39 态手工回退）；
//   - 只通过正式 deployment 入口执行第 39 条；
//   - 只删除本轮按真实 insertId/生成主键登记的合成行，不按当前查询结果认领未知资源。
//
// 场景（每个场景必须使用管理员预建的全新空库，单次运行只消耗一个库）：
//   A <目标库>：合法历史数据升级、回填、旧字段不变、CHECK 负例、二次执行无变化。
//   B <目标库>：38 态允许但 39 态预检拒绝的记录；正式入口在首次 ALTER 前拒绝。
//   C <目标库>：受控注入第 2 条包表 ALTER 失败；验证失败现场保留。
//     注意：正式入口把“列已存在但迁移未记录”识别为半迁移并在升级前拒绝，因此
//     部分 DDL 失败后的“正式入口续跑成功”当前不可证明；C2 只验证该失败关闭行为，
//     不把 C2 记为续跑通过，续跑实库证据仍是缺口。
//
// 目标库名不再硬编码：由 E2E_REAL_DB_NAME 显式指定，并在 beforeAll 重新核验其为空库
// （0 张基础表、无 migrations）。已升至 39 态的旧库不得复用，也不回退或重建旧现场。
//
// 运行示例（授权后，一次一个场景）：
//   E2E_REAL_DB_SPECS=1 E2E_ALLOW_MIGRATION_39_UPGRADE=1 \
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_M39_SCENARIO=A \
//   E2E_REAL_DB_NAME=<本轮授权的新空库> E2E_ALLOWED_DB_NAMES=<同一个库> \
//   E2E_REAL_DB_CONFIG_FILE=<该库的绝对路径 env 文件> \
//   E2E_EXPECTED_SERVER_UUID=<实例 server_uuid> \
//   npx jest src/infrastructure/database/record-package-state.migration.realdb.spec.ts --runInBand

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DataSource, type DataSourceOptions, type QueryRunner } from 'typeorm';

import {
  assertAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
} from '../../../test/utils/e2e-db-guard';
import { runGuardedScopedCleanup } from '../../../test/utils/e2e-scoped-cleanup';
import { normalizeBigIntId } from '../../../test/utils/lossless-bigint-id';
import { runDatabaseDeploy, type DeployRunDependencies } from './database-deploy';
import {
  createMigrationDataSource,
  loadExplicitEnvConfig,
  readBaseTableNames,
  readMigrationHistory,
  type MigrationDbConfig,
  type MigrationLogger,
} from './incremental-migration';

const REQUESTED = process.env.E2E_REAL_DB_SPECS === '1';
const UPGRADE_ALLOWED = process.env.E2E_ALLOW_MIGRATION_39_UPGRADE === '1';
const CLEANUP_ALLOWED = process.env.E2E_ALLOW_PHYSICAL_CLEANUP === '1';
const EXPECTED_DB = (process.env.E2E_REAL_DB_NAME ?? '').trim().toLowerCase();
const EXPECTED_SERVER_UUID = (process.env.E2E_EXPECTED_SERVER_UUID ?? '').trim();
const CONFIG_FILE = (process.env.E2E_REAL_DB_CONFIG_FILE ?? '').trim();
const RAW_SCENARIO = (process.env.E2E_M39_SCENARIO ?? '').trim().toUpperCase();

const MIGRATION_39_TIMESTAMP = 1775501700000;
const MIGRATION_39_NAME = 'AddRecordPackageCheckAndImportResultStatesForV131775501700000';
const FROZEN_38_AGGREGATE = '624c4570ef86873b363370a93b9746355ba0e0b57c46baec430a1f9e5f96f86d';
const FROZEN_39_FILE_SHA = '2c59866f614ba4b4b783f54bde7a9907f6759250d45aa2d0760f114177a6ecfb';
const MIGRATION_REPO_PREFIX = 'backend/src/infrastructure/database/migrations';
const PACKAGE_TABLE = 'record_package_import';
const ITEM_TABLE = 'record_package_item';

type Scenario = 'A' | 'B' | 'C';
type Row = Record<string, unknown>;

/** 目标库由本轮授权显式指定，不再硬编码具体库名；只校验其为合法 MySQL 库标识符。 */
const DB_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const isScenario = (value: string): value is Scenario =>
  value === 'A' || value === 'B' || value === 'C';

const SCENARIO: Scenario | null = isScenario(RAW_SCENARIO) ? RAW_SCENARIO : null;
const ENABLED =
  REQUESTED &&
  UPGRADE_ALLOWED &&
  CLEANUP_ALLOWED &&
  EXPECTED_DB.length > 0 &&
  EXPECTED_SERVER_UUID.length > 0 &&
  CONFIG_FILE.length > 0 &&
  SCENARIO !== null;

if (REQUESTED && !ENABLED) {
  throw new Error(
    '第 39 条实库验收规格被显式要求执行（E2E_REAL_DB_SPECS=1），但许可不全：' +
      '需要 E2E_ALLOW_MIGRATION_39_UPGRADE=1、E2E_ALLOW_PHYSICAL_CLEANUP=1、' +
      'E2E_REAL_DB_NAME、E2E_EXPECTED_SERVER_UUID、E2E_REAL_DB_CONFIG_FILE 与 E2E_M39_SCENARIO=A|B|C。' +
      '明确拒绝，不静默跳过。',
  );
}

if (ENABLED && SCENARIO !== null) {
  if (!DB_NAME_PATTERN.test(EXPECTED_DB)) {
    throw new Error(
      'E2E_REAL_DB_NAME 必须是合法的 MySQL 库标识符（小写字母开头，仅小写字母/数字/下划线），' +
        `实际：${JSON.stringify(EXPECTED_DB)}；拒绝执行。`,
    );
  }
  if (!path.isAbsolute(CONFIG_FILE)) {
    throw new Error(`E2E_REAL_DB_CONFIG_FILE 必须是绝对路径，实际：${CONFIG_FILE}`);
  }
  const allowed = (process.env.E2E_ALLOWED_DB_NAMES ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (allowed.length !== 1 || allowed[0] !== EXPECTED_DB) {
    throw new Error(
      `E2E_ALLOWED_DB_NAMES 必须且只能包含当前目标库 ${EXPECTED_DB}，实际：[${allowed.join(', ')}]。`,
    );
  }
}

const describeRealDb = ENABLED ? describe : describe.skip;
const silentLogger: MigrationLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

const messageOf = (error: unknown): string => {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(messageOf).join(' | ')}`;
  }
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause === undefined ? error.message : `${error.message} <- ${messageOf(cause)}`;
  }
  return String(error);
};

/**
 * INSERT 的 insertId 一律按无损字符串登记：禁止 Number()，BIGINT 超出安全整数会丢精度。
 * string/BigInt 不受安全整数上限限制；number 只接受安全整数，超出即失败关闭。
 */
const insertIdOf = (result: unknown, field: string): string => {
  const raw = (result as { insertId?: unknown }).insertId;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') {
    throw new Error(`INSERT 未返回有效 insertId（${field}）：${String(raw)}`);
  }
  const insertId = normalizeBigIntId(raw, `${field}.insertId`);
  if (!/^[1-9]\d*$/.test(insertId)) {
    throw new Error(`${field} 的 insertId 不是正整数：${insertId}`);
  }
  return insertId;
};

const plainRows = <T extends Row>(rows: readonly T[]): T[] =>
  JSON.parse(JSON.stringify(rows)) as T[];

const placeholdersOf = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

/**
 * 38 态构建的迁移文件必须与冻结候选逐文件聚合一致。
 * 聚合算法与执行记录一致：`sha256sum` 行（hash + 两空格 + backend/... 路径）排序后整体再 sha256。
 */
const loadFrozenMigrationFiles = (): {
  readonly first38: readonly string[];
  readonly migration39: string;
} => {
  const migrationsDir = path.resolve(__dirname, './migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => /^\d{13}-.*\.migration\.ts$/.test(file))
    .sort();
  const first38 = files.filter((file) => Number(file.slice(0, 13)) < MIGRATION_39_TIMESTAMP);
  const migration39 = files.find((file) => Number(file.slice(0, 13)) === MIGRATION_39_TIMESTAMP);
  if (first38.length !== 38) {
    throw new Error(`冻结 38 态迁移数量应为 38，实际 ${String(first38.length)}；拒绝构建。`);
  }
  if (migration39 === undefined) {
    throw new Error(`未找到第 39 条迁移文件（timestamp=${String(MIGRATION_39_TIMESTAMP)}）。`);
  }
  const aggregate = sha256(
    first38
      .map(
        (file) =>
          `${sha256(fs.readFileSync(path.join(migrationsDir, file)))}  ` +
          `${MIGRATION_REPO_PREFIX}/${file}\n`,
      )
      .join(''),
  );
  if (aggregate !== FROZEN_38_AGGREGATE) {
    throw new Error(
      `冻结 38 条迁移聚合不一致：预期 ${FROZEN_38_AGGREGATE}，实际 ${aggregate}；` +
        '候选已变化，拒绝用不同源码构建 38 态。',
    );
  }
  const actual39 = sha256(fs.readFileSync(path.join(migrationsDir, migration39)));
  if (actual39 !== FROZEN_39_FILE_SHA) {
    throw new Error(
      `第 39 条迁移指纹不一致：预期 ${FROZEN_39_FILE_SHA}，实际 ${actual39}；拒绝升级。`,
    );
  }
  return { first38, migration39 };
};

type QueryRecord = {
  readonly sql: string;
  readonly executed: boolean;
};

/**
 * 受控记录 + 单次故障注入 DataSource。
 *
 * 只包装 query / createQueryRunner 的 query；不改迁移 SQL、不改 preflight，
 * 故障在目标 ALTER 执行前抛出，交给正式入口保存现场。
 */
class InstrumentedDataSource extends DataSource {
  readonly queries: QueryRecord[] = [];

  constructor(
    options: DataSourceOptions,
    private readonly failWhen?: (sql: string) => boolean,
  ) {
    super(options);
  }

  override query<T = unknown>(query: string, parameters?: unknown[]): Promise<T> {
    this.queries.push({ sql: query, executed: true });
    return super.query<T>(query, parameters);
  }

  override createQueryRunner(mode?: Parameters<DataSource['createQueryRunner']>[0]): QueryRunner {
    const runner = super.createQueryRunner(mode);
    const originalQuery = runner.query.bind(runner) as (
      sql: string,
      parameters?: unknown[],
      useStructuredResult?: boolean,
    ) => Promise<unknown>;
    return new Proxy(runner, {
      get: (target, property) => {
        if (property === 'query') {
          return async (
            sql: string,
            parameters?: unknown[],
            useStructuredResult?: boolean,
          ): Promise<unknown> => {
            const shouldFail = this.failWhen?.(sql) ?? false;
            this.queries.push({ sql, executed: !shouldFail });
            if (shouldFail) {
              throw new Error('INJECTED_DDL_FAILURE');
            }
            return originalQuery(sql, parameters, useStructuredResult);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  alterStatements(executedOnly = true): readonly QueryRecord[] {
    return this.queries.filter(
      (entry) => /^\s*ALTER\s+TABLE/i.test(entry.sql) && (!executedOnly || entry.executed),
    );
  }
}

const createInstrumentedDataSource = (
  config: MigrationDbConfig,
  failWhen?: (sql: string) => boolean,
): InstrumentedDataSource => {
  const base = createMigrationDataSource(config);
  return new InstrumentedDataSource(base.options, failWhen);
};

interface PackageSpec {
  readonly status: string;
  readonly schemaVersion: number | null;
  readonly expectedCheck: string | null;
  readonly items: readonly ItemSpec[];
}

interface ItemSpec {
  readonly result: string;
  readonly expectedCheck: string | null;
  readonly errorMessage?: string;
}

const LEGAL_PACKAGES: readonly PackageSpec[] = [
  {
    status: 'RUNNING',
    schemaVersion: 1,
    expectedCheck: 'PASSED',
    items: [{ result: 'SUCCEEDED', expectedCheck: 'PASSED' }],
  },
  {
    status: 'SUCCEEDED',
    schemaVersion: 1,
    expectedCheck: 'PASSED',
    items: [{ result: 'SUCCEEDED', expectedCheck: 'PASSED' }],
  },
  {
    status: 'PARTIAL',
    schemaVersion: 1,
    expectedCheck: 'PASSED',
    items: [
      { result: 'SUCCEEDED', expectedCheck: 'PASSED' },
      { result: 'FAILED', expectedCheck: null, errorMessage: 'S4-39 partial failure' },
    ],
  },
  {
    status: 'PENDING',
    schemaVersion: 1,
    expectedCheck: null,
    items: [{ result: 'SKIPPED', expectedCheck: null }],
  },
  {
    status: 'FAILED',
    schemaVersion: 1,
    expectedCheck: null,
    items: [{ result: 'FAILED', expectedCheck: null, errorMessage: 'S4-39 package failure' }],
  },
];

/**
 * 38 态允许、39 态预检拒绝：`JSON_EXTRACT(..., '$.schema_version')` 返回 JSON null，
 * 在 38 态 CHECK 中 `IS NOT NULL` 成立；第 39 条预检要求 JSON_TYPE <> 'NULL'。
 */
const INVALID_PACKAGE: PackageSpec = {
  status: 'SUCCEEDED',
  schemaVersion: null,
  expectedCheck: null,
  items: [{ result: 'SKIPPED', expectedCheck: null }],
};

interface PackageFixture {
  readonly packageId: string;
  readonly status: string;
  readonly expectedCheck: string | null;
}

interface ItemFixture {
  readonly itemId: string;
  readonly packageId: string;
  readonly result: string;
  readonly expectedCheck: string | null;
}

const state: {
  config: MigrationDbConfig | null;
  allowCleanup: boolean;
  organizationId: string | null;
  accountId: string | null;
  packages: PackageFixture[];
  items: ItemFixture[];
  beforePackages: Row[];
  beforeItems: Row[];
} = {
  config: null,
  allowCleanup: false,
  organizationId: null,
  accountId: null,
  packages: [],
  items: [],
  beforePackages: [],
  beforeItems: [],
};

const assertTargetIdentity = async (dataSource: DataSource): Promise<void> => {
  assertAllowedE2eDatabase(EXPECTED_DB);
  await assertManagerOnExpectedE2eDatabase(dataSource.manager, EXPECTED_DB);
  const rows = await dataSource.query<
    Array<{ current_database: string; server_uuid: string; server_version: string }>
  >(
    'SELECT DATABASE() AS current_database, @@server_uuid AS server_uuid, VERSION() AS server_version',
  );
  const row = rows[0];
  if (!row) {
    throw new Error('无法读取目标库身份（SELECT DATABASE()/@@server_uuid 返回空）。');
  }
  if (row.current_database.toLowerCase() !== EXPECTED_DB) {
    throw new Error(`实际连接库 ${row.current_database} 与预期 ${EXPECTED_DB} 不一致；拒绝执行。`);
  }
  if (row.server_uuid !== EXPECTED_SERVER_UUID) {
    throw new Error(
      `实例 server_uuid ${row.server_uuid} 与预期 ${EXPECTED_SERVER_UUID} 不一致；拒绝执行。`,
    );
  }
  const version = String(row.server_version);
  if (!/^8\.0\./.test(version)) {
    throw new Error(`本规格只支持 MySQL 8.0.x，实际 ${version}；拒绝执行。`);
  }
};

const assertEmptyTarget = async (dataSource: DataSource): Promise<void> => {
  const tables = await readBaseTableNames(dataSource, EXPECTED_DB);
  if (tables.length > 0) {
    throw new Error(
      `目标库 ${EXPECTED_DB} 已存在 ${String(tables.length)} 张表；` +
        '本规格只接受管理员预建空库，拒绝复用/清表代替正向构建。',
    );
  }
  const history = await readMigrationHistory(dataSource, EXPECTED_DB);
  if (history.migrationsTableExists || history.history.length > 0) {
    throw new Error(`目标库 ${EXPECTED_DB} 已存在迁移历史；拒绝在半迁移或已升级库上执行。`);
  }
};

const build38State = async (config: MigrationDbConfig): Promise<DataSource> => {
  const frozen = loadFrozenMigrationFiles();
  const base = createMigrationDataSource(config);
  const migrationsDir = path.resolve(__dirname, './migrations');
  const options: DataSourceOptions = {
    ...base.options,
    migrations: frozen.first38.map((file) => path.join(migrationsDir, file)),
  };
  const dataSource = new DataSource(options);
  await dataSource.initialize();
  try {
    const executed = await dataSource.runMigrations({ transaction: 'none' });
    if (executed.length !== 38) {
      throw new Error(`38 态正向构建应执行 38 条迁移，实际 ${String(executed.length)} 条。`);
    }
    const history = await readMigrationHistory(dataSource, EXPECTED_DB);
    if (history.history.length !== 38) {
      throw new Error(`38 态迁移历史应为 38 条，实际 ${String(history.history.length)} 条。`);
    }
    const last = history.history[37];
    if (!last || last.timestamp !== 1775501600000) {
      throw new Error(
        `38 态最后一条迁移应为 1775501600000，实际 ${String(last?.timestamp ?? '缺失')}。`,
      );
    }
    const tables = await readBaseTableNames(dataSource, EXPECTED_DB);
    if (tables.length !== 52) {
      throw new Error(`38 态基础表应为 52 张，实际 ${String(tables.length)} 张。`);
    }
    return dataSource;
  } catch (error) {
    await dataSource.destroy();
    throw error;
  }
};

const seedFixtures = async (dataSource: DataSource, scenario: Scenario): Promise<void> => {
  const runTag = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
  const orgCode = `M39-${scenario}-${runTag}`;
  const orgResult = await dataSource.query(
    `INSERT INTO organization (organization_code, name, kind) VALUES (?, ?, 'CLIENT')`,
    [orgCode, `M39 ${scenario} 组织 ${runTag}`],
  );
  state.organizationId = insertIdOf(orgResult, 'organization');

  const accountResult = await dataSource.query(
    `INSERT INTO base_user_account (login_name, login_email, login_password, status)
     VALUES (?, ?, ?, 'ACTIVE')`,
    [`m39_${scenario}_${runTag}`, `m39_${scenario}_${runTag}@example.com`, 'M39Spec!Passw0rd'],
  );
  state.accountId = insertIdOf(accountResult, 'base_user_account');

  const specs = scenario === 'B' ? [...LEGAL_PACKAGES, INVALID_PACKAGE] : LEGAL_PACKAGES;
  for (const spec of specs) {
    const packageId = randomUUID();
    const manifestJson = JSON.stringify({
      schema_version: spec.schemaVersion,
      tag: `${scenario}-${spec.status}-${packageId}`,
    });
    const manifestChecksum = sha256(`${scenario}:${packageId}`);
    const itemTotal = spec.items.length;
    const itemSucceeded = spec.items.filter((item) => item.result === 'SUCCEEDED').length;
    const itemFailed = spec.items.filter((item) => item.result === 'FAILED').length;
    await dataSource.query(
      `INSERT INTO record_package_import
         (package_id, organization_id, imported_by_account_id, manifest_json, manifest_checksum,
          status, item_total, item_succeeded, item_failed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        packageId,
        state.organizationId,
        state.accountId,
        manifestJson,
        manifestChecksum,
        spec.status,
        itemTotal,
        itemSucceeded,
        itemFailed,
      ],
    );
    state.packages.push({
      packageId,
      status: spec.status,
      expectedCheck: spec.expectedCheck,
    });

    for (const item of spec.items) {
      const itemResult = await dataSource.query(
        `INSERT INTO record_package_item
           (package_id, record_uuid, resource_type, version_no, result, receipt_id, error_message)
         VALUES (?, ?, 'REPAIR', 1, ?, NULL, ?)`,
        [packageId, randomUUID(), item.result, item.errorMessage ?? null],
      );
      state.items.push({
        itemId: insertIdOf(itemResult, 'record_package_item'),
        packageId,
        result: item.result,
        expectedCheck: item.expectedCheck,
      });
    }
  }
};

const selectOldPackages = async (dataSource: DataSource): Promise<Row[]> => {
  const packageIds = state.packages.map((item) => item.packageId);
  if (packageIds.length === 0) {
    return [];
  }
  const rows = await dataSource.query<
    Array<{
      package_id: string;
      organization_id: number;
      imported_by_account_id: number;
      manifest_json: string;
      manifest_checksum: string;
      status: string;
      item_total: number;
      item_succeeded: number;
      item_failed: number;
      created_at: Date;
      completed_at: Date | null;
    }>
  >(
    `SELECT package_id, organization_id, imported_by_account_id, manifest_json, manifest_checksum,
            status, item_total, item_succeeded, item_failed, created_at, completed_at
       FROM record_package_import
      WHERE package_id IN (${placeholdersOf(packageIds)})
      ORDER BY package_id`,
    packageIds,
  );
  return plainRows(rows);
};

const selectOldItems = async (dataSource: DataSource): Promise<Row[]> => {
  const itemIds = state.items.map((item) => item.itemId);
  if (itemIds.length === 0) {
    return [];
  }
  const rows = await dataSource.query<
    Array<{
      id: string;
      package_id: string;
      record_uuid: string;
      resource_type: string;
      version_no: number;
      result: string;
      receipt_id: string | null;
      error_message: string | null;
      created_at: Date;
    }>
  >(
    `SELECT id, package_id, record_uuid, resource_type, version_no, result, receipt_id,
            error_message, created_at
       FROM record_package_item
      WHERE id IN (${placeholdersOf(itemIds)})
      ORDER BY id`,
    itemIds,
  );
  return plainRows(rows);
};

const columnExists = async (
  dataSource: DataSource,
  table: string,
  column: string,
): Promise<boolean> => {
  const rows = await dataSource.query<Array<{ column_name: string }>>(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length > 0;
};

const columnNullable = async (
  dataSource: DataSource,
  table: string,
  column: string,
): Promise<string> => {
  const rows = await dataSource.query<Array<{ is_nullable: string }>>(
    `SELECT IS_NULLABLE AS is_nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`列 ${table}.${column} 不存在。`);
  }
  return row.is_nullable;
};

const constraintNames = async (
  dataSource: DataSource,
  table: string,
): Promise<readonly string[]> => {
  const rows = await dataSource.query<Array<{ constraint_name: string }>>(
    `SELECT CONSTRAINT_NAME AS constraint_name
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'CHECK'
      ORDER BY CONSTRAINT_NAME`,
    [table],
  );
  return rows.map((row) => row.constraint_name);
};

const showCreateTable = async (dataSource: DataSource, table: string): Promise<string> => {
  const rows = await dataSource.query<Row[]>(`SHOW CREATE TABLE \`${table}\``);
  const row = rows[0];
  if (!row) {
    throw new Error(`SHOW CREATE TABLE ${table} 返回空。`);
  }
  const values = Object.values(row);
  const createSql = values[1];
  if (typeof createSql !== 'string') {
    throw new Error(`SHOW CREATE TABLE ${table} 返回格式异常。`);
  }
  return createSql;
};

const selectPackageChecks = async (dataSource: DataSource): Promise<Map<string, string | null>> => {
  const packageIds = state.packages.map((item) => item.packageId);
  const rows = await dataSource.query<Array<{ package_id: string; check_status: string | null }>>(
    `SELECT package_id, check_status FROM record_package_import
      WHERE package_id IN (${placeholdersOf(packageIds)})
      ORDER BY package_id`,
    packageIds,
  );
  return new Map(rows.map((row) => [row.package_id, row.check_status]));
};

/**
 * BIGINT 主键可能以 string 或 number 返回，Map 键统一走无损归一化，
 * 绝不以 number 作键（超过 2^53-1 会丢精度且与 string 键不匹配）。
 */
const selectItemChecks = async (dataSource: DataSource): Promise<Map<string, string | null>> => {
  const itemIds = state.items.map((item) => item.itemId);
  const rows = await dataSource.query<Array<{ id: string; check_result: string | null }>>(
    `SELECT id, check_result FROM record_package_item
      WHERE id IN (${placeholdersOf(itemIds)})
      ORDER BY id`,
    itemIds,
  );
  return new Map(
    rows.map((row) => [normalizeBigIntId(row.id, 'record_package_item.id'), row.check_result]),
  );
};

/**
 * 先断言 Map 命中，再比较值：未命中（has=false）与数据库 NULL（get=null）必须区分，
 * 不能用“查不到时返回 null”掩盖键类型错误。
 */
const expectBackfill = async (dataSource: DataSource): Promise<void> => {
  const packageChecks = await selectPackageChecks(dataSource);
  for (const item of state.packages) {
    expect(packageChecks.has(item.packageId)).toBe(true);
    expect(packageChecks.get(item.packageId)).toBe(item.expectedCheck);
  }
  const itemChecks = await selectItemChecks(dataSource);
  for (const item of state.items) {
    const key = normalizeBigIntId(item.itemId, 'state.items[].itemId');
    expect(itemChecks.has(key)).toBe(true);
    expect(itemChecks.get(key)).toBe(item.expectedCheck);
  }
};

const deployOptions = (): {
  readonly mode: 'upgrade';
  readonly envFile: string;
  readonly database: string;
  readonly confirmDatabase: string;
} => ({
  mode: 'upgrade',
  envFile: CONFIG_FILE,
  database: EXPECTED_DB,
  confirmDatabase: EXPECTED_DB,
});

const cleanupOwned = async (): Promise<void> => {
  const config = state.config;
  if (!config || !state.allowCleanup) {
    return;
  }
  const dataSource = createMigrationDataSource(config);
  try {
    await dataSource.initialize();
    await runGuardedScopedCleanup({
      dataSource,
      helper: `M39/${SCENARIO ?? '?'}/收尾`,
      expectedDatabase: EXPECTED_DB,
      cleanup: async (manager) => {
        const itemIds = state.items.map((item) => item.itemId);
        if (itemIds.length > 0) {
          await manager.query(
            `DELETE FROM record_package_item WHERE id IN (${placeholdersOf(itemIds)})`,
            itemIds,
          );
        }
        const packageIds = state.packages.map((item) => item.packageId);
        if (packageIds.length > 0) {
          await manager.query(
            `DELETE FROM record_package_import WHERE package_id IN (${placeholdersOf(packageIds)})`,
            packageIds,
          );
        }
        if (state.accountId !== null) {
          await manager.query('DELETE FROM base_user_account WHERE id = ?', [state.accountId]);
        }
        if (state.organizationId !== null) {
          await manager.query('DELETE FROM organization WHERE id = ?', [state.organizationId]);
        }
      },
    });
  } finally {
    await dataSource.destroy();
  }
};

describeRealDb(`第 39 条迁移实库验收（场景 ${SCENARIO ?? '未启用'}）`, () => {
  beforeAll(async () => {
    state.config = loadExplicitEnvConfig(CONFIG_FILE, EXPECTED_DB);
    const guardDataSource = createMigrationDataSource(state.config);
    await guardDataSource.initialize();
    try {
      await assertTargetIdentity(guardDataSource);
      await assertEmptyTarget(guardDataSource);
      state.allowCleanup = true;
    } finally {
      await guardDataSource.destroy();
    }

    const buildDataSource = await build38State(state.config);
    try {
      await seedFixtures(buildDataSource, SCENARIO ?? 'A');
      state.beforePackages = await selectOldPackages(buildDataSource);
      state.beforeItems = await selectOldItems(buildDataSource);
    } finally {
      await buildDataSource.destroy();
    }
  }, 180000);

  afterAll(async () => {
    await cleanupOwned();
  }, 60000);

  const itScenario = (
    scenario: Scenario,
    name: string,
    test: () => Promise<void>,
    timeout?: number,
  ): void => {
    if (SCENARIO === scenario) {
      it(name, test, timeout);
    } else {
      it.skip(`${name}（仅场景 ${scenario}）`, test);
    }
  };

  itScenario(
    'A',
    'A 合法历史数据升级：仅第 39 条、回填正确、旧字段不变、重跑无变化',
    async () => {
      const report = await runDatabaseDeploy(deployOptions(), silentLogger);
      expect(report.mode).toBe('upgrade');
      expect(report.executed).toEqual([MIGRATION_39_NAME]);
      expect(report.noChanges).toBe(false);

      const audit = createMigrationDataSource(state.config as MigrationDbConfig);
      await audit.initialize();
      try {
        const history = await readMigrationHistory(audit, EXPECTED_DB);
        expect(history.history).toHaveLength(39);
        expect(history.history[38]?.name).toBe(MIGRATION_39_NAME);
        expect(await columnExists(audit, PACKAGE_TABLE, 'check_status')).toBe(true);
        expect(await columnExists(audit, ITEM_TABLE, 'check_result')).toBe(true);
        expect(await columnNullable(audit, ITEM_TABLE, 'result')).toBe('YES');
        expect(await constraintNames(audit, PACKAGE_TABLE)).toEqual(
          expect.arrayContaining([
            'chk_record_package_import_check_status',
            'chk_record_package_import_check_stage',
            'chk_record_package_import_manifest',
          ]),
        );
        expect(await constraintNames(audit, ITEM_TABLE)).toEqual(
          expect.arrayContaining([
            'chk_record_package_item_check_result',
            'chk_record_package_item_check_stage',
            'chk_record_package_item_result',
          ]),
        );

        expect(await selectOldPackages(audit)).toEqual(state.beforePackages);
        expect(await selectOldItems(audit)).toEqual(state.beforeItems);
        await expectBackfill(audit);

        // CHECK 负例：MySQL 的 CHECK 在结果为 NULL/UNKNOWN 时视为满足，
        // 因此必须显式验证组合约束不会被 NULL 绕过：
        //   - SUCCEEDED 条目 check_result=NULL / 'REJECTED' → 拒绝；
        //   - SUCCEEDED 包 check_status=NULL → 拒绝；
        // 且拒绝后原值必须保持不变。
        const succeededPackage = state.packages.find((item) => item.status === 'SUCCEEDED');
        if (succeededPackage === undefined) {
          throw new Error('A 场景夹具缺少 SUCCEEDED 包，CHECK 负例无法执行。');
        }
        const succeededItem = state.items.find(
          (item) => item.packageId === succeededPackage.packageId && item.result === 'SUCCEEDED',
        );
        if (succeededItem === undefined) {
          throw new Error(
            `SUCCEEDED 包 ${succeededPackage.packageId} 缺少 SUCCEEDED 条目，CHECK 负例无法执行。`,
          );
        }
        const itemKey = normalizeBigIntId(succeededItem.itemId, 'state.items[].itemId');

        await expect(
          audit.query('UPDATE record_package_item SET check_result = NULL WHERE id = ?', [
            succeededItem.itemId,
          ]),
        ).rejects.toThrow(/chk_record_package_item_check_stage/);
        let itemChecks = await selectItemChecks(audit);
        expect(itemChecks.has(itemKey)).toBe(true);
        expect(itemChecks.get(itemKey)).toBe('PASSED');

        await expect(
          audit.query("UPDATE record_package_item SET check_result = 'REJECTED' WHERE id = ?", [
            succeededItem.itemId,
          ]),
        ).rejects.toThrow(/chk_record_package_item_check_stage/);
        itemChecks = await selectItemChecks(audit);
        expect(itemChecks.has(itemKey)).toBe(true);
        expect(itemChecks.get(itemKey)).toBe('PASSED');

        await expect(
          audit.query('UPDATE record_package_import SET check_status = NULL WHERE package_id = ?', [
            succeededPackage.packageId,
          ]),
        ).rejects.toThrow(/chk_record_package_import_check_stage/);
        const packageChecks = await selectPackageChecks(audit);
        expect(packageChecks.has(succeededPackage.packageId)).toBe(true);
        expect(packageChecks.get(succeededPackage.packageId)).toBe('PASSED');

        const afterFirstPackages = await audit.query<Row[]>(
          `SELECT * FROM record_package_import WHERE package_id IN (${placeholdersOf(
            state.packages.map((item) => item.packageId),
          )}) ORDER BY package_id`,
          state.packages.map((item) => item.packageId),
        );
        const afterFirstItems = await audit.query<Row[]>(
          `SELECT * FROM record_package_item WHERE id IN (${placeholdersOf(
            state.items.map((item) => item.itemId),
          )}) ORDER BY id`,
          state.items.map((item) => item.itemId),
        );

        const second = await runDatabaseDeploy(deployOptions(), silentLogger);
        expect(second.noChanges).toBe(true);
        expect(second.executed).toEqual([]);

        expect(
          plainRows(
            await audit.query<Row[]>(
              `SELECT * FROM record_package_import WHERE package_id IN (${placeholdersOf(
                state.packages.map((item) => item.packageId),
              )}) ORDER BY package_id`,
              state.packages.map((item) => item.packageId),
            ),
          ),
        ).toEqual(plainRows(afterFirstPackages));
        expect(
          plainRows(
            await audit.query<Row[]>(
              `SELECT * FROM record_package_item WHERE id IN (${placeholdersOf(
                state.items.map((item) => item.itemId),
              )}) ORDER BY id`,
              state.items.map((item) => item.itemId),
            ),
          ),
        ).toEqual(plainRows(afterFirstItems));
      } finally {
        await audit.destroy();
      }
    },
    120_000,
  );

  itScenario('B', 'B 违规历史数据拒绝：首次 ALTER 前失败、结构/历史/原数据全部不变', async () => {
    const auditBefore = createMigrationDataSource(state.config as MigrationDbConfig);
    await auditBefore.initialize();
    const beforeCreatePackage = await showCreateTable(auditBefore, PACKAGE_TABLE);
    const beforeCreateItem = await showCreateTable(auditBefore, ITEM_TABLE);
    await auditBefore.destroy();

    const recorder = createInstrumentedDataSource(state.config as MigrationDbConfig);
    const dependencies: DeployRunDependencies = {
      createDataSource: (): DataSource => recorder,
      lockTimeoutSeconds: 0,
    };
    let caught: unknown;
    try {
      await runDatabaseDeploy(deployOptions(), silentLogger, dependencies);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = messageOf(caught);
    expect(message).toContain('预检失败');
    expect(message).toContain('schema_version 为 JSON null');
    expect(recorder.alterStatements()).toEqual([]);

    const audit = createMigrationDataSource(state.config as MigrationDbConfig);
    await audit.initialize();
    try {
      const history = await readMigrationHistory(audit, EXPECTED_DB);
      expect(history.history).toHaveLength(38);
      expect(await columnExists(audit, PACKAGE_TABLE, 'check_status')).toBe(false);
      expect(await columnExists(audit, ITEM_TABLE, 'check_result')).toBe(false);
      expect(await showCreateTable(audit, PACKAGE_TABLE)).toBe(beforeCreatePackage);
      expect(await showCreateTable(audit, ITEM_TABLE)).toBe(beforeCreateItem);
      expect(await selectOldPackages(audit)).toEqual(state.beforePackages);
      expect(await selectOldItems(audit)).toEqual(state.beforeItems);
    } finally {
      await audit.destroy();
    }
  });

  itScenario('C', 'C1 部分 DDL 失败：第 2 条包表 ALTER 前注入失败、现场保留', async () => {
    const failedSecondPackageAlter = (sql: string): boolean =>
      /ALTER TABLE `record_package_import`/i.test(sql) &&
      sql.includes('chk_record_package_import_check_status');

    const recorder = createInstrumentedDataSource(
      state.config as MigrationDbConfig,
      failedSecondPackageAlter,
    );
    const dependencies: DeployRunDependencies = {
      createDataSource: (): DataSource => recorder,
      lockTimeoutSeconds: 0,
    };
    let caught: unknown;
    try {
      await runDatabaseDeploy(deployOptions(), silentLogger, dependencies);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = messageOf(caught);
    expect(message).toContain('INJECTED_DDL_FAILURE');
    expect(message).toContain('第 39 条迁移');
    expect(message).toContain('record_package_import 增加检查/导入组合约束');

    const alters = recorder.alterStatements(false);
    expect(alters.filter((entry) => entry.executed)).toHaveLength(1);
    expect(alters.filter((entry) => !entry.executed)).toHaveLength(1);

    const audit = createMigrationDataSource(state.config as MigrationDbConfig);
    await audit.initialize();
    try {
      const history = await readMigrationHistory(audit, EXPECTED_DB);
      expect(history.history).toHaveLength(38);
      expect(await columnExists(audit, PACKAGE_TABLE, 'check_status')).toBe(true);
      expect(await columnExists(audit, ITEM_TABLE, 'check_result')).toBe(false);
      expect(await columnNullable(audit, ITEM_TABLE, 'result')).toBe('NO');
      expect(await constraintNames(audit, PACKAGE_TABLE)).toContain(
        'chk_record_package_import_manifest',
      );
      expect(await constraintNames(audit, PACKAGE_TABLE)).not.toContain(
        'chk_record_package_import_check_status',
      );
      expect(await constraintNames(audit, PACKAGE_TABLE)).not.toContain(
        'chk_record_package_import_check_stage',
      );
      expect(await constraintNames(audit, ITEM_TABLE)).not.toContain(
        'chk_record_package_item_check_result',
      );
      expect(await selectOldPackages(audit)).toEqual(state.beforePackages);
      expect(await selectOldItems(audit)).toEqual(state.beforeItems);
      const packageChecks = await selectPackageChecks(audit);
      for (const item of state.packages) {
        expect(packageChecks.has(item.packageId)).toBe(true);
        expect(packageChecks.get(item.packageId)).toBe(item.expectedCheck);
      }
    } finally {
      await audit.destroy();
    }
  });

  itScenario('C', 'C2 续跑尝试：正式入口按半迁移拒绝且零新 ALTER（续跑证据缺口）', async () => {
    const recorder = createInstrumentedDataSource(state.config as MigrationDbConfig);
    const dependencies: DeployRunDependencies = {
      createDataSource: (): DataSource => recorder,
      lockTimeoutSeconds: 0,
    };
    let caught: unknown;
    try {
      await runDatabaseDeploy(deployOptions(), silentLogger, dependencies);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = messageOf(caught);
    expect(message).toContain('疑似半迁移');
    expect(message).toContain('check_status');
    expect(recorder.alterStatements()).toEqual([]);

    const audit = createMigrationDataSource(state.config as MigrationDbConfig);
    await audit.initialize();
    try {
      const history = await readMigrationHistory(audit, EXPECTED_DB);
      expect(history.history).toHaveLength(38);
      expect(await columnExists(audit, PACKAGE_TABLE, 'check_status')).toBe(true);
      expect(await columnExists(audit, ITEM_TABLE, 'check_result')).toBe(false);
      expect(await selectOldPackages(audit)).toEqual(state.beforePackages);
      expect(await selectOldItems(audit)).toEqual(state.beforeItems);
    } finally {
      await audit.destroy();
    }
  });
});
