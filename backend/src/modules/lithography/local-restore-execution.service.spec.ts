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

import { LocalRestoreExecutionService } from './local-restore-execution.service';

const KEY_HEX = 'a'.repeat(64);
const INSTALLATION_ID = 'inst-1';

function buildPackage(root: string, payload: Record<string, unknown>): string {
  const packageDir = join(root, 'package');
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
}) {
  const root = '/tmp/task09-restore-spec';
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  const packageDir = buildPackage(root, { maintenance_report: [{ id: 1 }] });

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
  const release = jest.fn().mockResolvedValue(1);

  const writer = options.writer ?? {
    supportedTables: ['maintenance_report'],
    write: jest.fn().mockResolvedValue({ status: 'WRITTEN', written: 1, reason: null }),
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
    { get: jest.fn(() => writer) } as never,
    { keyHex: KEY_HEX, keyId: 'kid-1' },
  );
  return { service, hold, release, restoreRunRepository, writer };
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
        write: jest
          .fn()
          .mockResolvedValue({ status: 'FAILED', written: 0, reason: '写入被来源域拒绝' }),
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

  it('核验不一致：失败且保持冻结', async () => {
    const { service, release } = buildService({
      writer: {
        supportedTables: ['maintenance_report'],
        write: jest.fn().mockResolvedValue({ status: 'WRITTEN', written: 1, reason: null }),
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
