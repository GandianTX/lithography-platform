// src/modules/lithography/local-restore-execution.service.spec.ts

/**
 * 恢复执行编排的定向测试（任务 09 S5-2／S5-3；独立验收 P1-2／P1-3）。
 *
 * 守住五条：
 * 1. 未受理／预检未通过 ⇒ 不执行不冻结；闸门未就绪 ⇒ 如实不可用；
 * 2. 成功 ⇒ 先冻结、恢复、核验，**终态发布**（运行终态＋最终审计同事务）后解除冻结；
 * 3. 失败 ⇒ 按保护副本回滚，**保持冻结**、终态 FAILED、保护副本与任务不被清理；
 * 4. **执行占用**（P1-2）：取得执行权后必须重读最新运行事实并原子占用，
 *    已终态的恢复**不得**再次执行旧备份（零写入受控拒绝）；
 * 5. **终态一致性**（P1-3）：运行终态与最终审计原子落地；解冻失败**不回滚、不改判失败**
 *    ⇒ 不出现"成功＋失败"双终态（旧单测把双终态写成预期，这里已改正）。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BACKUP_PAYLOAD_PATH,
  buildProtectedBackupManifest,
  encryptBackupPayload,
  parseProtectionKey,
} from '@core/local-runtime/policy/protected-backup.policy';

import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

import { LocalRestoreExecutionService } from './local-restore-execution.service';

const KEY_HEX = 'a'.repeat(64);
const INSTALLATION_ID = 'inst-1';
const ORGANIZATION_ID = 4;

type RunRow = {
  restoreId: string;
  backupId: string;
  protectionBackupId: string;
  targetInstallationId: string | null;
  organizationId: number;
  status: string;
  checkStatus: string;
  confirmation: unknown;
};

function buildPackage(root: string, payload: Record<string, unknown>, dirName = 'package'): string {
  const packageDir = join(root, dirName);
  mkdirSync(packageDir, { recursive: true });
  const key = parseProtectionKey(KEY_HEX);
  const encrypted = encryptBackupPayload(key, Buffer.from(JSON.stringify(payload), 'utf8'));
  writeFileSync(join(packageDir, BACKUP_PAYLOAD_PATH), encrypted.data);
  const manifest = buildProtectedBackupManifest({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    runId: 1,
    generatedAt: new Date('2026-10-01T00:00:00.000Z'),
    encryption: { keyId: 'kid-1', iv: encrypted.iv, authTag: encrypted.authTag },
    // 清单必须覆盖**全部范围表**（生成端与恢复端共用同一契约）
    scope: [
      { table: 'repair_request', rowCount: 0, lastUpdatedAt: null },
      { table: 'maintenance_report', rowCount: 1, lastUpdatedAt: null },
      { table: 'reference_document', rowCount: 0, lastUpdatedAt: null },
      { table: 'stored_file', rowCount: 0, lastUpdatedAt: null },
      { table: 'local_upload_task', rowCount: 0, lastUpdatedAt: null },
      { table: 'local_backup_run', rowCount: 0, lastUpdatedAt: null },
    ],
    files: [
      {
        relative_path: BACKUP_PAYLOAD_PATH,
        sha256: 'b'.repeat(64),
        byte_size: encrypted.data.byteLength,
      },
    ],
    originals: [],
  });
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return packageDir;
}

function buildService(options: {
  runStatus?: string;
  checkStatus?: string;
  protectionStatus?: string;
  writer?: unknown;
  /** 冻结解除失败（模拟"终态已发布但停写停传没解除"） */
  releaseError?: boolean;
  /** 保护副本可读（回滚能成功 ⇒ 走到"冻结解除失败"那条路径） */
  protectionPackageReady?: boolean;
  /** 恢复执行权（数据库命名锁）是否取得：0＝已被同一次恢复的并发执行占用 */
  executionLockAcquired?: number;
  /** 过期清理服务替身（恢复运行时检查）；不提供则该检查缺席 */
  cleanupService?: { cleanupAllExpiredPackages: () => Promise<unknown> };
  /**
   * **取得执行权之后**读到的最新运行事实（锁前快路径读到的行与之不同 ⇒ 制造"过期读"）。
   * 传 null 表示最新事实里已经没有这次恢复。
   */
  latestRun?: Partial<RunRow> | null;
  /** 执行占用（条件更新）的影响行数；0 ⇒ 已被别人终态化／占用 */
  claimAffected?: number;
  /** 终态发布（条件更新）的影响行数；0 ⇒ 已被别人终态化 */
  terminalAffected?: number;
  /** 终态状态更新抛错（注入"事件写成功但状态更新失败"的反面：状态更新失败） */
  terminalUpdateError?: boolean;
  /** 执行人的公司授权范围（null＝全局范围） */
  allowedOrganizationId?: number | null;
  /** 当前该公司数据区的活动冻结条数（用于如实回报 holdRetained） */
  activeHoldCount?: number;
}) {
  const root = '/tmp/task09-restore-spec';
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  const packageDir = buildPackage(root, { maintenance_report: [{ id: 1 }] });
  if (options.protectionPackageReady === true) {
    // 保护副本可读 ⇒ 按保护副本回滚能成功
    buildPackage(root, { maintenance_report: [{ id: 1 }] }, 'protection');
  }

  const baseRun: RunRow = {
    restoreId: 'restore-1',
    backupId: 'backup-source',
    protectionBackupId: 'backup-protection',
    targetInstallationId: INSTALLATION_ID,
    organizationId: ORGANIZATION_ID,
    status: 'RUNNING',
    checkStatus: 'PASSED',
    confirmation: { accepted_at: '2026-11-23T00:00:00.000Z' },
  };
  // 锁前快路径读到的行（**可能过期**）
  const fastPathRun: RunRow = {
    ...baseRun,
    status: options.runStatus ?? 'RUNNING',
    checkStatus: options.checkStatus ?? 'PASSED',
  };
  // 取得执行权之后重读到的**最新事实**
  const latestRun: RunRow | null =
    options.latestRun === undefined
      ? baseRun
      : options.latestRun === null
        ? null
        : { ...baseRun, ...options.latestRun };

  const order: string[] = [];
  const runFindOne = jest.fn().mockImplementation(() => Promise.resolve(latestRun));
  const runUpdate = jest
    .fn()
    .mockImplementation((_criteria: unknown, partial: Record<string, unknown>) => {
      if (partial.status === 'SUCCEEDED' || partial.status === 'FAILED') {
        // 终态发布（运行终态）
        if (options.terminalUpdateError === true && partial.status === 'SUCCEEDED') {
          // 注入"事件写成功但状态更新失败"的反面：成功终态的状态更新失败
          return Promise.reject(new Error('终态状态更新失败'));
        }
        order.push(`terminal:${String(partial.status)}`);
        return Promise.resolve({ affected: options.terminalAffected ?? 1 });
      }
      // 执行占用（条件更新）
      order.push('claim');
      return Promise.resolve({ affected: options.claimAffected ?? 1 });
    });

  type ManagerMock = {
    transaction: (callback: (m: ManagerMock) => Promise<unknown>) => Promise<unknown>;
    getRepository: jest.Mock;
    connection: { createQueryRunner: jest.Mock };
  };
  const manager: ManagerMock = {
    transaction: jest.fn(
      async (callback: (m: ManagerMock) => Promise<unknown>) => await callback(manager),
    ),
    getRepository: jest.fn(() => ({ findOne: runFindOne, update: runUpdate })),
    // 恢复执行权互斥（G30–G33）用的数据库命名锁替身：
    // `manager.connection.createQueryRunner()` 取独占连接（GET_LOCK / RELEASE_LOCK）。
    connection: {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn((sql: string) => {
          if (sql.includes('GET_LOCK')) {
            return Promise.resolve([{ locked: options.executionLockAcquired ?? 1 }]);
          }
          if (sql.includes('RELEASE_LOCK')) {
            return Promise.resolve([{ released: 1 }]);
          }
          return Promise.resolve([]);
        }),
        release: jest.fn().mockResolvedValue(undefined),
      })),
    },
  };

  const restoreRunRepository = {
    findOne: jest.fn().mockResolvedValue(fastPathRun),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager,
  };
  const backupAssetRepository = {
    findOne: jest.fn().mockImplementation(({ where }: { where: { backupId: string } }) =>
      Promise.resolve(
        where.backupId === 'backup-source'
          ? { backupId: 'backup-source', localReference: packageDir, localStatus: 'PENDING' }
          : {
              backupId: 'backup-protection',
              localReference: join(root, 'protection'),
              localStatus: options.protectionStatus ?? 'PENDING',
            },
      ),
    ),
  };
  const installationRepository = {
    findOne: jest.fn().mockResolvedValue({ id: 1, installationId: INSTALLATION_ID }),
  };
  const hold = jest.fn().mockResolvedValue({ holdId: 'hold-1', created: true });
  const release =
    options.releaseError === true
      ? jest.fn().mockImplementation(() => {
          order.push('release');
          return Promise.reject(new Error('冻结解除失败'));
        })
      : jest.fn().mockImplementation(() => {
          order.push('release');
          return Promise.resolve(1);
        });
  const listActive = jest.fn().mockResolvedValue(
    Array.from({ length: options.activeHoldCount ?? 0 }, (_item, index) => ({
      organizationId: ORGANIZATION_ID,
      holdType: 'RESTORE',
      status: 'ACTIVE',
      reason: `hold-${index}`,
    })),
  );
  const appendRestoreEvent = jest.fn().mockImplementation(() => {
    order.push('event');
    return Promise.resolve(undefined);
  });

  const writer = options.writer ?? {
    supportedTables: ['maintenance_report'],
    // 整体替换语义：一次事务内清空＋写回全部表
    write: jest.fn().mockResolvedValue({
      status: 'WRITTEN',
      written: 1,
      counts: { maintenance_report: 1 },
      reason: null,
    }),
    restoreOriginals: jest.fn().mockResolvedValue({ restored: 0, failed: 0, reason: null }),
    count: jest
      .fn()
      .mockImplementation(({ table }: { table: string }) =>
        Promise.resolve(table === 'maintenance_report' ? 1 : 0),
      ),
  };

  const service = new LocalRestoreExecutionService(
    restoreRunRepository as never,
    backupAssetRepository as never,
    installationRepository as never,
    { hold, release, listActive } as never,
    { appendRestoreEvent } as never,
    { get: jest.fn(() => writer) } as never,
    asPinoLogger(createTestPinoLogger()),
    { keyHex: KEY_HEX, keyId: 'kid-1' },
    options.cleanupService as never,
  );
  return {
    service,
    hold,
    release,
    listActive,
    restoreRunRepository,
    runFindOne,
    runUpdate,
    order,
    writer,
    appendRestoreEvent,
    cleanupService: options.cleanupService,
  };
}

