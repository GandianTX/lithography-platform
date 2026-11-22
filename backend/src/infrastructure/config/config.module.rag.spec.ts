// src/infrastructure/config/config.module.rag.spec.ts
// P2-04 定向验证：用隔离子进程 + 合成生产变量加载真实 AppConfigModule。
//
// 覆盖：
// - 显式 disabled 时，无 RAG 配置、仅有残留 URL、残留非法超时／布尔值都能启动，且不解析 RAG 参数；
// - remote 完整配置可启动并正确解析；未设置模式保留既有 remote 默认；
// - remote 缺密钥、未设置模式只有 URL、非法模式／超时／布尔值按生产预检拒绝。
//
// 隔离与脱敏（配置测试隔离补修）：
// - 每次子进程都运行在 mkdtempSync 创建的独占临时 cwd，避免 cwd 下的 env/.env.production 污染配置；
// - 子进程只输出固定协议：状态、字段名与匹配布尔值，不打印配置对象、异常或环境；
// - 父进程错误信息只保留状态、信号、错误码与字段名，不转发子进程原始输出。
//
// 子进程只读取合成变量，不连接数据库、Redis 或任何真实服务。

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

jest.setTimeout(180_000);

const BACKEND_ROOT = resolve(__dirname, '..', '..', '..');
const BACKEND_PACKAGE = join(BACKEND_ROOT, 'package.json');
const BACKEND_TSCONFIG = join(BACKEND_ROOT, 'tsconfig.json');
const PROTOCOL_PREFIX = 'RAG_CONFIG_CHILD:';

/** 从后端 package.json 锚定依赖解析，避免新 cwd 下解析失败。 */
const backendRequire = createRequire(BACKEND_PACKAGE);

const resolveBackendDependency = (id: string): string => backendRequire.resolve(id);

interface TsconfigPaths {
  readonly baseUrl: string;
  readonly paths: Readonly<Record<string, readonly string[]>>;
}

const readTsconfigPaths = (): TsconfigPaths => {
  const parsed = JSON.parse(readFileSync(BACKEND_TSCONFIG, 'utf8')) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  const baseUrl = parsed.compilerOptions?.baseUrl ?? '.';
  return {
    baseUrl: isAbsolute(baseUrl) ? baseUrl : join(BACKEND_ROOT, baseUrl),
    paths: parsed.compilerOptions?.paths ?? {},
  };
};

const TSCONFIG_PATHS = readTsconfigPaths();

const CHILD_PATHS = {
  reflectMetadata: resolveBackendDependency('reflect-metadata'),
  tsNodeRegister: resolveBackendDependency('ts-node/register/transpile-only'),
  tsConfigPaths: resolveBackendDependency('tsconfig-paths'),
  testing: resolveBackendDependency('@nestjs/testing'),
  config: resolveBackendDependency('@nestjs/config'),
  configModule: join(BACKEND_ROOT, 'src', 'infrastructure', 'config', 'config.module.ts'),
};

/**
 * 子进程脚本：读取 payload 文件，按绝对路径注册 ts-node／路径别名，
 * 加载真实 AppConfigModule，并把结果压缩成不含敏感值的协议行。
 */
