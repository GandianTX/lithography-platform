// scripts/task09-identity-counterexample-matrix.ts
/**
 * 任务 09 · **跨安装身份反例矩阵**取证脚本（G29）。
 *
 * 目的：把"跨安装时来源账号身份的口径"从**单元测试**推进到**一次性隔离双库**
 * 上的真实副作用取证。矩阵覆盖 8 个反例/正例变体：
 *
 * | 变体 | 本机（目标机 B）事实 | 期望裁决 |
 * | --- | --- | --- |
 * | V1 同人不同号 | `account_uuid` 命中（数字 id 不同） | 放行，且作者落**本机** id |
 * | V2 同号不同人（账号名相同） | 数字 id 与包内相同、uuid 不同、账号名相同、姓名不同 | 拒绝（姓名快照交叉核对失败） |
 * | V3 同号不同人（账号名也不同） | 数字 id 与包内相同、uuid 与账号名均不同 | 拒绝（本机不存在可核验来源账号） |
 * | V4 来源账号已停用 | uuid 命中但 `status=SUSPENDED` | 拒绝（账号已停用） |
 * | V5 来源账号资料已停用 | uuid 命中但 `user_state=INACTIVE` | 拒绝（资料已停用） |
 * | V6 来源账号已离职 | uuid 命中但成员关系 `LEFT` | 拒绝（已离开本公司） |
 * | V7 来源账号换了公司 | uuid 命中但成员关系在**另一公司** | 拒绝（不是本公司的在职成员） |
 * | V8 包内无可移植身份 | 包内既无 uuid 也无账号名 | 拒绝（不以导入人冒充原作者） |
 *
 * 核心价值：**证明"绝不按包内数字 id 选作者"**。V2／V3 的目标机账号 id
 * 与包内 `source_account_id` **完全相同**，只要实现按数字 id 落作者，
 * 源机工程师的报告就会被记到目标机**另一个人**名下；本脚本对此断言
 * "目标机没有出现该 record_uuid 的报告"（错归属即失败）。
 *
 * 同时防"导出侧退化"：若导出不再携带 `source_account_uuid`／`login_name`，
 * V1 会失败（不会静默变成 V8 那样"看起来正确"），矩阵另有清单字段断言兜底。
 *
 * 纪律（与恢复自检同一套边界）：
 * - **默认拒绝**：来源库与目标库各自必须显式给出一次性库、预期实例身份、
 *   一次性库标识、受控文件根、安装／公司标识与测试授权；缺一即零写入退出；
 * - 只写**本轮创建的夹具**（账号 id 段 902xxx），收尾按精确清单删除；
 * - 两端**必须是不同的库**（同一库自导自导没有反例意义）且**存储根不同**；
 * - 反例与正例**都取证**：正例（V1）必须放行且落本机 id，否则矩阵无意义。
 *
 * 用法（两套授权都要给）：
 *   TASK09_RESTORE_ENV_FILE=.local/task09/iso-b.env \
 *   TASK09_RESTORE_DATABASE=lithography_task09_isolated_test_b \
 *   TASK09_RESTORE_EXPECTED_HOST=127.0.0.1 TASK09_RESTORE_EXPECTED_PORT=33307 \
 *   TASK09_RESTORE_EXPECTED_SERVER_UUID=<@@server_uuid> \
 *   TASK09_RESTORE_DISPOSABLE_MARKER=<B 库标识值> \
 *   TASK09_RESTORE_FILE_ROOT=<B 受控文件根> \
 *   TASK09_RESTORE_INSTALLATION_ID=<B installation_id> \
 *   TASK09_RESTORE_ORGANIZATION_ID=1 \
 *   TASK09_RESTORE_TEST_AUTHORIZATION=TASK09-RESTORE-SELFCHECK-ISOLATED-RUN \
 *   TASK09_IDENTITY_SOURCE_ENV_FILE=.local/task09/iso-a.env \
 *   TASK09_IDENTITY_SOURCE_DATABASE=lithography_task09_isolated_a \
 *   TASK09_IDENTITY_SOURCE_EXPECTED_HOST=127.0.0.1 TASK09_IDENTITY_SOURCE_EXPECTED_PORT=33307 \
 *   TASK09_IDENTITY_SOURCE_EXPECTED_SERVER_UUID=<@@server_uuid> \
 *   TASK09_IDENTITY_SOURCE_DISPOSABLE_MARKER=<A 库标识值> \
 *   TASK09_IDENTITY_SOURCE_FILE_ROOT=<A 受控文件根> \
 *   TASK09_IDENTITY_SOURCE_INSTALLATION_ID=<A installation_id> \
 *   TASK09_IDENTITY_SOURCE_ORGANIZATION_ID=1 \
 *   TASK09_IDENTITY_SOURCE_TEST_AUTHORIZATION=TASK09-RESTORE-SELFCHECK-ISOLATED-RUN \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-identity-counterexample-matrix.ts
 */

