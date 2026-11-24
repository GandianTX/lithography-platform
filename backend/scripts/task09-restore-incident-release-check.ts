// scripts/task09-restore-incident-release-check.ts

/**
 * 任务 09 · 恢复故障现场受控解冻入口的**真实库取证**（独立验收 P2-2）。
 *
 * 目的：在**一次性可丢弃隔离库**上，用**真实表、真实连接、真实服务**验证管理员处置入口
 * 的完整判定矩阵，而不是只跑单测里的替身。
 *
 * 覆盖（计划 05 第 3 条要求的矩阵）：
 * 1. 无权（工程师）；
 * 2. 跨公司（二级管理员处置他公司现场）；
 * 3. 伪造 restoreId；
 * 4. 恢复仍在运行；
 * 5. 已有终态（正常解除）＋重复（幂等）；
 * 6. 失败（解冻动作失败）；
 * 7. 审计失败（解冻与成功审计**同事务** ⇒ 整体回滚：冻结保留、无成功处置事件，
 *    且设备继续停写停传；随后重试成功才恢复写入）；
 * 8. 处置原因落库（管理员填写的真实原因写得进去、也读得回来）；
 * 8. 并发（同一现场并发处置 ⇒ 只解除一次、只留一条"已解除"审计）。
 *
 * 纪律：真实库、真实文件、无 mock；造数按本轮登记的真实主键精确回收，收尾零残留；
 * 断言写"期望行为"；不操作真实故障现场。
 *
 * 用法（与恢复自检同一套显式授权环境变量）：
 *   TASK09_RESTORE_ENV_FILE=... TASK09_RESTORE_DATABASE=... ... \
 *   TASK09_RESTORE_INCIDENT_EVIDENCE_FILE=... \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-restore-incident-release-check.ts
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, Repository } from 'typeorm';

import { projectManagementAuditDetail } from '@core/management-audit/policy/management-audit-detail.policy';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';

import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { BackupAssetEntity } from '@src/modules/lithography/entities/backup-asset.entity';
import { BackupRestoreRunEntity } from '@src/modules/lithography/entities/backup-restore-run.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { LocalWriteHoldEntity } from '@src/modules/lithography/entities/local-write-hold.entity';
import { LocalRestoreIncidentReleaseService } from '@src/modules/lithography/local-restore-incident-release.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { LocalWriteScopeLockService } from '@src/modules/lithography/local-write-scope-lock.service';
import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@usecases/common/ports/transaction-runner.contract';

import {
  assertControlledFileRoot,
  assertDisposableMarker,
  assertServerIdentity,
  holdSentinelFingerprint,
  normalizeOwnedFieldValue,
  readSelfcheckAuthorization,
  type SentinelSnapshot,
} from './task09-restore-selfcheck.safety';
import {
  CleanupIssueLog,
  collectResidue,
  compareSentinelEntries,
  planForensicsCleanupSteps,
  runAtomicForensicsCleanup,
  type ForensicsCleanupStep,
} from './task09-forensics-cleanup.safety';

type AppContext = {
  readonly dataSource: DataSource;
  readonly moduleRef: TestingModule;
  readonly writeHold: LocalWriteHoldService;
  readonly scopeLock: LocalWriteScopeLockService;
  readonly transactionRunner: TransactionRunner;
  readonly audit: ManagementAuditService;
  readonly restoreRunRepository: Repository<BackupRestoreRunEntity>;
  readonly backupAssetRepository: Repository<BackupAssetEntity>;
  readonly installationRepository: Repository<LocalInstallationEntity>;
  readonly holdRepository: Repository<LocalWriteHoldEntity>;
};

const text = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
};

async function bootstrap(envFile: string, database: string): Promise<AppContext> {
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
      LithographyModule,
    ],
  }).compile();
  return {
    dataSource: moduleRef.get(DataSource),
    moduleRef,
    writeHold: moduleRef.get(LocalWriteHoldService),
    scopeLock: moduleRef.get(LocalWriteScopeLockService),
    transactionRunner: moduleRef.get<TransactionRunner>(TRANSACTION_RUNNER),
    audit: moduleRef.get(ManagementAuditService),
    restoreRunRepository: moduleRef.get(getRepositoryToken(BackupRestoreRunEntity)),
    backupAssetRepository: moduleRef.get(getRepositoryToken(BackupAssetEntity)),
    installationRepository: moduleRef.get(getRepositoryToken(LocalInstallationEntity)),
    holdRepository: moduleRef.get(getRepositoryToken(LocalWriteHoldEntity)),
  };
}

function buildService(
  app: AppContext,
  options: { audit?: ManagementAuditService } = {},
): LocalRestoreIncidentReleaseService {
  return new LocalRestoreIncidentReleaseService(
    app.restoreRunRepository,
    app.holdRepository,
    app.backupAssetRepository,
    app.installationRepository,
    app.writeHold,
    app.scopeLock,
    options.audit ?? app.audit,
    new PinoLogger({}),
  );
}

/* ───────────────────────── 造数（全部登记真实主键） ───────────────────────── */

type Registry = {
  readonly accountIds: number[];
  readonly backupRunIds: number[];
  readonly backupIds: string[];
  readonly restoreIds: string[];
  readonly holdIds: string[];
};

async function createAccount(dataSource: DataSource, tag: string): Promise<number> {
  const loginName = `task09-incident-${tag}-${randomUUID().slice(0, 8)}`;
  await dataSource.query(
    'INSERT INTO base_user_account (login_name, login_email, login_password, status, admin_level, ' +
      'account_uuid, credential_version, must_change_password, created_at, updated_at) ' +
      "VALUES (?, ?, 'x', 'ACTIVE', 1, ?, 0, 0, NOW(3), NOW(3))",
    [loginName, `${loginName}@task09.invalid`, randomUUID()],
  );
  const rows: unknown = await dataSource.query(
    'SELECT id FROM base_user_account WHERE login_name = ?',
    [loginName],
  );
  const id = Number((rows as Array<{ id: number | string }>)[0]?.id ?? 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('造数失败：未取得本轮账号 ID');
  }
  return id;
}

async function createBackupRun(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
): Promise<number> {
  await dataSource.query(
    'INSERT INTO local_backup_run (installation_id, organization_id, trigger_type, status, ' +
      'started_at, finished_at, manifest_path, manifest_checksum, byte_size, attachment_count, ' +
      'schema_version, error_code, error_message, created_at, updated_at) ' +
      "VALUES (?, ?, 'MANUAL', 'SUCCEEDED', NOW(3), NOW(3), ?, ?, 1024, 1, 1, NULL, NULL, NOW(3), NOW(3))",
    [installationId, organizationId, 'task09/incident/manifest.json', 'b'.repeat(64)],
  );
  const rows: unknown = await dataSource.query('SELECT LAST_INSERT_ID() AS id');
  const id = Number((rows as Array<{ id: number | string }>)[0]?.id ?? 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('造数失败：未取得本轮备份运行 ID');
  }
  return id;
}