const CHILD_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const emit = (payload) => { process.stdout.write('RAG_CONFIG_CHILD:' + JSON.stringify(payload) + '\\n'); };",
  'const main = async () => {',
  '  let payload;',
  "  try { payload = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); }",
  "  catch { emit({ status: 'payload-error' }); process.exitCode = 10; return; }",
  '  try {',
  '    require(payload.paths.reflectMetadata);',
  '    require(payload.paths.tsNodeRegister);',
  '    require(payload.paths.tsConfigPaths).register({ baseUrl: payload.tsconfig.baseUrl, paths: payload.tsconfig.paths });',
  '  } catch (error) {',
  "    emit({ status: 'register-error', errorName: (error && error.name) || 'Error' }); process.exitCode = 11; return;",
  '  }',
  '  let AppConfigModule;',
  '  try { AppConfigModule = require(payload.paths.configModule).AppConfigModule; }',
  '  catch (error) {',
  '    if (payload.expectPrecheck) {',
  "      const matched = typeof error?.message === 'string' && error.message.includes(payload.expectPrecheck);",
  "      emit({ status: 'precheck', matched }); process.exitCode = matched ? 0 : 12; return;",
  '    }',
  "    emit({ status: 'import-error', errorName: (error && error.name) || 'Error' }); process.exitCode = 13; return;",
  '  }',
  '  const { Test } = require(payload.paths.testing);',
  '  const { ConfigService } = require(payload.paths.config);',
  '  let moduleRef;',
  '  try { moduleRef = await Test.createTestingModule({ imports: [AppConfigModule] }).compile(); }',
  '  catch (error) {',
  '    if (payload.expectPrecheck) {',
  "      const matched = typeof error?.message === 'string' && error.message.includes(payload.expectPrecheck);",
  "      emit({ status: 'precheck', matched }); process.exitCode = matched ? 0 : 14; return;",
  '    }',
  "    emit({ status: 'start-error', errorName: (error && error.name) || 'Error' }); process.exitCode = 15; return;",
  '  }',
  '  try {',
  '    if (payload.expectPrecheck) {',
  "      emit({ status: 'started-unexpected' }); process.exitCode = 16; return;",
  '    }',
  "    const actual = moduleRef.get(ConfigService).get('ragDiagnosis');",
  '    const expected = payload.expected;',
  '    const matches = {',
  '      mode: Boolean(actual) && actual.mode === expected.mode,',
  '      baseUrl: Boolean(actual) && actual.baseUrl === expected.baseUrl,',
  '      apiKey: Boolean(actual) && actual.apiKey === expected.apiKey,',
  '      allowInsecureHttp: Boolean(actual) && actual.allowInsecureHttp === expected.allowInsecureHttp,',
  '      timeoutMs: Boolean(actual) && actual.timeoutMs === expected.timeoutMs,',
  '    };',
  '    emit({',
  "      status: 'started',",
  '      matches,',
  "      envFilePresentInCwd: fs.existsSync(path.join(process.cwd(), 'env', '.env.production')),",
  '      cwdIsBackendRoot: path.resolve(process.cwd()) === path.resolve(payload.backendRoot),',
  '    });',
  '    process.exitCode = Object.values(matches).every(Boolean) ? 0 : 17;',
  '  } catch (error) {',
  "    emit({ status: 'inspect-error', errorName: (error && error.name) || 'Error' }); process.exitCode = 18;",
  '  } finally {',
  '    await moduleRef.close();',
  '  }',
  '};',
  "main().catch((error) => { emit({ status: 'fatal', errorName: (error && error.name) || 'Error' }); process.exitCode = 99; });",
].join('\n');

/** 仅满足生产必填与格式校验的最小合成变量，不含任何真实凭据。 */
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  TS_NODE_PROJECT: BACKEND_TSCONFIG,
  TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}',
  APP_HOST: '127.0.0.1',
  APP_PORT: '3000',
  APP_CORS_ENABLED: 'false',
  APP_CORS_CREDENTIALS: 'false',
  GRAPHQL_SANDBOX_ENABLED: 'false',
  GRAPHQL_INTROSPECTION_ENABLED: 'false',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'synthetic',
  DB_PASS: 'synthetic',
  DB_NAME: 'synthetic',
  DB_SYNCHRONIZE: 'false',
  DB_LOGGING: 'false',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_DB: '0',
  REDIS_TLS: 'false',
  BULLMQ_PREFIX: 'synthetic',
  JWT_SECRET: 'synthetic-jwt-secret',
  JWT_ENABLE_REFRESH: 'false',
  PAGINATION_HMAC_SECRET: 'synthetic-pagination-secret',
  FIELD_ENCRYPTION_KEY: 'synthetic-field-key-32-bytes-long',
  FIELD_ENCRYPTION_IV: 'synthetic-field-iv',
  AI_PROVIDER_MODE: 'mock',
  AI_QUEUE_DEBUG_ENABLED: 'false',
  EMAIL_QUEUE_DEBUG_ENABLED: 'false',
};

