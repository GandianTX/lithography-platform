// src/usecases/local-runtime/accept-local-restore.usecase.spec.ts
/// <reference types="jest" />

/**
 * 恢复受理的定向测试（任务 09 S5 第 1 条：确认前再次检查权限、目标与保护副本）。
 *
 * 守住：工程师拒绝；预检不存在／结论未通过／已被受理／设备不符／公司不符／
 * 被恢复资产已清理／保护副本缺失或已清理 —— 一律拒绝且给出受控原因；
 * 正常路径受理并写入受理事实（**不产生恢复成功结论**）。
 */

import { BackupRestoreAcceptanceService } from '@src/modules/lithography/backup-restore-acceptance.service';

import { AcceptLocalRestoreUsecase } from './accept-local-restore.usecase';

const ADMIN_SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ADMIN_LEVEL_2',
  roles: ['SUPER_ADMIN'],
  identityType: 'SUPER_ADMIN',
  adminLevel: 2,
} as never;

const ENGINEER_SESSION = { ...(ADMIN_SESSION as object), role: 'ENGINEER' } as never;

type RestoreRun = Record<string, unknown>;

function run(overrides: RestoreRun = {}): RestoreRun {
  return {
    restoreId: 'restore-1',
    backupId: 'backup-1',
    protectionBackupId: 'protection-1',
    targetInstallationId: 'inst-1',
    checkStatus: 'PASSED',
    confirmation: null,
    organizationId: 9,
    status: 'PENDING',
    ...overrides,
  };
}

function buildUsecase(
  options: {
    scope?: { role: string; organizationId: number | null; adminLevel: number | null };
    restoreRun?: RestoreRun | null;
    assets?: { backupId: string; localStatus: string }[];
  } = {},
) {
  const update = jest.fn((_where?: unknown, _patch?: unknown) => Promise.resolve({ affected: 1 }));
  const restoreRunRepository = {
    findOne: jest.fn(() =>
      Promise.resolve(options.restoreRun === undefined ? run() : options.restoreRun),
    ),
    update,
  };
  const assets: { backupId: string; localStatus: string }[] = options.assets ?? [
    { backupId: 'backup-1', localStatus: 'PENDING' },
    { backupId: 'protection-1', localStatus: 'PENDING' },
  ];
  const backupAssetRepository = {
    findOne: jest.fn((query: { where: { backupId: string } }) =>
      Promise.resolve(assets.find((asset) => asset.backupId === query.where.backupId) ?? null),
    ),
  };
  const installationRepository = {
    findOne: jest.fn(() => Promise.resolve({ id: 1, installationId: 'inst-1' })),
  };
  const scope = options.scope ?? { role: 'ADMIN_LEVEL_2', organizationId: 9, adminLevel: 2 };
  const acceptanceService = new BackupRestoreAcceptanceService(
    restoreRunRepository as never,
    backupAssetRepository as never,
    installationRepository as never,
  );
  const usecase = new AcceptLocalRestoreUsecase(
    { resolve: jest.fn(() => Promise.resolve(scope)) } as never,
    acceptanceService,
  );
  return { usecase, update };
}

describe('恢复受理（S5-1：确认前再次检查权限、目标与保护副本）', () => {
  it('工程师拒绝受理', async () => {
    const { usecase, update } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 9, adminLevel: null },
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(update).not.toHaveBeenCalled();
  });

  it('正常路径：受理并写入受理事实（不产生恢复成功结论）', async () => {
    const { usecase, update } = buildUsecase();

    const result = await usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' });

    expect(result.accepted).toBe(true);
    expect(result.protectionBackupId).toBe('protection-1');
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][1] as { confirmation: string };
    const confirmation = JSON.parse(patch.confirmation) as Record<string, unknown>;
    expect(confirmation.restore_id).toBe('restore-1');
    expect(confirmation.accepted_by_account_id).toBe(900101);
    // 受理 ≠ 恢复：只写受理事实，不写成功结论
    expect(confirmation).not.toHaveProperty('succeeded');
  });

  it('保护副本标识只随快照落库时也能受理（PENDING 行本列为空）', async () => {
    // 库级 CHECK `chk_backup_restore_run_execution_guard`：
    // PENDING 行的 `protection_backup_id` 必须为空 ⇒ 标识随快照落库，
    // 受理（→ RUNNING）时再从快照取回并写回本列。
    const snapshot = JSON.stringify({
      schema_version: 1,
      protection: { backupId: 'protection-1', created: true },
    });
    const { usecase, update } = buildUsecase({
      restoreRun: run({ protectionBackupId: null, checkSnapshot: snapshot }),
    });

    const result = await usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' });

    expect(result.accepted).toBe(true);
    expect(result.protectionBackupId).toBe('protection-1');
    const patch = update.mock.calls[0][1] as { protectionBackupId: string; status: string };
    expect(patch.protectionBackupId).toBe('protection-1');
    expect(patch.status).toBe('RUNNING');
  });

  it('快照里也没有保护副本：拒绝（没有回滚保障不得受理）', async () => {
    const snapshot = JSON.stringify({ schema_version: 1, protection: { backupId: null } });
    const { usecase } = buildUsecase({
      restoreRun: run({ protectionBackupId: null, checkSnapshot: snapshot }),
    });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toThrow(/保护副本/);
  });

  it('预检不存在：拒绝', async () => {
    const { usecase, update } = buildUsecase({ restoreRun: null });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_STATE_CONFLICT' });
    expect(update).not.toHaveBeenCalled();
  });

  it('预检结论未通过：拒绝', async () => {
    const { usecase } = buildUsecase({ restoreRun: run({ checkStatus: 'FAILED' }) });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_STATE_CONFLICT' });
  });

  it('已被受理过：拒绝（换包后旧确认作废，需重新预检）', async () => {
    const { usecase } = buildUsecase({ restoreRun: run({ confirmation: '{"accepted_at":"x"}' }) });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_STATE_CONFLICT' });
  });

  it('预检来自其它设备：拒绝（旧预检在本机作废）', async () => {
    const { usecase } = buildUsecase({ restoreRun: run({ targetInstallationId: 'inst-other' }) });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_STATE_CONFLICT' });
  });

  it('二级管理员受理他公司：拒绝', async () => {
    const { usecase } = buildUsecase({ restoreRun: run({ organizationId: 10 }) });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_STATE_CONFLICT' });
  });

  it('保护副本已被清理：拒绝（没有回滚保障不得受理）', async () => {
    const { usecase, update } = buildUsecase({
      assets: [
        { backupId: 'backup-1', localStatus: 'PENDING' },
        { backupId: 'protection-1', localStatus: 'CLEANED' },
      ],
    });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_STATE_CONFLICT' });
    expect(update).not.toHaveBeenCalled();
  });

  it('被恢复的本地包已清理：拒绝本机受理', async () => {
    const { usecase } = buildUsecase({
      assets: [
        { backupId: 'backup-1', localStatus: 'CLEANED' },
        { backupId: 'protection-1', localStatus: 'PENDING' },
      ],
    });

    await expect(
      usecase.execute({ session: ADMIN_SESSION, restoreId: 'restore-1' }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_STATE_CONFLICT' });
  });
});
