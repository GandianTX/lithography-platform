// src/modules/auth/token.helper.verify-silently.spec.ts

import { AudienceTypeEnum } from '@app-types/models/account.types';
import { DomainError, JWT_ERROR } from '@core/common/errors/domain-error';
import { JsonWebTokenError, JwtService, TokenExpiredError } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { TokenHelper } from './token.helper';

describe('TokenHelper.verifyTokenSilently（浏览器会话恢复专用校验）', () => {
  const jwtService = {
    verify: jest.fn(),
  } as unknown as JwtService;
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
  const helper = new TokenHelper(jwtService, logger);

  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.signature-part-should-never-be-logged';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('按调用方给出的受众与签发者校验（与 Bearer 链路同等严格）', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({ sub: 1 });

    helper.verifyTokenSilently({ token, audience: AudienceTypeEnum.SSTSWEB, issuer: 'ssts-local' });

    expect(jwtService.verify).toHaveBeenCalledWith(token, {
      audience: AudienceTypeEnum.SSTSWEB,
      issuer: 'ssts-local',
    });
  });

  it('未提供签发者时不传 issuer（由令牌自身决定是否含该声明）', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({ sub: 1 });

    helper.verifyTokenSilently({ token, audience: AudienceTypeEnum.SSTSWEB });

    expect(jwtService.verify).toHaveBeenCalledWith(token, {
      audience: AudienceTypeEnum.SSTSWEB,
    });
  });

  it('令牌过期映射为 TOKEN_EXPIRED', () => {
    (jwtService.verify as jest.Mock).mockImplementation(() => {
      throw new TokenExpiredError('jwt expired', new Date());
    });

    expect(() => helper.verifyTokenSilently({ token, audience: 'SSTSWEB' })).toThrow(DomainError);
    expect(() => helper.verifyTokenSilently({ token, audience: 'SSTSWEB' })).toThrow(
      expect.objectContaining({ code: JWT_ERROR.TOKEN_EXPIRED }),
    );
  });

  it('受众不匹配等签名类失败映射为 TOKEN_INVALID', () => {
    (jwtService.verify as jest.Mock).mockImplementation(() => {
      throw new JsonWebTokenError('jwt audience invalid');
    });

    expect(() => helper.verifyTokenSilently({ token, audience: 'SSTSTEST' })).toThrow(
      expect.objectContaining({ code: JWT_ERROR.TOKEN_INVALID }),
    );
  });

  it('失败路径不记录任何令牌片段（与 verifyToken 的 tokenPrefix 日志区分）', () => {
    (jwtService.verify as jest.Mock).mockImplementation(() => {
      throw new JsonWebTokenError('jwt audience invalid');
    });

    expect(() => helper.verifyTokenSilently({ token, audience: 'SSTSTEST' })).toThrow();

    const logged = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ]
      .flat()
      .map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument)))
      .join(' ');

    expect(logged).not.toContain('signature-part');
    expect(logged).not.toContain(token.slice(0, 20));
  });
});
