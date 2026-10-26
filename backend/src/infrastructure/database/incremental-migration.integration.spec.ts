// src/infrastructure/database/incremental-migration.integration.spec.ts
/// <reference types="jest" />
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm';

import {
  MigrationCleanupError,
  createMigrationDataSource,
  getCleanupErrors,
  loadExplicitEnvConfig,
  runIncrementalMigration,
  runStatusCommand,
  runVerifyCommand,
  type MigrationCliOptions,
  type MigrationDbConfig,
  type MigrationLogger,
} from './incremental-migration';
import { assertStructureDefinitionsComplete } from './migration-schema-contract';

/**
 * 实库验收测试：默认跳过。启用时必须同时显式声明破坏性授权。
 *
 * 运行方式（在 backend 目录）：
 *   MIGRATION_INTEGRATION=1 MIGRATION_INTEGRATION_ALLOW_DESTRUCTIVE=1 \
 *     npx jest src/infrastructure/database/incremental-migration.integration.spec.ts --runInBand
 *
 * 测试准备会清空并重建 lithography_e2e（测试专用库）。正式升级只通过新增入口执行；
 * 测试侧仅负责造旧库、注入失败与快照比对。
 */
const ENABLED =
  process.env.MIGRATION_INTEGRATION === '1' &&
  process.env.MIGRATION_INTEGRATION_ALLOW_DESTRUCTIVE === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

const ENV_FILE = 'env/.env.e2e';
const DATABASE = 'lithography_e2e';
const BASELINE_COUNT = 14;
const MIGRATION_LOCK_NAME = `lithography:migration:${DATABASE}`;
const BACKEND_DIR = path.resolve(__dirname, '../../..');
const LEGACY_DOCUMENT_COLUMNS = [
  'id',
  'title',
  'document_type',
  'equipment_model_id',
  'description',
  'original_filename',
  'mime_type',
  'content_text',
  'storage_backend',
  'storage_reference',
  'created_by_account_id',
  'deprecated',
  'deleted_at',
  'created_at',
  'updated_at',
].join(', ');

type MigrationClass = new () => MigrationInterface;

interface CapturedLogger {
  readonly logger: MigrationLogger;
  readonly lines: string[];
}

interface TablesAndHistory {
  readonly tables: string[];
  readonly history: Array<Record<string, unknown>>;
}

interface LegacyRows {
  readonly equipmentModels: Array<Record<string, unknown>>;
  readonly accounts: Array<Record<string, unknown>>;
  readonly userInfos: Array<Record<string, unknown>>;
  readonly documents: Array<Record<string, unknown>>;
}

/**
 * 记录日志到内存，便于断言诊断信息。
 */
function createCapturedLogger(): CapturedLogger {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message: string): void => {
        lines.push(`INFO ${message}`);
      },
      warn: (message: string): void => {
        lines.push(`WARN ${message}`);
      },
      error: (message: string): void => {
        lines.push(`ERROR ${message}`);
      },
    },
  };
}

/**
 * 规范化 MySQL 返回值，保证快照可稳定比较。
 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  if (value !== null && typeof value === 'object') {
    return JSON.parse(JSON.stringify(value)) as unknown;
  }
  return value;
}

/**
 * 规范化整行结果。
 */
function normalizeRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])),
  );
}

/**
 * 去除指定列，用于比对回填 UPDATE 会影响 updated_at 的旧资料。
 */
function omitColumns(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<string>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const copy = { ...row };
    for (const column of columns) {
      delete copy[column];
    }
    return copy;
  });
}

/**
 * 构造测试专用 DataSource（可显式指定迁移类）。
 */
function buildDataSource(config: MigrationDbConfig, migrations: MigrationClass[]): DataSource {
  return new DataSource({
    type: 'mysql',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    timezone: config.timezone,
    charset: config.charset,
    logging: false,
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    migrations,
  });
}

interface CleanupFailure {
  readonly destroy?: string;
  readonly releaseLock?: string;
  readonly historyInsert?: 'before' | 'after';
  readonly targetDatabase?: string;
  readonly failQueriesAfterRunFailure?: string;
}

interface Instrumentation {
  readonly dataSource: DataSource;
  readonly calls: { destroy: number; release: number };
}

/**
 * 识别迁移历史写入；MySQL 可能带库名限定，如 `db`.`migrations`。
 */
function isMigrationHistoryInsert(sql: string): boolean {
  return /INSERT\s+INTO\s+(?:`?[\w$]+`?\.)?`?migrations`?\s*\(/i.test(sql);
}

/**
 * 测试侧受控 DataSource：保留真实连接/DDL/查询，只注入收尾、目标或历史写入失败。
 * 不进入生产代码，也不改变被测执行器的控制流。
 */
function instrumentDataSource(dataSource: DataSource, failure: CleanupFailure): Instrumentation {
  const calls = { destroy: 0, release: 0 };
  const state = { runFailed: false };
  const originalQuery = dataSource.query.bind(dataSource) as (
    sql: string,
    parameters?: unknown[],
  ) => Promise<unknown>;
  const originalDestroy = dataSource.destroy.bind(dataSource);
  const originalCreate = dataSource.createQueryRunner.bind(dataSource);
  const originalRun = dataSource.runMigrations.bind(dataSource) as (
    options?: unknown,
  ) => Promise<unknown>;
  const mutable = dataSource as unknown as {
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
    destroy: () => Promise<void>;
    createQueryRunner: () => QueryRunner;
    runMigrations: (options?: unknown) => Promise<unknown>;
  };

  mutable.query = async (sql: string, parameters?: unknown[]): Promise<unknown> => {
    if (failure.targetDatabase && sql.includes('SELECT DATABASE()')) {
      return [{ current_database: failure.targetDatabase, server_version: '8.0.46-injected' }];
    }
    if (failure.failQueriesAfterRunFailure && state.runFailed) {
      throw new Error(failure.failQueriesAfterRunFailure);
    }
    return originalQuery(sql, parameters);
  };

  mutable.destroy = async (): Promise<void> => {
    calls.destroy += 1;
    await originalDestroy();
    if (failure.destroy) {
      throw new Error(failure.destroy);
    }
  };

  mutable.createQueryRunner = (): QueryRunner => {
    const runner = originalCreate();
    if (!failure.releaseLock && !failure.historyInsert) {
      return runner;
    }
    const mutableRunner = runner as unknown as {
      query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
    };
    const originalRunnerQuery = runner.query.bind(runner) as (
      sql: string,
      parameters?: unknown[],
      useStructuredResult?: boolean,
    ) => Promise<unknown>;
    mutableRunner.query = async (...args: unknown[]): Promise<unknown> => {
      const text = typeof args[0] === 'string' ? args[0] : '';
      if (failure.historyInsert && isMigrationHistoryInsert(text)) {
        if (failure.historyInsert === 'before') {
          throw new Error('injected-history-insert-failure-before-write');
        }
        await originalRunnerQuery(...(args as [string, unknown[]?, boolean?]));
        throw new Error('injected-history-insert-failure-after-write');
      }
      const result = await originalRunnerQuery(...(args as [string, unknown[]?, boolean?]));
      if (failure.releaseLock && text.includes('RELEASE_LOCK')) {
        calls.release += 1;
        throw new Error(failure.releaseLock);
      }
      return result;
    };
    return runner;
  };

  mutable.runMigrations = async (options?: unknown): Promise<unknown> => {
    try {
      return await originalRun(options);
    } catch (error: unknown) {
      state.runFailed = true;
      throw error;
    }
  };

  return { dataSource, calls };
}

/**
 * 生成带失败探针的迁移目录副本；探针先执行真实 DDL 再抛错。
 */
function createFailureArtifacts(): string {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-artifacts-'));
  const realMigrationsDir = path.resolve(__dirname, './migrations');
  for (const fileName of fs.readdirSync(realMigrationsDir)) {
    fs.copyFileSync(path.resolve(realMigrationsDir, fileName), path.resolve(artifactDir, fileName));
  }
  fs.writeFileSync(
    path.resolve(artifactDir, '9999999999999-failing-probe.migration.ts'),
    [
      '// test-only failure injection',
      'CREATE TABLE `__migration_failure_probe` (`id` int NOT NULL, PRIMARY KEY (`id`))',
    ].join('\n'),
    'utf8',
  );
  return artifactDir;
}

/**
 * 运行真实 CLI；预加载文件仅在测试子进程中生效。
 */
function runMigrationCli(
  args: ReadonlyArray<string>,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; output: string } {
  const child = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      '-r',
      'tsconfig-paths/register',
      '-r',
      './src/infrastructure/database/test-support/inject-cleanup-failure.js',
      'scripts/migration.ts',
      ...args,
    ],
    {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, TZ: 'Asia/Shanghai', ...extraEnv },
    },
  );
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