// 脚本属**受控 wiring**（同 scripts/task09-restore-selfcheck.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { TypeOrmModule } from '@nestjs/typeorm';
import { parse as parseDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalReferenceDocumentStorageModule } from '@src/infrastructure/file-storage/local-reference-document-storage.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { MaintenanceReportEntity } from '@src/modules/lithography/entities/maintenance-report.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { CheckRecordPackageUsecase } from '@src/usecases/local-runtime/check-record-package.usecase';
import { ExportRecordPackageUsecase } from '@src/usecases/local-runtime/export-record-package.usecase';
import { ImportRecordPackageUsecase } from '@src/usecases/local-runtime/import-record-package.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { MaintenanceReportUsecasesModule } from '@src/usecases/maintenance-report/maintenance-report-usecases.module';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@usecases/common/ports/transaction-runner.contract';

import {
  MaintenanceReportChangeKind,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
} from '@app-types/models/maintenance-report.types';

import {
  assertDisposableMarker,
  assertServerIdentity,
  DISPOSABLE_MARKER_TABLE,
  readSelfcheckAuthorization,
  type SelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';

/** 断言条目 */
type Assertion = { name: string; passed: boolean; detail: string };

const assertions: Assertion[] = [];

function check(name: string, passed: boolean, detail: string): void {
  assertions.push({ name, passed, detail });
}

/** 数据库行取值统一转文本（不用 String(unknown)：那会退化成默认字符串化） */
function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value) ?? '';
}

/** 目标公司（seed 的确定性组织编码）与同行组织（"换公司"反例用） */
const TARGET_ORGANIZATION_CODE = 'CLIENT_DEFAULT';
const PEER_ORGANIZATION_CODE = 'PEER_ALT';

/** 本轮夹具账号 id 段（与既有 seed 账号 900xxx／979xxx 不冲突） */
const SOURCE_ACCOUNT_ID_BASE = 902_001;
const IMPORTER_ACCOUNT_ID = 902_099;

/** 导入者：二级管理员（admin_level=2，按本公司范围可导入同公司他人记录） */
const IMPORTER_LOGIN_NAME = 'task09_iso_admin_l2';

type DeviceContext = {
  dataSource: DataSource;
  exportUsecase: ExportRecordPackageUsecase;
  checkUsecase: CheckRecordPackageUsecase;
  importUsecase: ImportRecordPackageUsecase;
  maintenanceReportService: MaintenanceReportService;
  transactionRunner: TransactionRunner;
};

/** 读取环境文件到 process.env（受控 wiring） */
function loadEnvFile(envFile: string): void {
  const parsed: Record<string, string> = parseDotenv(readFileSync(envFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
}

/** 装配一台"设备"（独立库、独立文件根） */
async function bootstrapDevice(envFile: string, database: string): Promise<DeviceContext> {
  loadEnvFile(envFile);
  const config = loadExplicitEnvConfig(envFile, database);

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
      TypeOrmTransactionModule,
      LocalReferenceDocumentStorageModule,
      LocalRuntimeStorageModule,
      LocalRuntimeUsecasesModule,
      MaintenanceReportUsecasesModule,
    ],
  }).compile();

  return {
    dataSource: moduleRef.get(DataSource),
    exportUsecase: moduleRef.get(ExportRecordPackageUsecase),
    checkUsecase: moduleRef.get(CheckRecordPackageUsecase),
    importUsecase: moduleRef.get(ImportRecordPackageUsecase),
    maintenanceReportService: moduleRef.get(MaintenanceReportService),
    transactionRunner: moduleRef.get<TransactionRunner>(TRANSACTION_RUNNER),
  };
}

/** 工程师会话（公司范围由本机成员关系复核，不自报公司） */
function engineerSession(accountId: number): UsecaseSession {
  return {
    accountId,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
    adminLevel: null,
    customerOrganizationId: null,
  } as unknown as UsecaseSession;
}

/** 二级管理员会话（等级由服务端查库复核） */
function secondLevelAdminSession(accountId: number): UsecaseSession {
  return {
    accountId,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: null,
    customerOrganizationId: null,
  } as unknown as UsecaseSession;
}

type AccountFixture = {
  accountId: number;
  loginName: string | null;
  accountUuid: string | null;
  realName: string | null;
  accountStatus: string;
  userState: string;
  adminLevel: number | null;
};