describe('恢复执行编排（S5-2／S5-3）', () => {
  it('成功路径：先冻结 → 恢复 → 核验 → 终态发布 → 解除冻结，终态 SUCCEEDED', async () => {
    const { service, hold, release, runUpdate, appendRestoreEvent } = buildService({});

    const result = await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(hold).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    // 运行终态：条件更新（CAS）落到"仍是 RUNNING"的行上
    expect(runUpdate).toHaveBeenCalledWith(
      { restoreId: 'restore-1', status: 'RUNNING' },
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
    // 最终审计：成功终态阶段
    expect(appendRestoreEvent).toHaveBeenCalledTimes(1);
    expect(appendRestoreEvent).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'SUCCEEDED', stage: 'RESTORE_SUCCEEDED' }),
    );
  });

  it('未受理（仍是 PENDING）：不执行、不冻结', async () => {
    const { service, hold } = buildService({ runStatus: 'PENDING' });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_NOT_ACCEPTED');
    expect(hold).not.toHaveBeenCalled();
  });

  it('预检未通过：不执行、不冻结', async () => {
    const { service, hold } = buildService({ checkStatus: 'FAILED' });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    expect(hold).not.toHaveBeenCalled();
  });

  it('闸门未就绪（保护副本已清理）：如实不可用，不冻结', async () => {
    const { service, hold } = buildService({ protectionStatus: 'CLEANED' });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_FAILURE_COMPENSATION_UNAVAILABLE');
    expect(hold).not.toHaveBeenCalled();
  });

  it('业务数据写入失败：失败且**保持冻结**（设备继续停写停传），终态 FAILED', async () => {
    const { service, hold, release, runUpdate, appendRestoreEvent } = buildService({
      writer: {
        supportedTables: ['maintenance_report'],
        write: jest.fn().mockResolvedValue({
          status: 'FAILED',
          written: 0,
          counts: {},
          reason: '写入被来源域拒绝',
        }),
        restoreOriginals: jest.fn().mockResolvedValue({ restored: 0, failed: 0, reason: null }),
        count: jest
          .fn()
          .mockImplementation(({ table }: { table: string }) =>
            Promise.resolve(table === 'maintenance_report' ? 1 : 0),
          ),
      },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.holdRetained).toBe(true);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledWith(
      { restoreId: 'restore-1', status: 'RUNNING' },
      expect.objectContaining({ status: 'FAILED' }),
    );
    // 失败终态事件：阶段＝回滚也失败（保护副本不可读 ⇒ 回滚失败 ⇒ 保持冻结）
    expect(appendRestoreEvent).toHaveBeenCalledTimes(1);
    expect(appendRestoreEvent).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'FAILED', stage: 'RESTORE_ROLLBACK_FAILED' }),
    );
  });

  it('核验不一致：失败且保持冻结', async () => {
    const { service, release } = buildService({
      writer: {
        supportedTables: ['maintenance_report'],
        write: jest
          .fn()
          .mockResolvedValue({ status: 'WRITTEN', written: 1, counts: {}, reason: null }),
        restoreOriginals: jest.fn().mockResolvedValue({ restored: 0, failed: 0, reason: null }),
        count: jest.fn().mockResolvedValue(0),
      },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_VERIFY_FAILED');
    expect(release).not.toHaveBeenCalled();
  });

  it('失败路径：数据已按保护副本回滚、但**冻结解除失败** ⇒ 终态＝失败且保留冻结（留痕可读）', async () => {
    const write = jest
      .fn()
      // 第一次：恢复写回失败
      .mockResolvedValueOnce({
        status: 'FAILED',
        written: 0,
        counts: {},
        reason: '写入被来源域拒绝',
      })
      // 第二次：按保护副本回滚成功
      .mockResolvedValueOnce({
        status: 'WRITTEN',
        written: 1,
        counts: { maintenance_report: 1 },
        reason: null,
      });
    const { service, release, appendRestoreEvent, runUpdate } = buildService({
      releaseError: true,
      protectionPackageReady: true,
      writer: {
        supportedTables: ['maintenance_report'],
        write,
        restoreOriginals: jest.fn().mockResolvedValue({ restored: 0, failed: 0, reason: null }),
        count: jest
          .fn()
          .mockImplementation(({ table }: { table: string }) =>
            Promise.resolve(table === 'maintenance_report' ? 1 : 0),
          ),
      },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    // 设备仍停写停传（保守口径）⇒ 终态事实必须能被任务 10 读回
    expect(result.holdRetained).toBe(true);
    // 失败路径里解除冻结试了一次（失败）
    expect(release).toHaveBeenCalledTimes(1);
    // 数据已按保护副本回滚（写回两次：恢复一次、回滚一次）
    expect(write).toHaveBeenCalledTimes(2);
    // 运行终态：失败
    expect(runUpdate).toHaveBeenCalledWith(
      { restoreId: 'restore-1', status: 'RUNNING' },
      expect.objectContaining({ status: 'FAILED' }),
    );
    // 只有**一条**终态事实：失败且冻结未解除（不叠加"成功"）
    expect(appendRestoreEvent).toHaveBeenCalledTimes(1);
    expect(appendRestoreEvent).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'FAILED', stage: 'RESTORE_HOLD_RETAINED' }),
    );
  });
});

