// src/infrastructure/config/web-session.config.spec.ts

import { APP_CONFIG_FACTORIES } from './config.module';

type WebSessionEnv = {
  enabled?: string;
  ttl?: string;
  origins?: string;
  secure?: string;
  nodeEnv?: string;
};

/**
 * 从已注册的配置工厂清单里定位浏览器会话工厂。
 *
 * 直接断言 `APP_CONFIG_FACTORIES` 而不是导入私有常量：既验证「配置确实注册」
 * （漏注册时运行期读不到），也不得不暴露内部实现。
 *
 * 按函数名定位而不是「调用后看输出」：非法配置下工厂本身会抛错，
 * 调用式探测会把「应抛错」误判成「未注册」。
 */
const findWebSessionFactory = () =>
  APP_CONFIG_FACTORIES.find((factory) => factory.name === 'webSessionConfig');

describe('webSession 配置（浏览器会话开关与边界）', () => {
  const ORIGINAL = {
    enabled: process.env.WEB_SESSION_ENABLED,
    ttl: process.env.WEB_SESSION_ACCESS_TOKEN_TTL,
    origins: process.env.WEB_SESSION_ALLOWED_ORIGINS,
    secure: process.env.WEB_SESSION_COOKIE_SECURE,
    nodeEnv: process.env.NODE_ENV,
  };

  const applyEnv = (env: WebSessionEnv) => {
    const entries: Array<[string, string | undefined]> = [
      ['WEB_SESSION_ENABLED', env.enabled],
      ['WEB_SESSION_ACCESS_TOKEN_TTL', env.ttl],
      ['WEB_SESSION_ALLOWED_ORIGINS', env.origins],
      ['WEB_SESSION_COOKIE_SECURE', env.secure],
      ['NODE_ENV', env.nodeEnv],
    ];

    for (const [key, value] of entries) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  const readWebSession = (): Record<string, unknown> => {
    const factory = findWebSessionFactory();

    if (!factory) {
      throw new Error('webSession config factory is not registered in APP_CONFIG_FACTORIES');
    }

    return (factory() as { webSession: Record<string, unknown> }).webSession;
  };

  afterEach(() => {
    applyEnv({
      enabled: ORIGINAL.enabled,
      ttl: ORIGINAL.ttl,
      origins: ORIGINAL.origins,
      secure: ORIGINAL.secure,
      nodeEnv: ORIGINAL.nodeEnv,
    });
  });

  it('已注册到 APP_CONFIG_FACTORIES', () => {
    expect(findWebSessionFactory()).toBeDefined();
  });

  it('默认关闭：不要求任何新增配置，且不给出网页专属有效期', () => {
    applyEnv({ nodeEnv: 'test' });

    expect(readWebSession()).toEqual({
      enabled: false,
      accessTokenTtl: undefined,
      cookieSecure: false,
      allowedOrigins: [],
    });
  });

  it('启用但未配置可信来源时启动失败（不静默回退）', () => {
    applyEnv({ enabled: 'true', nodeEnv: 'test' });

    expect(() => readWebSession()).toThrow(/WEB_SESSION_ALLOWED_ORIGINS is required/);
  });

  it('启用但来源不是绝对 origin 时启动失败', () => {
    applyEnv({ enabled: 'true', origins: 'localhost:5173', nodeEnv: 'test' });

    expect(() => readWebSession()).toThrow(/absolute origins/);
  });

  it('启用但有效期写法非法时启动失败', () => {
    applyEnv({
      enabled: 'true',
      origins: 'http://localhost:5173',
      ttl: 'eight-hours',
      nodeEnv: 'test',
    });

    expect(() => readWebSession()).toThrow(/WEB_SESSION_ACCESS_TOKEN_TTL/);
  });

  it('生产启用但未开启 Secure 时启动失败', () => {
    applyEnv({
      enabled: 'true',
      origins: 'https://app.example.com',
      secure: 'false',
      nodeEnv: 'production',
    });

    expect(() => readWebSession()).toThrow(/WEB_SESSION_COOKIE_SECURE must be true/);
  });

  it('配置齐备时按原样暴露有效期与来源（8 小时只能由部署显式配置）', () => {
    applyEnv({
      enabled: 'true',
      origins: 'https://app.example.com, https://app2.example.com',
      ttl: '8h',
      secure: 'true',
      nodeEnv: 'production',
    });

    expect(readWebSession()).toEqual({
      enabled: true,
      accessTokenTtl: '8h',
      cookieSecure: true,
      allowedOrigins: ['https://app.example.com', 'https://app2.example.com'],
    });
  });

  it('启用且未配置有效期时保持 undefined（沿用全局 JWT_EXPIRES_IN）', () => {
    applyEnv({
      enabled: 'true',
      origins: 'http://localhost:5173',
      secure: 'false',
      nodeEnv: 'test',
    });

    expect(readWebSession()).toMatchObject({ enabled: true, accessTokenTtl: undefined });
  });
});