/** 只给最小系统变量；不继承宿主 process.env，避免外部 dotenv／NODE_OPTIONS 等干扰。 */
const buildChildEnv = (extra: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv => ({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: homeDir,
  ...BASE_ENV,
  ...extra,
});

interface RagConfigExpectation {
  readonly mode: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly allowInsecureHttp: boolean;
  readonly timeoutMs: number;
}

type MatchKey = 'mode' | 'baseUrl' | 'apiKey' | 'allowInsecureHttp' | 'timeoutMs';

interface StartedProtocol {
  readonly status: 'started';
  readonly matches: Readonly<Record<MatchKey, boolean>>;
  readonly envFilePresentInCwd: boolean;
  readonly cwdIsBackendRoot: boolean;
}

interface PrecheckProtocol {
  readonly status: 'precheck';
  readonly matched: boolean;
}

interface OtherProtocol {
  readonly status:
    | 'payload-error'
    | 'register-error'
    | 'import-error'
    | 'start-error'
    | 'started-unexpected'
    | 'inspect-error'
    | 'fatal';
  readonly errorName?: string;
}

type ChildProtocol = StartedProtocol | PrecheckProtocol | OtherProtocol;

interface ChildRunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly errorCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly protocol: ChildProtocol | null;
}

interface RunOptions {
  readonly expected?: RagConfigExpectation;
  readonly expectPrecheck?: string;
  /** 仅用于隔离因果链探针；普通用例必须留空，由用例创建独占临时 cwd。 */
  readonly cwd?: string;
}

const parseProtocol = (stdout: string): ChildProtocol | null => {
  const line = stdout.split('\n').find((item) => item.startsWith(PROTOCOL_PREFIX));
  if (!line) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed as ChildProtocol;
  } catch {
    return null;
  }
};

const readErrorCode = (error: Error | undefined): string | null => {
  if (!error) {
    return null;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

const runConfigChild = (extraEnv: NodeJS.ProcessEnv, options: RunOptions = {}): ChildRunResult => {
  const childCwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'rag-config-spec-'));
  const ownedCwd = options.cwd === undefined ? childCwd : null;
  try {
    const payloadPath = join(childCwd, 'payload.json');
    writeFileSync(
      payloadPath,
      JSON.stringify({
        paths: CHILD_PATHS,
        tsconfig: TSCONFIG_PATHS,
        backendRoot: BACKEND_ROOT,
        expected: options.expected ?? null,
        expectPrecheck: options.expectPrecheck ?? null,
      }),
      'utf8',
    );

    const result = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, payloadPath], {
      cwd: childCwd,
      env: buildChildEnv(extraEnv, childCwd),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const errorCode = readErrorCode(result.error);

    return {
      status: result.status,
      signal: result.signal,
      errorCode,
      stdout,
      stderr,
      protocol: parseProtocol(stdout),
    };
  } finally {
    if (ownedCwd) {
      rmSync(ownedCwd, { recursive: true, force: true });
    }
  }
};

const describeRun = (result: ChildRunResult): string =>
  `status=${result.status === null ? 'null' : result.status} signal=${
    result.signal === null ? 'none' : result.signal
  } errorCode=${result.errorCode ?? 'none'} protocol=${
    result.protocol === null ? 'missing' : result.protocol.status
  }`;

const readStarted = (result: ChildRunResult): StartedProtocol => {
  if (result.protocol === null || result.protocol.status !== 'started') {
    throw new Error(`RAG 配置子进程未按协议启动（${describeRun(result)}）`);
  }
  return result.protocol;
};

const readPrecheck = (result: ChildRunResult): PrecheckProtocol => {
  if (result.protocol === null || result.protocol.status !== 'precheck') {
    throw new Error(`RAG 配置子进程未命中生产预检（${describeRun(result)}）`);
  }
  return result.protocol;
};

