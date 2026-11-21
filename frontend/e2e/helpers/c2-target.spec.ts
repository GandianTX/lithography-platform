// e2e/helpers/c2-target.spec.ts
// C2 启用判定与代理绑定核验的纯逻辑单测（不启动浏览器、不访问保留环境）。

import { describe, expect, it } from 'vitest';

import {
  assertC2GraphQLBinding,
  assertC2Runtime,
  type C2Fetch,
  type C2TargetSummary,
  resolveC2Target,
  validateC2BrowserBinding,
} from './c2-target';

const API_URL = 'http://127.0.0.1:43117';
const CONTROL_URL = 'http://127.0.0.1:4399';
const RUN_TAG = 'c2-run-1a2b3c4d';

function makeTarget(overrides: Partial<C2TargetSummary> = {}): C2TargetSummary {
  return {
    apiBaseUrl: API_URL,
    apiPort: 43117,
    databaseInstanceHash: '8770ccde2565',
    databaseNameHash: '64147ef46e53',
    frontendPort: 4278,
    providerPort: 4399,
    redisInstanceHash: 'b6c27157d349',
    redisPort: 16506,
    runTag: RUN_TAG,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    verified: true,
    ...overrides,
  };
}

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    AI_C2_CONTROL_URL: CONTROL_URL,
    AI_E2E_C2: '1',
    AI_E2E_C2_OK_TAG: 'C2-OK-deadbeef',
    AI_E2E_C2_RUN_TAG: RUN_TAG,
    AI_E2E_C2_TARGET_FILE: '/tmp/c2-target.json',
    AI_E2E_C2_TOKEN: 'C2-FAIL-cafebabe',
    AI_E2E_BACKEND_URL: API_URL,
    ...overrides,
  };
}

function resolveWith(env: NodeJS.ProcessEnv, target: C2TargetSummary = makeTarget()) {
  return resolveC2Target({
    env,
    exists: () => true,
    readFile: () => JSON.stringify(target),
  });
}

