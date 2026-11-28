// src/usecases/auth/resolve-web-session.usecase.spec.ts

import {
  SessionRestriction,
  type AuthenticatedSessionUser,
} from '@app-types/auth/session-restriction.types';
import { AudienceTypeEnum, IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, JWT_ERROR } from '@core/common/errors/domain-error';
import { TokenHelper } from '@modules/auth/token.helper';
import { ValidateAccessTokenSessionUsecase } from './validate-access-token-session.usecase';
import { ResolveWebSessionUsecase } from './resolve-web-session.usecase';

describe('ResolveWebSessionUsecase（浏览器会话恢复：只验不改）', () => {
  const tokenHelper = {
    verifyTokenSilently: jest.fn(),
    generateAccessToken: jest.fn(),
    generateRefreshToken: jest.fn(),
  } as unknown as TokenHelper;
  const validateAccessTokenSessionUsecase = {
    execute: jest.fn(),
  } as unknown as ValidateAccessTokenSessionUsecase;
  const usecase = new ResolveWebSessionUsecase(tokenHelper, validateAccessTokenSessionUsecase);

  const session: AuthenticatedSessionUser = {
    sub: 42,
    accountId: 42,
    role: IdentityTypeEnum.ENGINEER,
    accessGroup: [IdentityTypeEnum.ENGINEER],
    restriction: SessionRestriction.NONE,
    adminLevel: null,
    customerOrganizationId: null,
    engineerOrganizationId: 7,
    adminOrganizationId: null,
    registrationOrganizationId: null,
  } as AuthenticatedSessionUser;

  beforeEach(() => {
    jest.clearAllMocks();
    (tokenHelper.verifyTokenSilently as jest.Mock).mockReturnValue({
      sub: 42,
      type: 'access',
      exp: 1_893_456_000,
    });
    (validateAccessTokenSessionUsecase.execute as jest.Mock).mockResolvedValue(session);
  });

  it('只接受网页受众：校验时固定传 SSTSWEB 与签发者', async () => {
    await usecase.execute({ token: 'cookie-token', issuer: 'ssts-local' });

    expect(tokenHelper.verifyTokenSilently).toHaveBeenCalledWith({
      token: 'cookie-token',
      audience: AudienceTypeEnum.SSTSWEB,
      issuer: 'ssts-local',
    });
  });

  it('复用每请求会话复核（账号状态/角色集/凭据代次等由既有用例判定）', async () => {
    const payload = { sub: 42, type: 'access', exp: 1_893_456_000 };
    (tokenHelper.verifyTokenSilently as jest.Mock).mockReturnValue(payload);

    await usecase.execute({ token: 'cookie-token' });

    expect(validateAccessTokenSessionUsecase.execute).toHaveBeenCalledTimes(1);
    expect(validateAccessTokenSessionUsecase.execute).toHaveBeenCalledWith({ payload });
  });

  it('返回原令牌（不重签）与原会话事实', async () => {
    const result = await usecase.execute({ token: 'cookie-token' });

    expect(result.accessToken).toBe('cookie-token');
    expect(result.session).toBe(session);
    expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
    expect(tokenHelper.generateRefreshToken).not.toHaveBeenCalled();
  });

  it('验签/受众/有效期失败时原样抛出 JWT 领域错误，不降级为放行', async () => {
    (tokenHelper.verifyTokenSilently as jest.Mock).mockImplementation(() => {
      throw new DomainError(JWT_ERROR.TOKEN_INVALID, 'Token 无效或不属于当前入口');
    });

    await expect(usecase.execute({ token: 'other-audience-token' })).rejects.toMatchObject({
      code: JWT_ERROR.TOKEN_INVALID,
    });
    expect(validateAccessTokenSessionUsecase.execute).not.toHaveBeenCalled();
  });

  it('会话复核拒绝时向上抛出，不吞错、不改写为放行', async () => {
    (validateAccessTokenSessionUsecase.execute as jest.Mock).mockRejectedValue(
      new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, '认证失败'),
    );

    await expect(usecase.execute({ token: 'cookie-token' })).rejects.toMatchObject({
      code: JWT_ERROR.AUTHENTICATION_FAILED,
    });
  });

  it('非领域异常（数据库故障）保持原样上抛，便于 REST 侧保留为服务错误', async () => {
    const dbError = new Error('connection lost');
    (validateAccessTokenSessionUsecase.execute as jest.Mock).mockRejectedValue(dbError);

    await expect(usecase.execute({ token: 'cookie-token' })).rejects.toBe(dbError);
  });
});