const ALL_MATCHED: Readonly<Record<MatchKey, boolean>> = {
  mode: true,
  baseUrl: true,
  apiKey: true,
  allowInsecureHttp: true,
  timeoutMs: true,
};

/** 断言正常启动，并保证没有回退到后端根目录或带 env 文件的 cwd。 */
const expectStarted = (result: ChildRunResult): StartedProtocol => {
  const started = readStarted(result);
  expect(result.status).toBe(0);
  expect(result.signal).toBeNull();
  expect(started.matches).toEqual(ALL_MATCHED);
  expect(started.envFilePresentInCwd).toBe(false);
  expect(started.cwdIsBackendRoot).toBe(false);
  return started;
};

/** 断言退出码为 0 且命中了预期的生产预检分类。 */
const expectPrecheckRejected = (result: ChildRunResult): PrecheckProtocol => {
  const precheck = readPrecheck(result);
  expect(result.status).toBe(0);
  expect(result.signal).toBeNull();
  expect(precheck.matched).toBe(true);
  return precheck;
};

/** 用布尔结果检查泄漏，失败时只显示 true／false，不把合成值放进断言 diff。 */
const assertNoSecretLeak = (result: ChildRunResult, secrets: readonly string[]): void => {
  for (const secret of secrets) {
    expect(result.stdout.includes(secret)).toBe(false);
    expect(result.stderr.includes(secret)).toBe(false);
  }
};

const SYNTHETIC_URL = 'https://rag.synthetic.invalid';
const SYNTHETIC_KEY = 'synthetic-rag-key';
const SYNTHETIC_QWEN_URL = 'https://qwen.synthetic.invalid';
const SYNTHETIC_QWEN_KEY = 'synthetic-qwen-key';
const SYNTHETIC_OPENAI_URL = 'https://openai.synthetic.invalid';
const SYNTHETIC_OPENAI_KEY = 'synthetic-openai-key';
const REMOTE_PROVIDER_REJECT_MESSAGE =
  'AI_PROVIDER_MODE=remote requires at least one remote provider config: LITHO_RAG_*, QWEN_* or OPENAI_*';

const DISABLED_EXPECTED: RagConfigExpectation = {
  mode: 'disabled',
  baseUrl: '',
  apiKey: '',
  allowInsecureHttp: false,
  timeoutMs: 30000,
};

