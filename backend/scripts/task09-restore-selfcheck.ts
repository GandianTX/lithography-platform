/**
 * 任务 09 · 恢复链自检矩阵（**隔离实库**，独立验收 P1-3 修复后的安全入口）。
 *
 * 目的：在**一次性隔离库**上跑通恢复链的真实矩阵，把"恢复能不能用"从**未验证**变成**有证据**：
 *   1. 原机成功恢复（预检 → 受理 → 执行 → 计数与冻结解除）；
 *   2. 异机拒绝（资产归属安装标识不符 ⇒ 预检拒绝）；
 *   3. 工程师拒绝（无恢复权限）；
 *   4. 失败保持冻结（保护副本被破坏 ⇒ 执行失败 ⇒ 设备仍停写停传 ＋ 冻结落库可识别）；
 *   5. 重启识别（冻结事实落在库里，换一个数据源实例仍能读到）；
 *   6. 非目标哨兵（恢复只动本公司数据区，其他公司／其他账号／其他文件不变）。
 *
 * ── 安全边界（独立验收 P1-3）──
 * 本脚本**默认拒绝运行**：必须显式给出一次性库、预期实例身份、一次性库标识、
 * 受控文件根、安装／公司标识与测试授权；任一缺失即零写入退出。
 * 清理只删**本轮**创建的对象：数据库删除在同一事务内按先子后父执行，
 * 文件删除限定在受控根内并逐条实名核对；收尾失败不吞异常。
 *
 * 纪律：
 * - 全部走**生产代码路径**（预检／受理／执行／冻结守卫），不做插表代证；
 * - 断言落在**真实副作用**上（DB 行、冻结表、磁盘上的包目录）；
 * - 只在**可丢弃的一次性隔离库**里执行；夹具（授权、设置）按需新建并登记主键。
 *
 * 用法（一次性隔离库；缺任何一项都拒绝运行）：
 *   TASK09_RESTORE_ENV_FILE=env/.env.task09-iso-a \
 *   TASK09_RESTORE_DATABASE=lithography_task09_isolated_a \
 *   TASK09_RESTORE_EXPECTED_HOST=127.0.0.1 \
 *   TASK09_RESTORE_EXPECTED_PORT=33307 \
 *   TASK09_RESTORE_EXPECTED_SERVER_UUID=<@@server_uuid> \
 *   TASK09_RESTORE_DISPOSABLE_MARKER=<库内标识值> \
 *   TASK09_RESTORE_FILE_ROOT=<受控文件根> \
 *   TASK09_RESTORE_INSTALLATION_ID=<local_installation.installation_id> \
 *   TASK09_RESTORE_ORGANIZATION_ID=<local_installation.organization_id> \
 *   TASK09_RESTORE_TEST_AUTHORIZATION=TASK09-RESTORE-SELFCHECK-ISOLATED-RUN \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-restore-selfcheck.ts
 */

// 脚本属**受控 wiring**（同 scripts/seed-mock.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { TypeOrmModule } from '@nestjs/typeorm';
import { parse as parseDotenv } from 'dotenv';
import { DataSource, EntityManager } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { BackupAssetEntity } from '@src/modules/lithography/entities/backup-asset.entity';
import { LocalAccountAuthorizationEntity } from '@src/modules/lithography/entities/local-account-authorization.entity';
import { LocalCompanySettingEntity } from '@src/modules/lithography/entities/local-company-setting.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { IntakeAnalysisService } from '@src/modules/lithography/intake-analysis.service';
import { ManagementAuditEventQueryService } from '@src/modules/lithography/queries/management-audit-event.query.service';
import { AcceptLocalRestoreUsecase } from '@src/usecases/local-runtime/accept-local-restore.usecase';
import { ExecuteLocalRestoreUsecase } from '@src/usecases/local-runtime/execute-local-restore.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { PrecheckLocalRestoreUsecase } from '@src/usecases/local-runtime/precheck-local-restore.usecase';
import { StartManualLocalBackupUsecase } from '@src/usecases/local-runtime/start-manual-local-backup.usecase';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import {
  assertAuthorizationNotOverwritable,
  assertControlledFileRoot,
  assertDisposableMarker,
  assertNoExternalReference,
  assertNoForeignActiveHold,
  assertPathWithinRoot,
  assertSentinelsUnchanged,
  assertServerIdentity,
  buildCleanupError,
  deleteFilesByList,
  listFilesUnder,
  planDatabaseDeletion,
  pruneEmptyDirs,
  readSelfcheckAuthorization,
  selectReleasableHolds,
  SelfcheckSafetyError,
  type DatabaseDeletionTarget,
  type DisposableMarkerRow,
  type ExistingAuthorizationFact,
  type ExistingHoldFact,
  type SentinelSnapshot,
} from './task09-restore-selfcheck.safety';

type Assertion = { name: string; passed: boolean; detail: string };

const assertions: Assertion[] = [];

function check(name: string, passed: boolean, detail: string): void {
  assertions.push({ name, passed, detail });
}

/**
 * 数据库行取值统一转文本（行类型是 `Record<string, unknown>`）。
 *
 * 不用 `String(unknown)`：那会退化成默认字符串化（`[object Object]`）而看不出类型问题。
 */
function asText(value: unknown): string {
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

/** 受控范围内的对象表（删除顺序＝先子后父） */
const MANAGED_TABLES: ReadonlyArray<{ readonly table: string; readonly idColumn: string }> = [
  { table: 'management_audit_event', idColumn: 'event_id' },
  { table: 'local_write_hold', idColumn: 'hold_id' },
  { table: 'backup_restore_run', idColumn: 'restore_id' },
  { table: 'backup_asset', idColumn: 'backup_id' },
  { table: 'local_backup_run', idColumn: 'id' },
  { table: 'local_company_setting', idColumn: 'id' },
  { table: 'local_account_authorization', idColumn: 'id' },
];

type ChainContext = {
  dataSource: DataSource;
  startManualBackup: StartManualLocalBackupUsecase;
  precheck: PrecheckLocalRestoreUsecase;
  accept: AcceptLocalRestoreUsecase;
  execute: ExecuteLocalRestoreUsecase;
  writeHold: LocalWriteHoldService;
  /** 首析写侧服务（后台回写路径；任务 09 新计划第 04 项的冻结守卫取证用） */
  intakeAnalysis: IntakeAnalysisService;
  /** 事务运行器（模块服务写入需要事务上下文） */
  transactionRunner: TransactionRunner;
  /** 关键操作记录读侧（任务 10 契约；用于读回恢复终态事件） */
  auditEventQuery: ManagementAuditEventQueryService;
  /** 业务原件目录（受控根内；用于原件字节级还原核对） */
  originalsDir: string;
};

/** 本轮运行范围：只登记**本轮**产生的对象，清理时只删这些 */
type RunScope = {
  readonly runId: string;
  readonly fileRoot: string;
  readonly runRoot: string;
  readonly backupRoot: string;
  readonly referenceRoot: string;
  readonly envFile: string;
  readonly database: string;
  readonly expectedHost: string;
  readonly expectedPort: number;
  readonly expectedServerUuid: string;
  readonly disposableMarker: string;
  readonly testAuthorization: string;
  installationId: string;
  organizationId: number;
  superAdminAccountId: number;
  engineerAccountId: number;
  readonly ownedBackupIds: Set<string>;
  readonly ownedRestoreIds: Set<string>;
  readonly ownedHoldIds: Set<string>;
  readonly ownedFilePaths: Set<string>;
  createdSettingId: string | null;
  createdAuthorizationId: string | null;
};

/**
 * 装配本机（一次性隔离库 ＋ 本轮受控文件根）。
 *
 * 备份包目录与业务原件目录都被**重写到本轮子目录**：这样"本轮产生的文件"
 * 天然落在受控根内，清理时不会碰到根外的任何东西。
 */
async function bootstrap(scope: RunScope): Promise<ChainContext> {
  const envContent = readFileSync(scope.envFile, 'utf8');
  const parsed: Record<string, string> = parseDotenv(envContent);
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
  // 受保护封包密钥：本机 env 里的占位值不是合法 AES-256 密钥，脚本改用固定测试密钥
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_PROTECTION_KEY =
    '9f2c7a1d4e6b8035c7d9e1f4a2b6c8d0e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3';
  // 本轮受控文件根（覆盖 env 文件里的默认落点）
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_STORAGE_DIR = scope.backupRoot;

  // 业务原件存储目录**必须**落在受控文件根内：
  // 原件是跨轮次存在的既有数据（备份会物理复制它们），不能落在受控根之外，
  // 否则"只删本轮对象"的边界无从保证。env 未给出时用受控根下的固定子目录。
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const configuredOriginalsDir = process.env['REFERENCE_DOCUMENT_STORAGE_DIR'];
  const originalsDir =
    configuredOriginalsDir === undefined || configuredOriginalsDir.trim().length === 0
      ? join(scope.fileRoot, 'originals')
      : resolve(configuredOriginalsDir);
  assertPathWithinRoot(scope.fileRoot, originalsDir);
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.REFERENCE_DOCUMENT_STORAGE_DIR = originalsDir;
  mkdirSync(originalsDir, { recursive: true });

  const config = loadExplicitEnvConfig(scope.envFile, scope.database);

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
      TypeOrmModule.forFeature([
        BackupAssetEntity,
        LocalCompanySettingEntity,
        LocalAccountAuthorizationEntity,
      ]),
      TypeOrmTransactionModule,
      LocalRuntimeStorageModule,
      LocalRuntimeUsecasesModule,
    ],
  }).compile();

  return {
    dataSource: moduleRef.get(DataSource),
    startManualBackup: moduleRef.get(StartManualLocalBackupUsecase),
    precheck: moduleRef.get(PrecheckLocalRestoreUsecase),
    accept: moduleRef.get(AcceptLocalRestoreUsecase),
    execute: moduleRef.get(ExecuteLocalRestoreUsecase),
    writeHold: moduleRef.get(LocalWriteHoldService),
    intakeAnalysis: moduleRef.get(IntakeAnalysisService),
    transactionRunner: moduleRef.get(TRANSACTION_RUNNER),
    auditEventQuery: moduleRef.get(ManagementAuditEventQueryService),
    originalsDir,
  };
}

