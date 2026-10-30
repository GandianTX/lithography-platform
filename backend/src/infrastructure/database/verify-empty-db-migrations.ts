// src/infrastructure/database/verify-empty-db-migrations.ts
import 'reflect-metadata';
import 'tsconfig-paths/register';

import databaseConfig from '@src/infrastructure/config/database.config';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  assertRequiredChecks,
  assertRequiredColumns,
  assertRequiredForeignKeys,
  assertRequiredIndexes,
  assertRequiredTables,
  hasQueryResult,
  isQueryRows,
  resolveMigrationName,
  toMigrationClasses,
} from './migration-schema-contract';

type MysqlDataSourceOptions = Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }>;

interface MysqlConnectionConfig {
  type: 'mysql';
  host: string;
  port: number;
  username: string;
  password?: string;
  database?: string;
  timezone?: string;
  charset?: string;
  extra?: Record<string, unknown>;
}

interface DrillDatabaseTarget {
  readonly databaseName: string;
  readonly shouldCreate: boolean;
  readonly shouldDrop: boolean;
}

/**
 * 输出标准信息日志。
 */
function writeInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * 输出标准错误日志。
 */
function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * 加载 Migration 演练所需环境变量。
 */
function loadMigrationDrillEnv(): void {
  const candidates = [
    process.env.MIGRATION_DRILL_DOTENV
      ? path.resolve(process.cwd(), process.env.MIGRATION_DRILL_DOTENV)
      : null,
    path.resolve(process.cwd(), 'env/.env.e2e'),
    path.resolve(process.cwd(), 'env/.ev.e2e'),
    path.resolve(process.cwd(), 'env/.env.development'),
    path.resolve(process.cwd(), 'env/.ev.development'),
  ].filter((item): item is string => item !== null);

  const envFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (envFile) {
    dotenv.config({ path: envFile });
    writeInfo(`🌱 已加载环境文件: ${envFile}`);
  } else {
    writeInfo('🌱 未找到环境文件，使用当前进程环境变量');
  }
}

/**
 * 解析演练数据库目标。
 */
function resolveDrillDatabaseTarget(mysqlConfig: MysqlConnectionConfig): DrillDatabaseTarget {
  const configuredDatabase = process.env.MIGRATION_DRILL_DATABASE?.trim();
  if (configuredDatabase) {
    return {
      databaseName: configuredDatabase,
      shouldCreate: false,
      shouldDrop: false,
    };
  }

  if (process.env.MIGRATION_DRILL_CREATE_TEMP_DB === 'true') {
    const dbPrefix = (mysqlConfig.database ?? 'worker_backend').replace(/[^a-zA-Z0-9_]/g, '_');
    return {
      databaseName: `${dbPrefix}_baseline_drill_${Date.now()}`,
      shouldCreate: true,
      shouldDrop: true,
    };
  }

  const configuredAppDatabase = mysqlConfig.database?.trim();
  if (configuredAppDatabase) {
    return {
      databaseName: configuredAppDatabase,
      shouldCreate: false,
      shouldDrop: false,
    };
  }

  throw new Error(
    '未指定演练数据库，请设置 DB_NAME 或 MIGRATION_DRILL_DATABASE；如确需临时建库，请设置 MIGRATION_DRILL_CREATE_TEMP_DB=true',
  );
}

/**
 * 读取并校验 MySQL 连接配置。
 */
function loadMysqlConfig(): MysqlConnectionConfig {
  const config = databaseConfig() as { mysql: MysqlConnectionConfig };
  const mysql = config.mysql;

  if (!mysql?.host || !mysql.port || !mysql.username) {
    throw new Error('数据库配置不完整，至少需要 DB_HOST/DB_PORT/DB_USER');
  }

  return mysql;
}

/**
 * 对数据库标识符进行安全转义。
 */
function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

/**
 * 构建用于管理库操作（创建/删除数据库）的连接配置。
 */
function buildAdminDataSourceOptions(config: MysqlConnectionConfig): MysqlDataSourceOptions {
  return {
    type: 'mysql',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    timezone: config.timezone,
    charset: config.charset,
    logging: false,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    extra: config.extra,
  };
}