/** 建账号夹具（原生 SQL：显式 id／uuid／状态，避免 ORM 对生成列的默认值干扰） */
async function insertAccount(
  device: DeviceContext,
  fixture: AccountFixture,
  membership: { organizationId: number; memberRole: string; status: 'ACTIVE' | 'LEFT' } | null,
): Promise<void> {
  await device.dataSource.query(
    `INSERT INTO base_user_account
       (id, login_name, login_email, account_uuid, login_password, status, identity_hint,
        admin_level, must_change_password, credential_version, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, NOW(3), NOW(3))`,
    [
      fixture.accountId,
      fixture.loginName,
      fixture.accountUuid,
      'task09-isolated-fixture',
      fixture.accountStatus,
      fixture.adminLevel === null ? 'ENGINEER' : 'SUPER_ADMIN',
      fixture.adminLevel,
    ],
  );
  await device.dataSource.query(
    `INSERT INTO base_user_info
       (account_id, nickname, real_name, customer_organization_id, company_name, gender,
        user_state, access_group, notify_count, unread_count, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 'SECRET', ?, JSON_ARRAY('ENGINEER'), 0, 0, NOW(3), NOW(3))`,
    [fixture.accountId, fixture.realName ?? '任务09 夹具', fixture.realName, fixture.userState],
  );
  if (membership !== null) {
    await device.dataSource.query(
      `INSERT INTO organization_membership
         (organization_id, account_id, member_role, status, joined_at, left_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(3), ?, NOW(3), NOW(3))`,
      [
        membership.organizationId,
        fixture.accountId,
        membership.memberRole,
        membership.status,
        membership.status === 'LEFT' ? new Date('2026-11-01T00:00:00.000Z') : null,
      ],
    );
  }
}

/** 按确定性组织编码读取公司 id（不猜 id） */
async function resolveOrganizationId(device: DeviceContext, code: string): Promise<number> {
  const organization = await device.dataSource
    .getRepository(OrganizationEntity)
    .findOne({ where: { organizationCode: code } });
  if (organization === null) {
    throw new Error(`本机缺少组织编码 ${code}`);
  }
  return organization.id;
}

/** 包内清单身份字段（用于证明导出侧没有退化） */
type ManifestIdentity = {
  source_account_id?: number | null;
  source_account_uuid?: string | null;
  source_account_login_name?: string | null;
  source_account_name?: string | null;
  owner_organization_id?: number | null;
};

/** 读取包内清单的身份字段 */
function readManifestIdentity(packagePath: string): ManifestIdentity {
  const raw = readFileSync(join(packagePath, 'manifest.json'), 'utf8');
  const parsed = JSON.parse(raw) as {
    items?: ManifestIdentity[];
  };
  const item = parsed.items?.[0] ?? {};
  return item;
}

type Variant = {
  key: string;
  title: string;
  /** 来源机（A）账号：id／uuid／账号名／姓名 */
  source: {
    accountId: number;
    loginName: string | null;
    accountUuid: string | null;
    realName: string;
  };
  /** 目标机（B）本机事实 */
  target: AccountFixture & {
    membership: { organizationId: number; memberRole: string; status: 'ACTIVE' | 'LEFT' } | null;
  };
  expect: {
    imported: boolean;
    reasonContains: string | null;
    authorAccountId: number | null;
  };
};

