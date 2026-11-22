/// <reference types="jest" />
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { LocalBackupCleanupService } from '@src/modules/lithography/local-backup-cleanup.service';
import type { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { CleanupLocalBackupPackagesUsecase } from './cleanup-local-backup-packages.usecase';

/**
 * 清理本地备份包用例：范围裁决、权限与授权来源。
 *
 * 清理的裁决与删除行为在 service/policy spec 中覆盖，这里只覆盖用例编排：
 * 范围、权限与"回执只取自服务端事实"三条约束。
 */
describe('CleanupLocalBackupPackagesUsecase', () => {
  const session = { accountId: 900101 } as UsecaseSession;

  const makeUsecase = (params: {
    scope: { role: string; organizationId: number | null; adminLevel: number | null };
    installation?: { installationId: string; organizationId: number | null } | null;
    receiptSource?: { backupId: string; receipt: string } | null;
    manualResult?: {
      available: boolean;
      reason: string | null;
      targetCount: number;
      cleaned: number;
      retained: number;
      items: Array<{ backupId: string; outcome: 'CLEANED' | 'RETAINED'; reason: string | null }>;
    };
    retentionResult?: {
      available: boolean;
      reason: string | null;
      targetCount: number;
      cleaned: number;
      retained: number;
      items: Array<{ backupId: string; outcome: 'CLEANED' | 'RETAINED'; reason: string | null }>;
    };
  }) => {
    const scopeResolver = {
      resolve: jest.fn(() => Promise.resolve(params.scope)),
    };
    const queryService = {
      readInstallation: jest.fn(() =>
        Promise.resolve(
          params.installation === undefined
            ? { installationId: 'inst-1', organizationId: 4 }
            : params.installation,
        ),
      ),
    };
    const cleanupService = {
      findManualRunCloudReceipt: jest.fn(() => Promise.resolve(params.receiptSource ?? null)),
      cleanupManualPackages: jest.fn(() =>
        Promise.resolve(
          params.manualResult ?? {
            available: false,
            reason: 'CLOUD_RECEIPT_MISSING',
            targetCount: 0,
            cleaned: 0,
            retained: 0,
            items: [],
          },
        ),
      ),
      cleanupExpiredPackages: jest.fn(() =>
        Promise.resolve(
          params.retentionResult ?? {
            available: true,
            reason: null,
            targetCount: 0,
            cleaned: 0,
            retained: 0,
            items: [],
          },
        ),
      ),
    };

    return {
      usecase: new CleanupLocalBackupPackagesUsecase(
        scopeResolver as unknown as LocalRuntimeScopeResolver,
        queryService as unknown as LocalRuntimeQueryService,
        cleanupService as unknown as LocalBackupCleanupService,
      ),
      cleanupService,
    };
  };

  it('手动清理的授权来源取自「本次手动备份」已落库的完整回执', async () => {
    const { usecase, cleanupService } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      receiptSource: { backupId: 'backup-1', receipt: '{"received":true}' },
    });

    const result = await usecase.execute({ session, mode: 'MANUAL' });

    expect(cleanupService.findManualRunCloudReceipt).toHaveBeenCalledWith({
      organizationId: 4,
      installationId: 'inst-1',
    });
    expect(cleanupService.cleanupManualPackages).toHaveBeenCalledWith({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
    });
    expect(result.mode).toBe('MANUAL');
  });

  it('没有完整回执时如实不可用：零清理并返回原因', async () => {
    const { usecase, cleanupService } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      receiptSource: null,
    });

    const result = await usecase.execute({ session, mode: 'MANUAL' });

    expect(cleanupService.cleanupManualPackages).toHaveBeenCalledWith({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: null,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('CLOUD_RECEIPT_MISSING');
    expect(result.cleaned).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('过期清理不开放工程师', async () => {
    const { usecase, cleanupService } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await expect(usecase.execute({ session, mode: 'RETENTION' })).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(cleanupService.cleanupExpiredPackages).not.toHaveBeenCalled();
  });

  it('管理员过期清理执行并逐项返回结果', async () => {
    const { usecase, cleanupService } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_2', organizationId: 4, adminLevel: 2 },
      retentionResult: {
        available: true,
        reason: null,
        targetCount: 2,
        cleaned: 1,
        retained: 1,
        items: [
          { backupId: 'backup-1', outcome: 'CLEANED', reason: null },
          { backupId: 'backup-2', outcome: 'RETAINED', reason: 'LOCAL_PACKAGE_DELETE_FAILED' },
        ],
      },
    });

    const result = await usecase.execute({ session, mode: 'RETENTION' });

    expect(cleanupService.cleanupExpiredPackages).toHaveBeenCalledWith({
      organizationId: 4,
      installationId: 'inst-1',
    });
    expect(result.cleaned).toBe(1);
    expect(result.retained).toBe(1);
    expect(result.items[1].reason).toBe('LOCAL_PACKAGE_DELETE_FAILED');
  });

  it('工程师只能清理本机所属公司，指定其他公司被拒绝', async () => {
    const { usecase } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await expect(
      usecase.execute({ session, mode: 'MANUAL', organizationId: 5 }),
    ).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('一级管理员可指定目标公司', async () => {
    const { usecase, cleanupService } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
    });

    await usecase.execute({ session, mode: 'MANUAL', organizationId: 5 });

    expect(cleanupService.cleanupManualPackages).toHaveBeenCalledWith({
      organizationId: 5,
      installationId: 'inst-1',
      cloudReceipt: null,
    });
  });

  it('本机未映射公司且未指定目标公司时失败关闭', async () => {
    const { usecase } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      installation: { installationId: 'inst-1', organizationId: null },
    });

    await expect(usecase.execute({ session, mode: 'MANUAL' })).rejects.toThrow();
  });
});
