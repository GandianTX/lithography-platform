// scripts/task09-restore-execution-claim-check.ts

/**
 * 任务 09 · 独立验收 **P1-2（执行占用／过期状态）**与 **P1-3（终态一致性）**取证脚本。
 *
 * 目的：把"恢复执行的占用与终态"从**结构性推断**变成**真实库、真实文件、真实连接**的实测结论。
 *
 * | 场景 | 期望行为（产品口径） | 实测关注点 |
 * | --- | --- | --- |
 * | S1 同一恢复的**延迟请求**（B 锁前读到旧 RUNNING，A 已跑完并释放执行锁） | B 必须**重新核验终态**并**零写入**受控拒绝；**不得**再次执行旧备份 | 两个真实连接 ＋ 屏障；哨兵保留 |
 * | S2 终态**状态更新失败**（真实库触发器注入） | 不得留下"成功"事实；数据按保护副本回滚，终态为失败 | 运行终态与最终审计的原子性 |
 * | S3 **解冻失败**（真实库触发器注入） | 终态仍是成功（数据确实已恢复），**不回滚、不改判失败**；冻结保留并留痕 | 不出现"成功＋失败"双终态 |
 *
 * 断言写的是**期望行为**，不是当前行为：若实现存在缺陷，脚本会**如实失败**（exit 1）
 * 并把复现证据写进 JSON——缺陷不靠改断言掩盖。
 *
 * 纪律：
 * - **默认拒绝**：复用恢复自检同一套环境变量（一次性库、预期实例身份、一次性库标识、
 *   受控文件根、安装／公司标识、测试授权），缺一即零写入退出；
 * - 只写**本轮创建**的对象（账号／备份运行／备份资产／恢复运行／上传任务行），
 *   收尾按**真实创建 ID** 精确回收，并核对零残留；
 * - 故障注入只用**一次性库里的触发器**，用完即删。
 *
 * 用法：见 `.local/task09/run-restore-write-mutex.sh` 的同款环境变量。
 */

// 脚本属**受控 wiring**（同 scripts/task09-restore-selfcheck.ts）：运行时配置只在这里读取一次。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type Repository } from 'typeorm';

import {
  BACKUP_PAYLOAD_PATH,
  buildProtectedBackupManifest,
  encryptBackupPayload,
  parseProtectionKey,
  type BackupScopeTable,
} from '@core/local-runtime/policy/protected-backup.policy';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { BackupAssetEntity } from '@src/modules/lithography/entities/backup-asset.entity';
import { BackupRestoreRunEntity } from '@src/modules/lithography/entities/backup-restore-run.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { LocalUploadTaskEntity } from '@src/modules/lithography/entities/local-upload-task.entity';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LocalRestoreExecutionService } from '@src/modules/lithography/local-restore-execution.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';

import { LOCAL_RESTORE_RECORD_TABLES } from '@usecases/common/ports/local-restore-record-writer.contract';

import {
  assertControlledFileRoot,
  assertDisposableMarker,
  assertNoForeignActiveHold,
  assertPathWithinRoot,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  readServerUuid,
  text,
} from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

/** 本轮固定的受保护包测试密钥（与恢复自检脚本同款；仅用于一次性隔离库） */
const TEST_KEY_HEX = '9f2c7a1d4e6b8035c7d9e1f4a2b6c8d0e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3';

type AppContext = {
  dataSource: DataSource;
  moduleRef: TestingModule;
  writeHold: LocalWriteHoldService;
  audit: ManagementAuditService;
  restoreRunRepository: Repository<BackupRestoreRunEntity>;
  backupAssetRepository: Repository<BackupAssetEntity>;
  installationRepository: Repository<LocalInstallationEntity>;
};

async function bootstrap(envFile: string, database: string): Promise<AppContext> {
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
      LithographyModule,
    ],
  }).compile();

  return {
    dataSource: moduleRef.get(DataSource),
    moduleRef,
    writeHold: moduleRef.get(LocalWriteHoldService),
    audit: moduleRef.get(ManagementAuditService),
    restoreRunRepository: moduleRef.get(getRepositoryToken(BackupRestoreRunEntity)),
    backupAssetRepository: moduleRef.get(getRepositoryToken(BackupAssetEntity)),
    installationRepository: moduleRef.get(getRepositoryToken(LocalInstallationEntity)),
  };
}

/**
 * 用**真实依赖**装配一个恢复执行服务实例。
 *
 * @param options.restoreRunRepository 覆盖恢复运行仓储（用于 S1 的屏障代理）
 */
