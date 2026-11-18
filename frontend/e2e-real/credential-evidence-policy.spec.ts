// e2e-real/credential-evidence-policy.spec.ts
// @vitest-environment node

/**
 * 含凭据规格的证据策略单测：常量必须保持三个自动证据全关，
 * CLI 守卫必须拒绝每一种会重新打开证据或追加附件的写法（`--flag value` 与 `--flag=value`）。
 * 真实运行由 `playwright.{admin-companies,admin-user-management}-real.config.ts`
 * 在配置加载期调用守卫；这里只钉住策略本身的判定边界。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoArtifactOverrides,
  CREDENTIAL_ARTIFACT_ISOLATION_ENV,
  CREDENTIAL_SAFE_USE,
  enableCredentialArtifactIsolation,
} from './credential-evidence-policy';

describe('含凭据规格的证据策略', () => {
  it('三个自动证据开关固定关闭，且不引入其它自动证据', () => {
    expect(CREDENTIAL_SAFE_USE).toEqual({
      screenshot: 'off',
      trace: 'off',
      video: 'off',
    });
  });

  it.each([['--trace'], ['--video'], ['--screenshot'], ['--reporter']])(
    '拒绝 CLI 覆盖 %s',
    (flag) => {
      expect(() => assertNoArtifactOverrides(['playwright', 'test', flag])).toThrow(
        /拒绝覆盖证据开关/,
      );
      expect(() => assertNoArtifactOverrides(['playwright', 'test', `${flag}=on`])).toThrow(
        /拒绝覆盖证据开关/,
      );
      // Playwright 的 `--flag value` 写法同样命中（只比对 flag 本身，不看取值）
      expect(() => assertNoArtifactOverrides(['playwright', 'test', flag, 'on'])).toThrow(
        /拒绝覆盖证据开关/,
      );
    },
  );

  it('一次命中多个覆盖时在错误里逐个点名，便于执行者定位', () => {
    expect(() =>
      assertNoArtifactOverrides(['playwright', 'test', '--trace=on', '--reporter=html']),
    ).toThrow(/--trace=on、--reporter=html/);
  });

  it('允许不含证据开关的常规参数与用例路径', () => {
    expect(() =>
      assertNoArtifactOverrides([
        'node',
        'playwright',
        'test',
        '--config=playwright.admin-companies-real.config.ts',
        '--workers=1',
        'e2e-real/admin-companies-real.spec.ts',
      ]),
    ).not.toThrow();
  });
});

describe('凭据失败附件隔离', () => {
  let originalIsolationValue: string | undefined;

  beforeEach(() => {
    originalIsolationValue = process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV];
  });

  afterEach(() => {
    // 恢复原值，避免本文件的进程环境变更污染兄弟用例
    if (originalIsolationValue === undefined) {
      delete process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV];
    } else {
      process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV] = originalIsolationValue;
    }
  });

  it('控制变量指向安装实现的失败快照开关', () => {
    expect(CREDENTIAL_ARTIFACT_ISOLATION_ENV).toBe('PLAYWRIGHT_NO_COPY_PROMPT');
  });

  it('外部未设置时强制启用隔离', () => {
    delete process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV];

    enableCredentialArtifactIsolation();

    expect(process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV]).toBe('1');
  });

  it.each([[''], ['0'], ['false'], ['off'], [' ']])('外部值为 %j 时仍强制启用隔离', (value) => {
    process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV] = value;

    enableCredentialArtifactIsolation();

    expect(process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV]).toBe('1');
  });

  it('作用于显式传入的环境对象且不污染进程环境', () => {
    delete process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV];
    const injectedEnv: NodeJS.ProcessEnv = {};

    enableCredentialArtifactIsolation(injectedEnv);

    expect(injectedEnv[CREDENTIAL_ARTIFACT_ISOLATION_ENV]).toBe('1');
    expect(process.env[CREDENTIAL_ARTIFACT_ISOLATION_ENV]).toBeUndefined();
  });
});