async function createAsset(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
  runId: number,
): Promise<string> {
  const backupId = randomUUID();
  await dataSource.query(
    'INSERT INTO backup_asset (backup_id, run_id, organization_id, installation_id, local_reference, ' +
      'storage_reference, file_sha256, byte_size, cloud_status, local_status, attempt_count, ' +
      'created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, 'task09/incident/pkg', 'task09/incident/pkg', ?, 1024, 'PENDING', 'PENDING', 0, NOW(3), NOW(3))",
    [backupId, runId, organizationId, installationId, 'c'.repeat(64)],
  );
  return backupId;
}

type RestoreRunOptions = {
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
  readonly resultSummary: string | null;
};

async function createRestoreRun(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
  accountId: number,
  backupId: string,
  protectionBackupId: string,
  options: RestoreRunOptions,
): Promise<string> {
  const restoreId = randomUUID();
  const terminal = options.status !== 'PENDING';
  const startedAt = terminal ? 'NOW(3)' : null;
  const finishedAt = options.status === 'PENDING' || options.status === 'RUNNING' ? null : 'NOW(3)';
  await dataSource.query(
    'INSERT INTO backup_restore_run (restore_id, backup_id, protection_backup_id, ' +
      'target_installation_id, check_status, confirmation, organization_id, started_by_account_id, ' +
      'status, check_snapshot, restored_scope, result_summary, started_at, finished_at) ' +
      'VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ' +
      (startedAt === null ? 'NULL' : 'NOW(3)') +
      ', ' +
      (finishedAt === null ? 'NULL' : 'NOW(3)') +
      ')',
    [
      restoreId,
      backupId,
      protectionBackupId,
      installationId,
      organizationId,
      accountId,
      options.status,
      JSON.stringify({ schema_version: 1 }),
      options.resultSummary,
    ],
  );
  return restoreId;
}

async function createHold(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
  restoreId: string,
): Promise<string> {
  const holdId = randomUUID();
  await dataSource.query(
    'INSERT INTO local_write_hold (hold_id, installation_id, organization_id, hold_type, status, ' +
      'restore_id, reason, created_at, updated_at, released_at) ' +
      "VALUES (?, ?, ?, 'RESTORE', 'ACTIVE', ?, '任务09 故障现场处置取证用冻结', NOW(3), NOW(3), NULL)",
    [holdId, installationId, organizationId, restoreId],
  );
  return holdId;
}

/* ───────────────────────── 核对（只读） ───────────────────────── */

async function readHoldStatus(dataSource: DataSource, holdId: string): Promise<string | null> {
  const rows: unknown = await dataSource.query(
    'SELECT status FROM local_write_hold WHERE hold_id = ?',
    [holdId],
  );
  const status = (rows as Array<{ status?: string }>)[0]?.status;
  return status === undefined ? null : String(status);
}

async function countAuditStage(
  dataSource: DataSource,
  restoreId: string,
  stage: string,
): Promise<number> {
  const rows: unknown = await dataSource.query(
    "SELECT COUNT(*) AS total FROM management_audit_event WHERE operation = 'RESTORE_LOCAL_BUSINESS' " +
      "AND target_type = 'LOCAL_RESTORE' AND target_id = ? " +
      "AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.stage')) = ?",
    [restoreId, stage],
  );
  return Number((rows as Array<{ total: number }>)[0]?.total ?? 0);
}

async function readAuditResults(dataSource: DataSource, restoreId: string): Promise<string[]> {
  const rows: unknown = await dataSource.query(
    "SELECT result FROM management_audit_event WHERE operation = 'RESTORE_LOCAL_BUSINESS' " +
      "AND target_type = 'LOCAL_RESTORE' AND target_id = ?",
    [restoreId],
  );
  return (rows as Array<{ result?: string }>).map((row) => text(row.result));
}

/* ───────────────────────── 主流程：判定矩阵 ───────────────────────── */

/**
 * 业务写入准入探测（真实事务 ＋ 真实范围共享锁）。
 *
 * 只做"写入准入"这一步（不写业务数据）：冻结生效时必须被受控拒绝，
 * 冻结解除后必须放行 ⇒ 用来证明"处置失败 ⇒ 设备继续停写停传"。
 */