/**
 * 业务原件目录的**字节级指纹**：逐件（相对路径 ＋ 字节数 ＋ SHA-256）排序拼接。
 *
 * 用于"恢复后原件与恢复前逐字节一致"的核对：只有**路径、字节数、校验值**三者全同
 * 才算原件真的被还原（只数文件个数不算证据）。
 */
function originalsFingerprint(dir: string): string {
  const parts = listFilesUnder(dir)
    .map((path) => {
      const relative = path.slice(dir.length).replace(/^\/+/, '');
      const bytes = readFileSync(path);
      return `${relative}:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`;
    })
    .sort();
  return parts.join('|');
}

/** 一级管理员会话（全局范围；等级由服务端查库复核） */
function superAdminSession(accountId: number): UsecaseSession {
  return {
    accountId,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: 1,
    customerOrganizationId: null,
  } as unknown as UsecaseSession;
}

/** 工程师会话（无恢复权限） */
function engineerSession(accountId: number): UsecaseSession {
  return {
    accountId,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
    adminLevel: null,
    customerOrganizationId: null,
  } as unknown as UsecaseSession;
}

/** 读取一次性库标识行（表不存在时按拒绝处理） */
async function readDisposableMarkerRows(dataSource: DataSource): Promise<DisposableMarkerRow[]> {
  try {
    const rows: unknown = await dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    if (!Array.isArray(rows)) {
      throw new Error('一次性标识表返回格式异常');
    }
    return rows.map((row) => {
      const record = row as { marker_key?: string; marker_value?: string };
      return {
        markerKey: String(record.marker_key ?? ''),
        markerValue: String(record.marker_value ?? ''),
      };
    });
  } catch (error: unknown) {
    throw new SelfcheckSafetyError(
      'MISSING_DISPOSABLE_MARKER_TABLE',
      `读取一次性库标识失败（该库必须先建立 ${'task09_disposable_marker'} 标识表）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 解析目标公司／账号（**真实账号**，不写死 id）。
 *
 * 一级管理员与工程师都必须是**本公司的有效成员**：否则"用管理员身份冒充记录人"
 * 会让权限断言失真。
 */
async function resolveScopeActors(
  dataSource: DataSource,
  organizationId: number,
): Promise<{ superAdminAccountId: number; engineerAccountId: number }> {
  const rows: unknown = await dataSource.query(
    'SELECT m.account_id AS account_id, m.member_role AS member_role, a.admin_level AS admin_level ' +
      'FROM organization_membership m ' +
      'JOIN base_user_account a ON a.id = m.account_id ' +
      "WHERE m.organization_id = ? AND m.status = ? AND a.status = 'ACTIVE' ORDER BY m.id ASC",
    [organizationId, 'ACTIVE'],
  );
  const memberships = rows as Array<{
    account_id: number;
    member_role: string;
    admin_level: number | null;
  }>;
  // 一级管理员必须**同时**具备组织管理员成员关系与请求期复核得到的管理员等级 1
  const superAdmin = memberships.find(
    (item) => item.member_role === 'SUPER_ADMIN' && item.admin_level === 1,
  );
  const engineer = memberships.find((item) => item.member_role === 'ENGINEER');
  if (superAdmin === undefined || engineer === undefined) {
    throw new SelfcheckSafetyError(
      'MISSING_SCOPE_ACTORS',
      `公司 ${organizationId} 缺少有效的一级管理员（admin_level=1）或工程师成员，` +
        '拒绝用写死账号冒充记录人。',
    );
  }
  return { superAdminAccountId: superAdmin.account_id, engineerAccountId: engineer.account_id };
}

/**
 * 找一个**非目标公司**的真实组织，作为"非目标范围冻结"哨兵的落点。
 *
 * 哨兵冻结必须落在别的公司范围：本轮的"按范围释放"只针对目标公司，
 * 一旦误伤到别的公司范围就说明释放逻辑越界。
 */
async function resolveSentinelHoldOrganization(
  dataSource: DataSource,
  targetOrganizationId: number,
): Promise<number> {
  const rows: unknown = await dataSource.query(
    "SELECT id FROM organization WHERE id <> ? AND kind = 'PEER' AND status = 'ACTIVE' ORDER BY id LIMIT 1",
    [targetOrganizationId],
  );
  const first = (rows as Array<{ id: number }>)[0];
  if (first === undefined) {
    throw new SelfcheckSafetyError(
      'MISSING_SENTINEL_ORGANIZATION',
      '隔离库缺少可用的外公司组织，无法建立非目标范围冻结哨兵。',
    );
  }
  return first.id;
}

/** 读取目标范围既有授权行（用于"不得覆盖既有授权"预检） */
async function readExistingAuthorizations(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
): Promise<ExistingAuthorizationFact[]> {
  const rows: unknown = await dataSource.query(
    'SELECT id, installation_id, account_id, organization_id, authorization_status ' +
      'FROM local_account_authorization WHERE installation_id = ? AND organization_id = ?',
    [installationId, organizationId],
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row['id']),
    installationId: String(row['installation_id']),
    accountId: Number(row['account_id']),
    organizationId: Number(row['organization_id']),
    authorizationStatus: String(row['authorization_status']),
  }));
}

/** 读取目标范围既有冻结（用于"不得释放他人现场"预检） */
async function readExistingHolds(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
): Promise<ExistingHoldFact[]> {
  const rows: unknown = await dataSource.query(
    'SELECT hold_id, installation_id, organization_id, status, restore_id ' +
      'FROM local_write_hold WHERE installation_id = ? AND organization_id = ?',
    [installationId, organizationId],
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    holdId: String(row['hold_id']),
    installationId: String(row['installation_id']),
    organizationId: Number(row['organization_id']),
    status: String(row['status']),
    restoreId: row['restore_id'] === null ? null : asText(row['restore_id']),
  }));
}

/** 快照某张受控表的主键集合 */
async function snapshotIds(
  dataSource: DataSource,
  table: string,
  idColumn: string,
): Promise<Set<string>> {
  const rows: unknown = await dataSource.query(`SELECT \`${idColumn}\` AS id FROM \`${table}\``);
  const ids = new Set<string>();
  for (const row of rows as Array<Record<string, unknown>>) {
    ids.add(String(row['id']));
  }
  return ids;
}

/**
 * 夹具：本公司设置（备份开启）＋ 云备份用途授权（**仅在本轮新建时写入**）。
 *
 * 纪律：既有设置／授权一律**不覆盖**（预检已拦截），本轮新建的行登记主键，
 * 收尾时按主键精确删除。
 */
async function ensureFixtures(ctx: ChainContext, scope: RunScope): Promise<void> {
  const settingRepository = ctx.dataSource.getRepository(LocalCompanySettingEntity);
  const existingSetting = await settingRepository.findOne({
    where: {
      installationId: scope.installationId,
      organizationId: scope.organizationId,
    },
  });
  if (existingSetting !== null) {
    throw new SelfcheckSafetyError(
      'PREEXISTING_COMPANY_SETTING',
      `目标范围已存在公司设置行（id=${existingSetting.id}），不得覆盖既有设置：拒绝运行。`,
    );
  }
  const setting = await settingRepository.save(
    settingRepository.create({
      installationId: scope.installationId,
      organizationId: scope.organizationId,
      settingSource: 'LOCAL_MANUAL',
      isCurrent: true,
      initializedAt: new Date(),
      backupIntervalHours: 72,
      backupEnabled: true,
      nextBackupAt: new Date(Date.now() + 72 * 3600_000),
      lastAutoSuccessAt: null,
      lastAutoFailureAt: null,
      failureReason: null,
      autoUploadEnabled: false,
    }),
  );
  scope.createdSettingId = String(setting.id);

  const authorizationRepository = ctx.dataSource.getRepository(LocalAccountAuthorizationEntity);
  const signedClaims = {
    purpose: ['CLOUD_BACKUP', 'BUSINESS_SYNC'],
    issuer: 'task09-selfcheck',
    subject: String(scope.superAdminAccountId),
  };
  const authorization = await authorizationRepository.save(
    authorizationRepository.create({
      installationId: scope.installationId,
      accountId: scope.superAdminAccountId,
      organizationId: scope.organizationId,
      authorizationStatus: 'ACTIVE',
      authorizedAt: new Date(),
      revokedAt: null,
      signedClaims,
      permissionVersion: 1,
      lastVerifiedAt: new Date(),
    }),
  );
  scope.createdAuthorizationId = String(authorization.id);
}

/** 外公司哨兵：本公司之外的业务行指纹（行数 ＋ 内容摘要） */
async function foreignCompanyFingerprint(
  dataSource: DataSource,
  organizationId: number,
): Promise<string> {
  const rows: unknown = await dataSource.query(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CRC32(CONCAT_WS('|', id, title, status))), 0) AS digest " +
      'FROM maintenance_report WHERE owner_organization_id <> ?',
    [organizationId],
  );
  const first = (rows as Array<{ total: number; digest: number }>)[0];
  return `${first?.total ?? 0}:${first?.digest ?? 0}`;
}

