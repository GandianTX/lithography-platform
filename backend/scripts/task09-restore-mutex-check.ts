// scripts/task09-restore-mutex-check.ts
/**
 * 任务 09 · **恢复受理／执行的互斥与冻结所有权**取证脚本（G30–G33）。
 *
 * 目的：把"同安装×公司同一时刻只有一个恢复写入""同一恢复不得并发执行"
 * "受理幂等""冻结释放必须校验持有者"从**结构性推断**变成**真实入口实测结论**。
 *
 * | 场景 | 期望行为（产品口径） | 实测关注点 |
 * | --- | --- | --- |
 * | M1 同一 restoreId **并发执行** | 一个成功，另一个受控拒绝（不写半个库） | 执行权互斥（数据库命名锁） |
 * | M2 范围**已被其它恢复占用**时执行 | 受控拒绝，且**业务数据一个字节都没写** | 范围占用判定与"未写入" |
 * | M3 **并发受理**同一预检 | 一个受理成功，另一个受控拒绝 | 受理 CAS（条件更新） |
 * | M4 **释放他人**的恢复期冻结 | 拒绝（不得把别人的冻结解掉） | 冻结所有权 |
 *
 * 断言写的是**期望行为**，不是当前行为：若实现存在缺陷，脚本会**如实失败**（exit 1）
 * 并把复现证据写进 JSON——缺陷不靠改断言掩盖。
 *
 * 纪律：
 * - **默认拒绝**：复用恢复自检同一套环境变量（一次性库、预期实例身份、一次性库标识、
 *   受控文件根、安装／公司标识、测试授权），缺一即零写入退出；
 * - 只写**本轮创建**的对象，精确登记真实 ID 后回收；非目标哨兵必须保持；
 * - 本轮自建目录（备份产物）整目录回收，不触碰其它目录。
 *
 * 用法：见 `.local/task09/run-restore-race.sh` 的同款环境变量。
 */

// 脚本属**受控 wiring**（同 scripts/task09-restore-selfcheck.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { AcceptLocalRestoreUsecase } from '@src/usecases/local-runtime/accept-local-restore.usecase';
import { ExecuteLocalRestoreUsecase } from '@src/usecases/local-runtime/execute-local-restore.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { PrecheckLocalRestoreUsecase } from '@src/usecases/local-runtime/precheck-local-restore.usecase';
import { StartManualLocalBackupUsecase } from '@src/usecases/local-runtime/start-manual-local-backup.usecase';

import {
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  text,
} from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

type Session = {
  accountId: number;
  roles: string[];
  activeRole: string;
  adminLevel: number;
  customerOrganizationId: null;
};

/** 会话按 usecase 契约构造（枚举型角色在边界处 cast，见 interrupt-child 同款做法） */
function toUsecaseSession(session: Session): UsecaseSession {
  return session as unknown as UsecaseSession;
}

type AppContext = {
  dataSource: DataSource;
  writeHold: LocalWriteHoldService;
  startBackup: StartManualLocalBackupUsecase;
  precheck: PrecheckLocalRestoreUsecase;
  accept: AcceptLocalRestoreUsecase;
  execute: ExecuteLocalRestoreUsecase;
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
      LocalRuntimeStorageModule,
      LocalRuntimeUsecasesModule,
    ],
  }).compile();

  return {
    dataSource: moduleRef.get(DataSource),
    writeHold: moduleRef.get(LocalWriteHoldService),
    startBackup: moduleRef.get(StartManualLocalBackupUsecase),
    precheck: moduleRef.get(PrecheckLocalRestoreUsecase),
    accept: moduleRef.get(AcceptLocalRestoreUsecase),
    execute: moduleRef.get(ExecuteLocalRestoreUsecase),
  };
}

/** 本轮创建的对象登记（收尾时精确回收） */
type Owned = {
  restoreIds: string[];
  backupIds: string[];
  holdIds: string[];
  fileRoot: string;
};

