/// <reference types="jest" />
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalInstallationSnapshot } from '@src/modules/lithography/local-runtime.types';
import type { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { RenewMyLocalAuthorizationUsecase } from './renew-my-local-authorization.usecase';

/**
 * 本人同公司授权续期（R065）：只更新凭据/版本/校验时间，不动队列；
 * 一级管理员无公司数据区，不适用本人续期。
 */
describe('RenewMyLocalAuthorizationUsecase', () => {
  const session = { accountId: 16 } as UsecaseSession;
  const transactionContext = Object.freeze({});

  const installation: LocalInstallationSnapshot = {
    id: 1,
    installationId: '6f1c2a3e-0a11-4b22-9c33-112233445566',
    organizationId: null,
    organizationCodeSnapshot: null,
    localSiteName: '现场 A',
    autoUploadEnabled: false,
    backupIntervalDays: 3,
    lastBackupCompletedAt: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  };

  const makeUsecase = (scope: {
    role: string;
    organizationId: number | null;
    adminLevel: number | null;
  }) => {
    const scopeResolver = { resolve: jest.fn(() => Promise.resolve(scope)) };
    const localRuntimeQueryService = {
      readInstallation: jest.fn(() => Promise.resolve(installation)),
    };
    const service = {
      renewAccountAuthorization: jest.fn(() => Promise.resolve({ renewedAuthorizationId: '9' })),
    };
    const transactionRunner = {
      run: jest.fn((callback: (ctx: unknown) => unknown) => callback(transactionContext)),
    } as unknown as TransactionRunner;

    return {
      usecase: new RenewMyLocalAuthorizationUsecase(
        scopeResolver as unknown as LocalRuntimeScopeResolver,
        localRuntimeQueryService as unknown as LocalRuntimeQueryService,
        service as unknown as SyncConflictService,
        transactionRunner,
      ),
      service,
    };
  };

  const command = {
    session,
    signedClaims: { sub: 'account-16', scopes: ['repair:read'] },
    permissionVersion: 2,
  };

  it('本人续期：范围键取自 Session 复核结果，校验时间由服务端生成', async () => {
    const { usecase, service } = makeUsecase({
      role: 'ENGINEER',
      organizationId: 4,
      adminLevel: null,
    });

    const result = await usecase.execute(command);

    expect(result.renewedAuthorizationId).toBe('9');
    expect(service.renewAccountAuthorization).toHaveBeenCalledWith(
      {
        installationId: installation.installationId,
        accountId: 16,
        organizationId: 4,
      },
      {
        signedClaims: command.signedClaims,
        permissionVersion: 2,
        lastVerifiedAt: expect.any(Date),
      },
      transactionContext,
    );
  });

  it('一级管理员（全局范围）不适用本人续期', async () => {
    const { usecase, service } = makeUsecase({
      role: 'ADMIN_LEVEL_1',
      organizationId: null,
      adminLevel: 1,
    });

    await expect(usecase.execute(command)).rejects.toMatchObject({
      code: SYNC_ERROR.INVALID_PARAMS,
    });
    expect(service.renewAccountAuthorization).not.toHaveBeenCalled();
  });

  it('REVOKED 行拒绝续期（模块服务抛错，用例不吞）', async () => {
    const { usecase, service } = makeUsecase({
      role: 'ENGINEER',
      organizationId: 4,
      adminLevel: null,
    });
    (service.renewAccountAuthorization as jest.Mock).mockImplementation(() =>
      Promise.reject(new Error(SYNC_ERROR.AUTHORIZATION_RENEWAL_NOT_ALLOWED)),
    );

    await expect(usecase.execute(command)).rejects.toThrow(
      SYNC_ERROR.AUTHORIZATION_RENEWAL_NOT_ALLOWED,
    );
  });
});