function fakeFetch(responses: Record<string, unknown>): C2Fetch {
  return (url: string) => {
    const payload = responses[url];
    if (payload === undefined) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
}

describe('C2 启用判定', () => {
  it('没有任何 C2 专有变量时只关闭 C2', () => {
    expect(resolveC2Target({ env: {} }).kind).toBe('disabled');
  });

  it('普通真实用例可以覆盖后端地址，遗留 C2 标记仍拒绝', () => {
    const env = { AI_E2E_BACKEND_URL: API_URL };
    expect(resolveC2Target({ env }).kind).toBe('disabled');
    expect(resolveC2Target({ env: { ...env, AI_E2E_C2_TOKEN: 'leftover' } }).kind).toBe('invalid');
    expect(resolveC2Target({ env: { AI_E2E_C2: '1' } }).kind).toBe('invalid');
  });

  it('遗留 C2 变量但未显式启用时拒绝（不允许半启用）', () => {
    const resolution = resolveC2Target({
      env: { AI_E2E_C2_TOKEN: 'C2-FAIL-cafebabe', AI_C2_CONTROL_URL: CONTROL_URL },
    });
    expect(resolution.kind).toBe('invalid');
    if (resolution.kind === 'invalid') {
      expect(resolution.reason).toContain('未显式启用');
    }
  });

  it('仅设置 AI_E2E_C2=0 且无其他变量时视为关闭', () => {
    expect(resolveC2Target({ env: { AI_E2E_C2: '0' } }).kind).toBe('disabled');
  });

  it('启用后缺少必填项时失败关闭', () => {
    const resolution = resolveC2Target({ env: { ...makeEnv(), AI_E2E_C2_RUN_TAG: '' } });
    expect(resolution.kind).toBe('invalid');
    if (resolution.kind === 'invalid') {
      expect(resolution.reason).toContain('AI_E2E_C2_RUN_TAG');
    }
  });

  it('启用后不得回退默认开发地址', () => {
    const resolution = resolveWith(makeEnv({ AI_E2E_BACKEND_URL: 'http://127.0.0.1:3005' }));
    expect(resolution.kind).toBe('invalid');
  });

  it('控制地址端口必须匹配本轮 provider', () => {
    const resolution = resolveWith(makeEnv({ AI_C2_CONTROL_URL: 'http://127.0.0.1:4400' }));
    expect(resolution.kind).toBe('invalid');
    if (resolution.kind === 'invalid') {
      expect(resolution.reason).toContain('控制地址端口');
    }
  });

  it('摘要运行标识必须与本轮一致', () => {
    const resolution = resolveWith(makeEnv(), makeTarget({ runTag: 'c2-run-other' }));
    expect(resolution.kind).toBe('invalid');
  });

  it('摘要哈希字段格式非法时拒绝', () => {
    const resolution = resolveWith(makeEnv(), makeTarget({ databaseNameHash: 'not-a-hash' }));
    expect(resolution.kind).toBe('invalid');
  });

  it('合法启用时返回本轮目标', () => {
    const resolution = resolveWith(makeEnv());
    expect(resolution.kind).toBe('enabled');
    if (resolution.kind === 'enabled') {
      expect(resolution.failToken).toBe('C2-FAIL-cafebabe');
      expect(resolution.target.frontendPort).toBe(4278);
    }
  });

  it('受控 WARNING 标识可选：缺省为空，提供时原样透传', () => {
    const withoutWarn = resolveWith(makeEnv());
    if (withoutWarn.kind !== 'enabled') throw new Error('预期启用 C2');
    expect(withoutWarn.warnToken).toBe('');

    const withWarn = resolveWith(makeEnv({ AI_E2E_C2_WARN_TOKEN: 'C2-WARN-cafebabe' }));
    if (withWarn.kind !== 'enabled') throw new Error('预期启用 C2');
    expect(withWarn.warnToken).toBe('C2-WARN-cafebabe');
  });

  it('只提供 WARNING 标识但未显式启用时同样拒绝（不允许半启用）', () => {
    expect(resolveC2Target({ env: { AI_E2E_C2_WARN_TOKEN: 'C2-WARN-cafebabe' } }).kind).toBe(
      'invalid',
    );
  });
});

describe('C2 浏览器绑定', () => {
  it('健康探测通过也拒绝浏览器使用其他 GraphQL 地址', async () => {
    const baseURL = 'http://127.0.0.1:4278';
    const resolution = resolveWith(makeEnv());
    if (resolution.kind !== 'enabled') throw new Error('预期启用 C2');
    const health = { status: 'ok', service: 'api', uptimeSeconds: 5, instanceTag: RUN_TAG };
    await assertC2Runtime({
      baseURL,
      resolution,
      fetchImpl: fakeFetch({ [`${API_URL}/health`]: health, [`${baseURL}/health`]: health }),
    });
    expect(() =>
      assertC2GraphQLBinding(`${baseURL}/login`, 'http://127.0.0.1:43118/graphql'),
    ).toThrow('浏览器 GraphQL 地址与本轮同源 /graphql 不一致');
    expect(() => assertC2GraphQLBinding(`${baseURL}/login`, '/other-graphql')).toThrow();
    expect(() => assertC2GraphQLBinding(`${baseURL}/login`, '/graphql')).not.toThrow();
  });

  const enabled = (() => {
    const resolution = resolveWith(makeEnv());
    if (resolution.kind !== 'enabled') {
      throw new Error('fixture should be enabled');
    }
    return resolution;
  })();

  it('摘要前端端口与真实 baseURL 不一致时拒绝', () => {
    const reason = validateC2BrowserBinding({
      baseURL: 'http://127.0.0.1:4288',
      resolution: enabled,
    });
    expect(reason).toContain('前端端口与本次浏览器入口不一致');
  });

  it('baseURL 缺失时拒绝', () => {
    expect(validateC2BrowserBinding({ baseURL: '', resolution: enabled })).toContain(
      '缺少本次运行的 baseURL',
    );
  });

  it('端口一致但同源代理命中另一实例时拒绝', async () => {
    await expect(
      assertC2Runtime({
        baseURL: 'http://127.0.0.1:4278',
        fetchImpl: fakeFetch({
          [`${API_URL}/health`]: {
            status: 'ok',
            service: 'api',
            uptimeSeconds: 5,
            instanceTag: RUN_TAG,
          },
          'http://127.0.0.1:4278/health': {
            status: 'ok',
            service: 'api',
            uptimeSeconds: 5,
            instanceTag: 'c2-run-wrong',
          },
        }),
        resolution: enabled,
      }),
    ).rejects.toThrow('浏览器代理命中的是其他实例');
  });

  it('直连 uptime 与摘要启动时间不一致时拒绝', async () => {
    await expect(
      assertC2Runtime({
        baseURL: 'http://127.0.0.1:4278',
        fetchImpl: fakeFetch({
          [`${API_URL}/health`]: {
            status: 'ok',
            service: 'api',
            uptimeSeconds: 600,
            instanceTag: RUN_TAG,
          },
          'http://127.0.0.1:4278/health': { status: 'ok', service: 'api', instanceTag: RUN_TAG },
        }),
        resolution: enabled,
      }),
    ).rejects.toThrow('实例身份不一致');
  });

  it('同源代理命中本轮实例时通过', async () => {
    const result = await assertC2Runtime({
      baseURL: 'http://127.0.0.1:4278',
      fetchImpl: fakeFetch({
        [`${API_URL}/health`]: {
          status: 'ok',
          service: 'api',
          uptimeSeconds: 5,
          instanceTag: RUN_TAG,
        },
        'http://127.0.0.1:4278/health': { status: 'ok', service: 'api', instanceTag: RUN_TAG },
      }),
      now: () => Date.now(),
      resolution: enabled,
    });
    expect(result.browserHealth.instanceTag).toBe(RUN_TAG);
  });
});