/**
 * 构建用于执行 migration 的空库连接配置。
 */
function buildMigrationDataSourceOptions(
  config: MysqlConnectionConfig,
  databaseName: string,
  migrations?: ReadonlyArray<new () => unknown>,
): MysqlDataSourceOptions {
  const options: MysqlDataSourceOptions = {
    ...buildAdminDataSourceOptions(config),
    database: databaseName,
    migrations: migrations
      ? (migrations as unknown as MysqlDataSourceOptions['migrations'])
      : [
          path.resolve(__dirname, './migrations/*.migration.ts'),
          path.resolve(__dirname, './migrations/*.migration.js'),
        ],
  };

  return options;
}

/**
 * 校验目标数据库名称，避免误操作生产库。
 */
function ensureSafeDatabaseTarget(databaseName: string): void {
  const isExplicitlyAllowed = process.env.MIGRATION_DRILL_ALLOW_NON_TEST_DB === 'true';
  const lower = databaseName.toLowerCase();
  const looksSafe = lower.includes('test') || lower.includes('drill') || lower.includes('ci');

  if (!looksSafe && !isExplicitlyAllowed) {
    throw new Error(
      `数据库名 ${databaseName} 未包含 test/drill/ci，已拒绝执行。若确认安全请设置 MIGRATION_DRILL_ALLOW_NON_TEST_DB=true`,
    );
  }
}

/**
 * 清空目标数据库中的全部表，确保 migration 在空库语义下执行。
 */
async function clearDatabaseTables(dataSource: DataSource, databaseName: string): Promise<void> {
  const rows: unknown = await dataSource.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
    `,
    [databaseName],
  );

  if (!isQueryRows(rows)) {
    throw new Error('读取数据库表清单失败，返回格式异常');
  }

  if (rows.length === 0) {
    return;
  }

  await dataSource.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const row of rows) {
      const tableNameCandidate = row['table_name'] ?? row['TABLE_NAME'];
      const tableNameValue =
        typeof tableNameCandidate === 'string' ? tableNameCandidate : String(tableNameCandidate);
      if (typeof tableNameValue !== 'string' || tableNameValue.length === 0) {
        throw new Error('读取到非法表名，无法继续清库');
      }
      await dataSource.query(`DROP TABLE IF EXISTS ${escapeIdentifier(tableNameValue)}`);
    }
  } finally {
    await dataSource.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/**
 * 解析旧库升级演练基线数量（T02，可重跑）。
 * 未设置或非正整数时返回 null，表示执行常规空库演练。
 */
function parseBaselineCount(total: number): number | null {
  const raw = process.env.MIGRATION_DRILL_BASELINE_COUNT?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MIGRATION_DRILL_BASELINE_COUNT 必须为正整数，实际: ${raw}`);
  }
  if (parsed >= total) {
    throw new Error(`基线数量 ${parsed} 必须小于迁移总数 ${total}`);
  }
  return parsed;
}

/**
 * 在旧基线库上写入旧表旧列可用的 fixture，模拟旧库数据。
 *
 * 基线可能早于也可能晚于「给 reference_document 补组织归属列」的迁移：
 * 早于时按旧列形态写入，由后续迁移回填；晚于时新列已收紧为 NOT NULL，
 * 必须显式写入归属组织与入库方式（不能让 fixture 依赖“该迁移尚未执行”）。
 */