/**
 * 目标公司哨兵：本公司业务行指纹（行数 ＋ 内容摘要）。
 *
 * 用于"写入失败但回滚成功 ⇒ 业务回到恢复前事实"的核对：
 * 只有状态行变了、数据没回滚，不算恢复成功。
 */
async function targetCompanyFingerprint(
  dataSource: DataSource,
  organizationId: number,
): Promise<string> {
  const rows: unknown = await dataSource.query(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CRC32(CONCAT_WS('|', id, title, status))), 0) AS digest " +
      'FROM maintenance_report WHERE owner_organization_id = ?',
    [organizationId],
  );
  const requests: unknown = await dataSource.query(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CRC32(CONCAT_WS('|', id, request_no, error_code, handling_status))), 0) AS digest " +
      'FROM repair_request WHERE owner_organization_id = ?',
    [organizationId],
  );
  const report = (rows as Array<{ total: number; digest: number }>)[0];
  const request = (requests as Array<{ total: number; digest: number }>)[0];
  return (
    `report=${report?.total ?? 0}:${report?.digest ?? 0}` +
    ` request=${request?.total ?? 0}:${request?.digest ?? 0}`
  );
}

/**
 * 删除指定备份包的本地目录（**故障注入**：让待恢复包不可读）。
 *
 * 只删**本轮**生成的夹具：先核对资产归属（本轮安装／公司／本轮备份运行），
 * 再核对路径确实落在本轮受控备份目录内，最后才做递归删除。
 */
async function removePackageDirectory(
  ctx: ChainContext,
  scope: RunScope,
  backupId: string,
): Promise<void> {
  const asset = await ctx.dataSource
    .getRepository(BackupAssetEntity)
    .findOne({ where: { backupId } });
  const path = asset?.localReference ?? null;
  if (path === null) {
    return;
  }
  if (!scope.ownedBackupIds.has(backupId)) {
    throw new SelfcheckSafetyError(
      'NOT_RUN_OWNED_BACKUP',
      `拒绝删除不属于本轮的备份包目录：${backupId}`,
    );
  }
  if (asset?.installationId !== scope.installationId) {
    throw new SelfcheckSafetyError(
      'BACKUP_INSTALLATION_MISMATCH',
      `备份包归属安装与本轮不一致：${backupId}`,
    );
  }
  if (asset?.organizationId !== scope.organizationId) {
    throw new SelfcheckSafetyError(
      'BACKUP_ORGANIZATION_MISMATCH',
      `备份包归属公司与本轮不一致：${backupId}`,
    );
  }
  assertPathWithinRoot(scope.backupRoot, path);
  scope.ownedFilePaths.add(path);
  rmSync(path, { recursive: true, force: true });
}

/**
 * 释放**本轮**的冻结（场景之间的夹具整理）。
 *
 * 恢复失败会**故意保持冻结**（设备继续停写停传）——那是待验证的语义，
 * 不是脚本要中断的理由；下一场景前只把**本轮**的冻结恢复到"无冻结"起点，
 * 别人留下的冻结一律不动。
 */
async function releaseRunHolds(ctx: ChainContext, scope: RunScope): Promise<void> {
  const rows: unknown = await ctx.dataSource.query(
    'SELECT hold_id, installation_id, organization_id, status, restore_id FROM local_write_hold ' +
      'WHERE installation_id = ? AND organization_id = ? AND status = ?',
    [scope.installationId, scope.organizationId, 'ACTIVE'],
  );
  const detail: ExistingHoldFact[] = (rows as Array<Record<string, unknown>>).map((row) => ({
    holdId: String(row['hold_id']),
    installationId: String(row['installation_id']),
    organizationId: Number(row['organization_id']),
    status: String(row['status']),
    restoreId: row['restore_id'] === null ? null : asText(row['restore_id']),
  }));
  if (detail.length === 0) {
    return;
  }
  const releasable = selectReleasableHolds(detail, [...scope.ownedRestoreIds]);
  if (releasable.length === 0) {
    return;
  }
  await ctx.writeHold.release({
    installationId: scope.installationId,
    organizationId: scope.organizationId,
    now: new Date(),
  });
  // 释放动作是"按范围释放"，因此必须核对本轮之外的冻结没有被一起释放
  const after: unknown = await ctx.dataSource.query(
    'SELECT hold_id, restore_id FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?',
    [scope.installationId, scope.organizationId, 'ACTIVE'],
  );
  const stillActive = (after as Array<Record<string, unknown>>).map((row) =>
    String(row['hold_id']),
  );
  for (const hold of detail) {
    if (hold.restoreId !== null && !scope.ownedRestoreIds.has(hold.restoreId)) {
      if (!stillActive.includes(hold.holdId)) {
        throw new SelfcheckSafetyError(
          'FOREIGN_HOLD_RELEASED',
          `释放冻结时误伤了他人的冻结：${hold.holdId}`,
        );
      }
    }
  }
}

/**
 * 拉起**中断子进程**并在其执行恢复途中 `SIGKILL`，制造真实进程中断。
 *
 * 子进程先完成"备份 → 预检 → 受理 → 冻结落库"，再改动一条业务数据，
 * 然后进入写入。父进程在收到 `READY` 后**立刻**杀掉它 ⇒
 * 写入要么尚未提交（事务回滚）、要么整批提交，**不会留下半截数据**。
 */
