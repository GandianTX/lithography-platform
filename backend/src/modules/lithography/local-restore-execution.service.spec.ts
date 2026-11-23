// src/modules/lithography/local-restore-execution.service.spec.ts

/**
 * 恢复执行编排的定向测试（任务 09 S5-2／S5-3）。
 *
 * 守住四条：未受理／预检未通过 ⇒ 不执行不冻结；闸门未就绪 ⇒ 如实不可用；
 * 成功 ⇒ 先冻结、恢复、核验后**解除冻结**；失败 ⇒ **保持冻结**、终态 FAILED、
 * 保护副本与任务不被清理。
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

function buildPackage(root: string, payload: Record<string, unknown>, dirName = 'package'): string {
  const packageDir = join(root, dirName);
  mkdirSync(packageDir, { recursive: true });
  const key = parseProtectionKey(KEY_HEX);
  const encrypted = encryptBackupPayload(key, Buffer.from(JSON.stringify(payload), 'utf8'));
  writeFileSync(join(packageDir, BACKUP_PAYLOAD_PATH), encrypted.data);
  const manifest = buildProtectedBackupManifest({
    organizationId: 4,
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
  /** 冻结解除失败（模拟"数据已回滚但停写停传没解除"） */
  releaseError?: boolean;
  /** 保护副本可读（回滚能成功 ⇒ 走到"冻结解除失败"那条路径） */
  protectionPackageReady?: boolean;
}) {
  const root = '/tmp/task09-restore-spec';
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  const packageDir = buildPackage(root, { maintenance_report: [{ id: 1 }] });
  if (options.protectionPackageReady === true) {
    // 保护副本可读 ⇒ 按保护副本回滚能成功
    buildPackage(root, { maintenance_report: [{ id: 1 }] }, 'protection');
  }

  const restoreRunRepository = {
    findOne: jest.fn().mockResolvedValue({
      restoreId: 'restore-1',
      backupId: 'backup-source',
      protectionBackupId: 'backup-protection',
      organizationId: 4,
      status: options.runStatus ?? 'RUNNING',
      checkStatus: options.checkStatus ?? 'PASSED',
      confirmation: { accepted_at: '2026-11-23T00:00:00.000Z' },
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
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
      ? jest.fn().mockRejectedValue(new Error('冻结解除失败'))
      : jest.fn().mockResolvedValue(1);
  const appendRestoreEvent = jest.fn().mockResolvedValue(undefined);

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
    { hold, release } as never,
    { appendRestoreEvent } as never,
    { get: jest.fn(() => writer) } as never,
    asPinoLogger(createTestPinoLogger()),
    { keyHex: KEY_HEX, keyId: 'kid-1' },
  );
  return { service, hold, release, restoreRunRepository, writer, appendRestoreEvent };
}

describe('恢复执行编排（S5-2／S5-3）', () => {
  it('成功路径：先冻结 → 恢复 → 核验 → 解除冻结，终态 SUCCEEDED', async () => {
    const { service, hold, release, restoreRunRepository } = buildService({});

    const result = await service.execute({
      restoreId: 'restore-1',
      actorAccountId: 900101,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(hold).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(restoreRunRepository.update).toHaveBeenCalledWith(
      { restoreId: 'restore-1' },
      expect.objectContaining({ status: 'SUCCEEDED' }),
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
    const { service, hold, release, restoreRunRepository } = buildService({
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
    expect(restoreRunRepository.update).toHaveBeenCalledWith(
      { restoreId: 'restore-1' },
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  it('数据已回滚但**冻结解除失败**：终态必须留痕（阶段＝冻结未解除）', async () => {
    const { service, release, appendRestoreEvent } = buildService({
      releaseError: true,
      protectionPackageReady: true,
    });

    const result = await service.execute({ restoreId: 'restore-1', actorAccountId: 900101 });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') {
      throw new Error('应失败');
    }
    // 设备仍停写停传（保守口径）⇒ 终态事实必须能被任务 10 读回
    expect(result.holdRetained).toBe(true);
    // 解除冻结被试了两次（成功后一次、回滚后再一次），两次都失败
    expect(release).toHaveBeenCalledTimes(2);
    // 两条事实都在：执行成功（数据已恢复）＋ 冻结未解除（设备仍停写停传）
    const stages = appendRestoreEvent.mock.calls.map((call: unknown[]) => {
      const payload = call[0] as { result: string; stage: string };
      return { result: payload.result, stage: payload.stage };
    });
    expect(stages).toEqual([
      { result: 'SUCCEEDED', stage: 'RESTORE_SUCCEEDED' },
      { result: 'FAILED', stage: 'RESTORE_HOLD_RETAINED' },
    ]);
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
});