async function insertLegacyUpgradeFixtures(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `INSERT INTO \`equipment_model\` (\`id\`, \`model_code\`, \`model_name\`, \`enabled\`, \`sort_order\`) VALUES (900001, 'T02-LEGACY-MODEL', 'T02 旧机型', 1, 1)`,
  );
  await dataSource.query(
    `INSERT INTO \`base_user_account\` (\`id\`, \`login_name\`, \`login_password\`, \`status\`) VALUES (900001, 't02_legacy_user', 'legacy-password-hash', 'ACTIVE')`,
  );

  const legacyDocumentHasOrganizationColumns = await hasQueryResult(
    dataSource,
    `
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'reference_document'
        AND column_name = 'owner_organization_id'
      LIMIT 1
    `,
    [],
  );

  if (!legacyDocumentHasOrganizationColumns) {
    await dataSource.query(
      `INSERT INTO \`reference_document\` (\`id\`, \`title\`, \`document_type\`, \`equipment_model_id\`, \`content_text\`, \`created_by_account_id\`, \`deprecated\`, \`deleted_at\`) VALUES (900001, 'T02 旧资料', 'MANUAL', 900001, 'T02 旧库升级基线内容', 900001, 0, NULL)`,
    );
    return;
  }

  await dataSource.query(
    `INSERT IGNORE INTO \`organization\` (\`organization_code\`, \`name\`, \`kind\`, \`status\`) VALUES ('CLIENT_DEFAULT', '甲方默认组织', 'CLIENT', 'ACTIVE')`,
  );
  const ownerRows: unknown = await dataSource.query(
    `SELECT \`id\` FROM \`organization\` WHERE \`organization_code\` = 'CLIENT_DEFAULT' LIMIT 1`,
  );
  if (!isQueryRows(ownerRows) || ownerRows.length === 0) {
    throw new Error('旧基线已含组织归属列，但无法解析 CLIENT_DEFAULT 组织');
  }
  const ownerId = Number(ownerRows[0]['id'] ?? ownerRows[0]['ID']);
  await dataSource.query(
    `INSERT INTO \`reference_document\` (\`id\`, \`title\`, \`document_type\`, \`equipment_model_id\`, \`content_text\`, \`created_by_account_id\`, \`deprecated\`, \`deleted_at\`, \`owner_organization_id\`, \`ingest_method\`) VALUES (900001, 'T02 旧资料', 'MANUAL', 900001, 'T02 旧库升级基线内容', 900001, 0, NULL, ?, 'ADMIN_DIRECT')`,
    [ownerId],
  );
}

/**
 * 校验迁移记录条数与新增迁移均已执行。
 */
async function assertMigrationsTableCount(
  dataSource: DataSource,
  databaseName: string,
  expected: number,
  expectedNewNames: ReadonlyArray<string>,
): Promise<void> {
  const rows: unknown = await dataSource.query(
    `SELECT COUNT(*) AS total FROM \`${databaseName}\`.\`migrations\``,
  );
  if (!isQueryRows(rows) || rows.length === 0) {
    throw new Error('读取 migrations 记录失败，返回格式异常');
  }
  const rawTotal = rows[0]['total'] ?? rows[0]['TOTAL'];
  const total = Number(rawTotal);
  if (total !== expected) {
    throw new Error(`migrations 记录数不符：预期 ${expected}，实际 ${String(rawTotal)}`);
  }

  for (const name of expectedNewNames) {
    const exists = await hasQueryResult(
      dataSource,
      `SELECT 1 FROM \`${databaseName}\`.\`migrations\` WHERE \`name\` = ? LIMIT 1`,
      [name],
    );
    if (!exists) {
      throw new Error(`新增迁移未记录: ${name}`);
    }
  }
}

/**
 * 校验旧库 fixture 在升级后保留且归属/入库方式已回填。
 */
