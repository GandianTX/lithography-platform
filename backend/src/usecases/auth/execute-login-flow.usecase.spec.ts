// src/usecases/auth/execute-login-flow.usecase.spec.ts

import { AccountStatus, AudienceTypeEnum } from '@app-types/models/account.types';
import { AUTH_ERROR } from '@core/common/errors';
import { ExecuteLoginFlowUsecase } from './execute-login-flow.usecase';

/**
 * 账户状态检查回归用例。
 *
 * 背景：受限会话（工程师待审）在凭据校验阶段已放行 `PENDING` 账号，
 * 但执行登录流程曾再次硬性要求 `ACTIVE`，导致受限会话实际无法签发令牌。
 * 这里锁定「仅显式允许时放行 PENDING，其余非 ACTIVE 一律拒绝」的口径。
 */
describe('ExecuteLoginFlowUsecase 账户状态检查', () => {
  const createUsecase = (accountStatus: AccountStatus) => {
    const accountQueryService = {
      getLoginBootstrapSnapshot: jest.fn().mockResolvedValue({
        account: { id: 9001, status: accountStatus },
        userInfo: { nickname: '待审工程师' },
      }),
    };
    const accountSecurityService = {
      checkAndHandleAccountSecurity: jest.fn().mockReturnValue({ wasSuspended: false }),
    };
    const loginBootstrapQueryService = {
      toLoginUserDataCollection: jest.fn().mockReturnValue({
        userWithAccessGroup: {
          id: 9001,
          loginEmail: 'engineer@example.com',
          accessGroup: [],
        },
        userInfo: { nickname: '待审工程师' },
      }),
    };
    const tokenHelper = {
      createPayloadFromUser: jest.fn().mockReturnValue({ sub: 9001 }),
      generateAccessToken: jest.fn().mockReturnValue('access'),
      generateRefreshToken: jest.fn().mockReturnValue('refresh'),
    };
    const loginResultQueryService = {
      toBasicLoginResult: jest.fn().mockReturnValue({ tokens: { refreshToken: 'refresh' } }),
    };

    const usecase = new ExecuteLoginFlowUsecase(
      { recordLoginHistory: jest.fn().mockResolvedValue(undefined) } as never,
      accountQueryService as never,
      accountSecurityService as never,
      { validateAudience: jest.fn().mockReturnValue(true) } as never,
      tokenHelper as never,
      loginBootstrapQueryService as never,
      loginResultQueryService as never,
      { setContext: jest.fn(), info: jest.fn(), error: jest.fn() } as never,
    );
    return usecase;
  };

  it('PENDING 账号在显式允许时通过状态检查并签发令牌', async () => {
    const usecase = createUsecase(AccountStatus.PENDING);

    await expect(
      usecase.execute({
        accountId: 9001,
        audience: AudienceTypeEnum.SJWEB,
        allowPendingAccount: true,
      }),
    ).resolves.toBeDefined();
  });

  it('PENDING 账号未显式允许时仍拒绝登录', async () => {
    const usecase = createUsecase(AccountStatus.PENDING);

    await expect(
      usecase.execute({ accountId: 9001, audience: AudienceTypeEnum.SJWEB }),
    ).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
  });

  it('停用/封禁类状态即使显式允许也不放行', async () => {
    const usecase = createUsecase(AccountStatus.SUSPENDED);

    await expect(
      usecase.execute({
        accountId: 9001,
        audience: AudienceTypeEnum.SJWEB,
        allowPendingAccount: true,
      }),
    ).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
  });
});
