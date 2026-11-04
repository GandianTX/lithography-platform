/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import type { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalInstallationSnapshot } from '@src/modules/lithography/local-runtime.types';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { UpdateLocalRuntimeSettingsUsecase } from './update-local-runtime-settings.usecase';

/**
 * 设置更新为「先锁后合并」：锁定读必须发生在合并之前，
 * 否则并发补丁各自基于旧值整体覆盖，造成丢失更新。
 */
describe('UpdateLocalRuntimeSettingsUsecase 先锁后合并', () => {
  const transactionContext = Object.freeze({});
  const adminSession: UsecaseSession = {
    accountId: 900001,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
  } as UsecaseSession;

  const current: LocalInstallationSnapshot = {
    id: 1,
    installationId: '6f1c2a3e-0a11-4b22-9c33-112233445566',
    organizationId: 920001,
    organizationCodeSnapshot: 'CLIENT_DEFAULT',
    localSiteName: '旧站点',
    autoUploadEnabled: true,
    backupIntervalDays: 7,
    lastBackupCompletedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  };

  const makeUsecase = (locked: LocalInstallationSnapshot | null = current) => {
    const callOrder: string[] = [];
    const service = {
      lockInstallation: jest.fn(() => {
        callOrder.push('lock');
        return Promise.resolve(locked);
      }),
      updateInstallationSettings: jest.fn(() => {
        callOrder.push('update');
        return Promise.resolve(undefined);
      }),
    };
    const transactionRunner = {
      run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
    } as unknown as TransactionRunner;
    const usecase = new UpdateLocalRuntimeSettingsUsecase(
      service as unknown as LocalRuntimeService,
      transactionRunner,
    );
    return { usecase, service, callOrder };
  };

  it('仅提交补丁字段时按锁定读到的落库值合并，且锁定发生在写入之前', async () => {
    const { usecase, service, callOrder } = makeUsecase();

    const result = await usecase.execute({
      session: adminSession,
      settings: { autoUploadEnabled: false },
    });

    expect(service.updateInstallationSettings).toHaveBeenCalledWith(
      {
        localSiteName: '旧站点',
        autoUploadEnabled: false,
        backupIntervalDays: 7,
      },
      transactionContext,
    );
    expect(callOrder.slice(0, 2)).toEqual(['lock', 'update']);
    expect(result.localSiteName).toBe('旧站点');
  });

  it('安装行缺失时失败关闭，不执行写入', async () => {
    const { usecase, service } = makeUsecase(null);

    await expect(
      usecase.execute({ session: adminSession, settings: { backupIntervalDays: 3 } }),
    ).rejects.toMatchObject({ code: LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND });

    expect(service.updateInstallationSettings).not.toHaveBeenCalled();
  });
});