/**
 * 迁移类时间戳。
 */
function classTimestamp(migration: MigrationClass): number {
  const name = (migration as unknown as { name: string }).name;
  const timestamp = Number.parseInt(name.slice(-13), 10);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`无法解析迁移类时间戳: ${name}`);
  }
  return timestamp;
}

/**
 * 按时间戳升序排列迁移类。
 */
function sortMigrationClasses(migrations: MigrationClass[]): MigrationClass[] {
  return [...migrations].sort((a, b) => classTimestamp(a) - classTimestamp(b));
}

/**
 * 测试所用的失败注入迁移：先执行真实 DDL，再抛错，模拟部分生效后的脏中间态。
 */
class FailingProbeMigration9999999999999 implements MigrationInterface {
  public name = 'FailingProbeMigration9999999999999';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `__migration_failure_probe` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
    throw new Error('injected failure after real DDL');
  }

  public async down(): Promise<void> {
    // 测试专用：不提供自动回滚，验证入口不会偷偷 down。
  }
}

describeIntegration('增量迁移实库验收（M02-M09）', () => {
  let config: MigrationDbConfig;
  let allMigrationClasses: MigrationClass[];

  jest.setTimeout(300000);

  beforeAll(async () => {
    config = loadExplicitEnvConfig(ENV_FILE, DATABASE, BACKEND_DIR);
    const host = config.host.trim().toLowerCase();
    if (config.database !== DATABASE || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(
        `拒绝对非隔离目标执行破坏性验收：${config.host}/${config.database}，要求本机 ${DATABASE}`,
      );
    }
    const loader = createMigrationDataSource(config);
    await loader.initialize();
    try {
      allMigrationClasses = sortMigrationClasses(
        loader.migrations.map((migration) => migration.constructor as MigrationClass),
      );
    } finally {
      await loader.destroy();
    }
    if (allMigrationClasses.length < BASELINE_COUNT) {
      throw new Error(`仓库迁移数量异常: ${allMigrationClasses.length}`);
    }
  });

  const options = (): MigrationCliOptions => ({
    command: 'run',
    envFile: ENV_FILE,
    database: DATABASE,
    confirmDatabase: DATABASE,
  });

  /**
   * 构造带测试侧故障注入的依赖；被测执行器仍使用真实连接与真实迁移。
   */
  const controlledDependencies = (
    failure: CleanupFailure,
    instrumentation: Instrumentation[],
    migrations: MigrationClass[] = allMigrationClasses,
    migrationsDir?: string,
  ): {
    createDataSource: (dbConfig: MigrationDbConfig) => DataSource;
    lockTimeoutSeconds: number;
    migrationsDir?: string;
  } => ({
    createDataSource: (dbConfig: MigrationDbConfig): DataSource => {
      const instrumented = instrumentDataSource(buildDataSource(dbConfig, migrations), failure);
      instrumentation.push(instrumented);
      return instrumented.dataSource;
    },
    lockTimeoutSeconds: 0,
    migrationsDir,
  });

  /**
   * 断言收尾错误全部可见。
   */
  const expectCleanupErrors = (error: unknown, expected: ReadonlyArray<string>): void => {
    const actual = getCleanupErrors(error);
    for (const item of expected) {
      expect(actual.join('\n')).toContain(item);
    }
  };

  /**
   * 通用短连接操作。
   */
  const withDataSource = async <T>(action: (dataSource: DataSource) => Promise<T>): Promise<T> => {
    const dataSource = buildDataSource(config, []);
    await dataSource.initialize();
    try {
      return await action(dataSource);
    } finally {
      await dataSource.destroy();
    }
  };

  /**
   * 清空测试库；仅用于测试准备，不属于被测正式入口。
   */
  const resetDatabase = async (): Promise<void> => {
    await withDataSource(async (dataSource) => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
        const rows = (await queryRunner.query(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_type = 'BASE TABLE'
            ORDER BY table_name ASC
          `,
        )) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const table = String(row['table_name'] ?? row['TABLE_NAME']);
          if (!/^[A-Za-z0-9_]+$/.test(table) || table === 'undefined') {
            throw new Error(`拒绝删除异常表名: ${table}`);
          }
          await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
        }
        await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
      } finally {
        await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
        await queryRunner.release();
      }
    });
  };

  /**
   * 读取表名。
   */
  const readTableNames = async (dataSource: DataSource): Promise<string[]> => {
    const rows = await dataSource.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
        ORDER BY table_name ASC
      `,
    );
    return rows.map((row: Record<string, unknown>) =>
      String(row['table_name'] ?? row['TABLE_NAME']),
    );
  };

  /**
   * 写入合成旧库数据（14 条基线迁移之后、正式升级之前）。
   */
  const seedLegacyFixtures = async (dataSource: DataSource): Promise<void> => {
    await dataSource.query(
      `INSERT INTO \`equipment_model\` (\`id\`, \`model_code\`, \`model_name\`, \`enabled\`, \`sort_order\`) VALUES (900001, 'T02-LEGACY-MODEL', 'T02 旧机型', 1, 7)`,
    );
    await dataSource.query(
      `INSERT INTO \`base_user_account\` (\`id\`, \`login_name\`, \`login_email\`, \`login_password\`, \`status\`, \`identity_hint\`) VALUES (900001, 't02_legacy_user', 'legacy@example.com', 'legacy-password-hash', 'ACTIVE', 'ENGINEER')`,
    );
    await dataSource.query(
      `INSERT INTO \`base_user_info\` (\`id\`, \`account_id\`, \`nickname\`, \`company_name\`, \`access_group\`) VALUES (900001, 900001, '旧用户', '旧公司', JSON_ARRAY('guest'))`,
    );
    await dataSource.query(
      `INSERT INTO \`reference_document\` (\`id\`, \`title\`, \`document_type\`, \`equipment_model_id\`, \`description\`, \`original_filename\`, \`mime_type\`, \`content_text\`, \`storage_backend\`, \`storage_reference\`, \`created_by_account_id\`, \`deprecated\`, \`deleted_at\`, \`created_at\`) VALUES (900001, 'T02 旧资料', 'MANUAL', 900001, '旧说明', 'legacy.md', 'text/markdown', 'T02 旧库升级基线内容', NULL, NULL, 900001, 0, NULL, '2026-01-01 00:00:00.000')`,
    );
    await dataSource.query(
      `INSERT INTO \`reference_document\` (\`id\`, \`title\`, \`document_type\`, \`equipment_model_id\`, \`content_text\`, \`storage_backend\`, \`storage_reference\`, \`created_by_account_id\`, \`deprecated\`, \`deleted_at\`, \`created_at\`) VALUES (900002, 'T02 软删资料', 'FILE', NULL, NULL, 'S3', 'legacy/soft-deleted.pdf', 900001, 1, '2026-01-02 00:00:00.000', '2026-01-02 00:00:00.000')`,
    );
  };

  /**
   * 造旧库：先清空，再只执行前 14 条原迁移，最后写入合成数据。
   */
  const buildBaseline = async (): Promise<void> => {
    await resetDatabase();
    const baseline = buildDataSource(config, allMigrationClasses.slice(0, BASELINE_COUNT));
    await baseline.initialize();
    try {
      await baseline.runMigrations({ transaction: 'none' });
      await seedLegacyFixtures(baseline);
    } finally {
      await baseline.destroy();
    }
  };

  /**
   * 读取表与迁移历史的轻量快照。
   */
  const readTablesAndHistory = async (): Promise<TablesAndHistory> => {
    return withDataSource(async (dataSource) => {
      const tables = await readTableNames(dataSource);
      let history: Array<Record<string, unknown>> = [];
      try {
        const rows = await dataSource.query(
          'SELECT id, name, timestamp FROM migrations ORDER BY id ASC',
        );
        history = normalizeRows(rows);
      } catch (error: unknown) {
        const code =
          (error as { code?: string }).code ??
          (error as { driverError?: { code?: string } }).driverError?.code;
        if (code !== 'ER_NO_SUCH_TABLE') {
          throw error;
        }
      }
      return { tables, history };
    });
  };

  /**
   * 读取旧业务数据快照。
   */
  const readLegacyRows = async (): Promise<LegacyRows> => {
    return withDataSource(async (dataSource) => {
      const equipmentModels = await dataSource.query(
        `SELECT id, model_code, model_name, enabled, sort_order, created_at, updated_at FROM equipment_model WHERE id = 900001`,
      );
      const accounts = await dataSource.query(
        `SELECT id, login_name, login_email, login_password, status, identity_hint, created_at, updated_at FROM base_user_account WHERE id = 900001`,
      );
      const userInfos = await dataSource.query(
        `SELECT id, account_id, nickname, company_name, access_group, created_at, updated_at FROM base_user_info WHERE id = 900001`,
      );
      const documents = await dataSource.query(
        `SELECT ${LEGACY_DOCUMENT_COLUMNS} FROM reference_document WHERE id IN (900001, 900002) ORDER BY id ASC`,
      );
      return {
        equipmentModels: normalizeRows(equipmentModels),
        accounts: normalizeRows(accounts),
        userInfos: normalizeRows(userInfos),
        documents: normalizeRows(documents),
      };
    });
  };

  /**
   * 执行一条测试准备 SQL；不属于正式入口行为。
   */
  const prepareSql = async (sql: string): Promise<void> => {
    await withDataSource(async (dataSource) => {
      await dataSource.query(sql);
    });
  };

  /**
   * 造指定条数的干净迁移前缀（不写入合成旧资料）。
   */
  const buildPrefix = async (count: number): Promise<void> => {
    await resetDatabase();
    const partial = buildDataSource(config, allMigrationClasses.slice(0, count));
    await partial.initialize();
    try {
      await partial.runMigrations({ transaction: 'none' });
    } finally {
      await partial.destroy();
    }
  };

  /**
   * 读取索引的有序列，用于确认工具未改写被篡改结构。
   */
  const readIndexColumns = async (table: string, index: string): Promise<string[]> => {
    return withDataSource(async (dataSource) => {
      const rows = await dataSource.query(
        `
          SELECT column_name
          FROM information_schema.statistics
          WHERE table_schema = DATABASE()
            AND table_name = ?
            AND index_name = ?
          ORDER BY seq_in_index ASC
        `,
        [table, index],
      );
      return rows.map((row: Record<string, unknown>) =>
        String(row['column_name'] ?? row['COLUMN_NAME']),
      );
    });
  };

  /**
   * 读取外键的本地列与引用列映射，用于确认工具未改写被篡改结构。
   */
  const readForeignKeyMapping = async (
    table: string,
    constraint: string,
  ): Promise<{ local: string[]; referenceTable: string; referenceColumns: string[] }> => {
    return withDataSource(async (dataSource) => {
      const rows = await dataSource.query(
        `
          SELECT column_name, referenced_table_name, referenced_column_name
          FROM information_schema.key_column_usage
          WHERE constraint_schema = DATABASE()
            AND table_name = ?
            AND constraint_name = ?
          ORDER BY ordinal_position ASC
        `,
        [table, constraint],
      );
      const local = rows.map((row: Record<string, unknown>) =>
        String(row['column_name'] ?? row['COLUMN_NAME']),
      );
      const referenceColumns = rows.map((row: Record<string, unknown>) =>
        String(row['referenced_column_name'] ?? row['REFERENCED_COLUMN_NAME']),
      );
      const first = rows[0] ?? {};
      return {
        local,
        referenceTable: String(
          first['referenced_table_name'] ?? first['REFERENCED_TABLE_NAME'] ?? '',
        ),
        referenceColumns,
      };
    });
  };

  /**
   * 断言升级被预检拒绝，且结构、历史与旧数据均未被改动。
   */
  const expectRunRejectedWithoutWrites = async (): Promise<void> => {
    const before = await readTablesAndHistory();
    const beforeRows = await readLegacyRows();
    await expect(runIncrementalMigration(options(), createCapturedLogger().logger)).rejects.toThrow(
      /升级前预检失败/,
    );
    const after = await readTablesAndHistory();
    expect(after).toEqual(before);
    expect(await readLegacyRows()).toEqual(beforeRows);
    expect(after.tables).not.toContain('organization');
  };

  it('M02：status/verify 只读且不改动历史、结构与旧数据', async () => {
    await buildBaseline();
    const beforeState = await readTablesAndHistory();
    const beforeRows = await readLegacyRows();
    const captured = createCapturedLogger();

    const status = await runStatusCommand(options(), captured.logger);
    expect(status.issues).toEqual([]);
    expect(status.pending).toHaveLength(allMigrationClasses.length - BASELINE_COUNT);

    const verify = await runVerifyCommand(options(), captured.logger);
    expect(verify.issues.join('\n')).toMatch(/迁移未完成/);

    const afterState = await readTablesAndHistory();
    const afterRows = await readLegacyRows();
    expect(afterState).toEqual(beforeState);
    expect(afterRows).toEqual(beforeRows);
    expect(afterState.tables).not.toContain('organization');
  });

  it('M03：历史缺失/未知/重复/缺口/结构缺失均在写入前拒绝', async () => {
    const cases: Array<{
      name: string;
      mutate: () => Promise<void>;
      expected: RegExp;
    }> = [
      {
        name: 'migrations 记录表缺失',
        mutate: async () => {
          await prepareSql('DROP TABLE `migrations`');
        },
        expected: /migrations 记录表不存在|升级前预检失败/,
      },
      {
        name: '未知迁移记录',
        mutate: async () => {
          await prepareSql(
            "INSERT INTO `migrations` (`timestamp`, `name`) VALUES (9999999999999, 'UnknownMigration9999999999999')",
          );
        },
        expected: /不在当前仓库|超过仓库迁移数|升级前预检失败/,
      },
      {
        name: '重复迁移记录',
        mutate: async () => {
          await prepareSql(
            'INSERT INTO `migrations` (`timestamp`, `name`) SELECT `timestamp`, `name` FROM `migrations` ORDER BY `id` DESC LIMIT 1',
          );
        },
        expected: /迁移记录重复|超过仓库迁移数|升级前预检失败/,
      },
      {
        name: '迁移历史缺口',
        mutate: async () => {
          await prepareSql(
            'DELETE FROM `migrations` WHERE `id` = (SELECT `id` FROM (SELECT `id` FROM `migrations` ORDER BY `id` ASC LIMIT 1 OFFSET 2) AS picked)',
          );
        },
        expected: /顺序与仓库不一致|升级前预检失败/,
      },
      {
        name: '已记录迁移但结构缺失',
        mutate: async () => {
          await withDataSource(async (dataSource) => {
            const queryRunner = dataSource.createQueryRunner();
            await queryRunner.connect();
            try {
              await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
              await queryRunner.query('DROP TABLE `reference_document`');
              await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
            } finally {
              await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
              await queryRunner.release();
            }
          });
        },
        expected: /结构缺失|升级前预检失败/,
      },
    ];

    for (const testCase of cases) {
      await buildBaseline();
      await testCase.mutate();
      const before = await readTablesAndHistory();
      const captured = createCapturedLogger();

      await expect(runIncrementalMigration(options(), captured.logger)).rejects.toThrow(
        testCase.expected,
      );

      const after = await readTablesAndHistory();
      expect(after.tables).toEqual(before.tables);
      expect(after.history).toEqual(before.history);
      expect(after.tables).not.toContain('organization');
      expect(after.history.length).toBe(before.history.length);
    }
  });

  it('M04：旧 14 条库仅执行新增 10 条，结构与旧数据保留', async () => {
    await buildBaseline();
    const beforeRows = await readLegacyRows();
    const beforeState = await readTablesAndHistory();
    const captured = createCapturedLogger();

    const report = await runIncrementalMigration(options(), captured.logger);
    expect(report.executed).toHaveLength(allMigrationClasses.length - BASELINE_COUNT);
    expect(report.executed[0]).toBe(
      (allMigrationClasses[BASELINE_COUNT] as unknown as { name: string }).name,
    );
    expect(report.pendingAfter).toEqual([]);
    expect(report.verification.issues).toEqual([]);

    const afterState = await readTablesAndHistory();
    expect(afterState.history).toHaveLength(allMigrationClasses.length);
    expect(afterState.history.slice(0, BASELINE_COUNT)).toEqual(
      beforeState.history.slice(0, BASELINE_COUNT),
    );
    const businessTables = afterState.tables.filter(
      (table) => table !== 'migrations' && table !== 'typeorm_metadata',
    );
    expect(businessTables).toHaveLength(23);
    expect(businessTables).toContain('organization');
    expect(businessTables).toContain('reference_document_case_detail');

    const afterRows = await readLegacyRows();
    expect(afterRows.equipmentModels).toEqual(beforeRows.equipmentModels);
    expect(afterRows.accounts).toEqual(beforeRows.accounts);
    expect(afterRows.userInfos).toEqual(beforeRows.userInfos);
    expect(omitColumns(afterRows.documents, ['updated_at'])).toEqual(
      omitColumns(beforeRows.documents, ['updated_at']),
    );

    const newDocumentColumns: Array<Record<string, unknown>> = await withDataSource(
      async (dataSource) =>
        dataSource.query(
          `
          SELECT id, owner_organization_id, ingest_method, schema_version,
                 source_submission_id, source_revision_id, equipment_model_text,
                 updated_by_account_id, extension_json
          FROM reference_document
          WHERE id IN (900001, 900002)
          ORDER BY id ASC
        `,
        ),
    );
    expect(newDocumentColumns).toHaveLength(2);
    for (const row of newDocumentColumns) {
      expect(row['ingest_method']).toBe('ADMIN_DIRECT');
      expect(Number(row['schema_version'])).toBe(1);
      expect(row['source_submission_id']).toBeNull();
      expect(row['source_revision_id']).toBeNull();
      expect(row['equipment_model_text']).toBeNull();
      expect(row['updated_by_account_id']).toBeNull();
      expect(row['extension_json']).toBeNull();
      expect(Number(row['owner_organization_id'])).toBeGreaterThan(0);
    }

    const organizations: Array<Record<string, unknown>> = await withDataSource(async (dataSource) =>
      dataSource.query(
        "SELECT id, organization_code FROM organization WHERE organization_code = 'CLIENT_DEFAULT'",
      ),
    );
    expect(organizations).toHaveLength(1);
    expect(Number(newDocumentColumns[0]['owner_organization_id'])).toBe(
      Number(organizations[0]['id']),
    );
  });

  it('M05：第二次正式 run 执行 0 条，verify 通过且数据不变', async () => {
    await buildBaseline();
    await runIncrementalMigration(options(), createCapturedLogger().logger);
    const beforeSecondRun = await readLegacyRows();
    const beforeState = await readTablesAndHistory();
    const captured = createCapturedLogger();

    const report = await runIncrementalMigration(options(), captured.logger);
    expect(report.executed).toEqual([]);
    expect(report.pendingBefore).toEqual([]);
    expect(report.pendingAfter).toEqual([]);

    const verify = await runVerifyCommand(options(), captured.logger);
    expect(verify.issues).toEqual([]);

    expect(await readLegacyRows()).toEqual(beforeSecondRun);
    expect(await readTablesAndHistory()).toEqual(beforeState);
    const organizations: Array<Record<string, unknown>> = await withDataSource(async (dataSource) =>
      dataSource.query(
        "SELECT COUNT(*) AS total FROM organization WHERE organization_code = 'CLIENT_DEFAULT'",
      ),
    );
    expect(Number(organizations[0]['total'])).toBe(1);
  });

  it('M06：待执行迁移对象已存在但无记录时拒绝盲重试', async () => {
    await buildBaseline();
    await prepareSql(
      'CREATE TABLE `content_submission` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
    const before = await readTablesAndHistory();
    const captured = createCapturedLogger();

    const status = await runStatusCommand(options(), captured.logger);
    expect(status.issues.join('\n')).toMatch(/疑似半迁移.*content_submission/);

    await expect(runIncrementalMigration(options(), captured.logger)).rejects.toThrow(
      /疑似半迁移|升级前预检失败/,
    );

    const after = await readTablesAndHistory();
    expect(after.tables).toContain('content_submission');
    expect(after.tables).not.toContain('organization');
    expect(after.history).toEqual(before.history);
  });

  it('M07：真实 DDL 生效后失败，保留中间态且不自动回滚/补记录', async () => {
    await buildBaseline();
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-artifacts-'));
    const realMigrationsDir = path.resolve(__dirname, './migrations');
    for (const fileName of fs.readdirSync(realMigrationsDir)) {
      fs.copyFileSync(
        path.resolve(realMigrationsDir, fileName),
        path.resolve(artifactDir, fileName),
      );
    }
    fs.writeFileSync(
      path.resolve(artifactDir, '9999999999999-failing-probe.migration.ts'),
      [
        '// test-only failure injection',
        'CREATE TABLE `__migration_failure_probe` (`id` int NOT NULL, PRIMARY KEY (`id`))',
      ].join('\n'),
      'utf8',
    );

    const injectedClasses = [...allMigrationClasses, FailingProbeMigration9999999999999];
    const captured = createCapturedLogger();

    try {
      await expect(
        runIncrementalMigration(options(), captured.logger, {
          createDataSource: (dbConfig) => buildDataSource(dbConfig, injectedClasses),
          lockTimeoutSeconds: 0,
          migrationsDir: artifactDir,
        }),
      ).rejects.toThrow(/injected failure/);

      const state = await readTablesAndHistory();
      expect(state.history).toHaveLength(allMigrationClasses.length);
      expect(state.history.map((row) => String(row['name']))).not.toContain(
        'FailingProbeMigration9999999999999',
      );
      expect(state.tables).toContain('__migration_failure_probe');

      const columns: Array<Record<string, unknown>> = await withDataSource(async (dataSource) =>
        dataSource.query(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'reference_document'
              AND column_name IN ('owner_organization_id', 'ingest_method')
          `,
        ),
      );
      expect(columns).toHaveLength(2);
      expect(captured.lines.join('\n')).toMatch(/失败后只读现场/);
      expect(captured.lines.join('\n')).toMatch(/疑似半迁移.*__migration_failure_probe/);
    } finally {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('M09：同一目标互斥执行，另一进程明确失败且不并发 DDL', async () => {
    await buildBaseline();
    const lockDataSource = buildDataSource(config, []);
    await lockDataSource.initialize();
    const lockRunner = lockDataSource.createQueryRunner();
    await lockRunner.connect();
    const captured = createCapturedLogger();

    try {
      const lockRows = (await lockRunner.query('SELECT GET_LOCK(?, 0) AS acquired', [
        MIGRATION_LOCK_NAME,
      ])) as Array<Record<string, unknown>>;
      expect(Number(lockRows[0]['acquired'])).toBe(1);

      await expect(runIncrementalMigration(options(), captured.logger)).rejects.toThrow(/互斥锁/);

      const child = spawnSync(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          '-r',
          'tsconfig-paths/register',
          'scripts/migration.ts',
          'run',
          '--config-file',
          ENV_FILE,
          '--database',
          DATABASE,
          '--confirm-database',
          DATABASE,
        ],
        {
          cwd: BACKEND_DIR,
          encoding: 'utf8',
          timeout: 180000,
          env: { ...process.env, TZ: 'Asia/Shanghai' },
        },
      );
      expect(child.status).not.toBe(0);
      expect(`${child.stdout}${child.stderr}`).toMatch(/互斥锁/);

      const afterConflict = await readTablesAndHistory();
      expect(afterConflict.history).toHaveLength(BASELINE_COUNT);
      expect(afterConflict.tables).not.toContain('organization');
    } finally {
      await lockRunner.query('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK_NAME]);
      await lockRunner.release();
      await lockDataSource.destroy();
    }

    const report = await runIncrementalMigration(options(), captured.logger);
    expect(report.executed).toHaveLength(allMigrationClasses.length - BASELINE_COUNT);
  });

  it('M01：配置缺失时 CLI 非 0 退出且目标零 DDL/DML', async () => {
    await buildBaseline();
    const beforeState = await readTablesAndHistory();
    const beforeRows = await readLegacyRows();

    const child = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        'scripts/migration.ts',
        'run',
        '--config-file',
        'env/.env.missing',
        '--database',
        DATABASE,
        '--confirm-database',
        DATABASE,
      ],
      {
        cwd: BACKEND_DIR,
        encoding: 'utf8',
        timeout: 180000,
        env: { ...process.env, TZ: 'Asia/Shanghai' },
      },
    );

    expect(child.status).not.toBe(0);
    expect(`${child.stdout}${child.stderr}`).toMatch(/环境文件不存在/);
    expect(await readTablesAndHistory()).toEqual(beforeState);
    expect(await readLegacyRows()).toEqual(beforeRows);
  });

  it('R1：有 pending 时迁移落地后 destroy 失败，执行器 reject 且收尾原因可见', async () => {
    await buildBaseline();
    const instrumentation: Instrumentation[] = [];
    const captured = createCapturedLogger();
    const error = await runIncrementalMigration(
      options(),
      captured.logger,
      controlledDependencies(
        { destroy: 'injected-destroy-failure-after-real-close' },
        instrumentation,
      ),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationCleanupError);
    expectCleanupErrors(error, ['关闭数据库连接 失败: injected-destroy-failure-after-real-close']);
    expect(instrumentation).toHaveLength(1);
    expect(instrumentation[0].calls.destroy).toBe(1);

    const state = await readTablesAndHistory();
    expect(state.history).toHaveLength(allMigrationClasses.length);
    expect(state.tables).toContain('organization');
  });

  it('R1：零 pending 空操作成功后 destroy 失败也 reject', async () => {
    await buildBaseline();
    await runIncrementalMigration(options(), createCapturedLogger().logger);
    const before = await readTablesAndHistory();
    const instrumentation: Instrumentation[] = [];
    const error = await runIncrementalMigration(
      options(),
      createCapturedLogger().logger,
      controlledDependencies(
        { destroy: 'injected-destroy-failure-after-real-close' },
        instrumentation,
      ),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationCleanupError);
    expectCleanupErrors(error, ['关闭数据库连接 失败: injected-destroy-failure-after-real-close']);
    expect(await readTablesAndHistory()).toEqual(before);
  });

  it('R1：status/verify 查询成功后 destroy 失败不得静默吞错', async () => {
    await buildBaseline();
    const statusInstrumentation: Instrumentation[] = [];
    const statusError = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
      {
        createDataSource: (dbConfig) => {
          const instrumented = instrumentDataSource(
            buildDataSource(dbConfig, allMigrationClasses),
            { destroy: 'injected-destroy-failure-after-real-close' },
          );
          statusInstrumentation.push(instrumented);
          return instrumented.dataSource;
        },
      },
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(statusError).toBeInstanceOf(MigrationCleanupError);
    expectCleanupErrors(statusError, [
      '关闭数据库连接 失败: injected-destroy-failure-after-real-close',
    ]);

    const verifyInstrumentation: Instrumentation[] = [];
    const verifyError = await runVerifyCommand(
      { ...options(), command: 'verify' },
      createCapturedLogger().logger,
      {
        createDataSource: (dbConfig) => {
          const instrumented = instrumentDataSource(
            buildDataSource(dbConfig, allMigrationClasses),
            { destroy: 'injected-destroy-failure-after-real-close' },
          );
          verifyInstrumentation.push(instrumented);
          return instrumented.dataSource;
        },
      },
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(verifyError).toBeInstanceOf(MigrationCleanupError);
    expectCleanupErrors(verifyError, [
      '关闭数据库连接 失败: injected-destroy-failure-after-real-close',
    ]);
    expect(statusInstrumentation[0].calls.destroy).toBe(1);
    expect(verifyInstrumentation[0].calls.destroy).toBe(1);
  });

  it('R1：解锁失败仍尝试关闭连接，两个收尾错误都可见', async () => {
    await buildBaseline();
    const instrumentation: Instrumentation[] = [];
    const error = await runIncrementalMigration(
      options(),
      createCapturedLogger().logger,
      controlledDependencies(
        {
          releaseLock: 'injected-release-lock-failure-after-real-release',
          destroy: 'injected-destroy-failure-after-real-close',
        },
        instrumentation,
      ),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationCleanupError);
    expectCleanupErrors(error, [
      '释放迁移互斥锁 失败: injected-release-lock-failure-after-real-release',
      '关闭数据库连接 失败: injected-destroy-failure-after-real-close',
    ]);
    expect(instrumentation[0].calls.release).toBe(1);
    expect(instrumentation[0].calls.destroy).toBe(1);
    expect((await readTablesAndHistory()).history).toHaveLength(allMigrationClasses.length);
  });

  it('R1：迁移主因与解锁/断连失败同时发生时保留主因并附加上下文', async () => {
    await buildBaseline();
    const artifactDir = createFailureArtifacts();
    const injectedClasses = [...allMigrationClasses, FailingProbeMigration9999999999999];
    const instrumentation: Instrumentation[] = [];
    try {
      const error = await runIncrementalMigration(
        options(),
        createCapturedLogger().logger,
        controlledDependencies(
          {
            releaseLock: 'injected-release-lock-failure-after-real-release',
            destroy: 'injected-destroy-failure-after-real-close',
          },
          instrumentation,
          injectedClasses,
          artifactDir,
        ),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/injected failure after real DDL/);
      expectCleanupErrors(error, [
        '释放迁移互斥锁 失败: injected-release-lock-failure-after-real-release',
        '关闭数据库连接 失败: injected-destroy-failure-after-real-close',
      ]);
      expect(instrumentation[0].calls.destroy).toBe(1);
    } finally {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('R1：失败后诊断再次失败仍保留原始主因', async () => {
    await buildBaseline();
    const artifactDir = createFailureArtifacts();
    const injectedClasses = [...allMigrationClasses, FailingProbeMigration9999999999999];
    const instrumentation: Instrumentation[] = [];
    const captured = createCapturedLogger();
    try {
      const error = await runIncrementalMigration(
        options(),
        captured.logger,
        controlledDependencies(
          { failQueriesAfterRunFailure: 'injected-diagnosis-failure' },
          instrumentation,
          injectedClasses,
          artifactDir,
        ),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/injected failure after real DDL/);
      expect(captured.lines.join('\n')).toMatch(/失败后只读诊断也失败/);
      expect(captured.lines.join('\n')).toMatch(/injected-diagnosis-failure/);
    } finally {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('R1-CLI：真实 CLI 在 run/status/verify 收尾失败时均非 0', async () => {
    await buildBaseline();
    const runArgs = [
      'run',
      '--config-file',
      ENV_FILE,
      '--database',
      DATABASE,
      '--confirm-database',
      DATABASE,
    ];
    const statusArgs = ['status', '--config-file', ENV_FILE, '--database', DATABASE];
    const verifyArgs = ['verify', '--config-file', ENV_FILE, '--database', DATABASE];
    const cleanupEnv = { MIGRATION_TEST_INJECT_CLOSE_FAILURE: '1' };

    const pendingRun = runMigrationCli(runArgs, cleanupEnv);
    expect(pendingRun.status).not.toBe(0);
    expect(pendingRun.output).toMatch(/injected-destroy-failure-after-real-close/);
    expect((await readTablesAndHistory()).history).toHaveLength(allMigrationClasses.length);

    const statusRun = runMigrationCli(statusArgs, cleanupEnv);
    expect(statusRun.status).not.toBe(0);
    expect(statusRun.output).toMatch(/injected-destroy-failure-after-real-close/);

    const verifyRun = runMigrationCli(verifyArgs, cleanupEnv);
    expect(verifyRun.status).not.toBe(0);
    expect(verifyRun.output).toMatch(/injected-destroy-failure-after-real-close/);

    const zeroRun = runMigrationCli(runArgs, cleanupEnv);
    expect(zeroRun.status).not.toBe(0);
    expect(zeroRun.output).toMatch(/injected-destroy-failure-after-real-close/);
    expect((await readTablesAndHistory()).history).toHaveLength(allMigrationClasses.length);
  });

  it('R1-CLI：解锁失败后仍尝试关闭连接，CLI 非 0 且两个原因可见', async () => {
    await buildBaseline();
    const result = runMigrationCli(
      ['run', '--config-file', ENV_FILE, '--database', DATABASE, '--confirm-database', DATABASE],
      {
        MIGRATION_TEST_INJECT_RELEASE_FAILURE: '1',
        MIGRATION_TEST_INJECT_CLOSE_FAILURE: '1',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/injected-release-lock-failure-after-real-release/);
    expect(result.output).toMatch(/injected-destroy-failure-after-real-close/);
    expect((await readTablesAndHistory()).history).toHaveLength(allMigrationClasses.length);
  });

  it('R2：旧前缀缺关键索引/列/CHECK/外键或索引定义不符时在写入前拒绝', async () => {
    const cases: Array<{
      name: string;
      mutate: () => Promise<void>;
      expected: RegExp;
    }> = [
      {
        name: '缺失关键索引',
        mutate: async () => {
          await prepareSql('ALTER TABLE `base_user_account` DROP INDEX `uk_login_email`');
        },
        expected: /关键索引缺失: base_user_account\.uk_login_email/,
      },
      {
        name: '同名索引但非唯一',
        mutate: async () => {
          await prepareSql(
            'ALTER TABLE `base_user_account` DROP INDEX `uk_login_email`, ADD INDEX `uk_login_email` (`login_email`)',
          );
        },
        expected: /关键索引定义不符.*base_user_account\.uk_login_email/,
      },
      {
        name: '缺失关键列',
        mutate: async () => {
          await prepareSql('ALTER TABLE `base_user_info` DROP COLUMN `company_name`');
        },
        expected: /关键字段缺失: base_user_info\.company_name/,
      },
      {
        name: '缺失关键 CHECK',
        mutate: async () => {
          await prepareSql(
            'ALTER TABLE `equipment_model` DROP CHECK `chk_equipment_model_enabled`',
          );
        },
        expected: /关键 CHECK 约束缺失: equipment_model\.chk_equipment_model_enabled/,
      },
      {
        name: '缺失关键外键',
        mutate: async () => {
          await prepareSql(
            'ALTER TABLE `repair_request` DROP FOREIGN KEY `fk_repair_request_equipment_model`',
          );
        },
        expected: /关键外键缺失: repair_request\.fk_repair_request_equipment_model/,
      },
    ];

    for (const testCase of cases) {
      await buildBaseline();
      await testCase.mutate();
      const before = await readTablesAndHistory();

      const status = await runStatusCommand(
        { ...options(), command: 'status' },
        createCapturedLogger().logger,
      );
      expect(status.issues.join('\n')).toMatch(testCase.expected);

      await expect(
        runIncrementalMigration(options(), createCapturedLogger().logger),
      ).rejects.toThrow(/升级前预检失败/);

      const after = await readTablesAndHistory();
      expect(after.tables).toEqual(before.tables);
      expect(after.history).toEqual(before.history);
      expect(after.tables).not.toContain('organization');
    }
  });

  it('R2：合法中间前缀与完整终态按自身结构通过，不被未来对象误伤', async () => {
    await resetDatabase();
    const intermediateCount = 20;
    const partial = buildDataSource(config, allMigrationClasses.slice(0, intermediateCount));
    await partial.initialize();
    try {
      await partial.runMigrations({ transaction: 'none' });
    } finally {
      await partial.destroy();
    }

    const statusAt20 = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(statusAt20.issues).toEqual([]);
    expect(statusAt20.pending).toHaveLength(allMigrationClasses.length - intermediateCount);

    const upgrade = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(upgrade.executed).toHaveLength(allMigrationClasses.length - intermediateCount);
    expect(upgrade.verification.issues).toEqual([]);

    const statusAt24 = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(statusAt24.issues).toEqual([]);
    expect(statusAt24.pending).toEqual([]);

    const secondRun = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(secondRun.executed).toEqual([]);
  });

  it('C1：14 条库同名唯一邮箱索引改列后 status/run 拒绝且零写入', async () => {
    await buildBaseline();
    await prepareSql(
      'ALTER TABLE `base_user_account` DROP INDEX `uk_login_email`, ADD UNIQUE INDEX `uk_login_email` (`login_name`)',
    );

    const status = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(status.issues.join('\n')).toMatch(
      /关键索引列定义不符: base_user_account\.uk_login_email 期望\(login_email\)，实际\(login_name\)/,
    );

    await expectRunRejectedWithoutWrites();
    expect(await readIndexColumns('base_user_account', 'uk_login_email')).toEqual(['login_name']);
  });

  it('C2：14 条库客户外键同名同引用表但本地列被改后 status/run 拒绝', async () => {
    await buildBaseline();
    await prepareSql(
      'ALTER TABLE `repair_request` DROP FOREIGN KEY `fk_repair_request_customer_account`',
    );
    await prepareSql(
      'ALTER TABLE `repair_request` ADD CONSTRAINT `fk_repair_request_customer_account` FOREIGN KEY (`accepted_by_engineer_account_id`) REFERENCES `base_user_account` (`id`)',
    );

    const status = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(status.issues.join('\n')).toMatch(
      /关键外键定义不符: repair_request\.fk_repair_request_customer_account 期望 \(customer_account_id\) -> .*base_user_account\(id\)，实际 \(accepted_by_engineer_account_id\)/,
    );

    await expectRunRejectedWithoutWrites();
    expect(
      await readForeignKeyMapping('repair_request', 'fk_repair_request_customer_account'),
    ).toEqual({
      local: ['accepted_by_engineer_account_id'],
      referenceTable: 'base_user_account',
      referenceColumns: ['id'],
    });
  });

  it('C3：复合索引列序颠倒或缺列时前缀预检拒绝', async () => {
    const cases: Array<{ name: string; sql: string; expected: RegExp }> = [
      {
        name: '列序颠倒',
        sql: 'ALTER TABLE `base_async_task_record` DROP INDEX `uk_queue_name_job_id`, ADD UNIQUE INDEX `uk_queue_name_job_id` (`job_id`, `queue_name`)',
        expected:
          /关键索引列定义不符: base_async_task_record\.uk_queue_name_job_id 期望\(queue_name, job_id\)，实际\(job_id, queue_name\)/,
      },
      {
        name: '少一列',
        sql: 'ALTER TABLE `base_async_task_record` DROP INDEX `uk_queue_name_job_id`, ADD UNIQUE INDEX `uk_queue_name_job_id` (`queue_name`)',
        expected:
          /关键索引列定义不符: base_async_task_record\.uk_queue_name_job_id 期望\(queue_name, job_id\)，实际\(queue_name\)/,
      },
    ];

    for (const testCase of cases) {
      await buildBaseline();
      await prepareSql(testCase.sql);
      const status = await runStatusCommand(
        { ...options(), command: 'status' },
        createCapturedLogger().logger,
      );
      expect(status.issues.join('\n')).toMatch(testCase.expected);
      await expectRunRejectedWithoutWrites();
    }
  });

  it('C4：复合外键本地列顺序与映射不符时前缀预检拒绝', async () => {
    // 真实 MySQL 可构造：本地列序改为 (submission_id, attachment_id)，
    // 引用 (id, submission_id)，从而保持引用表正确但本地列映射顺序错误。
    // 复合外键由第 21 条迁移创建，因此使用 21 条前缀。
    await buildPrefix(21);
    await prepareSql(
      'ALTER TABLE `content_submission_revision` DROP FOREIGN KEY `fk_content_submission_revision_attachment`',
    );
    await prepareSql(
      'ALTER TABLE `content_submission_revision` ADD CONSTRAINT `fk_content_submission_revision_attachment` FOREIGN KEY (`submission_id`, `attachment_id`) REFERENCES `content_submission_attachment` (`id`, `submission_id`)',
    );

    const status = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(status.issues.join('\n')).toMatch(
      /关键外键定义不符: content_submission_revision\.fk_content_submission_revision_attachment 期望 \(attachment_id, submission_id\) -> .*content_submission_attachment\(id, submission_id\)，实际 \(submission_id, attachment_id\)/,
    );

    const before = await readTablesAndHistory();
    await expect(runIncrementalMigration(options(), createCapturedLogger().logger)).rejects.toThrow(
      /升级前预检失败/,
    );
    const after = await readTablesAndHistory();
    expect(after).toEqual(before);
  });

  it('C5：24 条库出现 C1/C2 错误定义时 verify 与零 pending run 均拒绝', async () => {
    await buildPrefix(allMigrationClasses.length);
    await prepareSql(
      'ALTER TABLE `base_user_account` DROP INDEX `uk_login_email`, ADD UNIQUE INDEX `uk_login_email` (`login_name`)',
    );
    await prepareSql(
      'ALTER TABLE `repair_request` DROP FOREIGN KEY `fk_repair_request_customer_account`',
    );
    await prepareSql(
      'ALTER TABLE `repair_request` ADD CONSTRAINT `fk_repair_request_customer_account` FOREIGN KEY (`accepted_by_engineer_account_id`) REFERENCES `base_user_account` (`id`)',
    );

    const before = await readTablesAndHistory();
    const verify = await runVerifyCommand(
      { ...options(), command: 'verify' },
      createCapturedLogger().logger,
    );
    expect(verify.issues.join('\n')).toMatch(/base_user_account\.uk_login_email/);
    expect(verify.issues.join('\n')).toMatch(/fk_repair_request_customer_account/);

    await expect(runIncrementalMigration(options(), createCapturedLogger().logger)).rejects.toThrow(
      /升级前预检失败/,
    );
    expect(await readTablesAndHistory()).toEqual(before);
  });

  it('C6：14/20/24 条合法前缀与正确复合定义均通过', async () => {
    await buildPrefix(BASELINE_COUNT);
    const statusAt14 = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(statusAt14.issues).toEqual([]);

    const upgradeFrom14 = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(upgradeFrom14.executed).toHaveLength(allMigrationClasses.length - BASELINE_COUNT);
    expect(upgradeFrom14.verification.issues).toEqual([]);

    expect(
      await readIndexColumns(
        'content_submission_attachment',
        'uk_content_submission_attachment_id_submission',
      ),
    ).toEqual(['id', 'submission_id']);
    expect(
      await readForeignKeyMapping(
        'content_submission_revision',
        'fk_content_submission_revision_attachment',
      ),
    ).toEqual({
      local: ['attachment_id', 'submission_id'],
      referenceTable: 'content_submission_attachment',
      referenceColumns: ['id', 'submission_id'],
    });
    expect(
      await readForeignKeyMapping('reference_document', 'fk_reference_document_source_revision'),
    ).toEqual({
      local: ['source_revision_id', 'source_submission_id'],
      referenceTable: 'content_submission_revision',
      referenceColumns: ['id', 'submission_id'],
    });

    await buildPrefix(20);
    const statusAt20 = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(statusAt20.issues).toEqual([]);
    const upgradeFrom20 = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(upgradeFrom20.executed).toHaveLength(allMigrationClasses.length - 20);

    await buildPrefix(allMigrationClasses.length);
    const statusAt24 = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(statusAt24.issues).toEqual([]);
    const runAt24 = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(runAt24.executed).toEqual([]);
  });

  it('C7：契约缺列定义与异常索引元数据均明确拒绝', async () => {
    expect(() =>
      assertStructureDefinitionsComplete(
        [{ table: 'base_user_account', index: 'uk_not_registered' }],
        [],
      ),
    ).toThrow(/关键索引未登记列定义/);
    expect(() =>
      assertStructureDefinitionsComplete(
        [],
        [
          {
            table: 'repair_request',
            constraint: 'fk_not_registered',
            referencedTable: 'base_user_account',
          },
        ],
      ),
    ).toThrow(/关键外键未登记列映射/);

    await buildBaseline();
    await prepareSql(
      'ALTER TABLE `base_user_account` DROP INDEX `uk_login_email`, ADD UNIQUE INDEX `uk_login_email` (`login_email`(10))',
    );
    const prefixStatus = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(prefixStatus.issues.join('\n')).toMatch(
      /关键索引不接受前缀索引: base_user_account\.uk_login_email/,
    );
    await expectRunRejectedWithoutWrites();

    await buildBaseline();
    await prepareSql(
      'ALTER TABLE `base_user_account` DROP INDEX `uk_login_email`, ADD UNIQUE INDEX `uk_login_email` ((lower(`login_email`)))',
    );
    const expressionStatus = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(expressionStatus.issues.join('\n')).toMatch(
      /关键索引不支持表达式索引: base_user_account\.uk_login_email/,
    );
    await expectRunRejectedWithoutWrites();
  });

  it('C8：有 pending 或零 pending 收尾失败时均无最终成功确认', async () => {
    await buildBaseline();
    const pendingCaptured = createCapturedLogger();
    const pendingError = await runIncrementalMigration(
      options(),
      pendingCaptured.logger,
      controlledDependencies({ destroy: 'injected-destroy-failure' }, []),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(pendingError).toBeInstanceOf(MigrationCleanupError);
    expectCleanupErrors(pendingError, ['injected-destroy-failure']);
    expect(pendingCaptured.lines.join('\n')).not.toMatch(/升级完成/);

    await buildBaseline();
    const upgrade = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(upgrade.executed).toHaveLength(allMigrationClasses.length - BASELINE_COUNT);

    const zeroCaptured = createCapturedLogger();
    const zeroError = await runIncrementalMigration(
      options(),
      zeroCaptured.logger,
      controlledDependencies({ releaseLock: 'injected-release-failure' }, []),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(zeroError).toBeInstanceOf(MigrationCleanupError);
    expectCleanupErrors(zeroError, ['injected-release-failure']);
    expect(zeroCaptured.lines.join('\n')).not.toMatch(/升级完成/);
  });

  it('C9：完整成功后最终成功确认恰好一次且位于最后', async () => {
    await buildBaseline();
    const pendingCaptured = createCapturedLogger();
    const upgrade = await runIncrementalMigration(options(), pendingCaptured.logger);
    expect(upgrade.executed).toHaveLength(allMigrationClasses.length - BASELINE_COUNT);
    const pendingSuccess = pendingCaptured.lines.filter((line) => line.includes('升级完成'));
    expect(pendingSuccess).toHaveLength(1);
    expect(pendingCaptured.lines[pendingCaptured.lines.length - 1]).toContain('升级完成');

    const zeroCaptured = createCapturedLogger();
    const secondRun = await runIncrementalMigration(options(), zeroCaptured.logger);
    expect(secondRun.executed).toEqual([]);
    const zeroSuccess = zeroCaptured.lines.filter((line) => line.includes('升级完成'));
    expect(zeroSuccess).toHaveLength(1);
    expect(zeroCaptured.lines[zeroCaptured.lines.length - 1]).toContain('升级完成');
  });

  it('R3：脏目标仍拒绝；恢复干净旧备份后 status→run→verify→run 闭环', async () => {
    await buildBaseline();
    const instrumentation: Instrumentation[] = [];
    const dirtyError = await runIncrementalMigration(
      options(),
      createCapturedLogger().logger,
      controlledDependencies({ historyInsert: 'before' }, instrumentation),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(dirtyError).toBeInstanceOf(Error);
    expect((dirtyError as Error).message).toMatch(/injected-history-insert-failure-before-write/);

    const dirtyState = await readTablesAndHistory();
    expect(dirtyState.history).toHaveLength(BASELINE_COUNT);
    expect(dirtyState.tables).toContain('organization');

    const dirtyStatus = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(dirtyStatus.issues.join('\n')).toMatch(/疑似半迁移.*organization/);
    await expect(runIncrementalMigration(options(), createCapturedLogger().logger)).rejects.toThrow(
      /疑似半迁移|升级前预检失败/,
    );
    expect((await readTablesAndHistory()).history).toHaveLength(BASELINE_COUNT);

    // 模拟按操作说明从升级前备份恢复干净旧库。
    await buildBaseline();
    const restoredStatus = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(restoredStatus.issues).toEqual([]);

    const preUpgradeVerify = await runVerifyCommand(
      { ...options(), command: 'verify' },
      createCapturedLogger().logger,
    );
    expect(preUpgradeVerify.issues.join('\n')).toMatch(/迁移未完成/);

    const upgrade = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(upgrade.executed).toHaveLength(allMigrationClasses.length - BASELINE_COUNT);
    expect(upgrade.verification.issues).toEqual([]);

    const finalVerify = await runVerifyCommand(
      { ...options(), command: 'verify' },
      createCapturedLogger().logger,
    );
    expect(finalVerify.issues).toEqual([]);

    const secondRun = await runIncrementalMigration(options(), createCapturedLogger().logger);
    expect(secondRun.executed).toEqual([]);
  });

  it('E1：实际连接目标与声明不一致时在首条升级写入前拒绝', async () => {
    await buildBaseline();
    const before = await readTablesAndHistory();
    const beforeRows = await readLegacyRows();
    const instrumentation: Instrumentation[] = [];

    await expect(
      runIncrementalMigration(
        options(),
        createCapturedLogger().logger,
        controlledDependencies({ targetDatabase: 'lithography_other' }, instrumentation),
      ),
    ).rejects.toThrow(/实际连接库与声明不一致/);

    const after = await readTablesAndHistory();
    expect(after).toEqual(before);
    expect(await readLegacyRows()).toEqual(beforeRows);
    expect(after.tables).not.toContain('organization');
  });

  it('E2：DDL 完成后迁移历史写入失败，非 0 且现场可诊断', async () => {
    await buildBaseline();
    const instrumentation: Instrumentation[] = [];
    const captured = createCapturedLogger();
    const error = await runIncrementalMigration(
      options(),
      captured.logger,
      controlledDependencies({ historyInsert: 'before' }, instrumentation),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/injected-history-insert-failure-before-write/);
    const state = await readTablesAndHistory();
    expect(state.history).toHaveLength(BASELINE_COUNT);
    expect(state.tables).toContain('organization');
    expect(captured.lines.join('\n')).toMatch(/失败后只读现场/);

    const status = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(status.issues.join('\n')).toMatch(/疑似半迁移.*organization/);
    await expect(runIncrementalMigration(options(), createCapturedLogger().logger)).rejects.toThrow(
      /疑似半迁移|升级前预检失败/,
    );
  });

  it('E3：写入未落地与写入已落地但调用方收错按实际历史分别判定', async () => {
    await buildBaseline();
    const notLanded = await runIncrementalMigration(
      options(),
      createCapturedLogger().logger,
      controlledDependencies({ historyInsert: 'before' }, []),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((notLanded as Error).message).toMatch(/injected-history-insert-failure-before-write/);
    const notLandedState = await readTablesAndHistory();
    expect(notLandedState.history).toHaveLength(BASELINE_COUNT);
    expect(notLandedState.tables).toContain('organization');
    const notLandedStatus = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(notLandedStatus.issues.join('\n')).toMatch(/疑似半迁移.*organization/);

    await buildBaseline();
    const landed = await runIncrementalMigration(
      options(),
      createCapturedLogger().logger,
      controlledDependencies({ historyInsert: 'after' }, []),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((landed as Error).message).toMatch(/injected-history-insert-failure-after-write/);
    const landedState = await readTablesAndHistory();
    expect(landedState.history).toHaveLength(BASELINE_COUNT + 1);
    expect(landedState.tables).toContain('organization');

    const landedStatus = await runStatusCommand(
      { ...options(), command: 'status' },
      createCapturedLogger().logger,
    );
    expect(landedStatus.issues).toEqual([]);
    expect(landedStatus.pending).toHaveLength(allMigrationClasses.length - BASELINE_COUNT - 1);
    expect((await readTablesAndHistory()).history).toHaveLength(BASELINE_COUNT + 1);
  });
});
