import { AccountStatus, AudienceTypeEnum, LoginTypeEnum } from '@app-types/models/account.types';
import { AUTH_ERROR } from '@core/common/errors';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { PinoLogger } from 'nestjs-pino';
import { DecideLoginRoleUsecase } from './decide-login-role.usecase';
import { EnrichLoginWithIdentityUsecase } from './enrich-login-with-identity.usecase';
import { ExecuteLoginFlowUsecase } from './execute-login-flow.usecase';
import { LoginWithPasswordUsecase } from './login-with-password.usecase';
import { TokenHelper } from '@modules/auth/token.helper';

describe('LoginWithPasswordUsecase（注册审核前的登录阻断）', () => {
  const accountQueryService = {
    findCredentialByLoginName: jest.fn(),
  } as unknown as AccountQueryService;
  const executeLoginFlowUsecase = {
    execute: jest.fn(),
  } as unknown as ExecuteLoginFlowUsecase;
  const decideLoginRoleUsecase = {
    execute: jest.fn(),
  } as unknown as DecideLoginRoleUsecase;
  const enrichLoginWithIdentityUsecase = {
    execute: jest.fn(),
  } as unknown as EnrichLoginWithIdentityUsecase;
  const tokenHelper = {
    generateAccessToken: jest.fn(),
  } as unknown as TokenHelper;
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
  const usecase = new LoginWithPasswordUsecase(
    accountQueryService,
    executeLoginFlowUsecase,
    decideLoginRoleUsecase,
    enrichLoginWithIdentityUsecase,
    tokenHelper,
    logger,
  );

  const credential = (status: AccountStatus) => ({
    id: 9001,
    status,
    loginEmail: 'engineer-pending@example.com',
    loginPassword: 'hashed-secret',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  const login = () =>
    usecase.execute({
      loginName: 'engineer-pending@example.com',
      loginPassword: 'PlainPassword1!',
      type: LoginTypeEnum.PASSWORD,
      ip: '127.0.0.1',
      audience: AudienceTypeEnum.SJWEB,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AccountService, 'verifyPassword').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['待审工程师（PENDING）', AccountStatus.PENDING],
    ['未激活（INACTIVE）', AccountStatus.INACTIVE],
    ['已停用（SUSPENDED）', AccountStatus.SUSPENDED],
  ])('%s 账号在签发令牌前即被拒绝', async (_label, status) => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(status),
    );

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
    expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
    expect(decideLoginRoleUsecase.execute).not.toHaveBeenCalled();
    expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
  });

  it('账号不存在时统一按 ACCOUNT_NOT_FOUND 拒绝', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(null);

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_NOT_FOUND });
    expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
  });

  it('激活账号密码错误仍按 INVALID_PASSWORD 拒绝', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.ACTIVE),
    );
    jest.spyOn(AccountService, 'verifyPassword').mockReturnValue(false);

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
    expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
  });
});
