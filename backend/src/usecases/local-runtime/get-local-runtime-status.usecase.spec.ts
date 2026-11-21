/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import type { LocalCompanySettingQueryService } from '@src/modules/lithography/queries/local-company-setting.query.service';
import type { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalInstallationSnapshot } from '@src/modules/lithography/local-runtime.types';
import { GetLocalRuntimeStatusUsecase } from './get-local-runtime-status.usecase';
import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 只读状态用例的两条红线：
 * 1) 全设备口径的任务计数不得越出全局范围（`local_upload_task` 无公司列，G-8）；
 * 2) 设备映射公司不得返回给其他公司的查看者。
 * 两者都属于"结构无法按公司归属"造成的越权面，必须在用例层收敛。
 */
describe('GetLocalRuntimeStatusUsecase 范围收敛', () => {
  const session = { accountId: 900101 } as UsecaseSession;

  const installation: LocalInstallationSnapshot = {
    id: 1,
    installationId: '6f1c2a3e-0a11-4b22-9c33-112233445566',
    organizationId: 4,
    organizationCodeSnapshot: 'COMPANY_A',
    localSiteName: '现场 A',
    autoUploadEnabled: false,
    backupIntervalDays: 3,
    lastBackupCompletedAt: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  };

  const taskSummary = {
    pendingUploadCount: 2,
    uploadingUploadCount: 0,
    failedUploadCount: 1,
    succeededUploadCount: 5,
    runningBackupCount: 0,
    lastBackupStartedAt: null,
    lastBackupFinishedAt: null,
  };

  const makeUsecase = (
    scope: { role: string; organizationId: number | null; adminLevel: number | null },
    current: LocalInstallationSnapshot | null = installation,
  ) => {
    const localRuntimeQueryService = {
      readInstallation: jest.fn(() => Promise.resolve(current)),
      readTaskStatusSummary: jest.fn(() => Promise.resolve(taskSummary)),
      readAuthorizationSummary: jest.fn(() => Promise.resolve([])),
    };
    const localCompanySettingQueryService = {
      listForScope: jest.fn(() => Promise.resolve([])),
    };
    const scopeResolver = {
      resolve: jest.fn(() => Promise.resolve(scope)),
    };
    const storageProbe = {
      probe: jest.fn(() =>
        Promise.resolve({
          backupDirectory: '/tmp/backups',
          backupDirectoryWritable: true,
          businessFileDirectory: '/tmp/business',
          businessFileDirectoryWritable: true,
        }),
      ),
    };

    return new GetLocalRuntimeStatusUsecase(
      localRuntimeQueryService as unknown as LocalRuntimeQueryService,
      localCompanySettingQueryService as unknown as LocalCompanySettingQueryService,
      scopeResolver as unknown as LocalRuntimeScopeResolver,
      storageProbe,
    );
  };

  it('一级管理员（全局范围）可见全设备任务计数与设备映射公司', async () => {
    const usecase = makeUsecase({ adminLevel: 1, organizationId: null, role: 'ADMIN_LEVEL_1' });

    const view = await usecase.execute({ session });

    expect(view.tasks).toEqual(taskSummary);
    expect(view.mappedOrganizationId).toBe(4);
    expect(view.mappedOrganizationCode).toBe('COMPANY_A');
  });

  it('二级管理员不属于设备映射公司时，任务计数与映射公司都为 null', async () => {
    const usecase = makeUsecase({ adminLevel: 2, organizationId: 5, role: 'ADMIN_LEVEL_2' });

    const view = await usecase.execute({ session });

    expect(view.tasks).toBeNull();
    expect(view.mappedOrganizationId).toBeNull();
    expect(view.mappedOrganizationCode).toBeNull();
    expect(view.scopeOrganizationId).toBe(5);
  });

  it('工程师属于设备映射公司时可看到映射公司，但任务计数仍为 null（非全局范围）', async () => {
    const usecase = makeUsecase({ adminLevel: null, organizationId: 4, role: 'ENGINEER' });

    const view = await usecase.execute({ session });

    expect(view.mappedOrganizationId).toBe(4);
    expect(view.tasks).toBeNull();
  });

  it('安装身份缺失时失败关闭，不返回空壳状态', async () => {
    const usecase = makeUsecase(
      { adminLevel: 1, organizationId: null, role: 'ADMIN_LEVEL_1' },
      null,
    );

    await expect(usecase.execute({ session })).rejects.toMatchObject({
      code: LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND,
    });
  });
});
