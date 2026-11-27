// src/modules/lithography/backup-restore-acceptance.service.spec.ts

/**
 * 恢复**受理复核**的定向测试（任务 09 G30–G33 追加）。
 *
 * 守住两条：
 * 1. **受理幂等**：受理用**条件更新**（CAS）推进 `PENDING → RUNNING`，
 *    并发受理只有一个能成功，另一个如实被拒（不覆盖受理人、不重复受理）；
 * 2. **CAS 失败即拒绝**：条件更新未命中（affected = 0）⇒ 受控拒绝，
 *    不得"以为受理成功"继续往下走。
 */

import { BackupRestoreAcceptanceService } from './backup-restore-acceptance.service';

const NOW = new Date('2026-11-24T00:00:00.000Z');

function buildService(options: { affected?: number } = {}) {
  const affected = options.affected ?? 1;
  const update = jest.fn().mockResolvedValue({ affected });
  const restoreRunRepository = {
    findOne: jest.fn().mockResolvedValue({
      restoreId: 'restore-1',
      backupId: 'backup-1',
      protectionBackupId: null,
      organizationId: 1,
      status: 'PENDING',
      checkStatus: 'PASSED',
      confirmation: null,
      targetInstallationId: 'inst-1',
      checkSnapshot: JSON.stringify({ protection: { backupId: 'backup-protection' } }),
    }),
    update,
  };
  const backupAssetRepository = {
    findOne: jest.fn().mockImplementation((query: { where: { backupId: string } }) =>
      Promise.resolve(
        query.where.backupId === 'backup-protection'
          ? {
              backupId: 'backup-protection',
              localStatus: 'AVAILABLE',
              localReference: '/tmp/p',
            }
          : { backupId: 'backup-1', localStatus: 'AVAILABLE', localReference: '/tmp/s' },
      ),
    ),
  };
  const installationRepository = {
    findOne: jest.fn().mockResolvedValue({ installationId: 'inst-1' }),
  };
  const service = new BackupRestoreAcceptanceService(
    restoreRunRepository as never,
    backupAssetRepository as never,
    installationRepository as never,
  );
  return { service, update };
}

describe('恢复受理复核（G30–G33）', () => {
  it('受理用条件更新推进 PENDING → RUNNING（CAS：状态与未受理同时为前提）', async () => {
    const { service, update } = buildService();

    const result = await service.review({
      restoreId: 'restore-1',
      acceptedByAccountId: 9001,
      allowedOrganizationId: null,
      now: NOW,
    });

    expect(result.accepted).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = update.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // CAS 前提：状态仍是 PENDING，且从未被受理过
    expect(criteria['restoreId']).toBe('restore-1');
    expect(criteria['status']).toBe('PENDING');
    expect(criteria['confirmation']).toBeDefined();
    expect(patch['status']).toBe('RUNNING');
    expect(patch['protectionBackupId']).toBe('backup-protection');
  });

  it('条件更新未命中（并发下已被受理）⇒ 受控拒绝，不谎报受理成功', async () => {
    const { service } = buildService({ affected: 0 });

    const result = await service.review({
      restoreId: 'restore-1',
      acceptedByAccountId: 9001,
      allowedOrganizationId: null,
      now: NOW,
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) {
      throw new Error('应拒绝');
    }
    expect(result.reason).toContain('已被受理');
  });
});