async function readAdminSession(dataSource: DataSource, organizationId: number): Promise<Session> {
  const rows: unknown = await dataSource.query(
    'SELECT m.account_id AS account_id FROM organization_membership m ' +
      'JOIN base_user_account a ON a.id = m.account_id ' +
      "WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND a.status = 'ACTIVE' " +
      "AND m.member_role = 'SUPER_ADMIN' AND a.admin_level = 1 ORDER BY m.id ASC LIMIT 1",
    [organizationId],
  );
  const accountId = Number((rows as Array<{ account_id: number }>)[0]?.account_id ?? 0);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error('找不到本公司有效的一级管理员账号，拒绝运行');
  }
  return {
    accountId,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: 1,
    customerOrganizationId: null,
  };
}

/** 业务表逐表行数（用于"未写入任何业务数据"的判据） */
async function scopeRowCounts(dataSource: DataSource): Promise<Record<string, number>> {
  const tables = [
    'repair_request',
    'repair_request_intake',
    'maintenance_report',
    'maintenance_report_version',
    'maintenance_report_attachment',
    'reference_document',
    'ai_conversation',
    'ai_message',
    'engineer_response',
    'local_upload_task',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows: unknown = await dataSource.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
    counts[table] = Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
  }
  return counts;
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  return Object.keys(a).every((table) => a[table] === b[table]);
}

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  const owned: Owned = { restoreIds: [], backupIds: [], holdIds: [], fileRoot: '' };

  // 本轮备份产物目录（自建子目录，收尾整目录回收）
  const runRoot = join(auth.fileRoot, 'mutex-check', `run-${Date.now()}`);
  owned.fileRoot = runRoot;
  mkdirSync(join(runRoot, 'backups'), { recursive: true });
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_STORAGE_DIR = join(runRoot, 'backups');
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_PROTECTION_KEY =
    '9f2c7a1d4e6b8035c7d9e1f4a2b6c8d0e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3';

  const app = await bootstrap(auth.envFile, auth.database);
  const installationId = await readInstallationId(app.dataSource);
  try {
    // ── 身份核对（默认拒绝） ──────────────────────────────────────────────
    const serverRows: unknown = await app.dataSource.query('SELECT @@server_uuid AS serverUuid');
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
    const markerRows: unknown = await app.dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    assertDisposableMarker(
      (markerRows as Array<Record<string, unknown>>).map((row) => ({
        markerKey: text(row['marker_key']),
        markerValue: text(row['marker_value']),
      })),
      auth.disposableMarker,
    );
    if (installationId !== auth.installationId) {
      throw new Error('库内安装标识与声明不一致，拒绝运行');
    }
    const session = await readAdminSession(app.dataSource, auth.organizationId);
    const detail: Record<string, Record<string, unknown>> = {};

    // ── M3：并发受理同一预检 ⇒ 只有一个受理成功 ────────────────────────────
    const backup1 = await app.startBackup.execute({ session: toUsecaseSession(session) });
    if (backup1.status !== 'SUCCEEDED' || backup1.backupId === null) {
      throw new Error(`准备备份失败：status=${backup1.status}`);
    }
    owned.backupIds.push(backup1.backupId);
    const precheck1 = await app.precheck.execute({
      session: toUsecaseSession(session),
      backupId: backup1.backupId,
    });
    if (precheck1.outcome !== 'PASSED') {
      throw new Error(`预检未通过：${precheck1.outcome}`);
    }
    const acceptResults = await Promise.allSettled([
      app.accept.execute({ session: toUsecaseSession(session), restoreId: precheck1.restoreId }),
      app.accept.execute({ session: toUsecaseSession(session), restoreId: precheck1.restoreId }),
    ]);
    const accepted = acceptResults.filter((item) => item.status === 'fulfilled').length;
    const rejectedAccept = acceptResults.filter((item) => item.status === 'rejected').length;
    const acceptedFlags = acceptResults
      .filter((item) => item.status === 'fulfilled')
      .map((item) => (item as PromiseFulfilledResult<{ accepted: boolean }>).value.accepted);
    const acceptRaw = acceptResults.map((item) =>
      item.status === 'fulfilled'
        ? {
            status: 'fulfilled',
            accepted: (item as PromiseFulfilledResult<{ accepted: boolean }>).value.accepted,
          }
        : {
            status: 'rejected',
            reason: String(item.reason),
          },
    );
    owned.restoreIds.push(precheck1.restoreId);
    detail.m3 = { accepted, rejectedAccept, acceptedFlags, acceptRaw };
    // 受理被拒时 usecase **抛受控 DomainError**（幂等拒绝）⇒ 表现为 rejected，
    // 而不是"返回 accepted=false"。
    check(
      'M3 并发受理同一预检：只有一个受理成功，另一个受控拒绝（幂等）',
      accepted === 1 && rejectedAccept === 1 && acceptedFlags.filter((flag) => flag).length === 1,
      `两路并发受理：受理成功 ${acceptedFlags.filter((flag) => flag).length}，` +
        `受控拒绝 ${rejectedAccept}` +
        `（拒绝原因：${acceptRaw.find((item) => item.status === 'rejected')?.reason ?? '无'}）`,
    );

    // ── M1：同一 restoreId 并发执行 ⇒ 一个成功、一个受控拒绝 ──────────────
    const countsBeforeExecute = await scopeRowCounts(app.dataSource);
    const executeResults = await Promise.allSettled([
      app.execute.execute({ session: toUsecaseSession(session), restoreId: precheck1.restoreId }),
      app.execute.execute({ session: toUsecaseSession(session), restoreId: precheck1.restoreId }),
    ]);
    const outcomes = executeResults
      .filter((item) => item.status === 'fulfilled')
      .map(
        (item) => (item as PromiseFulfilledResult<{ status: string; reasonCode?: string }>).value,
      );
    const succeeded = outcomes.filter((item) => item.status === 'SUCCEEDED').length;
    const rejectedByMutex = outcomes.filter(
      (item) => item.status === 'FAILED' && item.reasonCode === 'RESTORE_EXECUTION_ALREADY_RUNNING',
    ).length;
    detail.m1 = {
      statuses: outcomes.map((item) => ({
        status: item.status,
        reasonCode: item.reasonCode ?? null,
      })),
    };
    check(
      'M1 同一恢复并发执行：恰好一个成功，另一个被执行权互斥拒绝',
      succeeded === 1 && rejectedByMutex === 1,
      `两路并发执行：成功 ${succeeded}，执行权互斥拒绝 ${rejectedByMutex}，` +
        `（状态：${outcomes.map((item) => `${item.status}/${item.reasonCode ?? '-'}`).join('，')}）`,
    );

    // 终态只留一条（互斥成立 ⇒ 不会写出两条终态事件）
    const terminalRows: unknown = await app.dataSource.query(
      // 终态事件按 target_id ＝ 恢复 ID 取（审计表无 restore_id 列）
      'SELECT COUNT(*) AS c FROM management_audit_event WHERE target_id = ? AND result = ?',
      [precheck1.restoreId, 'SUCCEEDED'],
    );
    const terminalCount = Number((terminalRows as Array<{ c: number | string }>)[0]?.c ?? 0);
    detail.m1.terminalEventCount = terminalCount;
    check(
      'M1 并发执行只留一条成功终态事件',
      terminalCount === 1,
      `SUCCEEDED 终态事件 ${terminalCount} 条`,
    );

    // ── M2：范围已被其它恢复占用时执行 ⇒ 受控拒绝且业务数据未变 ────────────
    // **备份／预检／受理都必须在冻结建立之前完成**（备份与同步同样受写入冻结守卫约束），
    // 否则取证会退化成"备份被守卫拒绝"，测不到"范围占用"这一层。
    const foreignRestoreId = 'task09-mutex-foreign-restore';
    const backup2 = await app.startBackup.execute({ session: toUsecaseSession(session) });
    if (backup2.status !== 'SUCCEEDED' || backup2.backupId === null) {
      throw new Error(`准备备份失败：status=${backup2.status}`);
    }
    owned.backupIds.push(backup2.backupId);
    const precheck2 = await app.precheck.execute({
      session: toUsecaseSession(session),
      backupId: backup2.backupId,
    });
    if (precheck2.outcome !== 'PASSED') {
      throw new Error(`预检未通过：${precheck2.outcome}`);
    }
    owned.restoreIds.push(precheck2.restoreId);
    await app.accept.execute({
      session: toUsecaseSession(session),
      restoreId: precheck2.restoreId,
    });
    const foreignHold = await app.writeHold.hold({
      installationId,
      organizationId: auth.organizationId,
      restoreId: foreignRestoreId,
      reason: '任务09 互斥取证：其它恢复的冻结',
    });
    owned.holdIds.push(foreignHold.holdId);
    const countsBeforeConflict = await scopeRowCounts(app.dataSource);
    const conflictOutcome = await app.execute.execute({
      session: toUsecaseSession(session),
      restoreId: precheck2.restoreId,
    });
    const countsAfterConflict = await scopeRowCounts(app.dataSource);
    detail.m2 = {
      status: conflictOutcome.status,
      reasonCode: conflictOutcome.status === 'FAILED' ? conflictOutcome.reasonCode : null,
      rowsUnchanged: sameCounts(countsBeforeConflict, countsAfterConflict),
    };
    check(
      'M2 范围被其它恢复占用时执行 ⇒ 受控拒绝（RESTORE_SCOPE_OCCUPIED）',
      conflictOutcome.status === 'FAILED' &&
        conflictOutcome.reasonCode === 'RESTORE_SCOPE_OCCUPIED',
      `status=${conflictOutcome.status} reasonCode=` +
        `${conflictOutcome.status === 'FAILED' ? conflictOutcome.reasonCode : '-'}`,
    );
    check(
      'M2 受控拒绝时业务数据**一个字节都没写**（逐表行数不变）',
      sameCounts(countsBeforeConflict, countsAfterConflict),
      `执行前逐表行数与执行后一致：${text(sameCounts(countsBeforeConflict, countsAfterConflict))}`,
    );

    // ── M4：释放他人冻结 ⇒ 拒绝（不得把别人的冻结解掉） ───────────────────
    let wrongOwnerReleased = 0;
    let wrongOwnerRejected = false;
    let wrongOwnerReason = '';
    try {
      wrongOwnerReleased = await app.writeHold.release({
        installationId,
        organizationId: auth.organizationId,
        restoreId: 'task09-mutex-not-owner',
      });
    } catch (error) {
      wrongOwnerRejected = true;
      wrongOwnerReason = error instanceof Error ? error.message : text(error);
    }
    const foreignRows: unknown = await app.dataSource.query(
      'SELECT status FROM local_write_hold WHERE hold_id = ?',
      [foreignHold.holdId],
    );
    const foreignStillActive =
      String((foreignRows as Array<{ status: string }>)[0]?.status ?? '') === 'ACTIVE';
    detail.m4 = {
      wrongOwnerReleased,
      wrongOwnerRejected,
      wrongOwnerReason,
      foreignStillActive,
    };
    check(
      'M4 释放他人冻结 ⇒ 不得解掉（所有权不可伪造）',
      wrongOwnerReleased === 0 && foreignStillActive,
      `错误归属释放 ${wrongOwnerReleased} 条` +
        `${wrongOwnerRejected ? `（受控拒绝：${wrongOwnerReason}）` : ''}` +
        `；他人冻结仍 ACTIVE=${text(foreignStillActive)}`,
    );

    // 被拒绝的那次执行**不得**把冻结建立成自己的归属（不得抢归属）
    const holdRows: unknown = await app.dataSource.query(
      'SELECT hold_id, restore_id FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?',
      [installationId, auth.organizationId, 'ACTIVE'],
    );
    const activeHolds = holdRows as Array<{ hold_id: string; restore_id: string | null }>;
    const foreignOwnershipKept = activeHolds.some(
      (row) => row.hold_id === foreignHold.holdId && row.restore_id === foreignRestoreId,
    );
    detail.m4.foreignOwnershipKept = foreignOwnershipKept;
    check(
      'M4 被拒绝的执行**不得抢走**他人冻结的归属',
      foreignOwnershipKept,
      `他人冻结归属仍为 ${text(foreignRestoreId)}：${text(foreignOwnershipKept)}`,
    );

    // ── 收尾：按本轮真实 ID 精确回收 ──────────────────────────────────────
    const cleanupErrors: string[] = [];
    for (const holdId of owned.holdIds) {
      try {
        await app.dataSource.query('DELETE FROM local_write_hold WHERE hold_id = ?', [holdId]);
      } catch (error) {
        cleanupErrors.push(
          `hold ${holdId}：${text(error instanceof Error ? error.message : error)}`,
        );
      }
    }
    // 本轮创建的恢复运行行（含保护副本引用）⇒ 先取保护副本 ID，再按精确 ID 回收
    const ownedBackupIds = new Set<string>(owned.backupIds);
    for (const restoreId of owned.restoreIds) {
      try {
        const runRows: unknown = await app.dataSource.query(
          'SELECT backup_id, protection_backup_id FROM backup_restore_run WHERE restore_id = ?',
          [restoreId],
        );
        for (const row of runRows as Array<{
          backup_id: string;
          protection_backup_id: string | null;
        }>) {
          if (row.backup_id) {
            ownedBackupIds.add(row.backup_id);
          }
          if (row.protection_backup_id) {
            ownedBackupIds.add(row.protection_backup_id);
          }
        }
        await app.dataSource.query('DELETE FROM backup_restore_run WHERE restore_id = ?', [
          restoreId,
        ]);
      } catch (error) {
        cleanupErrors.push(
          `restore_run ${restoreId}：${text(error instanceof Error ? error.message : error)}`,
        );
      }
    }
    for (const backupId of ownedBackupIds) {
      try {
        const assetRows: unknown = await app.dataSource.query(
          'SELECT run_id FROM backup_asset WHERE backup_id = ?',
          [backupId],
        );
        // **先删子表再删父表**（`backup_asset.run_id → local_backup_run.id` 是 RESTRICT）
        await app.dataSource.query('DELETE FROM backup_asset WHERE backup_id = ?', [backupId]);
        for (const row of assetRows as Array<{ run_id: string | null }>) {
          if (row.run_id) {
            await app.dataSource.query('DELETE FROM local_backup_run WHERE id = ?', [row.run_id]);
          }
        }
      } catch (error) {
        cleanupErrors.push(
          `backup_asset ${backupId}：${text(error instanceof Error ? error.message : error)}`,
        );
      }
    }
    const remainingHolds: unknown = await app.dataSource.query(
      'SELECT COUNT(*) AS c FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?',
      [installationId, auth.organizationId, 'ACTIVE'],
    );
    const remainingCount = Number((remainingHolds as Array<{ c: number | string }>)[0]?.c ?? 0);
    check(
      '收尾：目标范围无残留 ACTIVE 冻结',
      remainingCount === 0,
      `残留 ACTIVE ${remainingCount} 条`,
    );
    check(
      '收尾：本轮自建冻结行按 hold_id 精确删除无失败',
      cleanupErrors.length === 0,
      cleanupErrors.length === 0 ? '按 hold_id 精确删除完成' : cleanupErrors.join(' | '),
    );
    const runRowsLeft: unknown = await app.dataSource.query(
      'SELECT COUNT(*) AS c FROM backup_restore_run WHERE restore_id IN (?)',
      [owned.restoreIds],
    );
    const assetRowsLeft: unknown = await app.dataSource.query(
      'SELECT COUNT(*) AS c FROM backup_asset WHERE backup_id IN (?)',
      [[...ownedBackupIds]],
    );
    check(
      '收尾：本轮恢复运行行与备份资产零残留',
      Number((runRowsLeft as Array<{ c: number }>)[0]?.c ?? 0) === 0 &&
        Number((assetRowsLeft as Array<{ c: number }>)[0]?.c ?? 0) === 0,
      `残留恢复运行 ${String((runRowsLeft as Array<{ c: number }>)[0]?.c ?? 0)} 行，` +
        `残留备份资产 ${String((assetRowsLeft as Array<{ c: number }>)[0]?.c ?? 0)} 行`,
    );
    void countsBeforeExecute;
  } finally {
    // ── 兜底回收（**异常路径也执行**）：按本轮真实 ID 精确删除 ──────────────
    // 不做这一步 ⇒ 一次失败运行就会在隔离库里留下 ACTIVE 冻结，
    // 下一轮连备份都会被守卫拒绝（现场污染 ⇒ 后续结论不可信）。
    try {
      const assetIds = new Set<string>(owned.backupIds);
      for (const restoreId of owned.restoreIds) {
        const runRows: unknown = await app.dataSource.query(
          'SELECT backup_id, protection_backup_id FROM backup_restore_run WHERE restore_id = ?',
          [restoreId],
        );
        for (const row of runRows as Array<{
          backup_id: string;
          protection_backup_id: string | null;
        }>) {
          if (row.backup_id) {
            assetIds.add(row.backup_id);
          }
          if (row.protection_backup_id) {
            assetIds.add(row.protection_backup_id);
          }
        }
        await app.dataSource.query('DELETE FROM backup_restore_run WHERE restore_id = ?', [
          restoreId,
        ]);
      }
      for (const backupId of assetIds) {
        const assetRows: unknown = await app.dataSource.query(
          'SELECT run_id FROM backup_asset WHERE backup_id = ?',
          [backupId],
        );
        // **先删子表再删父表**（RESTRICT 外键）
        await app.dataSource.query('DELETE FROM backup_asset WHERE backup_id = ?', [backupId]);
        for (const row of assetRows as Array<{ run_id: string | null }>) {
          if (row.run_id) {
            await app.dataSource.query('DELETE FROM local_backup_run WHERE id = ?', [row.run_id]);
          }
        }
      }
      for (const holdId of owned.holdIds) {
        await app.dataSource.query('DELETE FROM local_write_hold WHERE hold_id = ?', [holdId]);
      }
    } catch {
      // 兜底回收失败只影响本地残留，由断言与人工核对发现（不掩盖主失败）
    }
    // 本轮自建目录整目录回收（不触碰其它目录）
    try {
      rmSync(runRoot, { recursive: true, force: true });
    } catch {
      // 目录回收失败只影响本地临时文件，不影响数据库结论
    }
    await app.dataSource.destroy();
  }

  const failed = assertions.filter((item) => !item.passed);
  const outputFile =
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env.TASK09_MUTEX_OUTPUT ??
    join(process.cwd(), '..', '.local', 'task09', 'evidence', 'restore-mutex-check.json');
  mkdirSync(join(process.cwd(), '..', '.local', 'task09', 'evidence'), { recursive: true });
  writeFileSync(
    outputFile,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        database: auth.database,
        installationId,
        organizationId: auth.organizationId,
        assertions,
        assertionTotal: assertions.length,
        assertionFailed: failed.length,
        passed: failed.length === 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  process.stdout.write(`\n断言：${assertions.length} 项，失败 ${failed.length} 项\n`);
  for (const item of failed) {
    process.stdout.write(`  ✗ ${item.name}：${item.detail}\n`);
  }
  process.stdout.write(`证据：${outputFile}\n`);
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