async function probeBusinessWrite(
  app: AppContext,
  organizationId: number,
): Promise<{ ok: boolean; reason: string }> {
  try {
    await app.transactionRunner.run(async (transactionContext) => {
      await app.writeHold.assertBusinessWritableInTransaction({
        organizationId,
        transactionContext,
      });
    });
    return { ok: true, reason: '放行' };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 读该恢复"已解除"处置事件的 detail 投影（任务 10 读侧同一套白名单）。
 *
 * 用来证明"管理员填写的处置原因写得进去、也读得出来"。
 */
async function readReleasedEventReasons(
  dataSource: DataSource,
  restoreId: string,
): Promise<string[]> {
  const rows: unknown = await dataSource.query(
    "SELECT detail FROM management_audit_event WHERE operation = 'RESTORE_LOCAL_BUSINESS' " +
      "AND target_type = 'LOCAL_RESTORE' AND target_id = ? " +
      "AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.stage')) = 'RESTORE_HOLD_FORCE_RELEASED'",
    [restoreId],
  );
  return (rows as Array<{ detail?: string | null }>)
    .map((row) => projectManagementAuditDetail(row.detail ?? null)?.reason ?? '')
    .filter((reason) => reason !== '');
}

type CaseResult = {
  readonly id: string;
  readonly name: string;
  readonly expectation: string;
  readonly passed: boolean;
  readonly detail: string;
};

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  assertControlledFileRoot(auth.fileRoot);
  const app = await bootstrap(auth.envFile, auth.database);
  const dataSource = app.dataSource;
  const cases: CaseResult[] = [];
  const registry: Registry = {
    accountIds: [],
    backupRunIds: [],
    backupIds: [],
    restoreIds: [],
    holdIds: [],
  };
  // 收尾问题清单（**不被吞掉**）：主因与收尾错误都会进退出码判定
  const issues = new CleanupIssueLog();
  let mainError: unknown = null;
  let payload: IncidentReleasePayload | null = null;
  let sentinelBefore: SentinelSnapshot[] = [];
  let installationId = '';
  const organizationId = Number(auth.organizationId);
  let actorAccountId = 0;

  const record = (
    id: string,
    name: string,
    expectation: string,
    passed: boolean,
    detail: string,
  ) => {
    cases.push({ id, name, expectation, passed, detail });
  };

  try {
    // ── 安全边界（与恢复自检同一套）──
    const installationRows: unknown = await dataSource.query(
      'SELECT installation_id FROM local_installation WHERE id = 1',
    );
    const readInstallationId = text(
      (installationRows as Array<{ installation_id?: string }>)[0]?.installation_id,
    );
    if (
      readInstallationId === '' ||
      readInstallationId.toLowerCase() !== auth.installationId.toLowerCase()
    ) {
      throw new Error(
        `安装标识不一致：库内 ${readInstallationId}，声明 ${auth.installationId}，拒绝运行`,
      );
    }
    installationId = readInstallationId;
    const serverUuidRows: unknown = await dataSource.query('SELECT @@server_uuid AS server_uuid');
    const serverUuid = text(
      (serverUuidRows as Array<{ server_uuid?: string }>)[0]?.server_uuid,
    ).toLowerCase();
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

    // ★ 非目标哨兵快照：必须在**本轮造数之前**取（否则分不清谁是谁造的）
    sentinelBefore = await snapshotForeignSentinel(dataSource, {
      restoreIds: [],
      holdIds: [],
      backupIds: [],
      backupRunIds: [],
      accountIds: [],
    });

    const accountId = await createAccount(dataSource, 'actor');
    registry.accountIds.push(accountId);
    actorAccountId = accountId;
    const backupRunId = await createBackupRun(dataSource, installationId, organizationId);
    registry.backupRunIds.push(backupRunId);
    const backupId = await createAsset(dataSource, installationId, organizationId, backupRunId);
    registry.backupIds.push(backupId);
    const protectionBackupId = await createAsset(
      dataSource,
      installationId,
      organizationId,
      backupRunId,
    );
    registry.backupIds.push(protectionBackupId);

    const service = buildService(app);
    const baseCommand = {
      restoreId: '',
      actorAccountId: accountId,
      actorAdminLevel: 1,
      allowedOrganizationId: null,
      actorIsAdministrator: true,
      reason: '任务09 取证：恢复已终态但冻结未解除，核对数据一致后受控解除',
      confirmed: true,
    };

    // ── S1 正常解除（已有终态）──
    const s1RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s1RestoreId);
    const s1HoldId = await createHold(dataSource, installationId, organizationId, s1RestoreId);
    registry.holdIds.push(s1HoldId);
    const s1 = await service.release({ ...baseCommand, restoreId: s1RestoreId });
    const s1HoldStatus = await readHoldStatus(dataSource, s1HoldId);
    const s1Audit = await countAuditStage(dataSource, s1RestoreId, 'RESTORE_HOLD_FORCE_RELEASED');
    const s1Results = await readAuditResults(dataSource, s1RestoreId);
    const s1Reasons = await readReleasedEventReasons(dataSource, s1RestoreId);
    record(
      'S1',
      '已有终态（成功）＋冻结仍在：受控解除并如实回报',
      'outcome=RELEASED 且冻结转为 RELEASED ＋ 留一条"已解除"审计（result 镜像 SUCCEEDED）＋ 审计里能读回管理员填写的处置原因',
      s1.outcome === 'RELEASED' &&
        s1.released === true &&
        s1HoldStatus === 'RELEASED' &&
        s1Audit === 1 &&
        s1Results.includes('SUCCEEDED') &&
        s1Reasons.includes(baseCommand.reason),
      `outcome=${s1.outcome} released=${String(s1.released)} hold=${String(s1HoldStatus)} 审计=${String(s1Audit)} results=${s1Results.join('/')} 处置原因=${JSON.stringify(s1Reasons)}`,
    );

    // ── S2 重复（幂等）──
    const s2 = await service.release({ ...baseCommand, restoreId: s1RestoreId });
    const s2Audit = await countAuditStage(dataSource, s1RestoreId, 'RESTORE_HOLD_FORCE_RELEASED');
    const s2NotRequired = await countAuditStage(
      dataSource,
      s1RestoreId,
      'RESTORE_HOLD_FORCE_NOT_REQUIRED',
    );
    record(
      'S2',
      '重复处置：不得谎报"又解冻了一次"',
      'outcome=NOT_REQUIRED 且 released=false ＋ "已解除"审计仍恰好 1 条',
      s2.outcome === 'NOT_REQUIRED' &&
        s2.released === false &&
        s2Audit === 1 &&
        s2NotRequired === 1,
      `outcome=${s2.outcome} released=${String(s2.released)} 已解除审计=${String(s2Audit)} 无需解除审计=${String(s2NotRequired)}`,
    );

    // ── S9 提前执行：写入准入探测要求此时范围内**只有本轮自己的冻结**（
    //    否则其它用例留下的活动冻结会让"写入仍被拒"失去判别力）──
    // ── S9 审计写入失败：解冻与成功审计**同事务** ⇒ 必须整体回滚（冻结保留）──
    const s9RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s9RestoreId);
    const s9HoldId = await createHold(dataSource, installationId, organizationId, s9RestoreId);
    registry.holdIds.push(s9HoldId);
    // 注入：只让**成功处置**那一档的审计写入失败（失败档仍要能留痕）
    const failingAudit = {
      appendRestoreIncidentEvent: async (params: {
        stage: string;
        actorAccountId: number;
        actorAdminLevel: number;
        organizationId: number;
        restoreId: string;
        backupId: string;
        protectionBackupId: string | null;
        result: 'SUCCEEDED' | 'FAILED';
        reasonCode?: string | null;
        operatorReason?: string | null;
        transactionContext?: unknown;
      }) => {
        if (params.stage === 'RESTORE_HOLD_FORCE_RELEASED') {
          throw new Error('注入的审计写入失败');
        }
        await app.audit.appendRestoreIncidentEvent(params as never);
      },
      countRestoreIncidentEventsByStage: async (params: { restoreId: string; stage: string }) =>
        await app.audit.countRestoreIncidentEventsByStage(params as never),
    } as unknown as ManagementAuditService;
    const s9Service = buildService(app, { audit: failingAudit });
    const s9 = await s9Service.release({ ...baseCommand, restoreId: s9RestoreId });
    const s9HoldStatus = await readHoldStatus(dataSource, s9HoldId);
    const s9ReleasedAudit = await countAuditStage(
      dataSource,
      s9RestoreId,
      'RESTORE_HOLD_FORCE_RELEASED',
    );
    const s9FailedAudit = await countAuditStage(
      dataSource,
      s9RestoreId,
      'RESTORE_HOLD_FORCE_FAILED',
    );
    // 处置失败 ⇒ 冻结保留 ⇒ 设备继续停写停传（业务写入仍被受控拒绝）
    const s9Write = await probeBusinessWrite(app, organizationId);
    record(
      'S9',
      '审计写入失败：解冻与成功审计同事务 ⇒ **整体回滚**（冻结保留、无成功处置事件）',
      'outcome=DENIED ＋ reasonCode=…AUDIT_FAILED ＋ 冻结仍 ACTIVE ＋ 无"已解除"事件 ＋ 业务写入仍被受控拒绝',
      s9.outcome === 'DENIED' &&
        s9.released === false &&
        s9.holdRetained === true &&
        s9.reasonCode === 'RESTORE_INCIDENT_RELEASE_AUDIT_FAILED' &&
        s9HoldStatus === 'ACTIVE' &&
        s9ReleasedAudit === 0 &&
        s9FailedAudit === 1 &&
        s9Write.ok === false,
      `outcome=${s9.outcome} reasonCode=${String(s9.reasonCode)} hold=${String(s9HoldStatus)} 已解除审计=${String(s9ReleasedAudit)} 失败审计=${String(s9FailedAudit)} 写入=${s9Write.ok ? '放行' : '拒绝'}`,
    );

    // ── S9b 失败后重试（审计恢复可用）⇒ 同事务提交，写入恢复放行 ──
    const s9b = await service.release({ ...baseCommand, restoreId: s9RestoreId });
    const s9bHoldStatus = await readHoldStatus(dataSource, s9HoldId);
    const s9bReleasedAudit = await countAuditStage(
      dataSource,
      s9RestoreId,
      'RESTORE_HOLD_FORCE_RELEASED',
    );
    const s9bWrite = await probeBusinessWrite(app, organizationId);
    record(
      'S9b',
      '失败后重试（审计恢复可用）⇒ 解冻与成功审计同事务提交，业务写入恢复放行',
      'outcome=RELEASED ＋ 冻结 RELEASED ＋ "已解除"审计恰好 1 条 ＋ 业务写入放行',
      s9b.outcome === 'RELEASED' &&
        s9bHoldStatus === 'RELEASED' &&
        s9bReleasedAudit === 1 &&
        s9bWrite.ok === true,
      `outcome=${s9b.outcome} hold=${String(s9bHoldStatus)} 已解除审计=${String(s9bReleasedAudit)} 写入=${s9bWrite.ok ? '放行' : '拒绝'}`,
    );
    // ── S3 无权（工程师）──
    const s3RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s3RestoreId);
    const s3HoldId = await createHold(dataSource, installationId, organizationId, s3RestoreId);
    registry.holdIds.push(s3HoldId);
    const s3 = await service.release({
      ...baseCommand,
      restoreId: s3RestoreId,
      actorIsAdministrator: false,
    });
    const s3HoldStatus = await readHoldStatus(dataSource, s3HoldId);
    const s3Denied = await countAuditStage(dataSource, s3RestoreId, 'RESTORE_HOLD_FORCE_DENIED');
    record(
      'S3',
      '无权（工程师）：拒绝且**保持冻结**',
      'outcome=DENIED ＋ reasonCode=…NOT_ADMIN ＋ 冻结仍 ACTIVE ＋ 留一条"被拒绝"审计',
      s3.outcome === 'DENIED' &&
        s3.reasonCode === 'RESTORE_INCIDENT_RELEASE_NOT_ADMIN' &&
        s3HoldStatus === 'ACTIVE' &&
        s3Denied === 1,
      `outcome=${s3.outcome} reasonCode=${String(s3.reasonCode)} hold=${String(s3HoldStatus)} 拒绝审计=${String(s3Denied)}`,
    );

    // ── S4 跨公司 ──
    const s4RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s4RestoreId);
    const s4HoldId = await createHold(dataSource, installationId, organizationId, s4RestoreId);
    registry.holdIds.push(s4HoldId);
    const s4 = await service.release({
      ...baseCommand,
      restoreId: s4RestoreId,
      allowedOrganizationId: 9,
    });
    const s4HoldStatus = await readHoldStatus(dataSource, s4HoldId);
    record(
      'S4',
      '跨公司（二级管理员处置他公司现场）：拒绝且保持冻结',
      'outcome=DENIED ＋ reasonCode=…ORGANIZATION_NOT_ALLOWED ＋ 冻结仍 ACTIVE',
      s4.outcome === 'DENIED' &&
        s4.reasonCode === 'RESTORE_INCIDENT_RELEASE_ORGANIZATION_NOT_ALLOWED' &&
        s4HoldStatus === 'ACTIVE',
      `outcome=${s4.outcome} reasonCode=${String(s4.reasonCode)} hold=${String(s4HoldStatus)}`,
    );

    // ── S5 伪造 restoreId ──
    const s5RestoreId = randomUUID();
    const s5 = await service.release({ ...baseCommand, restoreId: s5RestoreId });
    const s5AuditTotal: unknown = await dataSource.query(
      'SELECT COUNT(*) AS total FROM management_audit_event WHERE target_id = ?',
      [s5RestoreId],
    );
    record(
      'S5',
      '伪造 restoreId：拒绝且零写入',
      'outcome=DENIED ＋ reasonCode=…RESTORE_NOT_FOUND ＋ 该 restoreId 下零审计行',
      s5.outcome === 'DENIED' &&
        s5.reasonCode === 'RESTORE_INCIDENT_RELEASE_RESTORE_NOT_FOUND' &&
        Number((s5AuditTotal as Array<{ total: number }>)[0]?.total ?? 0) === 0,
      `outcome=${s5.outcome} reasonCode=${String(s5.reasonCode)} 审计行=${String((s5AuditTotal as Array<{ total: number }>)[0]?.total ?? 0)}`,
    );

    // ── S6 恢复仍在运行 ──
    const s6RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'RUNNING', resultSummary: JSON.stringify({ status: 'RUNNING' }) },
    );
    registry.restoreIds.push(s6RestoreId);
    const s6HoldId = await createHold(dataSource, installationId, organizationId, s6RestoreId);
    registry.holdIds.push(s6HoldId);
    const s6 = await service.release({ ...baseCommand, restoreId: s6RestoreId });
    const s6HoldStatus = await readHoldStatus(dataSource, s6HoldId);
    record(
      'S6',
      '恢复仍在运行：拒绝且保持冻结（应当走安全重试）',
      'outcome=DENIED ＋ reasonCode=…RESTORE_RUNNING ＋ 冻结仍 ACTIVE',
      s6.outcome === 'DENIED' &&
        s6.reasonCode === 'RESTORE_INCIDENT_RELEASE_RESTORE_RUNNING' &&
        s6HoldStatus === 'ACTIVE',
      `outcome=${s6.outcome} reasonCode=${String(s6.reasonCode)} hold=${String(s6HoldStatus)}`,
    );

    // ── S7 冻结归属别的恢复 ──
    const s7RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s7RestoreId);
    const s7OtherRestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s7OtherRestoreId);
    const s7HoldId = await createHold(dataSource, installationId, organizationId, s7OtherRestoreId);
    registry.holdIds.push(s7HoldId);
    const s7 = await service.release({ ...baseCommand, restoreId: s7RestoreId });
    const s7HoldStatus = await readHoldStatus(dataSource, s7HoldId);
    record(
      'S7',
      '活动冻结归属别的恢复：拒绝且保持冻结（不得一刀切解掉别人的冻结）',
      'outcome=DENIED ＋ reasonCode=…HOLD_OWNER_MISMATCH ＋ 他人的冻结仍 ACTIVE',
      s7.outcome === 'DENIED' &&
        s7.reasonCode === 'RESTORE_INCIDENT_RELEASE_HOLD_OWNER_MISMATCH' &&
        s7HoldStatus === 'ACTIVE',
      `outcome=${s7.outcome} reasonCode=${String(s7.reasonCode)} hold=${String(s7HoldStatus)}`,
    );

    // ── S8 回滚失败（数据一致性不可确认）──
    const s8RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'FAILED', resultSummary: JSON.stringify({ status: 'FAILED', holdRetained: true }) },
    );
    registry.restoreIds.push(s8RestoreId);
    const s8HoldId = await createHold(dataSource, installationId, organizationId, s8RestoreId);
    registry.holdIds.push(s8HoldId);
    const s8 = await service.release({ ...baseCommand, restoreId: s8RestoreId });
    const s8HoldStatus = await readHoldStatus(dataSource, s8HoldId);
    record(
      'S8',
      '回滚失败（数据一致性不可确认）：拒绝且保持冻结',
      'outcome=DENIED ＋ reasonCode=…DATA_CONSISTENCY_UNCONFIRMED ＋ 冻结仍 ACTIVE',
      s8.outcome === 'DENIED' &&
        s8.reasonCode === 'RESTORE_INCIDENT_RELEASE_DATA_CONSISTENCY_UNCONFIRMED' &&
        s8HoldStatus === 'ACTIVE',
      `outcome=${s8.outcome} reasonCode=${String(s8.reasonCode)} hold=${String(s8HoldStatus)}`,
    );

    // ── S11 处置原因含凭据／系统绝对路径：拒绝（失败关闭），冻结保留，
    //      且**审计里没有任何敏感内容**（任务 09 剩余问题 01 的真实链负向断言）──
    const s11RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s11RestoreId);
    const s11HoldId = await createHold(dataSource, installationId, organizationId, s11RestoreId);
    registry.holdIds.push(s11HoldId);
    const s11Secret = 'FAKE_EXAMPLE_SECRET';
    const s11Path = '/srv/private';
    let s11Rejected = false;
    let s11Message = '';
    try {
      await service.release({
        ...baseCommand,
        restoreId: s11RestoreId,
        reason: `token=${s11Secret} ${s11Path}`,
      });
    } catch (error: unknown) {
      s11Rejected = true;
      s11Message = error instanceof Error ? error.message : '';
    }
    const s11HoldStatus = await readHoldStatus(dataSource, s11HoldId);
    const s11AuditRows: unknown = await dataSource.query(
      'SELECT detail FROM management_audit_event WHERE target_id = ?',
      [s11RestoreId],
    );
    const s11AuditList = s11AuditRows as Array<Record<string, unknown>>;
    const s11AuditText = JSON.stringify(s11AuditList);
    record(
      'S11',
      '处置原因含凭据／系统绝对路径：拒绝、冻结保留，且审计里没有任何敏感内容',
      '调用被拒（失败关闭）＋ 冻结仍 ACTIVE ＋ 该 restoreId 下零审计行 ＋ 错误提示与审计都不含命中内容',
      s11Rejected &&
        s11HoldStatus === 'ACTIVE' &&
        s11AuditList.length === 0 &&
        !s11AuditText.includes(s11Secret) &&
        !s11AuditText.includes(s11Path) &&
        !s11Message.includes(s11Secret) &&
        !s11Message.includes(s11Path),
      `拒绝=${String(s11Rejected)} hold=${String(s11HoldStatus)} 审计行=${String(s11AuditList.length)} 提示=${s11Message}`,
    );

    // ── S10 并发：同一现场并发处置 ⇒ 只解除一次、只留一条"已解除"审计 ──
    const s10RestoreId = await createRestoreRun(
      dataSource,
      installationId,
      organizationId,
      accountId,
      backupId,
      protectionBackupId,
      { status: 'SUCCEEDED', resultSummary: JSON.stringify({ status: 'SUCCEEDED' }) },
    );
    registry.restoreIds.push(s10RestoreId);
    const s10HoldId = await createHold(dataSource, installationId, organizationId, s10RestoreId);
    registry.holdIds.push(s10HoldId);
    const [s10a, s10b] = await Promise.all([
      service.release({ ...baseCommand, restoreId: s10RestoreId }),
      service.release({ ...baseCommand, restoreId: s10RestoreId }),
    ]);
    const s10HoldStatus = await readHoldStatus(dataSource, s10HoldId);
    const s10ReleasedAudit = await countAuditStage(
      dataSource,
      s10RestoreId,
      'RESTORE_HOLD_FORCE_RELEASED',
    );
    const releasedCount = [s10a, s10b].filter((item) => item.outcome === 'RELEASED').length;
    const notRequiredCount = [s10a, s10b].filter((item) => item.outcome === 'NOT_REQUIRED').length;
    record(
      'S10',
      '并发处置：只解除一次、只留一条"已解除"审计',
      '两个并发调用中恰好 1 个 RELEASED、另一个 NOT_REQUIRED ＋ 冻结 RELEASED ＋ "已解除"审计恰好 1 条',
      releasedCount === 1 &&
        notRequiredCount === 1 &&
        s10HoldStatus === 'RELEASED' &&
        s10ReleasedAudit === 1,
      `RELEASED=${String(releasedCount)} NOT_REQUIRED=${String(notRequiredCount)} hold=${String(s10HoldStatus)} 已解除审计=${String(s10ReleasedAudit)} 明细=${[s10a, s10b].map((item) => `${item.outcome}/${String(item.reasonCode)}`).join('+')}`,
    );

    const failed = cases.filter((item) => !item.passed);
    payload = {
      capturedAt: new Date().toISOString(),
      database: auth.database,
      installationId,
      organizationId,
      cases,
      passed: failed.length === 0,
      total: cases.length,
      failedCount: failed.length,
      cleanup: {
        issues: [...issues.list],
        residue: [],
        sentinelUnchanged: true,
      },
    };
    if (!payload.passed) {
      throw new Error(
        `取证未全部通过：${failed.map((item) => `${item.id}（${item.detail}）`).join('；')}`,
      );
    }
  } catch (error: unknown) {
    // 主因**不许被收尾吞掉**：记下来，最后统一以非零退出码回报
    mainError = error;
    if (payload === null) {
      payload = {
        capturedAt: new Date().toISOString(),
        database: auth.database,
        installationId,
        organizationId,
        cases,
        passed: false,
        total: cases.length,
        failedCount: cases.filter((item) => !item.passed).length,
        cleanup: {
          issues: [...issues.list],
          residue: [],
          sentinelUnchanged: true,
        },
      };
    }
  }

  // ── 收尾：按本轮登记的真实主键精确回收；**任何收尾问题都让 runner 非零退出** ──
  const cleanupResult = await runCleanup({
    dataSource,
    registry,
    installationId,
    organizationId,
    actorAccountId,
    issues,
  });
  const sentinelAfter = await snapshotForeignSentinel(dataSource, {
    restoreIds: registry.restoreIds,
    holdIds: registry.holdIds,
    backupIds: registry.backupIds,
    backupRunIds: registry.backupRunIds,
    accountIds: registry.accountIds,
  });
  const sentinelUnchanged = sameSentinels(sentinelBefore, sentinelAfter);
  if (!sentinelUnchanged) {
    issues.record('非目标哨兵在收尾前后发生变化（逐行字段指纹不一致）');
  }
  await dataSource.destroy();

  if (payload !== null) {
    payload = {
      ...payload,
      cleanup: {
        issues: [...issues.list],
        residue: [...cleanupResult.residue],
        sentinelUnchanged,
      },
    };
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    const evidenceFile = process.env['TASK09_RESTORE_INCIDENT_EVIDENCE_FILE'];
    if (evidenceFile !== undefined && evidenceFile.trim().length > 0) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(evidenceFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`TASK09_INCIDENT_RELEASE_RESULT ${JSON.stringify(payload)}\n`);
  }

  if (mainError !== null) {
    process.stderr.write(`取证异常：${describeError(mainError)}\n`);
    if (mainError instanceof Error && typeof mainError.stack === 'string') {
      process.stderr.write(`${mainError.stack}\n`);
    }
  }
  if (issues.list.length > 0) {
    process.stderr.write(`收尾问题：${issues.list.join('；')}\n`);
  }
  const caseFailed = cases.filter((item) => !item.passed);
  if (
    caseFailed.length > 0 ||
    mainError !== null ||
    issues.list.length > 0 ||
    cleanupResult.residue.length > 0
  ) {
    process.stderr.write(
      `\n❌ 恢复故障现场处置取证未通过：用例失败 ${String(caseFailed.length)} 项，收尾问题 ${String(issues.list.length)} 条，残留 ${String(cleanupResult.residue.length)} 项\n`,
    );
    if (cleanupResult.residue.length > 0) {
      process.stderr.write(`残留：${cleanupResult.residue.join('；')}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✅ 恢复故障现场处置取证通过\n');
}

/** 错误对象的安全字符串化（不把对象默认成 [object Object]） */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '未知错误';
}

/** 取证回执 */
type IncidentReleasePayload = {
  readonly capturedAt: string;
  readonly database: string;
  readonly installationId: string;
  readonly organizationId: number;
  readonly cases: CaseResult[];
  readonly passed: boolean;
  readonly total: number;
  readonly failedCount: number;
  readonly cleanup: {
    readonly issues: readonly string[];
    readonly residue: readonly string[];
    readonly sentinelUnchanged: boolean;
  };
};

/**
 * 两组哨兵是否完全一致（按**稳定标识**逐条比，不比数量）。
 *
 * 本脚本的"before"是本轮造数**之前**的全部受控行，"after"扣除了本轮创建的行 ⇒
 * 三个维度（消失／被改写／新出现）都必须为空。
 */
function sameSentinels(
  before: ReadonlyArray<SentinelSnapshot>,
  after: ReadonlyArray<SentinelSnapshot>,
): boolean {
  const comparison = compareSentinelEntries(before, after);
  return (
    comparison.missing.length === 0 &&
    comparison.changed.length === 0 &&
    comparison.added.length === 0
  );
}

/** 行字段指纹（固定字段顺序，可复现；缺失字段按 null 参与比较） */
function rowFingerprint(row: Readonly<Record<string, unknown>>, fields: readonly string[]): string {
  return fields
    .map((field) => `${field}=${normalizeOwnedFieldValue(row[field]) ?? 'null'}`)
    .join(';');
}

/**
 * 非目标哨兵快照：**本轮之外**的受控表行逐行字段指纹。
 *
 * 用"本轮登记的 ID 集合"取差集，而不是全表快照——
 * 后者会把本轮自己造的行也算进去，比较时无法区分"我造的"与"别人的"。
 */
async function snapshotForeignSentinel(
  dataSource: DataSource,
  owned: {
    readonly restoreIds: readonly string[];
    readonly holdIds: readonly string[];
    readonly backupIds: readonly string[];
    readonly backupRunIds: readonly number[];
    readonly accountIds: readonly number[];
  },
): Promise<SentinelSnapshot[]> {
  const snapshots: SentinelSnapshot[] = [];

  const holdRows: unknown = await dataSource.query(
    'SELECT hold_id, installation_id, organization_id, hold_type, status, restore_id, ' +
      'reason, created_at, released_at FROM local_write_hold',
  );
  for (const row of holdRows as Array<Record<string, unknown>>) {
    const holdId = text(row['hold_id']);
    if (owned.holdIds.includes(holdId)) {
      continue;
    }
    snapshots.push({
      label: `冻结#${holdId}`,
      fingerprint: holdSentinelFingerprint(row),
    });
  }

  const restoreRows: unknown = await dataSource.query(
    'SELECT restore_id, backup_id, protection_backup_id, target_installation_id, ' +
      'organization_id, started_by_account_id, status, started_at, finished_at ' +
      'FROM backup_restore_run',
  );
  for (const row of restoreRows as Array<Record<string, unknown>>) {
    const restoreId = text(row['restore_id']);
    if (owned.restoreIds.includes(restoreId)) {
      continue;
    }
    snapshots.push({
      label: `恢复运行#${restoreId}`,
      fingerprint: rowFingerprint(row, [
        'restore_id',
        'backup_id',
        'protection_backup_id',
        'target_installation_id',
        'organization_id',
        'started_by_account_id',
        'status',
        'started_at',
        'finished_at',
      ]),
    });
  }

  const assetRows: unknown = await dataSource.query(
    'SELECT backup_id, run_id, organization_id, installation_id, storage_reference, ' +
      'local_status, cloud_status FROM backup_asset',
  );
  for (const row of assetRows as Array<Record<string, unknown>>) {
    const backupId = text(row['backup_id']);
    if (owned.backupIds.includes(backupId)) {
      continue;
    }
    snapshots.push({
      label: `备份资产#${backupId}`,
      fingerprint: rowFingerprint(row, [
        'backup_id',
        'run_id',
        'organization_id',
        'installation_id',
        'storage_reference',
        'local_status',
        'cloud_status',
      ]),
    });
  }

  const runRows: unknown = await dataSource.query(
    'SELECT id, installation_id, organization_id, trigger_type, status, started_at, finished_at ' +
      'FROM local_backup_run',
  );
  for (const row of runRows as Array<Record<string, unknown>>) {
    const runId = Number(row['id'] ?? 0);
    if (owned.backupRunIds.includes(runId)) {
      continue;
    }
    snapshots.push({
      label: `备份运行#${String(runId)}`,
      fingerprint: rowFingerprint(row, [
        'id',
        'installation_id',
        'organization_id',
        'trigger_type',
        'status',
        'started_at',
        'finished_at',
      ]),
    });
  }

  const accountRows: unknown = await dataSource.query(
    'SELECT id, login_name, status, admin_level, account_uuid FROM base_user_account',
  );
  for (const row of accountRows as Array<Record<string, unknown>>) {
    const accountId = Number(row['id'] ?? 0);
    if (owned.accountIds.includes(accountId)) {
      continue;
    }
    snapshots.push({
      label: `账号#${String(accountId)}`,
      fingerprint: rowFingerprint(row, [
        'id',
        'login_name',
        'status',
        'admin_level',
        'account_uuid',
      ]),
    });
  }

  return snapshots.sort((left, right) => left.label.localeCompare(right.label));
}