function buildVariants(peerOrganizationId: number): Variant[] {
  const variants: Variant[] = [];

  // V1：同人不同号（uuid 命中）→ 放行，落本机 id
  variants.push({
    key: 'V1_SAME_PERSON_DIFFERENT_ID',
    title: '同人不同号：稳定标识命中，作者应落目标机本机账号 id',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE,
      loginName: 't09src_v1',
      accountUuid: '00000000-0000-4000-8000-000000009101',
      realName: '来源工程师一号',
    },
    target: {
      accountId: 902_011,
      loginName: 't09src_v1',
      accountUuid: '00000000-0000-4000-8000-000000009101',
      realName: '来源工程师一号',
      accountStatus: 'ACTIVE',
      userState: 'ACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: 1, status: 'ACTIVE' },
    },
    expect: { imported: true, reasonContains: null, authorAccountId: 902_011 },
  });

  // V2：同号不同人（账号名相同、姓名不同）→ 拒绝（姓名快照交叉核对失败）
  variants.push({
    key: 'V2_SAME_ID_DIFFERENT_PERSON_SAME_LOGIN',
    title: '同号不同人（账号名相同）：数字 id 与包内相同但属另一个人，应拒绝',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 1,
      loginName: 't09src_v2',
      accountUuid: '00000000-0000-4000-8000-000000009102',
      realName: '来源工程师二号',
    },
    target: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 1,
      loginName: 't09src_v2',
      accountUuid: '00000000-0000-4000-8000-000000009202',
      realName: '目标机另一个人',
      accountStatus: 'ACTIVE',
      userState: 'ACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: 1, status: 'ACTIVE' },
    },
    expect: {
      imported: false,
      reasonContains: '姓名快照与本机同账号名账号的姓名不一致',
      authorAccountId: null,
    },
  });

  // V3：同号不同人（账号名也不同）→ 拒绝（本机不存在可核验来源账号）
  variants.push({
    key: 'V3_SAME_ID_DIFFERENT_PERSON_NO_LOGIN',
    title: '同号不同人（账号名也不同）：两路标识都未命中，应拒绝且不得按数字 id 归属',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 2,
      loginName: 't09src_v3',
      accountUuid: '00000000-0000-4000-8000-000000009103',
      realName: '来源工程师三号',
    },
    target: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 2,
      loginName: 't09target_v3',
      accountUuid: '00000000-0000-4000-8000-000000009303',
      realName: '目标机另一个人',
      accountStatus: 'ACTIVE',
      userState: 'ACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: 1, status: 'ACTIVE' },
    },
    expect: {
      imported: false,
      reasonContains: '本机不存在可核验的来源账号',
      authorAccountId: null,
    },
  });

  // V4：来源账号已停用 → 拒绝
  variants.push({
    key: 'V4_SOURCE_ACCOUNT_SUSPENDED',
    title: '来源账号在本机已停用：应拒绝',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 3,
      loginName: 't09src_v4',
      accountUuid: '00000000-0000-4000-8000-000000009104',
      realName: '来源工程师四号',
    },
    target: {
      accountId: 902_014,
      loginName: 't09src_v4',
      accountUuid: '00000000-0000-4000-8000-000000009104',
      realName: '来源工程师四号',
      accountStatus: 'SUSPENDED',
      userState: 'ACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: 1, status: 'ACTIVE' },
    },
    expect: { imported: false, reasonContains: '账号已停用', authorAccountId: null },
  });

  // V5：来源账号资料已停用 → 拒绝
  variants.push({
    key: 'V5_SOURCE_PROFILE_DISABLED',
    title: '来源账号资料在本机已停用：应拒绝',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 4,
      loginName: 't09src_v5',
      accountUuid: '00000000-0000-4000-8000-000000009105',
      realName: '来源工程师五号',
    },
    target: {
      accountId: 902_015,
      loginName: 't09src_v5',
      accountUuid: '00000000-0000-4000-8000-000000009105',
      realName: '来源工程师五号',
      accountStatus: 'ACTIVE',
      userState: 'INACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: 1, status: 'ACTIVE' },
    },
    expect: { imported: false, reasonContains: '资料已停用', authorAccountId: null },
  });

  // V6：来源账号已离职 → 拒绝
  variants.push({
    key: 'V6_SOURCE_LEFT_COMPANY',
    title: '来源账号已离开本公司：应拒绝',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 5,
      loginName: 't09src_v6',
      accountUuid: '00000000-0000-4000-8000-000000009106',
      realName: '来源工程师六号',
    },
    target: {
      accountId: 902_016,
      loginName: 't09src_v6',
      accountUuid: '00000000-0000-4000-8000-000000009106',
      realName: '来源工程师六号',
      accountStatus: 'ACTIVE',
      userState: 'ACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: 1, status: 'LEFT' },
    },
    expect: { imported: false, reasonContains: '已离开本公司', authorAccountId: null },
  });

  // V7：来源账号换了公司 → 拒绝
  variants.push({
    key: 'V7_SOURCE_CHANGED_COMPANY',
    title: '来源账号已换到另一公司：应拒绝，不得写入本公司数据区',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 6,
      loginName: 't09src_v7',
      accountUuid: '00000000-0000-4000-8000-000000009107',
      realName: '来源工程师七号',
    },
    target: {
      accountId: 902_017,
      loginName: 't09src_v7',
      accountUuid: '00000000-0000-4000-8000-000000009107',
      realName: '来源工程师七号',
      accountStatus: 'ACTIVE',
      userState: 'ACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: peerOrganizationId, status: 'ACTIVE' },
    },
    expect: { imported: false, reasonContains: '不是本公司的在职成员', authorAccountId: null },
  });

  // V8：包内无可移植身份（只有数字 id）→ 拒绝
  variants.push({
    key: 'V8_NO_PORTABLE_IDENTITY',
    title: '包内未携带跨端可移植身份：应拒绝（不得回退到数字 id，也不冒用导入人）',
    source: {
      accountId: SOURCE_ACCOUNT_ID_BASE + 7,
      loginName: null,
      accountUuid: null,
      realName: '来源工程师八号',
    },
    target: {
      accountId: 902_018,
      loginName: 't09src_v8',
      accountUuid: '00000000-0000-4000-8000-000000009108',
      realName: '来源工程师八号',
      accountStatus: 'ACTIVE',
      userState: 'ACTIVE',
      adminLevel: null,
      membership: { memberRole: 'ENGINEER', organizationId: 1, status: 'ACTIVE' },
    },
    expect: {
      imported: false,
      reasonContains: '跨端可移植的来源账号标识',
      authorAccountId: null,
    },
  });

  return variants;
}

type VariantOutcome = {
  key: string;
  title: string;
  sourceAccountId: number;
  targetAccountId: number;
  packagePath: string;
  manifestIdentity: ManifestIdentity;
  checkResult: string | null;
  importResult: string | null;
  importError: string | null;
  authorAccountId: number | null;
  reportExists: boolean;
  expected: Variant['expect'];
  passed: boolean;
  details: string[];
};