async function assertLegacyUpgradeFixtures(dataSource: DataSource): Promise<void> {
  const equipmentRows: unknown = await dataSource.query(
    `SELECT \`model_code\` FROM \`equipment_model\` WHERE \`id\` = 900001 LIMIT 1`,
  );
  if (!isQueryRows(equipmentRows) || equipmentRows.length === 0) {
    throw new Error('旧库 fixture 丢失: equipment_model 900001 不存在（旧表数据未保留）');
  }

  const accountRows: unknown = await dataSource.query(
    `SELECT \`login_name\` FROM \`base_user_account\` WHERE \`id\` = 900001 LIMIT 1`,
  );
  if (!isQueryRows(accountRows) || accountRows.length === 0) {
    throw new Error('旧库 fixture 丢失: base_user_account 900001 不存在（旧表数据未保留）');
  }

  const documentRows: unknown = await dataSource.query(
    `SELECT \`owner_organization_id\`, \`ingest_method\`, \`schema_version\` FROM \`reference_document\` WHERE \`id\` = 900001 LIMIT 1`,
  );
  if (!isQueryRows(documentRows) || documentRows.length === 0) {
    throw new Error('旧库 fixture 丢失: reference_document 900001 不存在（旧资料未保留）');
  }
  const doc = documentRows[0];
  const ingestMethod = doc['ingest_method'] ?? doc['INGEST_METHOD'];
  if (ingestMethod !== 'ADMIN_DIRECT') {
    throw new Error(`旧资料入库方式回填错误：预期 ADMIN_DIRECT，实际 ${String(ingestMethod)}`);
  }
  const ownerValue = doc['owner_organization_id'] ?? doc['OWNER_ORGANIZATION_ID'];
  const ownerRows: unknown = await dataSource.query(
    `SELECT \`id\` FROM \`organization\` WHERE \`organization_code\` = 'CLIENT_DEFAULT' LIMIT 1`,
  );
  if (!isQueryRows(ownerRows) || ownerRows.length === 0) {
    throw new Error('回填目标组织 CLIENT_DEFAULT 不存在');
  }
  const expectedOwner = ownerRows[0]['id'] ?? ownerRows[0]['ID'];
  if (Number(ownerValue) !== Number(expectedOwner)) {
    throw new Error(
      `旧资料归属回填错误：预期组织 ${String(expectedOwner)}，实际 ${String(ownerValue)}`,
    );
  }
}

/**
 * 执行旧库升级演练（T02 可重跑版）：旧基线迁移 + 旧 fixture → 只执行新增迁移。
 */
async function runUpgradeMigrationDrill(
  migrationDataSource: DataSource,
  allMigrations: ReadonlyArray<new () => unknown>,
  mysqlConfig: MysqlConnectionConfig,
  databaseName: string,
  baselineCount: number,
): Promise<number> {
  const total = allMigrations.length;
  const expectedUpgrade = total - baselineCount;
  writeInfo(
    `🧱 旧库升级演练：旧基线 ${baselineCount} 条 + 新增 ${expectedUpgrade} 条（共 ${total} 条）`,
  );

  await clearDatabaseTables(migrationDataSource, databaseName);
  writeInfo('🧽 目标数据库已清空（模拟旧库前置）');

  const baselineDataSource = new DataSource(
    buildMigrationDataSourceOptions(
      mysqlConfig,
      databaseName,
      allMigrations.slice(0, baselineCount),
    ),
  );
  await baselineDataSource.initialize();
  let baselineExecuted: ReadonlyArray<unknown>;
  try {
    baselineExecuted = await baselineDataSource.runMigrations({ transaction: 'all' });
  } finally {
    await baselineDataSource.destroy();
  }
  if (baselineExecuted.length !== baselineCount) {
    throw new Error(`旧基线迁移数量不符：预期 ${baselineCount}，实际 ${baselineExecuted.length}`);
  }
  writeInfo(`✅ 旧基线迁移执行 ${baselineExecuted.length} 条`);

  await insertLegacyUpgradeFixtures(migrationDataSource);
  writeInfo('🗂️ 已写入旧库 fixture（旧表旧列可用）');

  const upgradeDataSource = new DataSource(
    buildMigrationDataSourceOptions(mysqlConfig, databaseName, allMigrations),
  );
  await upgradeDataSource.initialize();
  let upgradeExecuted: ReadonlyArray<unknown>;
  let secondRunCount: number;
  try {
    upgradeExecuted = await upgradeDataSource.runMigrations({ transaction: 'all' });
    if (upgradeExecuted.length !== expectedUpgrade) {
      throw new Error(
        `升级仅应执行新增 ${expectedUpgrade} 条，实际 ${upgradeExecuted.length} 条（旧迁移被重跑）`,
      );
    }
    await assertMigrationsTableCount(
      upgradeDataSource,
      databaseName,
      total,
      allMigrations.slice(baselineCount).map(resolveMigrationName),
    );
    await assertLegacyUpgradeFixtures(upgradeDataSource);

    const secondRun = await upgradeDataSource.runMigrations({ transaction: 'all' });
    if (secondRun.length !== 0) {
      throw new Error(`升级后再次执行应为 0 条，实际 ${secondRun.length} 条`);
    }
    secondRunCount = secondRun.length;
  } finally {
    await upgradeDataSource.destroy();
  }
  writeInfo(`✅ 升级只执行新增迁移 ${upgradeExecuted.length} 条，旧迁移无重跑`);
  writeInfo(
    `✅ 旧库 fixture 保留且归属/入库方式回填正确；升级后幂等（再次执行 ${secondRunCount} 条）`,
  );

  return total;
}

