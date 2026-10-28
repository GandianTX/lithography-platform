// test/utils/e2e-pr0-acceptance.e2e-spec.ts
//
// PR0 清理安全收敛 / V-ENV：受控验收启动器的永久回归。
//
// 覆盖：
//   - 拒绝必须发生在连接与 spawn 之前（缺失参数/配置、危险或冲突配置、父 shell 残留绑定）；
//   - 真实只读预检只绑定明确配置的实例（仅在 PR0_ACCEPTANCE_CONFIG 提供时执行，
//     完整 core 由启动器发起时该变量必然存在，因此真实分支不会被隐藏）；
//   - 预检成功不 spawn；真实 runner 的 spawn 证据由实际整组/定向执行提供。
//
// 本规格不创建/删除任何数据库，不启动 Nest 应用；预检只读。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.setTimeout(180000);

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const LAUNCHER = path.join(BACKEND_ROOT, 'test/run-pr0-acceptance.js');
const ACCEPTANCE_CONFIG = (process.env.PR0_ACCEPTANCE_CONFIG ?? '').trim();
const itReal = ACCEPTANCE_CONFIG === '' ? it.skip : it;

interface LauncherConfig {
  readonly path: string;
  readonly map: Record<string, string>;
  readonly hash: string;
}

interface LauncherModule {
  loadConfig(configPath: string): LauncherConfig;
  validateConfig(config: LauncherConfig): Record<string, unknown>;
  writeSanitizedDotenv(config: LauncherConfig, bound: Record<string, unknown>): string;
  buildChildEnv(
    config: LauncherConfig,
    bound: Record<string, unknown>,
    options: { group: string },
    dotenvFile: string,
  ): NodeJS.ProcessEnv;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const launcherModule = require(LAUNCHER) as LauncherModule;

/** 本期真实消费者新增的最小运行键（A01）。 */
const RUNTIME_KEYS = [
  'PAGINATION_HMAC_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_IV',
  'AI_PROVIDER_MODE',
] as const;

interface LauncherRun {
  readonly status: number | null;
  readonly output: string;
}

const runLauncher = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): LauncherRun => {
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 120000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
};

const assertRefusedBeforeSideEffects = (run: LauncherRun, stage: 'usage' | 'config'): void => {
  expect(run.status).toBe(2);
  expect(run.output).toContain(`PR0_ACCEPT_REFUSED=${stage}`);
  expect(run.output).not.toContain('PR0_ACCEPT_PRECHECK=ok');
  expect(run.output).not.toContain('PR0_ACCEPT_RUNNER=spawned');
};

const readAcceptanceConfig = (): string => fs.readFileSync(ACCEPTANCE_CONFIG, 'utf8');

const withConfigVariant = (
  label: string,
  mutate: (text: string) => string,
): { dir: string; file: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pr0-acc-${label}-`));
  const file = path.join(dir, `pr0-acceptance-${label}.env`);
  fs.writeFileSync(file, mutate(readAcceptanceConfig()), { mode: 0o600 });
  return { dir, file };
};

const replaceLine = (text: string, key: string, value: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(`${key}=`) ? `${key}=${value}` : line))
    .join('\n');

const dropLine = (text: string, key: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${key}=`))
    .join('\n');

