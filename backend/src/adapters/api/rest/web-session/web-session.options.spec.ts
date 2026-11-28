// src/adapters/api/rest/web-session/web-session.options.spec.ts

import { ConfigService } from '@nestjs/config';

import { createWebSessionOptions } from '../rest-adapter.module';

import { WEB_SESSION_COOKIE_PATH } from './web-session.options';

describe('createWebSessionOptions（配置 → 适配器选项的单一映射）', () => {
  const buildConfig = (entries: ReadonlyArray<readonly [string, unknown]>): ConfigService => {
    const values = new Map(entries);

    return {
      get: jest.fn((key: string, defaultValue?: unknown) => values.get(key) ?? defaultValue),
    } as unknown as ConfigService;
  };

  it('关闭时保持最小选项，不引入任何副作用', () => {
    const options = createWebSessionOptions(
      buildConfig([
        ['webSession.enabled', false],
        ['webSession.cookieSecure', false],
        ['webSession.allowedOrigins', []],
      ]),
    );

    expect(options).toEqual({
      enabled: false,
      cookieSecure: false,
      allowedOrigins: [],
    });
  });

  it('启用时映射有效期、Secure、来源与签发者（Bearer 链路同源）', () => {
    const options = createWebSessionOptions(
      buildConfig([
        ['webSession.enabled', true],
        ['webSession.accessTokenTtl', '8h'],
        ['webSession.cookieSecure', true],
        ['webSession.allowedOrigins', ['https://app.example.com']],
        ['jwt.issuer', 'ssts-local'],
      ]),
    );

    expect(options).toEqual({
      enabled: true,
      accessTokenTtl: '8h',
      cookieSecure: true,
      allowedOrigins: ['https://app.example.com'],
      issuer: 'ssts-local',
    });
  });

  it('Cookie 路径固定为窄路径（不接受运行时改写）', () => {
    expect(WEB_SESSION_COOKIE_PATH).toBe('/api/auth/web-session');
  });
});