/** 删除本轮夹具（按精确清单；先子后父） */
async function cleanupDeviceFixtures(
  device: DeviceContext,
  accountIds: number[],
  recordUuids: string[],
): Promise<string[]> {
  const errors: string[] = [];
  const run = async (sql: string, params: unknown[]): Promise<void> => {
    try {
      await device.dataSource.query(sql, params);
    } catch (error) {
      errors.push(`${sql.slice(0, 60)}…：${text(error instanceof Error ? error.message : error)}`);
    }
  };

  const accountPlaceholders = accountIds.map(() => '?').join(', ');
  const recordPlaceholders = recordUuids.map(() => '?').join(', ');

  // 报告：本轮持久化编号，或本轮创建账号作为作者/创建人的行（导入落库的行作者＝本机账号）。
  // 两种口径分两条语句执行：JOIN 形态与直删形态的别名/占位符不同，混用会拼出非法 SQL。
  if (recordUuids.length > 0) {
    await run(
      `DELETE v FROM maintenance_report_version v
         JOIN maintenance_report r ON r.id = v.report_id
        WHERE r.record_uuid IN (${recordPlaceholders})`,
      recordUuids,
    );
    await run(
      `DELETE a FROM maintenance_report_attachment a
         JOIN maintenance_report r ON r.id = a.report_id
        WHERE r.record_uuid IN (${recordPlaceholders})`,
      recordUuids,
    );
    await run(
      `DELETE FROM maintenance_report WHERE record_uuid IN (${recordPlaceholders})`,
      recordUuids,
    );
  }
  if (accountIds.length > 0) {
    await run(
      `DELETE v FROM maintenance_report_version v
         JOIN maintenance_report r ON r.id = v.report_id
        WHERE r.created_by_account_id IN (${accountPlaceholders})`,
      accountIds,
    );
    await run(
      `DELETE a FROM maintenance_report_attachment a
         JOIN maintenance_report r ON r.id = a.report_id
        WHERE r.created_by_account_id IN (${accountPlaceholders})`,
      accountIds,
    );
    await run(
      `DELETE FROM maintenance_report WHERE created_by_account_id IN (${accountPlaceholders})`,
      accountIds,
    );
  }

  if (accountIds.length > 0) {
    // 记录包批次：先删条目（外键指向批次），再删批次（外键指向账号）
    await run(
      `DELETE FROM record_package_item
        WHERE package_id IN (
          SELECT package_id FROM record_package_import
           WHERE imported_by_account_id IN (${accountPlaceholders})
        )`,
      accountIds,
    );
    await run(
      `DELETE FROM record_package_import WHERE imported_by_account_id IN (${accountPlaceholders})`,
      accountIds,
    );
    await run(
      `DELETE FROM organization_membership WHERE account_id IN (${accountPlaceholders})`,
      accountIds,
    );
    await run(
      `DELETE FROM base_user_info WHERE account_id IN (${accountPlaceholders})`,
      accountIds,
    );
    await run(`DELETE FROM base_user_account WHERE id IN (${accountPlaceholders})`, accountIds);
  }

  return errors;
}

/** 核对库内一次性标识 */
async function readDisposableMarker(
  device: DeviceContext,
): Promise<ReadonlyArray<{ markerKey: string; markerValue: string }>> {
  const rows: unknown = await device.dataSource.query(
    `SELECT marker_key AS markerKey, marker_value AS markerValue
       FROM ${DISPOSABLE_MARKER_TABLE}`,
  );
  return rows as ReadonlyArray<{ markerKey: string; markerValue: string }>;
}

/** 读取实例 UUID（`@@server_uuid`） */
async function readServerUuid(device: DeviceContext): Promise<string | null> {
  const rows: unknown = await device.dataSource.query('SELECT @@server_uuid AS serverUuid');
  const list = rows as ReadonlyArray<{ serverUuid: string }>;
  return list[0]?.serverUuid ?? null;
}

/** 读取库内安装标识 */
async function readInstallationId(device: DeviceContext): Promise<string | null> {
  const rows: unknown = await device.dataSource.query(
    'SELECT installation_id AS installationId FROM local_installation LIMIT 1',
  );
  const list = rows as ReadonlyArray<{ installationId: string }>;
  return list[0]?.installationId ?? null;
}