async function runInterruptScenario(
  ctx: ChainContext,
  scope: RunScope,
): Promise<{
  restoreId: string;
  noPartialWrite: boolean;
  detail: string;
  holdRetained: boolean;
  holdDetail: string;
  runStatus: string;
}> {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
      join(__dirname, 'task09-restore-interrupt-child.ts'),
    ],
    {
      cwd: join(__dirname, '..'),
      env: {
        // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
        ...process.env,
        // ts-node 由入口文件推断 rootDir 会与 tsconfig 的 include 冲突 ⇒ 显式覆盖
        TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}',
        // 子进程**独立复核**同一套安全约束：这里只透传声明值，不透传"已通过"的结论
        TASK09_RESTORE_ENV_FILE: scope.envFile,
        TASK09_RESTORE_DATABASE: scope.database,
        TASK09_RESTORE_EXPECTED_HOST: scope.expectedHost,
        TASK09_RESTORE_EXPECTED_PORT: String(scope.expectedPort),
        TASK09_RESTORE_EXPECTED_SERVER_UUID: scope.expectedServerUuid,
        TASK09_RESTORE_DISPOSABLE_MARKER: scope.disposableMarker,
        TASK09_RESTORE_FILE_ROOT: scope.fileRoot,
        TASK09_RESTORE_INSTALLATION_ID: scope.installationId,
        TASK09_RESTORE_ORGANIZATION_ID: String(scope.organizationId),
        TASK09_RESTORE_TEST_AUTHORIZATION: scope.testAuthorization,
        // 子进程写自己的子目录，避免与父进程的文件根重叠
        TASK09_RESTORE_RUN_ID: scope.runId,
        TASK09_RESTORE_RUN_MODE: 'INTERRUPT_CHILD',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const restoreId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('中断子进程未在时限内就绪')), 120_000);
    const check = setInterval(() => {
      const match = /READY ([0-9a-f-]{36})/.exec(stdout);
      if (match !== null) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(match[1]);
      }
    }, 50);
    child.on('exit', () => {
      clearInterval(check);
      clearTimeout(timer);
      reject(
        new Error(`中断子进程提前退出：stdout=${stdout.slice(-400)} stderr=${stderr.slice(-800)}`),
      );
    });
  });

  // 给写入留出"阻塞在行锁上"的时间：子进程此时正卡在恢复写入里，
  // SIGKILL 落在**写入途中** ⇒ 事务回滚（不留半截数据）。
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1500);
  });

  // 真实进程中断：SIGKILL（不给清理机会）
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    setTimeout(() => resolve(), 10_000);
  });

  // 观察留下的事实
  const rows: unknown = await ctx.dataSource.query(
    'SELECT fault_description FROM repair_request WHERE owner_organization_id = ? ORDER BY id',
    [scope.organizationId],
  );
  const descriptions = (rows as Array<{ fault_description: string | null }>).map(
    (row) => row.fault_description,
  );
  const mutated = descriptions.filter((value) => value === 'MUTATED-AFTER-BACKUP').length;
  const restored = descriptions.filter((value) => value !== 'MUTATED-AFTER-BACKUP').length;
  // 不留半截：要么全部仍是"改后的值"（未提交/已回滚），要么全部是"备份时刻的值"（整批提交）
  const noPartialWrite = mutated === 0 || restored === 0;

  const holds = await ctx.writeHold.listActive({
    installationId: scope.installationId,
    organizationId: scope.organizationId,
  });
  const runRows: unknown = await ctx.dataSource.query(
    'SELECT status FROM backup_restore_run WHERE restore_id = ?',
    [restoreId],
  );
  const runStatus = String((runRows as Array<{ status: string }>)[0]?.status ?? 'UNKNOWN');

  return {
    restoreId,
    noPartialWrite,
    detail: `mutated=${mutated} restored=${restored} total=${descriptions.length}（不得两者并存）`,
    holdRetained: holds.length > 0,
    holdDetail: `活动冻结=${holds.length}`,
    runStatus,
  };
}

/**
 * 本机授权凭据指纹（`local_account_authorization`）。
 *
 * 该表**不在受保护备份范围**内 ⇒ 恢复不得改动任何授权行
 * （不恢复旧 Token／旧等级／旧撤权状态）。
 */