describe('AppConfigModule 的 RAG 生产配置入口', () => {
  it.each<[string, NodeJS.ProcessEnv, RagConfigExpectation]>([
    ['disabled 且无 RAG 配置', { LITHO_RAG_MODE: 'disabled' }, DISABLED_EXPECTED],
    [
      'disabled 且只有残留 URL',
      { LITHO_RAG_MODE: 'disabled', LITHO_RAG_BASE_URL: SYNTHETIC_URL },
      DISABLED_EXPECTED,
    ],
    [
      'disabled 且残留非法超时与布尔值',
      {
        LITHO_RAG_MODE: 'disabled',
        LITHO_RAG_TIMEOUT_MS: 'not-a-number',
        LITHO_RAG_ALLOW_TAILNET_HTTP: 'maybe',
      },
      DISABLED_EXPECTED,
    ],
    [
      '未设置模式且无 RAG 配置时保留 remote 默认',
      {},
      {
        mode: 'remote',
        baseUrl: '',
        apiKey: '',
        allowInsecureHttp: false,
        timeoutMs: 30000,
      },
    ],
    [
      'remote 完整配置',
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: SYNTHETIC_URL,
        LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        LITHO_RAG_TIMEOUT_MS: '15000',
        LITHO_RAG_ALLOW_TAILNET_HTTP: 'true',
      },
      {
        mode: 'remote',
        baseUrl: SYNTHETIC_URL,
        apiKey: SYNTHETIC_KEY,
        allowInsecureHttp: true,
        timeoutMs: 15000,
      },
    ],
    [
      '未设置模式但 URL 与密钥齐全',
      {
        LITHO_RAG_BASE_URL: SYNTHETIC_URL,
        LITHO_RAG_API_KEY: SYNTHETIC_KEY,
      },
      {
        mode: 'remote',
        baseUrl: SYNTHETIC_URL,
        apiKey: SYNTHETIC_KEY,
        allowInsecureHttp: false,
        timeoutMs: 30000,
      },
    ],
  ])('%s 时进程可启动且配置正确', (_title, extra, expected) => {
    const result = runConfigChild(extra, { expected });
    expectStarted(result);
    assertNoSecretLeak(result, [SYNTHETIC_URL, SYNTHETIC_KEY]);
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    [
      'remote 有 URL 但缺密钥',
      { LITHO_RAG_MODE: 'remote', LITHO_RAG_BASE_URL: SYNTHETIC_URL },
      'LITHO_RAG_MODE=remote requires LITHO_RAG_BASE_URL and LITHO_RAG_API_KEY',
    ],
    [
      '未设置模式但只有 URL',
      { LITHO_RAG_BASE_URL: SYNTHETIC_URL },
      'LITHO_RAG_BASE_URL and LITHO_RAG_API_KEY must be configured together',
    ],
    ['非法模式', { LITHO_RAG_MODE: 'bogus' }, 'LITHO_RAG_MODE must be either disabled or remote'],
    [
      'remote 非法超时',
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: SYNTHETIC_URL,
        LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        LITHO_RAG_TIMEOUT_MS: 'not-a-number',
      },
      'LITHO_RAG_TIMEOUT_MS must be an integer',
    ],
    [
      'remote 非法私网开关',
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: SYNTHETIC_URL,
        LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        LITHO_RAG_ALLOW_TAILNET_HTTP: 'maybe',
      },
      'LITHO_RAG_ALLOW_TAILNET_HTTP must be a boolean-like value',
    ],
  ])('%s 时按生产预检拒绝启动', (_title, extra, message) => {
    const result = runConfigChild(extra, { expectPrecheck: message });
    expectPrecheckRejected(result);
    assertNoSecretLeak(result, [SYNTHETIC_URL, SYNTHETIC_KEY]);
  });

  // AI_PROVIDER_MODE=remote 的远程来源三选一回归：
  // 完整启用的 RAG、完整 Qwen、完整 OpenAI 任一即可满足远程来源检查。
  // 子进程环境只由 PATH/HOME/BASE_ENV/extra 合成，天然不含宿主 QWEN_*/OPENAI_*；
  // RAG-only 用例再显式置空这四个键，保证隔离与语义双重明确。
  const EMPTY_LEGACY_PROVIDER_ENV: NodeJS.ProcessEnv = {
    QWEN_BASE_URL: '',
    QWEN_API_KEY: '',
    OPENAI_BASE_URL: '',
    OPENAI_API_KEY: '',
  };
  const REMOTE_MODE: NodeJS.ProcessEnv = { AI_PROVIDER_MODE: 'remote' };
  const RAG_ONLY_EXPECTED: RagConfigExpectation = {
    mode: 'remote',
    baseUrl: SYNTHETIC_URL,
    apiKey: SYNTHETIC_KEY,
    allowInsecureHttp: false,
    timeoutMs: 30000,
  };

  describe('AI_PROVIDER_MODE=remote 的远程来源判定', () => {
    it.each<[string, NodeJS.ProcessEnv, RagConfigExpectation]>([
      [
        '生产仅配置完整 RAG（显式排除 Qwen／OpenAI）',
        {
          ...REMOTE_MODE,
          ...EMPTY_LEGACY_PROVIDER_ENV,
          LITHO_RAG_MODE: 'remote',
          LITHO_RAG_BASE_URL: SYNTHETIC_URL,
          LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        },
        RAG_ONLY_EXPECTED,
      ],
      [
        '未设置 RAG 模式时按 remote 默认视为合格来源',
        {
          ...REMOTE_MODE,
          ...EMPTY_LEGACY_PROVIDER_ENV,
          LITHO_RAG_BASE_URL: SYNTHETIC_URL,
          LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        },
        RAG_ONLY_EXPECTED,
      ],
      [
        'RAG 与 Qwen 同时配置',
        {
          ...REMOTE_MODE,
          QWEN_BASE_URL: SYNTHETIC_QWEN_URL,
          QWEN_API_KEY: SYNTHETIC_QWEN_KEY,
          LITHO_RAG_BASE_URL: SYNTHETIC_URL,
          LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        },
        RAG_ONLY_EXPECTED,
      ],
      [
        '仅完整 Qwen',
        { ...REMOTE_MODE, QWEN_BASE_URL: SYNTHETIC_QWEN_URL, QWEN_API_KEY: SYNTHETIC_QWEN_KEY },
        { ...RAG_ONLY_EXPECTED, baseUrl: '', apiKey: '' },
      ],
      [
        '仅完整 OpenAI',
        {
          ...REMOTE_MODE,
          OPENAI_BASE_URL: SYNTHETIC_OPENAI_URL,
          OPENAI_API_KEY: SYNTHETIC_OPENAI_KEY,
        },
        { ...RAG_ONLY_EXPECTED, baseUrl: '', apiKey: '' },
      ],
    ])('%s 时生产进程可启动', (_title, extra, expected) => {
      const result = runConfigChild(extra, { expected });
      expectStarted(result);
      assertNoSecretLeak(result, [SYNTHETIC_URL, SYNTHETIC_KEY]);
    });

    it('AI_PROVIDER_MODE=mock 时无任何远程来源仍可启动（mock 路由不变）', () => {
      // mock 路由下 RAG 配置按默认 remote 解析且 URL／Key 均为空，不应阻断启动。
      const result = runConfigChild(EMPTY_LEGACY_PROVIDER_ENV, {
        expected: { ...RAG_ONLY_EXPECTED, baseUrl: '', apiKey: '' },
      });
      expectStarted(result);
    });

    it.each<[string, NodeJS.ProcessEnv]>([
      [
        'RAG 显式 disabled 但残留 URL／Key 且无 Qwen／OpenAI',
        {
          ...REMOTE_MODE,
          LITHO_RAG_MODE: 'disabled',
          LITHO_RAG_BASE_URL: SYNTHETIC_URL,
          LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        },
      ],
      ['RAG 与旧供应商均未配置', { ...REMOTE_MODE, ...EMPTY_LEGACY_PROVIDER_ENV }],
      [
        'RAG URL 与密钥均为纯空白（按未配置处理）',
        {
          ...REMOTE_MODE,
          ...EMPTY_LEGACY_PROVIDER_ENV,
          LITHO_RAG_BASE_URL: '   ',
          LITHO_RAG_API_KEY: '   ',
        },
      ],
    ])('%s 时按生产预检拒绝启动', (_title, extra) => {
      const result = runConfigChild(extra, { expectPrecheck: REMOTE_PROVIDER_REJECT_MESSAGE });
      expectPrecheckRejected(result);
      assertNoSecretLeak(result, [SYNTHETIC_URL, SYNTHETIC_KEY]);
    });

    it.each<[string, NodeJS.ProcessEnv]>([
      [
        '显式 remote RAG 缺密钥但 Qwen 完整',
        {
          ...REMOTE_MODE,
          QWEN_BASE_URL: SYNTHETIC_QWEN_URL,
          QWEN_API_KEY: SYNTHETIC_QWEN_KEY,
          LITHO_RAG_MODE: 'remote',
          LITHO_RAG_BASE_URL: SYNTHETIC_URL,
        },
      ],
      [
        '显式 remote RAG 缺地址但 OpenAI 完整',
        {
          ...REMOTE_MODE,
          OPENAI_BASE_URL: SYNTHETIC_OPENAI_URL,
          OPENAI_API_KEY: SYNTHETIC_OPENAI_KEY,
          LITHO_RAG_MODE: 'remote',
          LITHO_RAG_API_KEY: SYNTHETIC_KEY,
        },
      ],
    ])('%s 时仍被 RAG 独立校验拒绝', (_title, extra) => {
      const result = runConfigChild(extra, {
        expectPrecheck: 'LITHO_RAG_MODE=remote requires LITHO_RAG_BASE_URL and LITHO_RAG_API_KEY',
      });
      expectPrecheckRejected(result);
      assertNoSecretLeak(result, [SYNTHETIC_URL, SYNTHETIC_KEY]);
    });
  });

  it('生产路径使用空隔离目录，不读取后端根目录的 env 文件', () => {
    const result = runConfigChild({ LITHO_RAG_MODE: 'disabled' }, { expected: DISABLED_EXPECTED });
    const started = expectStarted(result);
    // 正常路径必须落在独占临时目录：既不是后端根目录，也没有 env/.env.production。
    expect(started.cwdIsBackendRoot).toBe(false);
    expect(started.envFilePresentInCwd).toBe(false);
  });

  it('cwd 中的 env/.env.production 会污染配置，证明隔离必需且输出不含标记', () => {
    const markerUrl = 'https://file-marker.invalid';
    const markerKey = 'synthetic-file-marker';
    const pollutedCwd = mkdtempSync(join(tmpdir(), 'rag-config-polluted-'));
    try {
      mkdirSync(join(pollutedCwd, 'env'));
      writeFileSync(
        join(pollutedCwd, 'env', '.env.production'),
        `LITHO_RAG_BASE_URL=${markerUrl}\nLITHO_RAG_API_KEY=${markerKey}\n`,
        'utf8',
      );

      const result = runConfigChild(
        {},
        {
          expected: {
            mode: 'remote',
            baseUrl: '',
            apiKey: '',
            allowInsecureHttp: false,
            timeoutMs: 30000,
          },
          cwd: pollutedCwd,
        },
      );

      // 文件被加载时，脱敏协议应暴露不匹配；若隔离失效而仍用文件 cwd，本断言会失败。
      const started = readStarted(result);
      expect(started.envFilePresentInCwd).toBe(true);
      expect(started.matches.baseUrl).toBe(false);
      expect(started.matches.apiKey).toBe(false);
      expect(result.status).not.toBe(0);
      assertNoSecretLeak(result, [markerUrl, markerKey]);
    } finally {
      rmSync(pollutedCwd, { recursive: true, force: true });
    }
  });

  it('合成 URL／密钥只以匹配布尔值回传，成功输出不含原值', () => {
    const redactionUrl = 'https://redaction-probe.invalid';
    const redactionKey = 'redaction-probe-api-key';
    const result = runConfigChild(
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: redactionUrl,
        LITHO_RAG_API_KEY: redactionKey,
      },
      {
        expected: {
          mode: 'remote',
          baseUrl: redactionUrl,
          apiKey: redactionKey,
          allowInsecureHttp: false,
          timeoutMs: 30000,
        },
      },
    );

    expectStarted(result);
    assertNoSecretLeak(result, [redactionUrl, redactionKey]);
  });

  it('期望值不一致时按字段名失败，失败输出与诊断信息均不含原值', () => {
    const redactionUrl = 'https://redaction-probe.invalid';
    const redactionKey = 'redaction-probe-api-key';
    const result = runConfigChild(
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: redactionUrl,
        LITHO_RAG_API_KEY: redactionKey,
      },
      {
        expected: {
          mode: 'remote',
          baseUrl: '',
          apiKey: '',
          allowInsecureHttp: false,
          timeoutMs: 30000,
        },
      },
    );

    const started = readStarted(result);
    expect(started.matches.baseUrl).toBe(false);
    expect(started.matches.apiKey).toBe(false);
    expect(result.status).not.toBe(0);
    assertNoSecretLeak(result, [redactionUrl, redactionKey]);

    let diagnostic = '';
    try {
      expectStarted(result);
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : '';
    }
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic.includes(redactionUrl)).toBe(false);
    expect(diagnostic.includes(redactionKey)).toBe(false);
  });
});
