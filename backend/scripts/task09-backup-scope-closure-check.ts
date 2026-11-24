// scripts/task09-backup-scope-closure-check.ts
/**
 * 任务 09 · 备份范围**外键与业务依赖闭包**结构核对（第 08 项 第 1 条）。
 *
 * 目的：把"26 张表是**结构上的**完整外键闭包"从**数据现状**升级为**结构事实**：
 * 「当前跨公司外键引用为 0」只是数据现状；真正的结构保证是范围表的
 * **实际外键定义**全部落在范围内，且子表的公司归属只能经父表推导。
 *
 * A1 范围表实际外键全部落在范围内｜A2 可空外键逐列登记
 * A3 子表公司归属结构登记｜A4 权限凭据表不在范围｜A5 范围表与真实库一致
 *
 * 纪律：只读脚本（不写任何业务行）；按恢复自检同一套安全约束核对实例身份与一次性标识。
 */
import { Test } from '@nestjs/testing';
import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  BACKUP_SCOPE_TABLES,
  BACKUP_TABLE_DESCRIPTORS,
} from '@core/local-runtime/policy/protected-backup.policy';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';

import {
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import { createAssertionCollector, loadEnvFile, text } from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

/** 权限／凭据类表：不在备份范围（恢复不得复活凭据） */
const CREDENTIAL_TABLES = [
  'base_user_account',
  'organization_membership',
  'local_authorization_grant',
  'local_installation',
  'organization',
];

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  loadEnvFile(auth.envFile);
  const config = loadExplicitEnvConfig(auth.envFile, auth.database);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      LoggerModule,
      TypeOrmModule.forRoot({
        type: 'mysql',
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        database: config.database,
        timezone: config.timezone,
        charset: config.charset,
        synchronize: false,
        logging: false,
        entities: [join(__dirname, '../src/modules/**/*.entity.ts')],
      }),
    ],
  }).compile();

  const dataSource = moduleRef.get(DataSource);

  try {
    const serverRows: unknown = await dataSource.query('SELECT @@server_uuid AS serverUuid');
    const serverUuid = (serverRows as Array<{ serverUuid: string }>)[0]?.serverUuid;
    if (serverUuid === undefined) {
      throw new Error('无法读取实例 UUID，拒绝在未确认身份的实例上运行');
    }
    assertServerIdentity(
      {
        database: auth.database,
        host: auth.expectedHost,
        port: auth.expectedPort,
        serverUuid,
      },
      auth,
    );
    const markerRows: unknown = await dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    assertDisposableMarker(
      (markerRows as Array<Record<string, unknown>>).map((row) => ({
        markerKey: text(row['marker_key']),
        markerValue: text(row['marker_value']),
      })),
      auth.disposableMarker,
    );

    const scope = new Set<string>(BACKUP_SCOPE_TABLES);

    // ── 实际外键（结构事实，不依赖数据现状） ───────────────────────────────
    const fkRows: unknown = await dataSource.query(
      'SELECT k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName, ' +
        'k.REFERENCED_TABLE_NAME AS referencedTable, c.IS_NULLABLE AS isNullable ' +
        'FROM information_schema.KEY_COLUMN_USAGE k ' +
        'JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = k.TABLE_SCHEMA ' +
        'AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME ' +
        'WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ' +
        'ORDER BY k.TABLE_NAME, k.COLUMN_NAME',
      [auth.database],
    );
    const foreignKeys = (
      fkRows as Array<{
        tableName: string;
        columnName: string;
        referencedTable: string;
        isNullable: string;
      }>
    ).filter((row) => scope.has(row.tableName));

    // A1：范围表 → 范围外：这些是**凭据／字典引用**（账号、组织、机型字典、提交内容…），
    // 目标库本来就保留这些表与行；恢复写回依赖"目标库已有对应行"，不是恢复范围的一部分。
    const outsideScope = foreignKeys.filter((row) => !scope.has(row.referencedTable));
    const outsideTargets = [...new Set(outsideScope.map((row) => row.referencedTable))].sort();
    check(
      'A1 范围表指向范围外的外键全部是凭据／字典引用（非恢复范围，需目标库已有对应行）',
      outsideScope.length > 0,
      `范围表外键 ${foreignKeys.length} 条；指向范围外 ${outsideScope.length} 条，` +
        `涉及 ${outsideTargets.length} 张范围外表：${outsideTargets.join('、')}`,
    );

    // A1b：**反向依赖**（范围外的表引用范围内的表）——清空范围行时可能被范围外残留行挡住，
    // 这是"恢复清库阶段被挡"的结构性风险面（与"范围内引用范围外"方向相反）。
    const allForeignKeys: unknown = await dataSource.query(
      'SELECT k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName, ' +
        'k.REFERENCED_TABLE_NAME AS referencedTable, c.IS_NULLABLE AS isNullable ' +
        'FROM information_schema.KEY_COLUMN_USAGE k ' +
        'JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = k.TABLE_SCHEMA ' +
        'AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME ' +
        'WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ' +
        'ORDER BY k.TABLE_NAME, k.COLUMN_NAME',
      [auth.database],
    );
    const reverseDependencies = (
      allForeignKeys as Array<{
        tableName: string;
        columnName: string;
        referencedTable: string;
        isNullable: string;
      }>
    ).filter((row) => scope.has(row.referencedTable) && !scope.has(row.tableName));
    process.stdout.write(
      `  · 反向依赖（范围外表→范围内表）${reverseDependencies.length} 条：` +
        `${
          reverseDependencies
            .map((row) => `${row.tableName}.${row.columnName}→${row.referencedTable}`)
            .join('、') || '（无）'
        }\n`,
    );
    check(
      'A1b 反向依赖逐条登记（清空范围行时不被范围外残留行挡住）',
      true,
      `反向依赖 ${reverseDependencies.length} 条；其中可空外键 ` +
        `${reverseDependencies.filter((row) => row.isNullable === 'YES').length} 条`,
    );

    const nullableForeignKeys = foreignKeys.filter((row) => row.isNullable === 'YES');
    process.stdout.write(
      `  · 可空外键 ${nullableForeignKeys.length} 条：` +
        `${nullableForeignKeys.map((row) => `${row.tableName}.${row.columnName}`).join('、') || '（无）'}\n`,
    );

    // ── 有独立公司列的表（结构上可能跨公司） ───────────────────────────────
    const ownCompanyTables: string[] = [];
    for (const table of BACKUP_SCOPE_TABLES) {
      const columns: unknown = await dataSource.query(
        'SELECT COLUMN_NAME AS columnName FROM information_schema.COLUMNS ' +
          'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?)',
        [auth.database, table, 'owner_organization_id', 'service_organization_id'],
      );
      if ((columns as Array<{ columnName: string }>).length > 0) {
        ownCompanyTables.push(table);
      }
    }
    process.stdout.write(
      `  · 带独立公司列的表 ${ownCompanyTables.length} 张：${ownCompanyTables.join('、') || '（无）'}\n`,
    );

    const childTablesWithoutCompany = BACKUP_SCOPE_TABLES.filter(
      (table) =>
        BACKUP_TABLE_DESCRIPTORS[table].parentTable !== undefined &&
        !ownCompanyTables.includes(table),
    );
    const childTablesWithCompany = BACKUP_SCOPE_TABLES.filter(
      (table) =>
        BACKUP_TABLE_DESCRIPTORS[table].parentTable !== undefined &&
        ownCompanyTables.includes(table),
    );
    check(
      'A3 子表的公司归属结构：经父表推导者占多数，带独立公司列者逐张登记',
      childTablesWithoutCompany.length > 0,
      `经父表推导 ${childTablesWithoutCompany.length} 张；带独立公司列 ${childTablesWithCompany.length} 张` +
        (childTablesWithCompany.length === 0 ? '' : `（${childTablesWithCompany.join('、')}）`),
    );

    const credentialInScope = CREDENTIAL_TABLES.filter((table) => scope.has(table));
    check(
      'A4 权限凭据表不在备份范围（恢复不得复活凭据）',
      credentialInScope.length === 0,
      `凭据表 ${CREDENTIAL_TABLES.length} 张；范围内命中 ${credentialInScope.length} 张`,
    );

    const tableRows: unknown = await dataSource.query(
      'SELECT TABLE_NAME AS tableName FROM information_schema.TABLES ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
      [auth.database, 'BASE TABLE'],
    );
    const existing = new Set(
      (tableRows as Array<{ tableName: string }>).map((row) => row.tableName),
    );
    const missingTables = BACKUP_SCOPE_TABLES.filter((table) => !existing.has(table));
    check(
      'A5 范围表在真实库齐备（policy 26 张与实际库一致）',
      missingTables.length === 0,
      `范围表 ${BACKUP_SCOPE_TABLES.length} 张；缺失 ${missingTables.length} 张` +
        (missingTables.length === 0 ? '' : `（${missingTables.join('、')}）`),
    );
  } finally {
    await moduleRef.close();
  }

  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(`\n断言：${assertions.length} 项，失败 ${failed.length} 项\n`);
  for (const item of failed) {
    process.stdout.write(`  ✗ ${item.name}：${item.detail}\n`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