describe('对外原因不含原始异常（安全口径：路径与 SQL 片段只进服务端日志）', () => {
  it('写回抛出的异常原文（含本机绝对路径）不出现在对外 reason 里', async () => {
    const { service } = buildService({
      writer: {
        supportedTables: ['maintenance_report'],
        write: jest
          .fn()
          .mockRejectedValue(
            new Error(
              "ENOENT: no such file or directory, open '/var/lib/lithography/backups/4/manual-1/manifest.json'",
            ),
          ),
        restoreOriginals: jest.fn().mockResolvedValue({ restored: 0, failed: 0, reason: null }),
        count: jest.fn().mockResolvedValue(1),
      },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_EXECUTION_FAILED');
    expect(result.reason).not.toContain('/var/lib/lithography');
    expect(result.reason).not.toContain('ENOENT');
  });

  it('核验不一致的对外 reason 不含库表名与行数明细', async () => {
    const { service } = buildService({
      writer: {
        supportedTables: ['maintenance_report'],
        write: jest
          .fn()
          .mockResolvedValue({ status: 'WRITTEN', written: 1, counts: {}, reason: null }),
        restoreOriginals: jest.fn().mockResolvedValue({ restored: 0, failed: 0, reason: null }),
        count: jest.fn().mockResolvedValue(0),
      },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reason).not.toContain('maintenance_report');
  });
});

describe('恢复受理与执行的互斥（G30–G33）', () => {
  it('同一次恢复的并发执行 ⇒ 受控拒绝，且**一个字都没写**（不走回滚路径）', async () => {
    const { service, hold, writer, runUpdate } = buildService({
      executionLockAcquired: 0,
    });

    const result = await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_EXECUTION_ALREADY_RUNNING');
    // 没建立冻结、没写任何业务数据、没改恢复运行行
    expect(hold).not.toHaveBeenCalled();
    expect((writer as { write: jest.Mock }).write).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
  });
});

describe('执行占用与过期状态（独立验收 P1-2）', () => {
  it('锁前读到旧 RUNNING、取得执行权后最新事实**已是终态** ⇒ 零写入受控拒绝', async () => {
    const { service, hold, release, writer, appendRestoreEvent, runUpdate } = buildService({
      // 锁前快路径读到 RUNNING；取得执行权后重读到的最新事实已是成功终态
      latestRun: { status: 'SUCCEEDED' },
    });

    const result = await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_ALREADY_TERMINAL');
    // 零写入：不冻结、不恢复、不写终态事件、不改运行行
    expect(hold).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect((writer as { write: jest.Mock }).write).not.toHaveBeenCalled();
    expect(appendRestoreEvent).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it('占用条件更新影响行数为 0（已被别人占用／终态化）⇒ 零写入受控拒绝', async () => {
    const { service, hold, writer, appendRestoreEvent } = buildService({
      claimAffected: 0,
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_ALREADY_TERMINAL');
    expect(hold).not.toHaveBeenCalled();
    expect((writer as { write: jest.Mock }).write).not.toHaveBeenCalled();
    expect(appendRestoreEvent).not.toHaveBeenCalled();
  });

  it('最新事实的公司不在执行人授权范围内 ⇒ 跨公司执行被拒（零写入）', async () => {
    const { service, hold, writer, appendRestoreEvent } = buildService({
      allowedOrganizationId: 9,
    });

    const result = await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      allowedOrganizationId: 9,
    });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_ORGANIZATION_NOT_ALLOWED');
    expect(hold).not.toHaveBeenCalled();
    expect((writer as { write: jest.Mock }).write).not.toHaveBeenCalled();
    expect(appendRestoreEvent).not.toHaveBeenCalled();
  });

  it('最新事实的目标安装不是本机 ⇒ 异机执行被拒（零写入）', async () => {
    const { service, hold, writer, appendRestoreEvent } = buildService({
      latestRun: { targetInstallationId: 'other-installation' },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    expect(result.reasonCode).toBe('RESTORE_INSTALLATION_MISMATCH');
    expect(hold).not.toHaveBeenCalled();
    expect((writer as { write: jest.Mock }).write).not.toHaveBeenCalled();
    expect(appendRestoreEvent).not.toHaveBeenCalled();
  });

  it('执行占用成功后**以最新事实**为准（公司／资产都取最新值）', async () => {
    const { service, hold } = buildService({
      latestRun: { organizationId: 7 },
      allowedOrganizationId: null,
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('SUCCEEDED');
    // 冻结范围用的是**最新事实**里的公司（不是锁前读到的旧值）
    expect(hold).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 7, restoreId: 'restore-1' }),
    );
  });

  it('中断后重试（运行行仍是 RUNNING）⇒ 仍可占用并执行，不被永久拒绝', async () => {
    const { service, hold, writer } = buildService({
      // 上一轮中断：运行行仍是 RUNNING（未终态化）
      latestRun: { status: 'RUNNING' },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('SUCCEEDED');
    expect(hold).toHaveBeenCalledTimes(1);
    expect((writer as { write: jest.Mock }).write).toHaveBeenCalledTimes(1);
  });
});

describe('终态发布一致性（独立验收 P1-3）', () => {
  it('运行终态与最终审计**同一事务**（事件带事务上下文）', async () => {
    const { service, appendRestoreEvent } = buildService({});

    await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(appendRestoreEvent).toHaveBeenCalledTimes(1);
    const payload = appendRestoreEvent.mock.calls[0]?.[0] as {
      transactionContext?: unknown;
      result: string;
    };
    expect(payload.transactionContext).toBeDefined();
    expect(payload.result).toBe('SUCCEEDED');
  });

  it('发布顺序：终态（状态＋事件）**先于**解除冻结', async () => {
    const { service, order } = buildService({});

    await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(order).toEqual(['claim', 'terminal:SUCCEEDED', 'event', 'release']);
  });

  it('解冻失败：**不回滚、不改判失败**，终态仍是成功且只留一条成功事实', async () => {
    const { service, release, appendRestoreEvent, writer } = buildService({
      releaseError: true,
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    // 数据确实已恢复成功 ⇒ 终态是成功；冻结未解除 ⇒ 如实回报
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') {
      throw new Error('应成功');
    }
    expect(result.released).toBe(false);
    expect(result.holdRetained).toBe(true);
    // 没有回滚（写回只发生一次）
    expect((writer as { write: jest.Mock }).write).toHaveBeenCalledTimes(1);
    // 两条事实都是**成功**：不存在"成功＋失败"双终态
    const stages = appendRestoreEvent.mock.calls.map((call: unknown[]) => {
      const payload = call[0] as { result: string; stage: string };
      return { result: payload.result, stage: payload.stage };
    });
    expect(stages).toEqual([
      { result: 'SUCCEEDED', stage: 'RESTORE_SUCCEEDED' },
      { result: 'SUCCEEDED', stage: 'RESTORE_SUCCEEDED_HOLD_RETAINED' },
    ]);
    // 冻结只试了一次（成功路径里的那一次）
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('终态状态更新失败 ⇒ 不留成功事实，转入失败路径（回滚＋失败终态）', async () => {
    const { service, appendRestoreEvent, writer } = buildService({
      terminalUpdateError: true,
      protectionPackageReady: true,
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    // 成功终态没有落库 ⇒ 没有"成功"事件
    const results = appendRestoreEvent.mock.calls.map(
      (call: unknown[]) => (call[0] as { result: string }).result,
    );
    expect(results).not.toContain('SUCCEEDED');
    expect(results).toContain('FAILED');
    // 数据已按保护副本回滚（写回发生两次：恢复一次、回滚一次）
    expect((writer as { write: jest.Mock }).write).toHaveBeenCalledTimes(2);
  });
});

describe('恢复运行时的过期清理检查（任务书第 52 行「每日及恢复运行检查」）', () => {
  it('恢复成功后触发一次过期清理检查', async () => {
    const cleanupAllExpiredPackages = jest.fn().mockResolvedValue({
      targetCount: 2,
      cleaned: 1,
      retained: 1,
      items: [],
    });
    const { service } = buildService({
      cleanupService: { cleanupAllExpiredPackages },
    });

    const result = await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(cleanupAllExpiredPackages).toHaveBeenCalledTimes(1);
  });

  it('清理检查在**冻结解除之后**执行（冻结未解除时清理会被闸门拦住）', async () => {
    const order: string[] = [];
    const cleanupAllExpiredPackages = jest.fn().mockImplementation(() => {
      order.push('cleanup');
      return Promise.resolve({ targetCount: 0, cleaned: 0, retained: 0, items: [] });
    });
    const { service } = buildService({
      cleanupService: { cleanupAllExpiredPackages },
    });
    // 用带顺序记录的 release 替换原替身
    const serviceWithOrder = service as unknown as {
      localWriteHoldService: { release: (input: unknown) => Promise<number> };
    };
    serviceWithOrder.localWriteHoldService.release = jest.fn().mockImplementation(() => {
      order.push('release');
      return Promise.resolve(1);
    });

    await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(order).toEqual(['release', 'cleanup']);
  });

  it('清理检查失败**不改判恢复结果**（恢复已成功落事实）', async () => {
    const cleanupAllExpiredPackages = jest.fn().mockRejectedValue(new Error('清理链异常'));
    const { service, release, runUpdate } = buildService({
      cleanupService: { cleanupAllExpiredPackages },
    });

    const result = await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(cleanupAllExpiredPackages).toHaveBeenCalledTimes(1);
    // 恢复事实已落库：冻结已解除、运行行已置 SUCCEEDED
    expect(release).toHaveBeenCalledTimes(1);
    expect(runUpdate).toHaveBeenCalledWith(
      { restoreId: 'restore-1', status: 'RUNNING' },
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
  });

  it('恢复失败路径**不**触发清理检查（冻结仍持有，清理会被闸门拦住）', async () => {
    const cleanupAllExpiredPackages = jest.fn().mockResolvedValue({
      targetCount: 0,
      cleaned: 0,
      retained: 0,
      items: [],
    });
    const { service } = buildService({
      runStatus: 'PENDING',
      cleanupService: { cleanupAllExpiredPackages },
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    expect(cleanupAllExpiredPackages).not.toHaveBeenCalled();
  });
});