/**
 * 执行空库 migration 演练，失败时抛错以阻断 CI。
 */
async function runEmptyDbMigrationDrill(): Promise<void> {
  loadMigrationDrillEnv();
  const mysqlConfig = loadMysqlConfig();
  const target = resolveDrillDatabaseTarget(mysqlConfig);
  ensureSafeDatabaseTarget(target.databaseName);

  const adminDataSource = new DataSource(buildAdminDataSourceOptions(mysqlConfig));
  const migrationDataSource = new DataSource(
    buildMigrationDataSourceOptions(mysqlConfig, target.databaseName),
  );

  let adminInitialized = false;
  let migrationInitialized = false;

  try {
    writeInfo('🔧 开始空库 migration 演练...');
    await adminDataSource.initialize();
    adminInitialized = true;

    if (target.shouldCreate) {
      try {
        await adminDataSource.query(
          `CREATE DATABASE ${escapeIdentifier(target.databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        writeInfo(`🆕 已创建空库: ${target.databaseName}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '未知建库错误';
        throw new Error(
          `自动建库失败，请为当前账号授予 CREATE/DROP DATABASE 权限，或设置 MIGRATION_DRILL_DATABASE 使用预置空库。原始错误: ${message}`,
          {
            cause: error,
          },
        );
      }
    } else {
      writeInfo(`📌 使用指定演练库: ${target.databaseName}`);
    }

    try {
      await migrationDataSource.initialize();
      migrationInitialized = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '未知连接错误';
      throw new Error(
        `连接演练库失败，请确认账号对 ${target.databaseName} 具备访问与建表权限，或改用 MIGRATION_DRILL_DATABASE。原始错误: ${message}`,
        {
          cause: error,
        },
      );
    }
    const allMigrations = toMigrationClasses(migrationDataSource.migrations);
    const baselineCount = parseBaselineCount(allMigrations.length);
    if (baselineCount === null) {
      await clearDatabaseTables(migrationDataSource, target.databaseName);
      writeInfo('🧽 目标数据库已清空');

      const executedMigrations = await migrationDataSource.runMigrations({ transaction: 'all' });
      if (executedMigrations.length === 0) {
        throw new Error('未执行任何 migration，请检查 migration 配置');
      }
      writeInfo(`✅ migration 执行成功，共 ${executedMigrations.length} 条`);
    } else {
      await runUpgradeMigrationDrill(
        migrationDataSource,
        allMigrations,
        mysqlConfig,
        target.databaseName,
        baselineCount,
      );
    }

    await assertRequiredTables(migrationDataSource, target.databaseName);
    await assertRequiredColumns(migrationDataSource, target.databaseName);
    await assertRequiredIndexes(migrationDataSource, target.databaseName);
    await assertRequiredChecks(migrationDataSource, target.databaseName);
    await assertRequiredForeignKeys(migrationDataSource, target.databaseName);
    writeInfo('✅ 关键表、字段、索引、CHECK 与外键校验通过');
    writeInfo(baselineCount === null ? '🎉 空库 migration 演练通过' : '🎉 旧库升级演练通过');
  } finally {
    if (migrationInitialized) {
      await migrationDataSource.destroy();
    }
    if (adminInitialized && target.shouldDrop) {
      try {
        await adminDataSource.query(
          `DROP DATABASE IF EXISTS ${escapeIdentifier(target.databaseName)}`,
        );
        writeInfo(`🧹 已清理临时数据库: ${target.databaseName}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '未知清理错误';
        writeError(`⚠️ 临时数据库清理失败: ${message}`);
      }
    }
    if (adminInitialized) {
      await adminDataSource.destroy();
    }
  }
}

void runEmptyDbMigrationDrill().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '未知错误';
  writeError(`❌ 空库 migration 演练失败: ${message}`);
  process.exit(1);
});