/** 收尾结果 */
type CleanupResult = {
  readonly residue: readonly string[];
};

/**
 * 收尾：按本轮登记的真实主键精确回收（先子后父），且**不吞掉任何异常**。
 *
 * 纪律（任务 09 剩余问题 02）：
 * 1. 删除前**一次性预检**所有将清理的行（归属）与外部引用；不符 ⇒ **首次删除前中止**；
 * 2. 数据库删除放在**同一个事务**里按"精确 ID ＋ 归属条件"执行 ⇒ 失败整体回滚；
 * 3. 收尾后核对**本轮零残留**；
 * 4. 收尾错误逐条留痕 ⇒ runner **非零退出**（不得与"业务断言失败"混为一谈）。
 */
async function runCleanup(params: {
  dataSource: DataSource;
  registry: Registry;
  installationId: string;
  organizationId: number;
  actorAccountId: number;
  issues: CleanupIssueLog;
}): Promise<CleanupResult> {
  const { dataSource, registry, installationId, organizationId, actorAccountId, issues } = params;

  // ① 删除前**一次性预检**：归属与外部引用
  const steps = await (async (): Promise<readonly ForensicsCleanupStep[] | null> => {
    try {
      const planned = planIncidentReleaseDeletionSteps({
        registry,
        installationId,
        organizationId,
        actorAccountId,
      });
      await assertIncidentReleasePrecheck({ dataSource, registry, installationId, organizationId });
      return planned;
    } catch (error: unknown) {
      // 预检不通过 ⇒ **不进入删除路径**（保留现场，交人工判断）
      issues.recordError('删除前预检（已中止删除）', error);
      return null;
    }
  })();
  if (steps === null) {
    return { residue: [] };
  }

  // ② 数据库删除：**同一事务**、精确 ID ＋ 归属条件；失败 ⇒ 整体回滚
  if (steps.length > 0) {
    const result = await runAtomicForensicsCleanup(steps, {
      transaction: async <T>(
        run: (tx: {
          query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        await dataSource.transaction(async (manager) => {
          return await run({
            query: async (sql: string, params?: readonly unknown[]): Promise<unknown> =>
              await manager.query(sql, params as unknown[]),
          });
        }),
    });
    if (!result.ok) {
      const where =
        result.failedStep === null
          ? '（事务本身失败）'
          : `${result.failedStep.table}#${String(result.failedStep.id)}`;
      issues.recordError(`数据库清理（${where}）`, result.error);
    }
  }

  // ③ 残留核对：本轮对象必须**零残留**
  const residue: string[] = [];
  try {
    const counts = await readResidueCounts(dataSource, registry);
    residue.push(
      ...collectResidue([
        { label: '本轮处置审计事件', rows: counts.audit },
        { label: '本轮冻结', rows: counts.holds },
        { label: '本轮恢复运行', rows: counts.restoreRuns },
        { label: '本轮备份资产', rows: counts.assets },
        { label: '本轮备份运行', rows: counts.backupRuns },
        { label: '本轮账号', rows: counts.accounts },
      ]),
    );
  } catch (error: unknown) {
    issues.recordError('残留核对', error);
  }
  return { residue };
}

/** 删除计划：精确 ID ＋ 归属条件（"先子后父"由受控顺序表决定） */
function planIncidentReleaseDeletionSteps(params: {
  registry: Registry;
  installationId: string;
  organizationId: number;
  actorAccountId: number;
}): readonly ForensicsCleanupStep[] {
  const { registry, installationId, organizationId, actorAccountId } = params;
  const steps: ForensicsCleanupStep[] = [];
  for (const restoreId of registry.restoreIds) {
    steps.push({
      table: 'management_audit_event',
      idColumn: 'target_id',
      id: restoreId,
      ownership: `本轮恢复 ${restoreId} 的处置审计事件`,
      conditions: { operation: 'RESTORE_LOCAL_BUSINESS', target_type: 'LOCAL_RESTORE' },
    });
    steps.push({
      table: 'backup_restore_run',
      idColumn: 'restore_id',
      id: restoreId,
      ownership: `本轮恢复运行 ${restoreId}`,
      conditions: { organization_id: organizationId },
    });
  }
  for (const holdId of registry.holdIds) {
    steps.push({
      table: 'local_write_hold',
      idColumn: 'hold_id',
      id: holdId,
      ownership: `本轮冻结 ${holdId}`,
      conditions: { installation_id: installationId, organization_id: organizationId },
    });
  }
  for (const backupId of registry.backupIds) {
    steps.push({
      table: 'backup_asset',
      idColumn: 'backup_id',
      id: backupId,
      ownership: `本轮备份资产 ${backupId}`,
      conditions: { organization_id: organizationId },
    });
  }
  for (const runId of registry.backupRunIds) {
    steps.push({
      table: 'local_backup_run',
      idColumn: 'id',
      id: runId,
      ownership: `本轮备份运行 ${String(runId)}`,
      conditions: { organization_id: organizationId },
    });
  }
  for (const accountId of registry.accountIds) {
    steps.push({
      table: 'base_user_account',
      idColumn: 'id',
      id: accountId,
      ownership: `本轮账号 ${String(accountId)}`,
      // 账号名是本轮造的固定前缀 ⇒ 用 LIKE 精确限定，杜绝误删同表其它账号
      likeConditions: { login_name: 'task09-incident-%' },
    });
  }
  void actorAccountId;
  return planForensicsCleanupSteps(steps);
}

/**
 * 删除前**一次性预检**：所有将清理的行都必须与本轮登记一致，且**没有被本轮之外引用**。
 *
 * 任何一条不符 ⇒ 抛错 ⇒ 调用方在**首次删除前**中止（保留现场）。
 */
async function assertIncidentReleasePrecheck(params: {
  dataSource: DataSource;
  registry: Registry;
  installationId: string;
  organizationId: number;
}): Promise<void> {
  const { dataSource, registry, installationId, organizationId } = params;

  for (const restoreId of registry.restoreIds) {
    const events: unknown = await dataSource.query(
      'SELECT operation, target_type FROM management_audit_event WHERE target_id = ?',
      [restoreId],
    );
    for (const event of events as Array<Record<string, unknown>>) {
      if (
        text(event['operation']) !== 'RESTORE_LOCAL_BUSINESS' ||
        text(event['target_type']) !== 'LOCAL_RESTORE'
      ) {
        throw new Error(
          `恢复 ${restoreId} 上存在本轮之外的审计事件（operation=${text(event['operation'])}／target_type=${text(event['target_type'])}），拒绝删除`,
        );
      }
    }
    const runs: unknown = await dataSource.query(
      'SELECT organization_id, target_installation_id FROM backup_restore_run WHERE restore_id = ?',
      [restoreId],
    );
    for (const run of runs as Array<Record<string, unknown>>) {
      if (
        Number(run['organization_id'] ?? 0) !== organizationId ||
        text(run['target_installation_id']) !== installationId
      ) {
        throw new Error(`恢复运行 ${restoreId} 的归属与本轮登记不一致，拒绝删除`);
      }
    }
  }

  for (const holdId of registry.holdIds) {
    const rows: unknown = await dataSource.query(
      'SELECT installation_id, organization_id, restore_id FROM local_write_hold WHERE hold_id = ?',
      [holdId],
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      if (
        text(row['installation_id']) !== installationId ||
        Number(row['organization_id'] ?? 0) !== organizationId ||
        !registry.restoreIds.includes(text(row['restore_id']))
      ) {
        throw new Error(`冻结 ${holdId} 的归属与本轮登记不一致，拒绝删除`);
      }
    }
  }

  for (const backupId of registry.backupIds) {
    const rows: unknown = await dataSource.query(
      'SELECT organization_id, installation_id, run_id FROM backup_asset WHERE backup_id = ?',
      [backupId],
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      if (
        Number(row['organization_id'] ?? 0) !== organizationId ||
        text(row['installation_id']) !== installationId ||
        !registry.backupRunIds.includes(Number(row['run_id'] ?? 0))
      ) {
        throw new Error(`备份资产 ${backupId} 的归属与本轮登记不一致，拒绝删除`);
      }
    }
  }

  for (const runId of registry.backupRunIds) {
    const rows: unknown = await dataSource.query(
      'SELECT organization_id FROM local_backup_run WHERE id = ?',
      [runId],
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      if (Number(row['organization_id'] ?? 0) !== organizationId) {
        throw new Error(`备份运行 ${String(runId)} 的归属与本轮登记不一致，拒绝删除`);
      }
    }
  }

  for (const accountId of registry.accountIds) {
    const rows: unknown = await dataSource.query(
      'SELECT login_name FROM base_user_account WHERE id = ?',
      [accountId],
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      if (!text(row['login_name']).startsWith('task09-incident-')) {
        throw new Error(`账号 ${String(accountId)} 不是本轮造数账号，拒绝删除`);
      }
    }
  }

  // 外部引用：别的对象指向本轮对象 ⇒ 不删（而不是靠外键最后报错来拦）
  const externalAssetRefs = await countRows(
    dataSource,
    'SELECT COUNT(*) AS c FROM backup_restore_run ' +
      'WHERE (backup_id IN (?) OR protection_backup_id IN (?)) AND restore_id NOT IN (?)',
    [[...registry.backupIds], [...registry.backupIds], [...registry.restoreIds]],
  );
  if (externalAssetRefs > 0) {
    throw new Error(`本轮备份资产存在 ${String(externalAssetRefs)} 条本轮之外的恢复引用，拒绝删除`);
  }
  const externalRunRefs = await countRows(
    dataSource,
    'SELECT COUNT(*) AS c FROM backup_asset WHERE run_id IN (?) AND backup_id NOT IN (?)',
    [[...registry.backupRunIds], [...registry.backupIds]],
  );
  if (externalRunRefs > 0) {
    throw new Error(`本轮备份运行存在 ${String(externalRunRefs)} 条本轮之外的资产引用，拒绝删除`);
  }
  const externalHoldRefs = await countRows(
    dataSource,
    'SELECT COUNT(*) AS c FROM local_write_hold WHERE restore_id IN (?) AND hold_id NOT IN (?)',
    [[...registry.restoreIds], [...registry.holdIds]],
  );
  if (externalHoldRefs > 0) {
    throw new Error(`本轮恢复运行存在 ${String(externalHoldRefs)} 条本轮之外的冻结引用，拒绝删除`);
  }
  const externalAuditRefs = await countRows(
    dataSource,
    'SELECT COUNT(*) AS c FROM management_audit_event WHERE target_id IN (?) ' +
      "AND NOT (operation = 'RESTORE_LOCAL_BUSINESS' AND target_type = 'LOCAL_RESTORE')",
    [[...registry.restoreIds]],
  );
  if (externalAuditRefs > 0) {
    throw new Error(`本轮恢复运行存在 ${String(externalAuditRefs)} 条本轮之外的审计引用，拒绝删除`);
  }
}

/** 读一行计数 */
async function countRows(
  dataSource: DataSource,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const rows: unknown = await dataSource.query(sql, params as unknown[]);
  return Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
}

/** 收尾后的残留计数（本轮创建的对象必须为零） */
async function readResidueCounts(
  dataSource: DataSource,
  registry: Registry,
): Promise<{
  audit: number;
  holds: number;
  restoreRuns: number;
  assets: number;
  backupRuns: number;
  accounts: number;
}> {
  const [audit, holds, restoreRuns, assets, backupRuns, accounts] = await Promise.all([
    countRows(
      dataSource,
      'SELECT COUNT(*) AS c FROM management_audit_event WHERE target_id IN (?)',
      [[...registry.restoreIds]],
    ),
    countRows(dataSource, 'SELECT COUNT(*) AS c FROM local_write_hold WHERE hold_id IN (?)', [
      [...registry.holdIds],
    ]),
    countRows(dataSource, 'SELECT COUNT(*) AS c FROM backup_restore_run WHERE restore_id IN (?)', [
      [...registry.restoreIds],
    ]),
    countRows(dataSource, 'SELECT COUNT(*) AS c FROM backup_asset WHERE backup_id IN (?)', [
      [...registry.backupIds],
    ]),
    countRows(dataSource, 'SELECT COUNT(*) AS c FROM local_backup_run WHERE id IN (?)', [
      [...registry.backupRunIds],
    ]),
    countRows(dataSource, 'SELECT COUNT(*) AS c FROM base_user_account WHERE id IN (?)', [
      [...registry.accountIds],
    ]),
  ]);
  return { audit, holds, restoreRuns, assets, backupRuns, accounts };
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