async function main(): Promise<void> {
  // ── 1. 授权（默认拒绝）：来源库与目标库各自独立授权 ────────────────────────
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const env = process.env;
  const sourceEnv: Record<string, string | undefined> = {
    TASK09_RESTORE_ENV_FILE: env.TASK09_IDENTITY_SOURCE_ENV_FILE,
    TASK09_RESTORE_DATABASE: env.TASK09_IDENTITY_SOURCE_DATABASE,
    TASK09_RESTORE_EXPECTED_HOST: env.TASK09_IDENTITY_SOURCE_EXPECTED_HOST,
    TASK09_RESTORE_EXPECTED_PORT: env.TASK09_IDENTITY_SOURCE_EXPECTED_PORT,
    TASK09_RESTORE_EXPECTED_SERVER_UUID: env.TASK09_IDENTITY_SOURCE_EXPECTED_SERVER_UUID,
    TASK09_RESTORE_DISPOSABLE_MARKER: env.TASK09_IDENTITY_SOURCE_DISPOSABLE_MARKER,
    TASK09_RESTORE_FILE_ROOT: env.TASK09_IDENTITY_SOURCE_FILE_ROOT,
    TASK09_RESTORE_INSTALLATION_ID: env.TASK09_IDENTITY_SOURCE_INSTALLATION_ID,
    TASK09_RESTORE_ORGANIZATION_ID: env.TASK09_IDENTITY_SOURCE_ORGANIZATION_ID,
    TASK09_RESTORE_TEST_AUTHORIZATION: env.TASK09_IDENTITY_SOURCE_TEST_AUTHORIZATION,
  };
  const targetAuth: SelfcheckAuthorization = readSelfcheckAuthorization(env);
  const sourceAuth: SelfcheckAuthorization = readSelfcheckAuthorization(sourceEnv);

  if (targetAuth.database === sourceAuth.database) {
    throw new Error(
      `来源库与目标库必须是**不同的**一次性隔离库（同一库自导自导没有反例意义）：${targetAuth.database}`,
    );
  }

  // ── 2. 装配两台设备 ────────────────────────────────────────────────────────
  const source = await bootstrapDevice(sourceAuth.envFile, sourceAuth.database);
  const target = await bootstrapDevice(targetAuth.envFile, targetAuth.database);

  const sourceServerUuid = await readServerUuid(source);
  const targetServerUuid = await readServerUuid(target);
  if (sourceServerUuid === null || targetServerUuid === null) {
    throw new Error('无法读取实例 UUID，拒绝在未确认身份的实例上运行');
  }
  assertServerIdentity(
    {
      database: sourceAuth.database,
      host: sourceAuth.expectedHost,
      port: sourceAuth.expectedPort,
      serverUuid: sourceServerUuid,
    },
    sourceAuth,
  );
  assertServerIdentity(
    {
      database: targetAuth.database,
      host: targetAuth.expectedHost,
      port: targetAuth.expectedPort,
      serverUuid: targetServerUuid,
    },
    targetAuth,
  );
  assertDisposableMarker(await readDisposableMarker(source), sourceAuth.disposableMarker);
  assertDisposableMarker(await readDisposableMarker(target), targetAuth.disposableMarker);

  const sourceInstallationId = await readInstallationId(source);
  const targetInstallationId = await readInstallationId(target);
  check(
    '来源库安装标识与声明一致',
    sourceInstallationId === sourceAuth.installationId,
    `实际 ${text(sourceInstallationId)}，声明 ${sourceAuth.installationId}`,
  );
  check(
    '目标库安装标识与声明一致',
    targetInstallationId === targetAuth.installationId,
    `实际 ${text(targetInstallationId)}，声明 ${targetAuth.installationId}`,
  );
  check(
    '来源库与目标库是不同实例上的不同库',
    sourceAuth.database !== targetAuth.database,
    `${sourceAuth.database} ≠ ${targetAuth.database}`,
  );
  check(
    '两端受控文件根不同',
    resolve(sourceAuth.fileRoot) !== resolve(targetAuth.fileRoot),
    `${sourceAuth.fileRoot} ≠ ${targetAuth.fileRoot}`,
  );

  // ── 3. 夹具准备 ────────────────────────────────────────────────────────────
  const targetOrganizationId = await resolveOrganizationId(target, TARGET_ORGANIZATION_CODE);
  const peerOrganizationId = await resolveOrganizationId(target, PEER_ORGANIZATION_CODE);
  const sourceOrganizationId = await resolveOrganizationId(source, TARGET_ORGANIZATION_CODE);
  check(
    '两端目标公司一致（同一业务编码）',
    targetOrganizationId === sourceOrganizationId,
    `A=${sourceOrganizationId} / B=${targetOrganizationId}`,
  );

  const variants = buildVariants(peerOrganizationId);
  const sourceAccountIds: number[] = variants.map((variant) => variant.source.accountId);
  const targetAccountIds: number[] = variants.map((variant) => variant.target.accountId);

  // 幂等预清理：先删**本脚本固定 id 段**的遗留夹具（上一次运行未收尾时），
  // 避免"主键重复"把矩阵打断在写入阶段（只删本脚本自己的 id，不碰其他行）。
  const preCleanupErrors = [
    ...(await cleanupDeviceFixtures(source, sourceAccountIds, [])),
    ...(await cleanupDeviceFixtures(target, [IMPORTER_ACCOUNT_ID, ...targetAccountIds], [])),
  ];
  check(
    '预清理本脚本 id 段遗留夹具无失败',
    preCleanupErrors.length === 0,
    preCleanupErrors.length === 0
      ? '来源库与目标库本脚本 id 段已清空'
      : preCleanupErrors.join(' | '),
  );

  // 导入者：二级管理员（admin_level=2）
  await insertAccount(
    target,
    {
      accountId: IMPORTER_ACCOUNT_ID,
      loginName: IMPORTER_LOGIN_NAME,
      accountUuid: randomUUID(),
      realName: '任务09 二级管理员',
      accountStatus: 'ACTIVE',
      userState: 'ACTIVE',
      adminLevel: 2,
    },
    { memberRole: 'SUPER_ADMIN', organizationId: targetOrganizationId, status: 'ACTIVE' },
  );

  const outcomes: VariantOutcome[] = [];
  const recordUuids: string[] = [];
  const exportRoot = join(sourceAuth.fileRoot, 'identity-matrix-export');
  const mediaRoot = join(targetAuth.fileRoot, 'identity-matrix-media');
  mkdirSync(exportRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  for (const variant of variants) {
    const details: string[] = [];
    const recordUuid = randomUUID();
    recordUuids.push(recordUuid);

    // 3.1 来源机：建账号 → 建报告 → 导出包
    await insertAccount(
      source,
      {
        accountId: variant.source.accountId,
        loginName: variant.source.loginName,
        accountUuid: variant.source.accountUuid,
        realName: variant.source.realName,
        accountStatus: 'ACTIVE',
        userState: 'ACTIVE',
        adminLevel: null,
      },
      { memberRole: 'ENGINEER', organizationId: sourceOrganizationId, status: 'ACTIVE' },
    );

    const payload = {
      sourceType: MaintenanceReportSourceType.HISTORICAL_CASE,
      repairRequestId: null,
      title: `身份反例矩阵-${variant.key}`,
      customerFactoryName: '某客户工厂',
      equipmentModelId: null,
      equipmentModelText: '某机型',
      maintenanceDate: '2026-11-23',
      maintenanceEngineerAccountId: variant.source.accountId,
      maintenanceEngineerName: variant.source.realName,
      phaseFlowVersion: 1,
      alarms: [],
      steps: [],
      faults: [],
    };
    const { id: reportId } = await source.transactionRunner.run(async (transactionContext) =>
      source.maintenanceReportService.insertReport(
        {
          ownerOrganizationId: sourceOrganizationId,
          sourceType: MaintenanceReportSourceType.HISTORICAL_CASE,
          repairRequestId: null,
          title: `身份反例矩阵-${variant.key}`,
          customerFactoryName: '某客户工厂',
          equipmentModelId: null,
          equipmentModelText: '某机型',
          maintenanceDate: '2026-11-23',
          maintenanceEngineerAccountId: variant.source.accountId,
          maintenanceEngineerNameSnapshot: variant.source.realName,
          phaseFlowVersion: 1,
          createdByAccountId: variant.source.accountId,
          updatedByAccountId: variant.source.accountId,
          recordUuid,
          status: MaintenanceReportStatus.SUBMITTED,
          currentVersionNo: 1,
          lastSubmittedAt: new Date('2026-11-23T00:00:00.000Z'),
        },
        transactionContext,
      ),
    );
    await source.transactionRunner.run(async (transactionContext) =>
      source.maintenanceReportService.insertVersion(
        {
          reportId,
          versionNo: 1,
          changeKind: MaintenanceReportChangeKind.SUBMIT,
          changeReason: '身份反例矩阵夹具',
          payloadSnapshot: payload,
          submittedByAccountId: variant.source.accountId,
          submittedAt: new Date('2026-11-23T00:00:00.000Z'),
        },
        transactionContext,
      ),
    );

    const exportTarget = join(exportRoot, variant.key);
    const exported = await source.exportUsecase.execute({
      session: engineerSession(variant.source.accountId),
      targetPath: exportTarget,
      resourceType: 'MAINTENANCE_REPORT',
      recordIds: [reportId],
    });

    // 3.2 介质：把包目录复制到目标机可见路径（等价 U 盘搬运）
    const mediaPath = join(mediaRoot, variant.key);
    cpSync(exported.packagePath, mediaPath, { recursive: true });

    const manifestIdentity = readManifestIdentity(mediaPath);
    details.push(
      `包内身份：source_account_id=${text(manifestIdentity.source_account_id)}、uuid=${text(
        manifestIdentity.source_account_uuid,
      )}、login=${text(manifestIdentity.source_account_login_name)}`,
    );

    // 3.3 目标机：布置本机事实
    await insertAccount(target, variant.target, variant.target.membership);

    // 3.4 检查（不写正式业务）→ 导入（逐条结果）
    const checked = await target.checkUsecase.execute({
      session: secondLevelAdminSession(IMPORTER_ACCOUNT_ID),
      packagePath: mediaPath,
    });
    const checkResult = checked.items[0]?.checkResult ?? null;
    details.push(`检查结论：${text(checkResult)}`);

    const imported = await target.importUsecase.execute({
      session: secondLevelAdminSession(IMPORTER_ACCOUNT_ID),
      packageId: checked.import.packageId,
      packagePath: mediaPath,
      manifestChecksum: checked.import.manifestChecksum,
    });
    const importItem = imported.items[0] ?? null;
    const importResult = importItem?.result ?? null;
    const importError = importItem?.errorMessage ?? null;
    details.push(
      `导入结论：${text(importResult)}${importError === null ? '' : `（${importError}）`}`,
    );

    // 3.5 读回：作者账号与报告是否存在
    const report = await target.dataSource
      .getRepository(MaintenanceReportEntity)
      .findOne({ where: { recordUuid } });
    const authorAccountId = report?.createdByAccountId ?? null;
    const reportExists = report !== null;

    // 3.6 逐变体断言
    const expect = variant.expect;
    const importedAsExpected = expect.imported
      ? importResult === 'SUCCEEDED'
      : importResult === 'FAILED';
    check(
      `${variant.key}：导入裁决符合预期`,
      importedAsExpected,
      `期望 imported=${text(expect.imported)}，实际 ${text(importResult)}${
        importError === null ? '' : `（${importError}）`
      }`,
    );
    if (expect.reasonContains !== null) {
      check(
        `${variant.key}：拒绝原因可读且指向身份事实`,
        importError !== null && importError.includes(expect.reasonContains),
        `期望包含「${expect.reasonContains}」，实际 ${text(importError)}`,
      );
    }
    if (expect.authorAccountId !== null) {
      check(
        `${variant.key}：作者落目标机本机账号 id`,
        authorAccountId === expect.authorAccountId,
        `期望 ${text(expect.authorAccountId)}，实际 ${text(authorAccountId)}`,
      );
    } else {
      check(
        `${variant.key}：不得出现错归属报告（按包内数字 id 选作者即失败）`,
        reportExists === false && authorAccountId === null,
        `报告存在=${text(reportExists)}，作者=${text(authorAccountId)}`,
      );
    }
    // 包内身份字段必须真实携带（防止导出侧退化后矩阵"看起来正确"）
    if (variant.key !== 'V8_NO_PORTABLE_IDENTITY') {
      check(
        `${variant.key}：包内携带跨端可移植身份`,
        manifestIdentity.source_account_uuid === variant.source.accountUuid &&
          manifestIdentity.source_account_login_name === variant.source.loginName,
        `uuid=${text(manifestIdentity.source_account_uuid)}、login=${text(
          manifestIdentity.source_account_login_name,
        )}`,
      );
    } else {
      check(
        `${variant.key}：包内确实缺少可移植身份（只有数字 id）`,
        manifestIdentity.source_account_uuid === null &&
          manifestIdentity.source_account_login_name === null &&
          manifestIdentity.source_account_id === variant.source.accountId,
        `source_account_id=${text(manifestIdentity.source_account_id)}`,
      );
    }

    outcomes.push({
      key: variant.key,
      title: variant.title,
      sourceAccountId: variant.source.accountId,
      targetAccountId: variant.target.accountId,
      packagePath: mediaPath,
      manifestIdentity,
      checkResult,
      importResult,
      importError,
      authorAccountId,
      reportExists,
      expected: expect,
      passed: assertions
        .slice()
        .filter((item) => item.name.startsWith(`${variant.key}：`))
        .every((item) => item.passed),
      details,
    });

    process.stdout.write(
      `[${variant.key}] 检查=${text(checkResult)} 导入=${text(importResult)} 作者=${text(
        authorAccountId,
      )} 报告存在=${text(reportExists)}\n`,
    );
  }

  // ── 4. 收尾清理（精确清单；只删本轮夹具） ─────────────────────────────────
  const sourceCleanupErrors = await cleanupDeviceFixtures(source, sourceAccountIds, recordUuids);
  const targetCleanupErrors = await cleanupDeviceFixtures(
    target,
    [IMPORTER_ACCOUNT_ID, ...targetAccountIds],
    recordUuids,
  );
  const cleanupErrors = [...sourceCleanupErrors, ...targetCleanupErrors];
  check(
    '收尾删除本轮夹具无失败',
    cleanupErrors.length === 0,
    cleanupErrors.length === 0 ? '来源库与目标库夹具已按精确清单删除' : cleanupErrors.join(' | '),
  );

  for (const root of [exportRoot, mediaRoot]) {
    if (existsSync(root)) {
      rmSync(root, { force: true, recursive: true });
    }
  }

  // ── 5. 汇总 ────────────────────────────────────────────────────────────────
  const failed = assertions.filter((item) => !item.passed);
  const verdict = {
    generatedAt: new Date().toISOString(),
    sourceDatabase: sourceAuth.database,
    targetDatabase: targetAuth.database,
    sourceInstallationId,
    targetInstallationId,
    targetOrganizationId,
    importerAccountId: IMPORTER_ACCOUNT_ID,
    variants: outcomes,
    assertions,
    assertionTotal: assertions.length,
    assertionFailed: failed.length,
    passed: failed.length === 0,
  };

  const outputFile =
    env.TASK09_IDENTITY_OUTPUT ??
    join(
      process.cwd(),
      '..',
      '.local',
      'task09',
      'evidence',
      'identity-counterexample-matrix.json',
    );
  mkdirSync(resolve(outputFile, '..'), { recursive: true });
  writeFileSync(resolve(outputFile), `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');

  process.stdout.write(`\n断言：${assertions.length} 项，失败 ${failed.length} 项\n`);
  for (const item of failed) {
    process.stdout.write(`  ✗ ${item.name}：${item.detail}\n`);
  }
  process.stdout.write(`证据：${resolve(outputFile)}\n`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n${
      error instanceof Error && error.stack !== undefined ? error.stack : ''
    }\n`,
  );
  process.exitCode = 1;
});
