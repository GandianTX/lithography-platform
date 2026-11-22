// src/usecases/local-runtime/update-local-backup-plan.usecase.spec.ts
/// <reference types="jest" />

/**
 * 备份计划开关写入的定向测试（任务 09 S4）。
 *
 * 守住：准入（工程师拒绝／二级管理员仅本公司／一级管理员全局）、开关分开控制、
 * 改开关不重置周期、无计划行即拒绝。
 */

import { UpdateLocalBackupPlanUsecase } from './update-local-backup-plan.usecase';

const SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ADMIN_LEVEL_2',
  roles: ['SUPER_ADMIN'],
  identityType: 'SUPER_ADMIN',
  adminLevel: 2,
} as never;

function buildUsecase(scope: {
  role: 'ENGINEER' | 'ADMIN_LEVEL_2' | 'ADMIN_LEVEL_1';
  organizationId: number | null;
  adminLevel: 1 | 2 | null;
  plan?: Record<string, unknown> | null;
}) {
  const updateCompanyBackupPlan = jest.fn((input: Record<string, unknown>) => {
    if (scope.plan === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      organizationId: 9,
      backupEnabled: input.backupEnabled ?? true,
      backupIntervalHours: 72,
      nextBackupAt: new Date('2026-11-25T00:00:00.000Z'),
      autoUploadEnabled: input.autoUploadEnabled ?? false,
      initializedAt: new Date('2026-11-22T00:00:00.000Z'),
    });
  });
  const usecase = new UpdateLocalBackupPlanUsecase(
    {
      resolve: jest.fn().mockResolvedValue({
        role: scope.role,
        organizationId: scope.organizationId,
        adminLevel: scope.adminLevel,
      }),
    } as never,
    { updateCompanyBackupPlan } as never,
  );
  return { usecase, updateCompanyBackupPlan };
}

describe('备份计划开关写入（S4）', () => {
  it('工程师拒绝修改备份计划开关', async () => {
    const { usecase, updateCompanyBackupPlan } = buildUsecase({
      role: 'ENGINEER',
      organizationId: 9,
      adminLevel: null,
    });

    await expect(
      usecase.execute({ session: SESSION, organizationId: 9, backupEnabled: false }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(updateCompanyBackupPlan).not.toHaveBeenCalled();
  });

  it('二级管理员只能改本公司', async () => {
    const { usecase } = buildUsecase({
      role: 'ADMIN_LEVEL_2',
      organizationId: 9,
      adminLevel: 2,
    });

    await expect(
      usecase.execute({ session: SESSION, organizationId: 10, backupEnabled: false }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('一级管理员可改任意公司', async () => {
    const { usecase, updateCompanyBackupPlan } = buildUsecase({
      role: 'ADMIN_LEVEL_1',
      organizationId: null,
      adminLevel: 1,
    });

    await usecase.execute({ session: SESSION, organizationId: 10, backupEnabled: false });

    expect(updateCompanyBackupPlan).toHaveBeenCalledWith({
      organizationId: 10,
      backupEnabled: false,
      autoUploadEnabled: undefined,
    });
  });

  it('该公司尚无当前计划行时拒绝（不凭空建行）', async () => {
    const { usecase } = buildUsecase({
      role: 'ADMIN_LEVEL_1',
      organizationId: null,
      adminLevel: 1,
      plan: null,
    });

    await expect(
      usecase.execute({ session: SESSION, organizationId: 10, backupEnabled: false }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_BACKUP_RUN_NOT_FOUND' });
  });

  it('两个开关分开控制：只改云开关时本地自动备份开关保持原值', async () => {
    const { usecase, updateCompanyBackupPlan } = buildUsecase({
      role: 'ADMIN_LEVEL_1',
      organizationId: null,
      adminLevel: 1,
    });

    const result = await usecase.execute({
      session: SESSION,
      organizationId: 9,
      autoUploadEnabled: true,
    });

    expect(updateCompanyBackupPlan).toHaveBeenCalledWith({
      organizationId: 9,
      backupEnabled: undefined,
      autoUploadEnabled: true,
    });
    expect(result.backupEnabled).toBe(true);
    expect(result.autoUploadEnabled).toBe(true);
  });

  it('改开关不重置周期：下次计划时间保持原值', async () => {
    const { usecase } = buildUsecase({
      role: 'ADMIN_LEVEL_1',
      organizationId: null,
      adminLevel: 1,
    });

    const result = await usecase.execute({
      session: SESSION,
      organizationId: 9,
      backupEnabled: false,
    });

    expect(result.nextBackupAt).toEqual(new Date('2026-11-25T00:00:00.000Z'));
    expect(result.backupIntervalHours).toBe(72);
  });
});