async function authorizationFingerprint(dataSource: DataSource): Promise<string> {
  const rows: unknown = await dataSource.query(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CRC32(CONCAT_WS('|', account_id, organization_id, " +
      'authorization_status, permission_version))), 0) AS digest ' +
      'FROM local_account_authorization',
  );
  const first = (rows as Array<{ total: number; digest: number }>)[0];
  return `${first?.total ?? 0}:${first?.digest ?? 0}`;
}

/**
 * 读回恢复终态事件（**任务 10 读侧契约**）。
 *
 * 验证：恢复 ID、公司、操作者、真实终态、阶段可被读回；
 * 一级（全公司）与二级（本公司）范围口径正确；跨公司读不到。
 */
async function readBackRestoreEvents(
  ctx: ChainContext,
  scope: RunScope,
  restoreId: string,
): Promise<{
  levelOne: number;
  levelTwoOwn: number;
  levelTwoOther: number;
  projected: { reason?: string; stage?: string } | null;
  result: string | null;
  organizationId: number | null;
  actorAccountId: number | null;
}> {
  const pagination = { page: 1, pageSize: 50, withTotal: false } as never;
  const levelOne = await ctx.auditEventQuery.listEvents({
    organizationId: null,
    pagination,
  });
  const levelTwoOwn = await ctx.auditEventQuery.listEvents({
    organizationId: scope.organizationId,
    pagination,
  });
  // 另一个公司（二级管理员视角）读本公司事件 ⇒ 必须读不到
  const levelTwoOther = await ctx.auditEventQuery.listEvents({
    organizationId: scope.organizationId + 1,
    pagination,
  });
  const all = [...levelOne.items, ...levelTwoOwn.items];
  const hit = all.find((item) => item.targetId === restoreId);
  // 查询服务返回的 detail **已是**任务 10 白名单投影（读侧口径）
  const projected = hit?.detail ?? null;
  return {
    levelOne: levelOne.items.filter((item) => item.targetId === restoreId).length,
    levelTwoOwn: levelTwoOwn.items.filter((item) => item.targetId === restoreId).length,
    levelTwoOther: levelTwoOther.items.filter((item) => item.targetId === restoreId).length,
    projected,
    result: hit?.result ?? null,
    organizationId: hit?.organizationId ?? null,
    actorAccountId: hit?.actorAccountId ?? null,
  };
}

/** 取本公司的一条报修原稿（首析状态推进的写入对象） */
async function findTargetCompanyIntakeId(
  dataSource: DataSource,
  organizationId: number,
): Promise<number | null> {
  const rows: unknown = await dataSource.query(
    'SELECT id FROM repair_request_intake WHERE service_organization_id = ? ORDER BY id LIMIT 1',
    [organizationId],
  );
  const first = (rows as Array<{ id: number }>)[0];
  return first?.id ?? null;
}

/**
 * 后台回写路径（首析代次推进）在**当前冻结状态下**的真实结果。
 *
 * 走**生产代码路径**（`IntakeAnalysisService.bumpAnalysisGenerationForRetry`）：
 * 守卫在写入之前判定 ⇒ 冻结期抛受控错误；无冻结时正常执行。
 */
async function attemptBackgroundWrite(
  ctx: ChainContext,
  scope: RunScope,
): Promise<{ rejected: boolean; allowed: boolean; detail: string }> {
  const intakeId = await findTargetCompanyIntakeId(ctx.dataSource, scope.organizationId);
  if (intakeId === null) {
    return { rejected: false, allowed: false, detail: '本公司没有报修原稿，无法取证' };
  }
  try {
    await ctx.transactionRunner.run(async (transactionContext) => {
      await ctx.intakeAnalysis.bumpAnalysisGenerationForRetry({
        intakeId,
        transactionContext,
      });
    });
    return {
      rejected: false,
      allowed: true,
      detail: `intakeId=${intakeId} 未被拒绝（无活动冻结）`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      rejected: true,
      allowed: false,
      detail: `intakeId=${intakeId} 被拒：${message}`,
    };
  }
}

/** 冻结期：后台回写必须被拒 */
async function assertBackgroundWriteRejected(
  ctx: ChainContext,
  scope: RunScope,
): Promise<{ rejected: boolean; detail: string }> {
  const result = await attemptBackgroundWrite(ctx, scope);
  return { rejected: result.rejected, detail: result.detail };
}

/** 解除冻结后：后台回写必须可继续 */
async function assertBackgroundWriteAllowed(
  ctx: ChainContext,
  scope: RunScope,
): Promise<{ allowed: boolean; detail: string }> {
  const result = await attemptBackgroundWrite(ctx, scope);
  return { allowed: result.allowed, detail: result.detail };
}

/**
 * 把本公司的一条工单标记为删除（**夹具**：模拟"备份之后用户删除了记录"）。
 */
async function markOneCompanyRequestDeleted(
  dataSource: DataSource,
  organizationId: number,
): Promise<number> {
  const rows: unknown = await dataSource.query(
    'SELECT id FROM repair_request WHERE owner_organization_id = ? AND deleted_at IS NULL ' +
      'AND is_accepted = 0 AND handling_status IS NULL ORDER BY id LIMIT 1',
    [organizationId],
  );
  const first = (rows as Array<{ id: number }>)[0];
  if (first === undefined) {
    throw new Error('本公司没有可标记删除的工单，无法取证');
  }
  // 库级 CHECK `chk_repair_request_deletion_consistency`：
  // deprecated = 1 ⇒ deleted_at 非空且 is_accepted = 0（三者必须同时改）
  await dataSource.query(
    'UPDATE repair_request SET deprecated = 1, deleted_at = NOW(), is_accepted = 0, ' +
      'accepted_by_engineer_account_id = NULL, accepted_at = NULL WHERE id = ?',
    [first.id],
  );
  return first.id;
}

/** 该工单当前是否仍为删除态 */
async function isRequestStillDeleted(dataSource: DataSource, requestId: number): Promise<boolean> {
  const rows: unknown = await dataSource.query(
    'SELECT deleted_at FROM repair_request WHERE id = ?',
    [requestId],
  );
  const first = (rows as Array<{ deleted_at: Date | null }>)[0];
  return first !== undefined && first.deleted_at !== null;
}

/** 复原夹具的删除标记（避免污染后续场景） */
async function restoreRequestDeletedFlag(dataSource: DataSource, requestId: number): Promise<void> {
  await dataSource.query(
    'UPDATE repair_request SET deprecated = 0, deleted_at = NULL, is_accepted = 0, ' +
      'accepted_by_engineer_account_id = NULL, accepted_at = NULL WHERE id = ?',
    [requestId],
  );
}

/** 造一份可恢复的本机备份（真实生成受保护包），并登记为本轮对象 */
async function createBackup(
  ctx: ChainContext,
  scope: RunScope,
  session: UsecaseSession,
): Promise<string> {
  const backup = await ctx.startManualBackup.execute({ session });
  if (backup.status !== 'SUCCEEDED' || backup.backupId === null) {
    throw new Error(`准备恢复用的备份失败：status=${backup.status}`);
  }
  scope.ownedBackupIds.add(backup.backupId);
  const asset = await ctx.dataSource
    .getRepository(BackupAssetEntity)
    .findOne({ where: { backupId: backup.backupId } });
  if (asset?.localReference !== null && asset?.localReference !== undefined) {
    scope.ownedFilePaths.add(asset.localReference);
  }
  return backup.backupId;
}

/**
 * 收尾：按**先子后父**删除本轮创建的数据库对象，并按精确清单删除本轮文件。
 *
 * 数据库删除在**同一事务**内完成；文件删除不可回滚，因此逐条留痕。
 */
async function cleanupRunArtifacts(
  ctx: ChainContext,
  scope: RunScope,
  beforeIds: ReadonlyMap<string, Set<string>>,
): Promise<{ deleted: string[]; failed: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];

  // 1) 计算本轮新建的对象（after \ before）
  const targets: DatabaseDeletionTarget[] = [];
  for (const managed of MANAGED_TABLES) {
    const before = beforeIds.get(managed.table) ?? new Set<string>();
    const after = await snapshotIds(ctx.dataSource, managed.table, managed.idColumn);
    for (const id of after) {
      if (before.has(id)) {
        continue;
      }
      targets.push({
        table: managed.table,
        idColumn: managed.idColumn,
        id,
        ownership: `${managed.table}.${managed.idColumn}=${id}`,
      });
    }
  }

  // 2) 外部引用预检（本轮之外的引用一律拦下，不靠外键最后报错）
  const ownedRestoreIds = new Set(
    targets.filter((item) => item.table === 'backup_restore_run').map((item) => item.id),
  );
  const ownedBackupIds = new Set(
    targets.filter((item) => item.table === 'backup_asset').map((item) => item.id),
  );
  const restoreRefs: unknown = await ctx.dataSource.query(
    'SELECT restore_id, backup_id, protection_backup_id FROM backup_restore_run',
  );
  const runRefs: unknown = await ctx.dataSource.query(
    'SELECT backup_id, run_id, local_cleanup_run_id FROM backup_asset',
  );
  for (const target of targets) {
    if (target.table === 'backup_asset') {
      const references = (restoreRefs as Array<Record<string, unknown>>)
        .filter(
          (row) =>
            String(row['backup_id']) === target.id ||
            asText(row['protection_backup_id']) === target.id,
        )
        .map((row) => ({
          ownerTable: 'backup_restore_run',
          ownerId: String(row['restore_id']),
          referencedTable: 'backup_asset',
          referencedId: target.id,
        }));
      assertNoExternalReference(
        references,
        'backup_asset',
        target.id,
        [...ownedRestoreIds].map((id) => `backup_restore_run::${id}`),
      );
    }
    if (target.table === 'local_backup_run') {
      const references = (runRefs as Array<Record<string, unknown>>)
        .filter(
          (row) =>
            asText(row['run_id']) === target.id ||
            asText(row['local_cleanup_run_id']) === target.id,
        )
        .map((row) => ({
          ownerTable: 'backup_asset',
          ownerId: String(row['backup_id']),
          referencedTable: 'local_backup_run',
          referencedId: target.id,
        }));
      assertNoExternalReference(
        references,
        'local_backup_run',
        target.id,
        [...ownedBackupIds].map((id) => `backup_asset::${id}`),
      );
    }
  }

  // 3) 数据库删除：同一事务内，先子后父
  const plan = planDatabaseDeletion(targets);
  await ctx.dataSource.transaction(async (manager: EntityManager) => {
    for (const target of plan) {
      await manager.query(`DELETE FROM \`${target.table}\` WHERE \`${target.idColumn}\` = ?`, [
        target.id,
      ]);
      deleted.push(`${target.table}#${target.id}`);
    }
  });

  // 4) 文件删除：受控根内**精确清单**
  const files = listFilesUnder(scope.runRoot);
  const deletion = deleteFilesByList(files, scope.runRoot);
  for (const item of deletion.deleted) {
    deleted.push(`file:${item}`);
  }
  for (const item of deletion.failed) {
    failed.push(`file:${item.path}:${item.reason}`);
  }
  pruneEmptyDirs(scope.runRoot, scope.fileRoot);
  if (existsSync(scope.runRoot)) {
    errors.push(`本轮运行目录未清空：${scope.runRoot}`);
  }
  return { deleted, failed, errors };
}

async function main(): Promise<void> {
  // ── 0. 安全入口：默认拒绝（缺任何一项授权即零写入退出）──
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const authorization = readSelfcheckAuthorization(process.env);
  const fileRoot = assertControlledFileRoot(authorization.fileRoot);
  const runId = randomUUID();
  const runRoot = join(fileRoot, runId);
  const backupRoot = join(runRoot, 'backups');
  const referenceRoot = join(runRoot, 'references');
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(referenceRoot, { recursive: true });

  const scope: RunScope = {
    runId,
    fileRoot,
    runRoot,
    backupRoot,
    referenceRoot,
    envFile: authorization.envFile,
    database: authorization.database,
    expectedHost: authorization.expectedHost,
    expectedPort: authorization.expectedPort,
    expectedServerUuid: authorization.expectedServerUuid,
    disposableMarker: authorization.disposableMarker,
    testAuthorization: authorization.testAuthorization,
    installationId: authorization.installationId,
    organizationId: authorization.organizationId,
    superAdminAccountId: 0,
    engineerAccountId: 0,
    ownedBackupIds: new Set<string>(),
    ownedRestoreIds: new Set<string>(),
    ownedHoldIds: new Set<string>(),
    ownedFilePaths: new Set<string>(),
    createdSettingId: null,
    createdAuthorizationId: null,
  };

  let ctx: ChainContext | null = null;
  let mainError: unknown = null;
  let mainFailed = false;
  const cleanupErrors: string[] = [];
  const deletedArtifacts: string[] = [];
  const failedArtifacts: string[] = [];
  const beforeIds = new Map<string, Set<string>>();

  try {
    ctx = await bootstrap(scope);

    // ── 1. 实例身份 / 一次性库标识 / 安装与公司核对 ──
    const actualRows: unknown = await ctx.dataSource.query(
      'SELECT DATABASE() AS current_database, @@server_uuid AS server_uuid',
    );
    const actual = (actualRows as Array<Record<string, unknown>>)[0] ?? {};
    const options = ctx.dataSource.options as { host?: string; port?: number };
    assertServerIdentity(
      {
        database: asText(actual['current_database']),
        serverUuid: asText(actual['server_uuid']),
        host: String(options.host ?? ''),
        port: Number(options.port ?? 0),
      },
      authorization,
    );
    assertDisposableMarker(
      await readDisposableMarkerRows(ctx.dataSource),
      authorization.disposableMarker,
    );

    const installation = await ctx.dataSource
      .getRepository(LocalInstallationEntity)
      .findOne({ where: {} });
    if (installation === null) {
      throw new SelfcheckSafetyError(
        'MISSING_INSTALLATION',
        '隔离库缺少本机安装身份，无法执行恢复自检。',
      );
    }
    if (installation.installationId.toLowerCase() !== authorization.installationId) {
      throw new SelfcheckSafetyError(
        'INSTALLATION_MISMATCH',
        `安装标识与声明不一致：实际 ${installation.installationId}，声明 ${authorization.installationId}`,
      );
    }
    if (installation.organizationId !== authorization.organizationId) {
      throw new SelfcheckSafetyError(
        'ORGANIZATION_MISMATCH',
        `公司数据区与声明不一致：实际 ${String(installation.organizationId)}，声明 ${authorization.organizationId}`,
      );
    }

    const actors = await resolveScopeActors(ctx.dataSource, authorization.organizationId);
    scope.superAdminAccountId = actors.superAdminAccountId;
    scope.engineerAccountId = actors.engineerAccountId;

    // ── 2. 运行前预检：预存冻结 / 既有授权 / 既有设置一律拦下 ──
    const existingHolds = await readExistingHolds(
      ctx.dataSource,
      authorization.installationId,
      authorization.organizationId,
    );
    assertNoForeignActiveHold(
      existingHolds,
      authorization.installationId,
      authorization.organizationId,
    );
    const existingAuthorizations = await readExistingAuthorizations(
      ctx.dataSource,
      authorization.installationId,
      authorization.organizationId,
    );
    assertAuthorizationNotOverwritable(
      existingAuthorizations,
      authorization.installationId,
      authorization.organizationId,
      actors.superAdminAccountId,
    );

    // ── 3. 合成哨兵（非目标账号授权 / 非目标范围冻结 / 其他公司数据与文件）──
    //    哨兵必须在**快照之前**建立：它是"本轮之前就存在的非目标对象"，
    //    收尾时按 after \ before 计算 ⇒ 哨兵天然不会被本轮清理删除。
    const sentinelDir = join(fileRoot, 'sentinels');
    mkdirSync(sentinelDir, { recursive: true });
    const sentinelFile = join(sentinelDir, `${runId}.sentinel`);
    writeFileSync(sentinelFile, `task09 sentinel ${runId}\n`, 'utf8');
    const sentinelAuthorizationRepository = ctx.dataSource.getRepository(
      LocalAccountAuthorizationEntity,
    );
    // 哨兵授权：按 (安装, 账号, 公司) 唯一键**幂等**建立
    // （已存在则复用：哨兵要的是"非目标账号的授权行"，不要求一定由本轮新建）。
    const sentinelAuthorizationScope = {
      installationId: authorization.installationId,
      accountId: actors.engineerAccountId,
      organizationId: authorization.organizationId,
    };
    const sentinelAuthorizationExisting = await sentinelAuthorizationRepository.findOne({
      where: sentinelAuthorizationScope,
    });
    const sentinelAuthorization =
      sentinelAuthorizationExisting ??
      (await sentinelAuthorizationRepository.save(
        sentinelAuthorizationRepository.create({
          ...sentinelAuthorizationScope,
          authorizationStatus: 'ACTIVE',
          authorizedAt: new Date(),
          revokedAt: null,
          signedClaims: { purpose: ['CLOUD_BACKUP'], issuer: 'task09-sentinel' },
          permissionVersion: 1,
          lastVerifiedAt: new Date(),
        }),
      ));
    // 非目标范围的冻结（外公司）：本轮任何"按范围释放"都不得动它
    const sentinelHoldOrganizationId = await resolveSentinelHoldOrganization(
      ctx.dataSource,
      authorization.organizationId,
    );
    const sentinelHold = await ctx.writeHold.hold({
      installationId: authorization.installationId,
      organizationId: sentinelHoldOrganizationId,
      restoreId: null,
      reason: '任务09 哨兵冻结（非目标范围）',
    });
    const sentinelsBefore: SentinelSnapshot[] = [
      {
        label: 'foreign-company',
        fingerprint: await foreignCompanyFingerprint(ctx.dataSource, authorization.organizationId),
      },
      { label: 'sentinel-authorization', fingerprint: `${sentinelAuthorization.id}:ACTIVE` },
      { label: 'sentinel-hold', fingerprint: `${sentinelHold.holdId}:ACTIVE` },
      { label: 'sentinel-file', fingerprint: existsSync(sentinelFile) ? 'present' : 'missing' },
    ];

    // ── 4. 快照本轮之前的主键（收尾时只删 after \ before）──
    for (const managed of MANAGED_TABLES) {
      beforeIds.set(
        managed.table,
        await snapshotIds(ctx.dataSource, managed.table, managed.idColumn),
      );
    }

    // ── 5. 夹具（本轮新建，不覆盖既有）──
    await ensureFixtures(ctx, scope);

    const admin = superAdminSession(scope.superAdminAccountId);
    const engineer = engineerSession(scope.engineerAccountId);

    // ── 场景 1：原机成功恢复（预检 → 受理 → 执行）──
    const foreignBefore = await foreignCompanyFingerprint(
      ctx.dataSource,
      authorization.organizationId,
    );
    const authorizationBefore = await authorizationFingerprint(ctx.dataSource);
    const backupId = await createBackup(ctx, scope, admin);
    const precheck = await ctx.precheck.execute({ session: admin, backupId });
    scope.ownedRestoreIds.add(precheck.restoreId);
    check(
      '原机成功恢复：预检通过并生成保护副本',
      precheck.outcome === 'PASSED' && precheck.snapshot.protection.backupId !== null,
      `outcome=${precheck.outcome} protection=${precheck.snapshot.protection.backupId ?? 'null'} findings=${precheck.snapshot.findings.length}`,
    );
    const accepted = await ctx.accept.execute({ session: admin, restoreId: precheck.restoreId });
    check('原机成功恢复：受理成功', accepted.accepted === true, `accepted=${accepted.accepted}`);
    const beforeRestore = await targetCompanyFingerprint(
      ctx.dataSource,
      authorization.organizationId,
    );
    const originalsBefore = originalsFingerprint(ctx.originalsDir);
    const execution = await ctx.execute.execute({ session: admin, restoreId: precheck.restoreId });
    check(
      '原机成功恢复：执行成功并解除冻结',
      execution.status === 'SUCCEEDED' &&
        execution.released === true &&
        execution.holdRetained === false,
      `status=${execution.status} released=${execution.released} holdRetained=${execution.holdRetained} reason=${execution.reasonCode ?? 'null'} ${execution.reason ?? ''}`,
    );
    check(
      '原机成功恢复：逐项恢复计数非空',
      execution.restored !== null && execution.restored.records > 0,
      `restored=${JSON.stringify(execution.restored)}`,
    );
    // 原件字节级核对：逐件比对相对路径、字节数与 SHA-256（只数件数不算证据）
    const originalsAfter = originalsFingerprint(ctx.originalsDir);
    check(
      '原机成功恢复：原件字节级还原一致（逐件 sha256 与字节数一致）',
      originalsBefore === originalsAfter && originalsBefore.length > 0,
      `before=${originalsBefore} after=${originalsAfter}`,
    );
    const holds = await ctx.writeHold.listActive({
      installationId: scope.installationId,
      organizationId: scope.organizationId,
    });
    check('原机成功恢复：冻结已解除（无活动冻结）', holds.length === 0, `holds=${holds.length}`);
    const afterRestore = await targetCompanyFingerprint(
      ctx.dataSource,
      authorization.organizationId,
    );
    check(
      '原机成功恢复：目标数据与恢复前一致（整表替换后的真实内容一致）',
      beforeRestore === afterRestore,
      `before=${beforeRestore} after=${afterRestore}`,
    );
    const authorizationAfter = await authorizationFingerprint(ctx.dataSource);
    check(
      '现有权限凭据不被旧包复活（授权行不在备份范围，恢复前后完全一致）',
      authorizationBefore === authorizationAfter,
      `before=${authorizationBefore} after=${authorizationAfter}`,
    );

    // ── 读回：任务 10 的 `managementAuditEvents` 能读到本次恢复终态 ──
    const readBack = await readBackRestoreEvents(ctx, scope, precheck.restoreId);
    check(
      '恢复终态事件可被任务 10 读回（恢复 ID／公司／操作者／终态）',
      readBack.levelOne === 1 &&
        readBack.levelTwoOwn === 1 &&
        readBack.levelTwoOther === 0 &&
        readBack.result === 'SUCCEEDED' &&
        readBack.organizationId === authorization.organizationId &&
        readBack.actorAccountId === scope.superAdminAccountId,
      `level1=${readBack.levelOne} level2Own=${readBack.levelTwoOwn} level2Other=${readBack.levelTwoOther} ` +
        `result=${readBack.result} org=${readBack.organizationId} actor=${readBack.actorAccountId}`,
    );
    check(
      '恢复终态事件的阶段与原因可读（白名单字段双方一致）',
      readBack.projected?.stage === 'RESTORE_SUCCEEDED' && readBack.projected?.reason === undefined,
      `projected=${JSON.stringify(readBack.projected)}`,
    );
    const foreignAfter = await foreignCompanyFingerprint(
      ctx.dataSource,
      authorization.organizationId,
    );
    check(
      '外公司哨兵：恢复未触碰外公司数据',
      foreignBefore === foreignAfter,
      `before=${foreignBefore} after=${foreignAfter}`,
    );

    // ── 场景 2：异机拒绝（资产的安装标识不属于本机）──
    await releaseRunHolds(ctx, scope);
    const otherBackupId = await createBackup(ctx, scope, admin);
    await ctx.dataSource
      .getRepository(BackupAssetEntity)
      .update(
        { backupId: otherBackupId },
        { installationId: '00000000-0000-4000-8000-000000000000' },
      );
    const otherPrecheck = await ctx.precheck.execute({ session: admin, backupId: otherBackupId });
    check(
      '异机拒绝：预检不通过',
      otherPrecheck.outcome === 'FAILED',
      `outcome=${otherPrecheck.outcome} findings=${otherPrecheck.snapshot.findings.map((f) => f.code).join(',')}`,
    );

    // ── 场景 3：工程师拒绝（无恢复权限）──
    let engineerRejected = false;
    let engineerReason = '未被拒绝';
    try {
      await ctx.precheck.execute({ session: engineer, backupId });
    } catch (error) {
      engineerRejected = true;
      engineerReason = error instanceof Error ? error.message : String(error);
    }
    check('工程师拒绝：预检被拒', engineerRejected, engineerReason);

    // ── 场景 4：失败保持冻结（写入失败 ＋ 回滚失败 ⇒ 设备仍停写停传）──
    await releaseRunHolds(ctx, scope);
    const failingBackupId = await createBackup(ctx, scope, admin);
    const failingPrecheck = await ctx.precheck.execute({
      session: admin,
      backupId: failingBackupId,
    });
    scope.ownedRestoreIds.add(failingPrecheck.restoreId);
    const protectionBackupId = failingPrecheck.snapshot.protection.backupId;
    await ctx.accept.execute({ session: admin, restoreId: failingPrecheck.restoreId });
    // 破坏待恢复包 ⇒ 写入阶段失败
    await removePackageDirectory(ctx, scope, failingBackupId);
    if (protectionBackupId !== null) {
      scope.ownedBackupIds.add(protectionBackupId);
      const protectionAsset = await ctx.dataSource
        .getRepository(BackupAssetEntity)
        .findOne({ where: { backupId: protectionBackupId } });
      const protectionPath = protectionAsset?.localReference ?? null;
      if (protectionPath !== null) {
        assertPathWithinRoot(scope.backupRoot, protectionPath);
        scope.ownedFilePaths.add(protectionPath);
        rmSync(protectionPath, { recursive: true, force: true });
      }
    }
    const failingExecution = await ctx.execute.execute({
      session: admin,
      restoreId: failingPrecheck.restoreId,
    });
    check(
      '失败保持冻结：执行失败且保持冻结',
      failingExecution.status === 'FAILED' && failingExecution.holdRetained === true,
      `status=${failingExecution.status} holdRetained=${failingExecution.holdRetained} reason=${failingExecution.reasonCode ?? 'null'} ${failingExecution.reason ?? ''}`,
    );
    let writeRejected = false;
    let writeReason = '未被拒绝';
    try {
      await ctx.writeHold.assertBusinessWritable({ organizationId: scope.organizationId });
    } catch (error) {
      writeRejected = true;
      writeReason = error instanceof Error ? error.message : String(error);
    }
    check('失败保持冻结：本公司业务写入被冻结拒绝', writeRejected, writeReason);

    // ── 场景 4b：**后台回写路径**（首析状态推进）在冻结期被拒 ──
    const backgroundWriteRejected = await assertBackgroundWriteRejected(ctx, scope);
    check(
      '恢复期间后台回写被拒（首析状态推进受冻结守卫拦截）',
      backgroundWriteRejected.rejected,
      backgroundWriteRejected.detail,
    );

    // ── 场景 5：重启识别（冻结事实落库 ⇒ 换进程仍可识别）──
    const persisted: unknown = await ctx.dataSource.query(
      'SELECT COUNT(*) AS total FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?',
      [scope.installationId, scope.organizationId, 'ACTIVE'],
    );
    const persistedCount = (persisted as Array<{ total: number }>)[0]?.total ?? 0;
    check(
      '重启识别：冻结事实已落库（换进程仍可识别）',
      persistedCount > 0,
      `local_write_hold 活动行=${persistedCount}`,
    );

    // ── 场景 5b：解除冻结后，后台回写**可继续** ──
    await releaseRunHolds(ctx, scope);
    const afterRelease = await assertBackgroundWriteAllowed(ctx, scope);
    check(
      '解除冻结后后台回写可继续（冻结只拦截恢复期，不永久禁用）',
      afterRelease.allowed,
      afterRelease.detail,
    );

    // ── 场景 6：写入失败但**回滚成功** ⇒ 业务回到恢复前事实，冻结解除 ──
    await releaseRunHolds(ctx, scope);
    const rollbackBackupId = await createBackup(ctx, scope, admin);
    const rollbackPrecheck = await ctx.precheck.execute({
      session: admin,
      backupId: rollbackBackupId,
    });
    scope.ownedRestoreIds.add(rollbackPrecheck.restoreId);
    await ctx.accept.execute({ session: admin, restoreId: rollbackPrecheck.restoreId });
    const beforeRollback = await targetCompanyFingerprint(ctx.dataSource, scope.organizationId);
    await removePackageDirectory(ctx, scope, rollbackBackupId);
    const rollbackExecution = await ctx.execute.execute({
      session: admin,
      restoreId: rollbackPrecheck.restoreId,
    });
    const afterRollback = await targetCompanyFingerprint(ctx.dataSource, scope.organizationId);
    check(
      '写入失败但回滚成功：终态 FAILED 且冻结已解除',
      rollbackExecution.status === 'FAILED' && rollbackExecution.holdRetained === false,
      `status=${rollbackExecution.status} holdRetained=${rollbackExecution.holdRetained} reason=${rollbackExecution.reasonCode ?? 'null'} ${rollbackExecution.reason ?? ''}`,
    );
    check(
      '写入失败但回滚成功：业务数据回到恢复前事实',
      beforeRollback === afterRollback,
      `before=${beforeRollback} after=${afterRollback}`,
    );
    const failureReadBack = await readBackRestoreEvents(ctx, scope, rollbackPrecheck.restoreId);
    check(
      '失败终态事件可被任务 10 读回（真实失败终态 ＋ 阶段 ＋ 原因）',
      failureReadBack.levelOne === 1 &&
        failureReadBack.result === 'FAILED' &&
        failureReadBack.projected?.stage === 'RESTORE_ROLLED_BACK' &&
        typeof failureReadBack.projected?.reason === 'string',
      `level1=${failureReadBack.levelOne} result=${failureReadBack.result} ` +
        `projected=${JSON.stringify(failureReadBack.projected)}`,
    );

    // ── 场景 7：备份之后才被删除的记录，**不得被旧包复活** ──
    await releaseRunHolds(ctx, scope);
    const revivedBackupId = await createBackup(ctx, scope, admin);
    const revivedPrecheck = await ctx.precheck.execute({
      session: admin,
      backupId: revivedBackupId,
    });
    scope.ownedRestoreIds.add(revivedPrecheck.restoreId);
    await ctx.accept.execute({ session: admin, restoreId: revivedPrecheck.restoreId });
    const targetRequest = await markOneCompanyRequestDeleted(ctx.dataSource, scope.organizationId);
    const revivedExecution = await ctx.execute.execute({
      session: admin,
      restoreId: revivedPrecheck.restoreId,
    });
    const stillDeleted = await isRequestStillDeleted(ctx.dataSource, targetRequest);
    check(
      '备份后被删除的记录不被旧包复活（恢复后仍为删除态）',
      revivedExecution.status === 'SUCCEEDED' && stillDeleted,
      `status=${revivedExecution.status} requestId=${targetRequest} stillDeleted=${stillDeleted}`,
    );
    await restoreRequestDeletedFlag(ctx.dataSource, targetRequest);

    // ── 场景 8：**进程中断**（真实 SIGKILL 子进程）──
    await releaseRunHolds(ctx, scope);
    const interrupted = await runInterruptScenario(ctx, scope);
    scope.ownedRestoreIds.add(interrupted.restoreId);
    check(
      '进程中断：业务数据不留半截（要么未提交、要么整批提交）',
      interrupted.noPartialWrite,
      interrupted.detail,
    );
    check(
      '进程中断：冻结事实仍在（设备继续停写停传）',
      interrupted.holdRetained,
      interrupted.holdDetail,
    );
    check(
      '进程中断：恢复运行行停在 RUNNING（结果未知，未伪装成功）',
      interrupted.runStatus === 'RUNNING',
      `status=${interrupted.runStatus}`,
    );
    const recovery = await ctx.execute.execute({
      session: admin,
      restoreId: interrupted.restoreId,
    });
    check(
      '进程中断后重新执行可收口（结果未知可恢复）',
      recovery.status === 'SUCCEEDED' || recovery.status === 'FAILED',
      `status=${recovery.status} reason=${recovery.reasonCode ?? 'null'}`,
    );
    const retryReadBack = await readBackRestoreEvents(ctx, scope, interrupted.restoreId);
    check(
      '重试执行不产生重复终态事件（同一恢复 ID ＋ 终态只留一条）',
      retryReadBack.levelOne === 1,
      `level1=${retryReadBack.levelOne} result=${retryReadBack.result}`,
    );
    await releaseRunHolds(ctx, scope);

    // ── 6. 哨兵核对：非目标对象必须原样 ──
    const sentinelHoldStill: unknown = await ctx.dataSource.query(
      'SELECT status FROM local_write_hold WHERE hold_id = ?',
      [sentinelHold.holdId],
    );
    const sentinelsAfter: SentinelSnapshot[] = [
      {
        label: 'foreign-company',
        fingerprint: await foreignCompanyFingerprint(ctx.dataSource, authorization.organizationId),
      },
      { label: 'sentinel-authorization', fingerprint: `${sentinelAuthorization.id}:ACTIVE` },
      {
        label: 'sentinel-hold',
        fingerprint: `${sentinelHold.holdId}:${String((sentinelHoldStill as Array<{ status: string }>)[0]?.status ?? 'missing')}`,
      },
      { label: 'sentinel-file', fingerprint: existsSync(sentinelFile) ? 'present' : 'missing' },
    ];
    assertSentinelsUnchanged(sentinelsBefore, sentinelsAfter);
    check(
      '非目标哨兵在整轮后保持不变（外公司数据／他人授权／他人冻结／他人文件）',
      true,
      `sentinels=${sentinelsAfter.map((item) => item.label).join(',')}`,
    );
  } catch (error: unknown) {
    mainError = error;
    mainFailed = true;
  } finally {
    // ── 收尾：只删本轮对象；失败不吞异常 ──
    if (ctx !== null) {
      try {
        // 释放**本轮**冻结（不碰他人的）
        await releaseRunHolds(ctx, scope);
      } catch (error: unknown) {
        cleanupErrors.push(
          `释放本轮冻结失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        const outcome = await cleanupRunArtifacts(ctx, scope, beforeIds);
        deletedArtifacts.push(...outcome.deleted);
        failedArtifacts.push(...outcome.failed);
        cleanupErrors.push(...outcome.errors);
      } catch (error: unknown) {
        cleanupErrors.push(
          `清理本轮对象失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await ctx.dataSource.destroy();
      } catch (error: unknown) {
        cleanupErrors.push(
          `关闭数据库连接失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      // 仅建立数据源前失败：也不得遗留不明临时文件
      try {
        const files = existsSync(scope.runRoot) ? listFilesUnder(scope.runRoot) : [];
        const outcome = deleteFilesByList(files, scope.runRoot);
        deletedArtifacts.push(...outcome.deleted);
        failedArtifacts.push(...outcome.failed.map((item) => `file:${item.path}:${item.reason}`));
        pruneEmptyDirs(scope.runRoot, scope.fileRoot);
      } catch (error: unknown) {
        cleanupErrors.push(
          `清理本轮运行目录失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const finalError =
    mainFailed || cleanupErrors.length > 0 || failedArtifacts.length > 0
      ? buildCleanupError(mainFailed ? mainError : null, {
          errors: cleanupErrors,
          deleted: deletedArtifacts,
          failed: failedArtifacts,
        })
      : null;

  const failed = assertions.filter((item) => !item.passed);
  // 结果用**单行标记**输出：日志（pino）也走 stdout，标记便于从混合输出里精确取回。
  process.stdout.write(
    `TASK09_SELFCHECK_RESULT ${JSON.stringify({
      runId: scope.runId,
      database: scope.database,
      installationId: scope.installationId,
      organizationId: scope.organizationId,
      assertions: assertions.map((item) => ({
        name: item.name,
        passed: item.passed,
        detail: item.detail,
      })),
      passed: failed.length === 0 && finalError === null,
      total: assertions.length,
      failedCount: failed.length,
      cleanup: {
        deletedCount: deletedArtifacts.length,
        failed: failedArtifacts,
        errors: cleanupErrors,
      },
    })}\n`,
  );
  if (finalError !== null) {
    throw finalError instanceof Error ? finalError : new Error(asText(finalError));
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  const cleanupErrors = (error as { cleanupErrors?: ReadonlyArray<string> }).cleanupErrors;
  if (cleanupErrors !== undefined) {
    process.stderr.write(`cleanupErrors: ${cleanupErrors.join(' | ')}\n`);
  }
  process.exitCode = 1;
});