function buildService(
  app: AppContext,
  options: { restoreRunRepository?: Repository<BackupRestoreRunEntity> } = {},
): LocalRestoreExecutionService {
  return new LocalRestoreExecutionService(
    options.restoreRunRepository ?? app.restoreRunRepository,
    app.backupAssetRepository,
    app.installationRepository,
    app.writeHold,
    app.audit,
    app.moduleRef as never,
    new PinoLogger({}),
    { keyHex: TEST_KEY_HEX, keyId: 'kid-task09-p1-2-3' },
    undefined,
  );
}

/** 屏障：第一次"锁前快路径读"之后暂停，直到放行 */
type Barrier = {
  readonly reached: Promise<void>;
  release(): void;
  repository(real: Repository<BackupRestoreRunEntity>): Repository<BackupRestoreRunEntity>;
};

function createBarrier(): Barrier {
  let markReached: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let markReleased: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  let paused = false;
  return {
    reached,
    release: () => markReleased(),
    repository: (real) =>
      new Proxy(real, {
        get(target, property, receiver) {
          if (property === 'findOne') {
            return async (...args: unknown[]) => {
              const result = await (target.findOne as (...a: unknown[]) => Promise<unknown>)(
                ...args,
              );
              if (!paused) {
                paused = true;
                markReached();
                await released;
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
  };
}

/** 构造一个受保护的备份包目录（真实文件） */
function buildPackage(input: {
  root: string;
  dirName: string;
  backupId: string;
  organizationId: number;
  installationId: string;
  payload: Record<string, unknown[]>;
  scopeRowCounts: Record<string, number>;
}): string {
  const dir = join(input.root, input.dirName);
  mkdirSync(dir, { recursive: true });
  const key = parseProtectionKey(TEST_KEY_HEX);
  const encrypted = encryptBackupPayload(key, Buffer.from(JSON.stringify(input.payload), 'utf8'));
  writeFileSync(join(dir, BACKUP_PAYLOAD_PATH), encrypted.data);
  const manifest = buildProtectedBackupManifest({
    backupId: input.backupId,
    organizationId: input.organizationId,
    installationId: input.installationId,
    runId: null,
    generatedAt: new Date('2026-11-24T00:00:00.000Z'),
    encryption: { keyId: 'kid-task09-p1-2-3', iv: encrypted.iv, authTag: encrypted.authTag },
    scope: Object.entries(input.scopeRowCounts).map(([table, rowCount]) => ({
      table: table as BackupScopeTable,
      rowCount,
      lastUpdatedAt: null,
    })),
    files: [
      {
        relative_path: BACKUP_PAYLOAD_PATH,
        sha256: createHash('sha256').update(encrypted.data).digest('hex'),
        byte_size: encrypted.data.byteLength,
      },
    ],
    originals: [],
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

/** 全范围空载荷（根表齐备 ⇒ 载荷范围一致性检查通过） */
function emptyPayload(): Record<string, unknown[]> {
  const payload: Record<string, unknown[]> = {};
  for (const table of LOCAL_RESTORE_RECORD_TABLES) {
    payload[table] = [];
  }
  return payload;
}

/** 全范围行数口径（保护副本带一行"恢复前既有行"） */
function scopeCounts(preRestoreRows: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of LOCAL_RESTORE_RECORD_TABLES) {
    counts[table] = 0;
  }
  counts['local_upload_task'] = preRestoreRows;
  return counts;
}

/** 读某恢复的运行行（真实库） */
async function readRunRow(
  dataSource: DataSource,
  restoreId: string,
): Promise<Record<string, unknown> | null> {
  const rows: unknown = await dataSource.query(
    'SELECT restore_id, status, check_status, finished_at, result_summary, restored_scope, confirmation ' +
      'FROM backup_restore_run WHERE restore_id = ?',
    [restoreId],
  );
  const list = rows as Array<Record<string, unknown>>;
  return list[0] ?? null;
}

/** 读某恢复的审计事件（真实库；含阶段投影） */
async function readAuditEvents(
  dataSource: DataSource,
  restoreId: string,
): Promise<Array<{ result: string; stage: string; reason: string | null }>> {
  const rows: unknown = await dataSource.query(
    "SELECT result, detail FROM management_audit_event WHERE target_type = 'LOCAL_RESTORE' AND target_id = ?",
    [restoreId],
  );
  return (rows as Array<{ result: string; detail: string | null }>).map((row) => {
    let stage = '';
    let reason: string | null = null;
    try {
      const detail = JSON.parse(row.detail ?? '{}') as { stage?: string; reason?: string };
      stage = text(detail.stage);
      reason = detail.reason === undefined ? null : text(detail.reason);
    } catch {
      // 解析失败：保留"阶段未知"的缺省值（不猜）
    }
    return { result: text(row.result), stage, reason };
  });
}

/** 该公司数据区的活动冻结行数 */
async function activeHoldCount(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
): Promise<number> {
  const rows: unknown = await dataSource.query(
    'SELECT COUNT(*) AS c FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?',
    [installationId, organizationId, 'ACTIVE'],
  );
  return Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
}

/** 该公司数据区（本机范围）的上传任务行数（受控哨兵所在表） */
async function uploadTaskRowCount(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
): Promise<number> {
  const rows: unknown = await dataSource.query(
    'SELECT COUNT(*) AS c FROM local_upload_task WHERE installation_id = ? AND organization_id = ?',
    [installationId, organizationId],
  );
  return Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
}

/** 当前连接的连接 ID（用于证明"两个真实连接"） */
async function connectionId(dataSource: DataSource): Promise<number> {
  const rows: unknown = await dataSource.query('SELECT CONNECTION_ID() AS id');
  return Number((rows as Array<{ id: number | string }>)[0]?.id ?? 0);
}

type Fixture = {
  restoreId: string;
  sourceBackupId: string;
  protectionBackupId: string;
  accountId: number;
  backupRunId: number;
  preRestoreKey: string;
};

/** 本轮造数登记（**先登记后创建** ⇒ 中途失败也能按真实 ID 精确回收） */
type Registry = {
  accountIds: number[];
  backupRunIds: number[];
  backupIds: string[];
  restoreIds: string[];
  uploadTaskKeys: string[];
  constraints: Array<{ name: string; table: string }>;
};

/** 造数：账号、备份运行、两个备份资产、一个已受理（RUNNING）的恢复运行 */
async function seedFixture(input: {
  app: AppContext;
  scope: { installationId: string; organizationId: number };
  fileRoot: string;
  tag: string;
  accountId: number;
  backupRunId: number;
  registry: Registry;
  /** 恢复前既有行的实体定位（真实库唯一键：安装＋实体类型＋实体ID＋版本） */
  entityLocalId: number;
}): Promise<Fixture> {
  const { app, scope, fileRoot, tag, registry } = input;
  const sourceBackupId = randomUUID();
  const protectionBackupId = randomUUID();
  const restoreId = randomUUID();
  const preRestoreKey = `task09-p1-2-3-pre-${tag}`;
  // 先登记（中途失败也能回收）
  registry.backupIds.push(sourceBackupId, protectionBackupId);
  registry.restoreIds.push(restoreId);
  registry.uploadTaskKeys.push(preRestoreKey);

  // 恢复前既有行（真实业务行）：保护副本里带着它 ⇒ 回滚可验证
  await app.dataSource.getRepository(LocalUploadTaskEntity).insert({
    recordUuid: null,
    sourceVersion: null,
    taskKind: 'BACKUP_UPLOAD',
    manifestChecksum: null,
    organizationId: scope.organizationId,
    accountId: input.accountId,
    installationId: scope.installationId,
    entityType: 'BACKUP_MANIFEST',
    entityLocalId: input.entityLocalId,
    entityVersion: `v-${tag}`,
    idempotencyKey: preRestoreKey,
    status: 'PENDING',
    attemptCount: 0,
    lastAttemptAt: null,
    remoteId: null,
    remoteReceipt: null,
    errorCode: null,
    errorMessage: null,
  });

  // 被恢复的包（空载荷＝备份里的业务事实为空）与保护副本（带恢复前既有行）
  const sourceDir = buildPackage({
    root: join(fileRoot, 'packages'),
    dirName: `${tag}-source`,
    backupId: sourceBackupId,
    organizationId: scope.organizationId,
    installationId: scope.installationId,
    payload: emptyPayload(),
    scopeRowCounts: scopeCounts(0),
  });
  const protectionDir = buildPackage({
    root: join(fileRoot, 'packages'),
    dirName: `${tag}-protection`,
    backupId: protectionBackupId,
    organizationId: scope.organizationId,
    installationId: scope.installationId,
    payload: {
      ...emptyPayload(),
      local_upload_task: [
        {
          recordUuid: null,
          sourceVersion: null,
          taskKind: 'BACKUP_UPLOAD',
          manifestChecksum: null,
          organizationId: scope.organizationId,
          accountId: input.accountId,
          installationId: scope.installationId,
          entityType: 'BACKUP_MANIFEST',
          entityLocalId: input.entityLocalId,
          entityVersion: `v-${tag}`,
          idempotencyKey: preRestoreKey,
          status: 'PENDING',
          attemptCount: 0,
        },
      ],
    },
    scopeRowCounts: scopeCounts(1),
  });

  for (const [backupId, localReference] of [
    [sourceBackupId, sourceDir],
    [protectionBackupId, protectionDir],
  ] as Array<[string, string]>) {
    await app.dataSource.getRepository(BackupAssetEntity).insert({
      backupId,
      runId: input.backupRunId,
      organizationId: scope.organizationId,
      localCleanupRunId: null,
      installationId: scope.installationId,
      formatVersion: 1,
      dataVersion: 'v1',
      manifestChecksum: null,
      localReference,
      cloudReference: null,
      encryptionKeyId: 'kid-task09-p1-2-3',
      verifiedAt: null,
      retentionUntil: null,
      failureReason: null,
      deletedAt: null,
      localCleanupError: null,
      storageReference: `task09/${backupId}`,
      fileSha256: 'a'.repeat(64),
      byteSize: '1024',
      cloudStatus: 'PENDING',
      localStatus: 'PENDING',
      cloudReceipt: null,
      attemptCount: 0,
      lastAttemptAt: null,
    });
  }

  await app.dataSource.getRepository(BackupRestoreRunEntity).insert({
    restoreId,
    backupId: sourceBackupId,
    protectionBackupId,
    targetInstallationId: scope.installationId,
    checkStatus: 'PASSED',
    confirmation: {
      accepted_at: new Date().toISOString(),
      accepted_by_account_id: input.accountId,
      restore_id: restoreId,
      backup_id: sourceBackupId,
      protection_backup_id: protectionBackupId,
      organization_id: scope.organizationId,
    },
    organizationId: scope.organizationId,
    startedByAccountId: input.accountId,
    status: 'RUNNING',
    checkSnapshot: JSON.stringify({
      schema_version: 1,
      checked_at: new Date().toISOString(),
      findings: [],
    }),
    restoredScope: null,
    resultSummary: null,
    startedAt: new Date(),
    finishedAt: null,
  });

  return {
    restoreId,
    sourceBackupId,
    protectionBackupId,
    accountId: input.accountId,
    backupRunId: input.backupRunId,
    preRestoreKey,
  };
}

/** 造数：一级管理员账号（审计与运行行的事实来源） */
async function seedAccount(dataSource: DataSource): Promise<number> {
  const loginName = `task09-p1-2-3-${Date.now()}`;
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

/** 造数：本地备份运行（备份资产的外键来源） */
async function seedBackupRun(
  dataSource: DataSource,
  scope: { installationId: string; organizationId: number },
): Promise<number> {
  await dataSource.query(
    'INSERT INTO local_backup_run (installation_id, organization_id, ' +
      'trigger_type, status, started_at, finished_at, manifest_path, manifest_checksum, ' +
      'byte_size, attachment_count, schema_version, error_code, error_message, created_at, updated_at) ' +
      "VALUES (?, ?, 'MANUAL', 'SUCCEEDED', NOW(3), NOW(3), ?, ?, 1024, 1, 1, NULL, NULL, NOW(3), NOW(3))",
    [scope.installationId, scope.organizationId, 'task09/p1-2-3/manifest.json', 'b'.repeat(64)],
  );
  const rows: unknown = await dataSource.query('SELECT LAST_INSERT_ID() AS id');
  const id = Number((rows as Array<{ id: number | string }>)[0]?.id ?? 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('造数失败：未取得本轮备份运行 ID');
  }
  return id;
}

/**
 * 注入故障：**库级 CHECK 约束**（真实库，不用 SUPER 权限的触发器）。
 *
 * 约束按**本轮对象**限定（只挡住这一个恢复／这一条冻结的转移），
 * 既有行不受影响 ⇒ 收尾删掉约束即可复原。
 */
async function installConstraint(
  dataSource: DataSource,
  name: string,
  table: string,
  expression: string,
): Promise<void> {
  const existing: unknown = await dataSource.query(
    'SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS ' +
      'WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?',
    [name],
  );
  if ((existing as unknown[]).length > 0) {
    await dataSource.query('ALTER TABLE ' + table + ' DROP CHECK ' + name);
  }
  await dataSource.query(
    'ALTER TABLE ' + table + ' ADD CONSTRAINT ' + name + ' CHECK (' + expression + ')',
  );
}

async function dropConstraint(dataSource: DataSource, name: string, table: string): Promise<void> {
  await dataSource.query('ALTER TABLE ' + table + ' DROP CHECK ' + name);
}

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  const fileRoot = assertControlledFileRoot(auth.fileRoot);
  const packageRoot = join(fileRoot, 'p1-2-3');
  mkdirSync(packageRoot, { recursive: true });

  const appA = await bootstrap(auth.envFile, auth.database);
  const appB = await bootstrap(auth.envFile, auth.database);

  const installationId = await readInstallationId(appA.dataSource);
  if (installationId === null) {
    throw new Error('隔离库缺少本机安装记录，无法核对安装标识');
  }
  if (installationId.toLowerCase() !== auth.installationId.toLowerCase()) {
    throw new Error(
      `安装标识不一致：库内 ${installationId}，声明 ${auth.installationId}，拒绝运行`,
    );
  }
  const serverUuid = await readServerUuid(appA.dataSource);
  if (serverUuid === null) {
    throw new Error('读不到实例 UUID，拒绝运行');
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
  const markerRows: unknown = await appA.dataSource.query(
    'SELECT marker_key, marker_value FROM task09_disposable_marker',
  );
  assertDisposableMarker(
    (markerRows as Array<Record<string, unknown>>).map((row) => ({
      markerKey: text(row['marker_key']),
      markerValue: text(row['marker_value']),
    })),
    auth.disposableMarker,
  );

  const scope = { installationId, organizationId: auth.organizationId };
  const existingHoldRows: unknown = await appA.dataSource.query(
    'SELECT hold_id, installation_id, organization_id, status, restore_id FROM local_write_hold ' +
      'WHERE installation_id = ? AND organization_id = ? AND status = ?',
    [scope.installationId, scope.organizationId, 'ACTIVE'],
  );
  assertNoForeignActiveHold(
    (existingHoldRows as Array<Record<string, unknown>>).map((row) => ({
      holdId: text(row['hold_id']),
      installationId: text(row['installation_id']),
      organizationId: Number(row['organization_id'] ?? 0),
      status: text(row['status']),
      restoreId:
        row['restore_id'] === null || row['restore_id'] === undefined
          ? null
          : text(row['restore_id']),
    })),
    scope.installationId,
    scope.organizationId,
  );

  const phase = (label: string): void => {
    process.stdout.write(`[${new Date().toISOString()}] ${label}\n`);
  };

  const registry: Registry = {
    accountIds: [],
    backupRunIds: [],
    backupIds: [],
    restoreIds: [],
    uploadTaskKeys: [],
    constraints: [],
  };

  try {
    const accountId = await seedAccount(appA.dataSource);
    registry.accountIds.push(accountId);
    const backupRunId = await seedBackupRun(appA.dataSource, scope);
    registry.backupRunIds.push(backupRunId);

    // ══ S1：延迟到达的重复请求（P1-2）═════════════════════════════════════
    phase('S1 开始：两个真实连接 ＋ 屏障（A 跑完释放执行锁后 B 才取锁）');
    const fixture1 = await seedFixture({
      app: appA,
      scope,
      fileRoot: packageRoot,
      tag: 's1',
      accountId,
      backupRunId,
      registry,
      entityLocalId: 11,
    });

    const barrier = createBarrier();
    const serviceB = buildService(appB, {
      restoreRunRepository: barrier.repository(appB.restoreRunRepository),
    });
    const serviceA = buildService(appA);

    // B 先跑到"锁前快路径读"并停住（此时读到的是 RUNNING）
    const bTask = serviceB.execute({
      restoreId: fixture1.restoreId,
      actorAccountId: accountId,
      allowedOrganizationId: null,
      now: new Date(),
    });
    bTask.catch(() => undefined);
    await barrier.reached;

    // A 在**另一个连接**上把这次恢复跑完（成功终态 ＋ 审计 ＋ 解冻）
    const connectionA = await connectionId(appA.dataSource);
    const outcomeA = await serviceA.execute({
      restoreId: fixture1.restoreId,
      actorAccountId: accountId,
      allowedOrganizationId: null,
      now: new Date(),
    });
    const connectionB = await connectionId(appB.dataSource);
    check(
      'S1 两个执行方使用**不同的真实连接**',
      connectionA !== connectionB,
      `A 连接 ID = ${connectionA}，B 连接 ID = ${connectionB}`,
    );
    check(
      'S1 A 的恢复执行成功（终态 SUCCEEDED）',
      outcomeA.status === 'SUCCEEDED',
      `A 结果 = ${outcomeA.status}${outcomeA.status === 'SUCCEEDED' ? '' : `（${outcomeA.reasonCode}）`}`,
    );
    const runAfterA = await readRunRow(appA.dataSource, fixture1.restoreId);
    const eventsAfterA = await readAuditEvents(appA.dataSource, fixture1.restoreId);
    check(
      'S1 A 之后：运行行是成功终态且只留一条成功审计',
      text(runAfterA?.['status']) === 'SUCCEEDED' &&
        eventsAfterA.length === 1 &&
        eventsAfterA[0]?.result === 'SUCCEEDED' &&
        eventsAfterA[0]?.stage === 'RESTORE_SUCCEEDED',
      `status=${text(runAfterA?.['status'])} 事件=${JSON.stringify(eventsAfterA)}`,
    );
    check(
      'S1 A 之后：冻结已解除（无活动冻结）',
      (await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)) === 0,
      `活动冻结行数 = ${await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)}`,
    );

    // 写入**新的受控哨兵**（A 之后、B 之前）
    const sentinelKey = `task09-p1-2-3-sentinel-${Date.now()}`;
    registry.uploadTaskKeys.push(sentinelKey);
    await appA.dataSource.getRepository(LocalUploadTaskEntity).insert({
      recordUuid: null,
      sourceVersion: null,
      taskKind: 'BACKUP_UPLOAD',
      manifestChecksum: null,
      organizationId: scope.organizationId,
      accountId,
      installationId: scope.installationId,
      entityType: 'BACKUP_MANIFEST',
      entityLocalId: 21,
      entityVersion: 'v-sentinel',
      idempotencyKey: sentinelKey,
      status: 'PENDING',
      attemptCount: 0,
      lastAttemptAt: null,
      remoteId: null,
      remoteReceipt: null,
      errorCode: null,
      errorMessage: null,
    });
    const rowsBefore = await uploadTaskRowCount(
      appA.dataSource,
      scope.installationId,
      scope.organizationId,
    );

    // 放行 B：B 此刻才去取执行锁（此时锁已由 A 释放）
    barrier.release();
    const outcomeB = await bTask;
    check(
      'S1 B 被受控拒绝（已终态不得再次执行旧备份）',
      outcomeB.status === 'FAILED' && outcomeB.reasonCode === 'RESTORE_ALREADY_TERMINAL',
      `B 结果 = ${outcomeB.status}${outcomeB.status === 'FAILED' ? `（${outcomeB.reasonCode}）` : ''}`,
    );

    const runAfterB = await readRunRow(appA.dataSource, fixture1.restoreId);
    const eventsAfterB = await readAuditEvents(appA.dataSource, fixture1.restoreId);
    const rowsAfterB = await uploadTaskRowCount(
      appA.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'S1 B **零写入**：运行行与 A 结束时逐字段一致',
      text(runAfterB?.['status']) === text(runAfterA?.['status']) &&
        text(runAfterB?.['finished_at']) === text(runAfterA?.['finished_at']) &&
        text(runAfterB?.['result_summary']) === text(runAfterA?.['result_summary']) &&
        text(runAfterB?.['restored_scope']) === text(runAfterA?.['restored_scope']),
      `A 后 = ${JSON.stringify(runAfterA)}；B 后 = ${JSON.stringify(runAfterB)}`,
    );
    check(
      'S1 B **零写入**：审计事件仍只有 A 的那一条成功终态',
      eventsAfterB.length === 1 &&
        eventsAfterB[0]?.result === 'SUCCEEDED' &&
        eventsAfterB[0]?.stage === 'RESTORE_SUCCEEDED',
      `B 后事件 = ${JSON.stringify(eventsAfterB)}`,
    );
    check(
      'S1 B **零写入**：受控哨兵保留（业务数据未被再次恢复覆盖）',
      rowsAfterB === rowsBefore && rowsAfterB >= 1,
      `B 前业务行数 = ${rowsBefore}，B 后 = ${rowsAfterB}`,
    );
    check(
      'S1 B **零写入**：未建立新的冻结',
      (await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)) === 0,
      `活动冻结行数 = ${await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)}`,
    );

    // ══ S2：终态状态更新失败（P1-3）════════════════════════════════════════
    phase('S2 开始：注入"终态状态更新失败"（真实库 CHECK 约束）');
    const fixture2 = await seedFixture({
      app: appA,
      scope,
      fileRoot: packageRoot,
      tag: 's2',
      accountId,
      backupRunId,
      registry,
      entityLocalId: 12,
    });

    await installConstraint(
      appA.dataSource,
      'chk_task09_block_restore_success',
      'backup_restore_run',
      `status <> 'SUCCEEDED' OR restore_id <> '${fixture2.restoreId}'`,
    );
    registry.constraints.push({
      name: 'chk_task09_block_restore_success',
      table: 'backup_restore_run',
    });
    const outcomeS2 = await buildService(appA).execute({
      restoreId: fixture2.restoreId,
      actorAccountId: accountId,
      allowedOrganizationId: null,
      now: new Date(),
    });
    await dropConstraint(appA.dataSource, 'chk_task09_block_restore_success', 'backup_restore_run');
    registry.constraints.splice(
      registry.constraints.findIndex((item) => item.name === 'chk_task09_block_restore_success'),
      1,
    );

    const runS2 = await readRunRow(appA.dataSource, fixture2.restoreId);
    const eventsS2 = await readAuditEvents(appA.dataSource, fixture2.restoreId);
    const rowsS2 = await uploadTaskRowCount(
      appA.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'S2 状态更新失败 ⇒ 终态为失败（不得呈现成功）',
      text(runS2?.['status']) === 'FAILED' &&
        outcomeS2.status === 'FAILED' &&
        eventsS2.every((event) => event.result === 'FAILED'),
      `status=${text(runS2?.['status'])} 结果=${outcomeS2.status} 事件=${JSON.stringify(eventsS2)}`,
    );
    check(
      'S2 状态更新失败 ⇒ **不留成功事件**（同一事实不重复、不矛盾）',
      eventsS2.length === 1 &&
        eventsS2[0]?.result === 'FAILED' &&
        eventsS2[0]?.stage === 'RESTORE_ROLLED_BACK',
      `事件 = ${JSON.stringify(eventsS2)}`,
    );
    check(
      'S2 失败并回滚 ⇒ 业务数据回到**恢复前状态**（保护副本里的既有行）',
      rowsS2 === 1,
      `上传任务行数 = ${rowsS2}（期望 1：恢复前既有行）`,
    );
    check(
      'S2 失败并回滚 ⇒ 冻结已解除（设备可继续写入）',
      (await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)) === 0,
      `活动冻结行数 = ${await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)}`,
    );

    // ══ S3：解冻失败（P1-3）═════════════════════════════════════════════════
    phase('S3 开始：注入"冻结解除失败"（真实库 CHECK 约束）');
    const fixture3 = await seedFixture({
      app: appA,
      scope,
      fileRoot: packageRoot,
      tag: 's3',
      accountId,
      backupRunId,
      registry,
      entityLocalId: 13,
    });

    await installConstraint(
      appA.dataSource,
      'chk_task09_block_hold_release',
      'local_write_hold',
      `status <> 'RELEASED' OR restore_id <> '${fixture3.restoreId}'`,
    );
    registry.constraints.push({ name: 'chk_task09_block_hold_release', table: 'local_write_hold' });
    const outcomeS3 = await buildService(appA).execute({
      restoreId: fixture3.restoreId,
      actorAccountId: accountId,
      allowedOrganizationId: null,
      now: new Date(),
    });
    await dropConstraint(appA.dataSource, 'chk_task09_block_hold_release', 'local_write_hold');
    registry.constraints.splice(
      registry.constraints.findIndex((item) => item.name === 'chk_task09_block_hold_release'),
      1,
    );

    const runS3 = await readRunRow(appA.dataSource, fixture3.restoreId);
    const eventsS3 = await readAuditEvents(appA.dataSource, fixture3.restoreId);
    const rowsS3 = await uploadTaskRowCount(
      appA.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'S3 解冻失败 ⇒ 终态仍是成功（数据确实已恢复，不改判失败、不回滚）',
      text(runS3?.['status']) === 'SUCCEEDED' &&
        outcomeS3.status === 'SUCCEEDED' &&
        outcomeS3.released === false &&
        outcomeS3.holdRetained === true,
      `status=${text(runS3?.['status'])} 结果=${outcomeS3.status} released=${String(outcomeS3.status === 'SUCCEEDED' ? outcomeS3.released : 'n/a')}`,
    );
    check(
      'S3 解冻失败 ⇒ **不出现"成功＋失败"双终态**（两条事实都是成功）',
      eventsS3.length === 2 &&
        eventsS3.every((event) => event.result === 'SUCCEEDED') &&
        eventsS3.map((event) => event.stage).join(',') ===
          'RESTORE_SUCCEEDED,RESTORE_SUCCEEDED_HOLD_RETAINED',
      `事件 = ${JSON.stringify(eventsS3)}`,
    );
    check(
      'S3 解冻失败 ⇒ 冻结**保留**（设备继续停写停传）',
      (await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)) === 1,
      `活动冻结行数 = ${await activeHoldCount(appA.dataSource, scope.installationId, scope.organizationId)}`,
    );
    check(
      'S3 解冻失败 ⇒ 数据保持**恢复后的状态**（恢复前既有行已被替换掉）',
      rowsS3 === 0,
      `上传任务行数 = ${rowsS3}（期望 0：备份里的业务事实为空）`,
    );
  } finally {
    // ── 收尾：先删故障注入，再按**真实创建 ID** 精确回收 ──────────────────
    for (const constraint of registry.constraints) {
      try {
        await dropConstraint(appA.dataSource, constraint.name, constraint.table);
      } catch {
        // 忽略（主因优先）
      }
    }
    for (const restoreId of registry.restoreIds) {
      try {
        // 本轮恢复产生的终态事实（审计事件 ＋ 已释放冻结记录）也一并回收
        await appA.dataSource.query(
          "DELETE FROM management_audit_event WHERE target_type = 'LOCAL_RESTORE' AND target_id = ?",
          [restoreId],
        );
      } catch {
        // 忽略
      }
      try {
        await appA.dataSource.query('DELETE FROM local_write_hold WHERE restore_id = ?', [
          restoreId,
        ]);
      } catch {
        // 忽略
      }
      try {
        await appA.dataSource.query('DELETE FROM backup_restore_run WHERE restore_id = ?', [
          restoreId,
        ]);
      } catch {
        // 忽略
      }
    }
    for (const key of registry.uploadTaskKeys) {
      try {
        await appA.dataSource.query('DELETE FROM local_upload_task WHERE idempotency_key = ?', [
          key,
        ]);
      } catch {
        // 忽略
      }
    }
    for (const backupId of registry.backupIds) {
      try {
        await appA.dataSource.query('DELETE FROM backup_asset WHERE backup_id = ?', [backupId]);
      } catch {
        // 忽略
      }
    }
    for (const runId of registry.backupRunIds) {
      try {
        await appA.dataSource.query('DELETE FROM local_backup_run WHERE id = ?', [runId]);
      } catch {
        // 忽略
      }
    }
    for (const accountId of registry.accountIds) {
      try {
        await appA.dataSource.query('DELETE FROM base_user_account WHERE id = ?', [accountId]);
      } catch {
        // 忽略
      }
    }
    try {
      await appA.dataSource.query(
        'DELETE FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?',
        [scope.installationId, scope.organizationId, 'ACTIVE'],
      );
    } catch {
      // 忽略
    }
    // 文件：只删本轮受控子目录
    try {
      assertPathWithinRoot(fileRoot, packageRoot);
      rmSync(packageRoot, { force: true, recursive: true });
    } catch {
      // 忽略
    }

    // ── 残留核对（清理之后、连接关闭之前）─────────────────────────────────
    try {
      const residue: unknown = await appA.dataSource.query(
        'SELECT (SELECT COUNT(*) FROM backup_restore_run WHERE restore_id LIKE ?) AS runs, ' +
          '(SELECT COUNT(*) FROM backup_asset WHERE storage_reference LIKE ?) AS assets, ' +
          '(SELECT COUNT(*) FROM local_upload_task WHERE idempotency_key LIKE ?) AS tasks, ' +
          '(SELECT COUNT(*) FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?) AS holds',
        [
          'task09-%',
          'task09/%',
          'task09-p1-2-3-%',
          scope.installationId,
          scope.organizationId,
          'ACTIVE',
        ],
      );
      const residueRow: Record<string, unknown> =
        (residue as Array<Record<string, unknown>>)[0] ?? {};
      check(
        '收尾：本轮对象零残留（运行行／资产／业务行／活动冻结）',
        Number(residueRow['runs'] ?? 0) === 0 &&
          Number(residueRow['assets'] ?? 0) === 0 &&
          Number(residueRow['tasks'] ?? 0) === 0 &&
          Number(residueRow['holds'] ?? 0) === 0,
        `残留 = ${JSON.stringify(residueRow)}`,
      );
    } catch (error) {
      check('收尾：本轮对象零残留', false, `残留核对失败：${text(error)}`);
    }

    // 关闭连接（异常路径也必须关闭，否则进程不退出）
    await appA.dataSource.destroy().catch(() => undefined);
    await appB.dataSource.destroy().catch(() => undefined);
  }

  const failed = assertions.filter((item) => !item.passed);
  const evidence = {
    capturedAt: new Date().toISOString(),
    database: auth.database,
    installationId: scope.installationId,
    organizationId: scope.organizationId,
    scenarios: [
      'S1 延迟到达的重复请求（两个真实连接＋屏障）',
      'S2 终态状态更新失败（库级 CHECK 约束注入）',
      'S3 冻结解除失败（库级 CHECK 约束注入）',
    ],
    assertions,
  };
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const evidenceFile = process.env['TASK09_RESTORE_EVIDENCE_FILE'];
  if (evidenceFile !== undefined && evidenceFile !== '') {
    mkdirSync(join(evidenceFile, '..'), { recursive: true });
    writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`证据已写入：${evidenceFile}\n`);
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (failed.length > 0) {
    process.stderr.write(`\n❌ P1-2／P1-3 取证失败：${failed.length} 项断言未通过\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n✅ P1-2／P1-3 取证通过：${assertions.length} 项断言全部成立\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