describe('PR0 受控验收启动器（V-ENV）', () => {
  it('缺少 --config：usage 阶段拒绝，未连接、未 spawn', () => {
    assertRefusedBeforeSideEffects(runLauncher(['--phase', 'preflight-only']), 'usage');
  });

  it('配置文件不存在：config 阶段拒绝，未连接、未 spawn', () => {
    const run = runLauncher([
      '--config',
      path.join(os.tmpdir(), 'pr0-acceptance-does-not-exist.env'),
      '--phase',
      'preflight-only',
    ]);
    assertRefusedBeforeSideEffects(run, 'config');
  });

  itReal('危险/冲突配置在连接前被拒绝，且不回落默认实例', () => {
    const variants: Array<{ label: string; mutate: (text: string) => string; reason: string }> = [
      {
        label: 'sync',
        mutate: (t) => replaceLine(t, 'DB_SYNCHRONIZE', 'true'),
        reason: 'DB_SYNCHRONIZE',
      },
      {
        label: 'cleanup',
        mutate: (t) => replaceLine(t, 'E2E_ALLOW_DB_CLEANUP', '1'),
        reason: 'E2E_ALLOW_DB_CLEANUP',
      },
      { label: 'db3306', mutate: (t) => replaceLine(t, 'DB_PORT', '3306'), reason: '3306' },
      { label: 'redis6379', mutate: (t) => replaceLine(t, 'REDIS_PORT', '6379'), reason: '6379' },
      {
        label: 'no-uuid',
        mutate: (t) => dropLine(t, 'ACCEPTANCE_MYSQL_SERVER_UUID'),
        reason: 'ACCEPTANCE_MYSQL_SERVER_UUID',
      },
      {
        label: 'external',
        mutate: (t) => `${t}\nRUN_REAL_AI_E2E=true\n`,
        reason: 'RUN_REAL_AI_E2E',
      },
    ];
    for (const variant of variants) {
      const { dir, file } = withConfigVariant(variant.label, variant.mutate);
      try {
        const run = runLauncher(['--config', file, '--phase', 'preflight-only']);
        expect(run.status).toBe(2);
        expect(run.output).toContain('PR0_ACCEPT_REFUSED=config');
        expect(run.output).not.toContain('PR0_ACCEPT_PRECHECK=ok');
        expect(run.output).not.toContain('PR0_ACCEPT_RUNNER=spawned');
        expect(run.output).toContain(variant.reason);
        console.log(`PR0_ACCEPT_REFUSAL_${variant.label}=config`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  itReal('新增必需运行键缺失或空白：config 阶段拒绝，未连接未 spawn', () => {
    for (const key of RUNTIME_KEYS) {
      const cases: Array<{ label: string; mutate: (text: string) => string }> = [
        { label: `missing-${key}`, mutate: (text) => dropLine(text, key) },
        { label: `blank-${key}`, mutate: (text) => replaceLine(text, key, '') },
      ];
      for (const variant of cases) {
        const { dir, file } = withConfigVariant(variant.label, variant.mutate);
        try {
          const run = runLauncher(['--config', file, '--phase', 'preflight-only']);
          expect(run.status).toBe(2);
          expect(run.output).toContain('PR0_ACCEPT_REFUSED=config');
          expect(run.output).toContain(key);
          expect(run.output).not.toContain('PR0_ACCEPT_PRECHECK=ok');
          expect(run.output).not.toContain('PR0_ACCEPT_RUNNER=spawned');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  itReal('加密参数长度或 AI 模式不合规：config 阶段拒绝，未连接未 spawn', () => {
    const variants: Array<{ label: string; mutate: (text: string) => string; reason: string }> = [
      {
        label: 'short-field-key',
        mutate: (text) => replaceLine(text, 'FIELD_ENCRYPTION_KEY', 'x'.repeat(15)),
        reason: 'FIELD_ENCRYPTION_KEY',
      },
      {
        label: 'short-field-iv',
        mutate: (text) => replaceLine(text, 'FIELD_ENCRYPTION_IV', 'x'.repeat(15)),
        reason: 'FIELD_ENCRYPTION_IV',
      },
      {
        label: 'ai-remote',
        mutate: (text) => replaceLine(text, 'AI_PROVIDER_MODE', 'remote'),
        reason: 'AI_PROVIDER_MODE',
      },
    ];
    for (const variant of variants) {
      const { dir, file } = withConfigVariant(variant.label, variant.mutate);
      try {
        const run = runLauncher(['--config', file, '--phase', 'preflight-only']);
        expect(run.status).toBe(2);
        expect(run.output).toContain('PR0_ACCEPT_REFUSED=config');
        expect(run.output).toContain(variant.reason);
        expect(run.output).not.toContain('PR0_ACCEPT_PRECHECK=ok');
        expect(run.output).not.toContain('PR0_ACCEPT_RUNNER=spawned');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  itReal('显式运行值与父环境不同：子环境及净化文件同源使用显式值', () => {
    const parentValues: Record<string, string> = {
      PAGINATION_HMAC_SECRET: 'parent-pagination-secret-not-used',
      FIELD_ENCRYPTION_KEY: 'parent-field-key-not-used',
      FIELD_ENCRYPTION_IV: 'parent-field-iv-not-used',
      AI_PROVIDER_MODE: 'remote',
    };
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(parentValues)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    const { dir, file } = withConfigVariant('runtime-same-source', (text) => text);
    try {
      const config = launcherModule.loadConfig(file);
      const bound = launcherModule.validateConfig(config);
      const dotenvFile = launcherModule.writeSanitizedDotenv(config, bound);
      const childEnv = launcherModule.buildChildEnv(config, bound, { group: 'core' }, dotenvFile);
      const dotenvText = fs.readFileSync(dotenvFile, 'utf8');

      for (const key of RUNTIME_KEYS) {
        const expected = key === 'AI_PROVIDER_MODE' ? 'mock' : (config.map[key] ?? '').trim();
        expect(expected).not.toBe('');
        expect(childEnv[key]).toBe(expected);
        expect(dotenvText).toContain(`${key}=${expected}`);
        expect(childEnv[key]).not.toBe(parentValues[key]);
      }
      expect(dotenvText).not.toContain('E2E_ALLOW_DB_CLEANUP');
      expect(dotenvText).not.toContain('E2E_SKIP_DB_CLEANUP');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itReal('父 shell 残留 DB/REDIS 绑定与配置冲突时拒绝，不发生隐式绑定', () => {
    const shellPort = readAcceptanceConfig()
      .match(/^DB_PORT=(.*)$/m)?.[1]
      ?.trim();
    if (!shellPort) {
      throw new Error('基线配置缺少 DB_PORT');
    }
    const run = runLauncher(['--config', ACCEPTANCE_CONFIG, '--phase', 'preflight-only'], {
      DB_PORT: shellPort === '3306' ? '3307' : '3306',
    });
    assertRefusedBeforeSideEffects(run, 'config');
    expect(run.output).toContain('父 shell 残留 DB_PORT');
  });

  itReal('真实只读预检：绑定配置实例成功且不 spawn runner', () => {
    const run = runLauncher(['--config', ACCEPTANCE_CONFIG, '--phase', 'preflight-only']);
    expect(run.status).toBe(0);
    expect(run.output).toContain('PR0_ACCEPT_PRECHECK=ok');
    expect(run.output).toContain('PR0_ACCEPT_PHASE=preflight-only');
    expect(run.output).not.toContain('PR0_ACCEPT_RUNNER=spawned');
    expect(run.output).not.toContain('DB_PASS');
    expect(run.output).not.toContain('REDIS_PASSWORD');
  });

  itReal('期望实例标识不符：preflight 阶段拒绝，未 spawn', () => {
    const { dir, file } = withConfigVariant('bad-uuid', (text) =>
      replaceLine(text, 'ACCEPTANCE_MYSQL_SERVER_UUID', '00000000-0000-0000-0000-000000000000'),
    );
    try {
      const run = runLauncher(['--config', file, '--phase', 'preflight-only']);
      expect(run.status).toBe(2);
      expect(run.output).toContain('PR0_ACCEPT_REFUSED=preflight');
      expect(run.output).not.toContain('PR0_ACCEPT_PRECHECK=ok');
      expect(run.output).not.toContain('PR0_ACCEPT_RUNNER=spawned');
      console.log('PR0_ACCEPT_REFUSAL_bad_uuid=preflight');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
