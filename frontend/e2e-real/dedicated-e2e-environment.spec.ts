// e2e-real/dedicated-e2e-environment.spec.ts
// @vitest-environment node
// 专用真实联调环境配置与 global setup 的防回退单测（R4 复核修正轮 P4）。
// 全部使用 mock runner（execFileSync / real-backend 模块），不连接真实数据库、
// 不依赖本地 backend env 文件（五项连接经进程环境显式提供）。
// 关键断言：任何失败关闭场景下 Migration/Seed/探针进程都绝不启动。

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMigrationChildEnv,
  buildSeedChildEnv,
  DB_TARGET_MUTATING_KEYS,
  DEDICATED_DB_CONNECTION_KEYS,
  DEDICATED_E2E_DB_NAME,
  DEDICATED_E2E_DB_NAME_DEFAULT,
  DEDICATED_E2E_DB_NAME_OVERRIDE_ENV,
  probeDedicatedDatabaseConnection,
  resolveDedicatedE2EDatabase,
  resolveDedicatedE2EDbName,
} from './dedicated-e2e-environment';
import globalSetup from './global-setup';

const {
  execFileSyncMock,
  assertPhysicalCleanupAllowedMock,
  acquireExecutionLockMock,
  readBackendEnvMock,
  releaseMock,
} = vi.hoisted(() => ({
  execFileSyncMock:
    vi.fn<
      (file: string, args: readonly string[], options?: { env?: Record<string, string> }) => string
    >(),
  assertPhysicalCleanupAllowedMock: vi.fn(),
  acquireExecutionLockMock: vi.fn<(dbName: string) => () => void>(),
  readBackendEnvMock: vi.fn<() => Record<string, string>>(),
  releaseMock: vi.fn<() => void>(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));

// 模拟 backend env 文件缺失：配置解析必须仅依赖进程环境，保证单测封闭性
// （真实环境中该文件是本地文件，缺失时进程环境提供完整五项即可解析）
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT: mocked missing backend env file');
  }),
}));

vi.mock('../e2e/helpers/real-backend', () => ({
  assertPhysicalCleanupAllowed: assertPhysicalCleanupAllowedMock,
  readBackendEnv: readBackendEnvMock,
}));

// 执行锁是本 spec 的纯副作用依赖：真实实现落在 os.tmpdir()，跨用例复用同一锁路径
// 会与 execution-lock.spec.ts 的真实多进程竞争互相干扰。此处只验证「先取锁、再跑
// 破坏性子进程、teardown 即释放」的调用顺序；并发与归属语义由
// e2e/helpers/execution-lock.spec.ts 真实多进程回归覆盖。
vi.mock('../e2e/helpers/execution-lock', () => ({
  acquireExecutionLock: acquireExecutionLockMock,
}));

const VALID_DB: Record<string, string> = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3331',
  DB_USER: 'e2e_user',
  DB_PASS: 'e2e-secret',
  DB_NAME: DEDICATED_E2E_DB_NAME,
};

const PROBE_OUTPUT = `${DEDICATED_E2E_DB_NAME}\t3331\tdb-host.example`;

// 测试涉及的全部进程环境键（含 globalSetup 会写入测试进程环境的五项 DB 键）
const MANAGED_ENV_KEYS = [
  ...DEDICATED_DB_CONNECTION_KEYS,
  ...DB_TARGET_MUTATING_KEYS,
  'MIGRATION_DRILL_ALLOW_NON_TEST_DB',
  'SEED_ALLOW_NON_TEST_DB',
  'E2E_ALLOW_PHYSICAL_CLEANUP',
  'E2E_BACKEND_ORIGIN',
  'npm_execpath',
] as const;

const originalEnvValues: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// npm 子进程调用与探针调用共用 execFileSync mock：按 file 参数分流返回值
function stubChildProcesses(): void {
  execFileSyncMock.mockImplementation((file: string) => (file === 'mysql' ? PROBE_OUTPUT : ''));
}

// 探针成功、指定 npm 脚本失败：用于验证「setup 中途失败也必须释放执行锁」
function stubChildProcessFailure(failingScript: string): void {
  execFileSyncMock.mockImplementation((file: string, args: readonly string[]) => {
    if (file === 'mysql') {
      return PROBE_OUTPUT;
    }

    if (args.includes(failingScript)) {
      throw new Error(`${failingScript} boom`);
    }

    return '';
  });
}

// 从 execFileSync 调用中提取 npm 子进程调用（排除 mysql 探针调用）
function childProcessCalls(): Array<{ file: string; args: string[]; env: Record<string, string> }> {
  return execFileSyncMock.mock.calls
    .filter(([file]) => file !== 'mysql')
    .map(([file, args, options]) => ({
      args: args as string[],
      env: (options as { env?: Record<string, string> } | undefined)?.env ?? {},
      file: file as string,
    }));
}

describe('专用库名解析（团队默认 + 受控本地覆盖）', () => {
  it('未声明覆盖时始终使用团队默认库', () => {
    expect(DEDICATED_E2E_DB_NAME_DEFAULT).toBe('lithography_e2e');
    expect(resolveDedicatedE2EDbName({})).toBe(DEDICATED_E2E_DB_NAME_DEFAULT);
  });

  it('空白覆盖按未声明处理', () => {
    expect(resolveDedicatedE2EDbName({ [DEDICATED_E2E_DB_NAME_OVERRIDE_ENV]: '   ' })).toBe(
      DEDICATED_E2E_DB_NAME_DEFAULT,
    );
  });

  it('白名单内的本地隔离库覆盖生效', () => {
    expect(
      resolveDedicatedE2EDbName({
        [DEDICATED_E2E_DB_NAME_OVERRIDE_ENV]: 'lithography_isolated_e2e',
      }),
    ).toBe('lithography_isolated_e2e');
  });

  it.each([
    ['开发库', 'lithography_drill'],
    ['业务库', 'lithography_platform'],
    ['缺少团队前缀', 'e2e_review'],
    ['形态不符', 'lithography_e2e_extra'],
  ])('%s（%s）覆盖被拒绝', (_label, value) => {
    expect(() =>
      resolveDedicatedE2EDbName({ [DEDICATED_E2E_DB_NAME_OVERRIDE_ENV]: value }),
    ).toThrow(DEDICATED_E2E_DB_NAME_OVERRIDE_ENV);
  });
});

describe('resolveDedicatedE2EDatabase 失败关闭校验', () => {
  beforeEach(() => {
    setEnv({
      ...VALID_DB,
      E2E_BACKEND_ORIGIN: 'http://127.0.0.1:3100',
      MIGRATION_DRILL_CREATE_TEMP_DB: undefined,
      MIGRATION_DRILL_DATABASE: undefined,
      MIGRATION_DRILL_DOTENV: undefined,
      SEED_DOTENV: undefined,
    });
  });

  it('外部 MIGRATION_DRILL_DATABASE 指向其他库时拒绝', () => {
    setEnv({ MIGRATION_DRILL_DATABASE: 'lithography_drill' });

    expect(() => resolveDedicatedE2EDatabase()).toThrow('MIGRATION_DRILL_DATABASE');
  });

  it('外部 MIGRATION_DRILL_CREATE_TEMP_DB=true 时拒绝', () => {
    setEnv({ MIGRATION_DRILL_CREATE_TEMP_DB: 'true' });

    expect(() => resolveDedicatedE2EDatabase()).toThrow('MIGRATION_DRILL_CREATE_TEMP_DB');
  });

  it.each([['MIGRATION_DRILL_DOTENV'], ['SEED_DOTENV']])(
    '外部设置 %s（第二套配置源）时拒绝',
    (key) => {
      setEnv({ [key]: 'env/.env.local-override' });

      expect(() => resolveDedicatedE2EDatabase()).toThrow('第二套 dotenv 配置源');
    },
  );

  it.each([
    ['DB_NAME 非专用库', { DB_NAME: 'lithography_platform' }, '必须以'],
    ['DB_HOST 为空', { DB_HOST: '   ' }, '配置不完整'],
    ['DB_USER 为空', { DB_USER: '' }, '配置不完整'],
    ['DB_PASS 为空', { DB_PASS: '' }, '配置不完整'],
    ['DB_PORT 非数字', { DB_PORT: 'http' }, '合法端口'],
    ['DB_PORT 超范围', { DB_PORT: '70000' }, '合法端口'],
  ])('%s 时拒绝', (_label, overrides, message) => {
    setEnv(overrides);

    expect(() => resolveDedicatedE2EDatabase()).toThrow(message);
  });

  it('密码不出现在任何校验失败错误文本中', () => {
    setEnv({ DB_PORT: 'http' });

    try {
      resolveDedicatedE2EDatabase();
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain(VALID_DB.DB_PASS);
    }
  });

  it('进程环境提供完整五项时无需本地 env 文件即可解析', () => {
    expect(resolveDedicatedE2EDatabase()).toEqual({
      host: VALID_DB.DB_HOST,
      name: DEDICATED_E2E_DB_NAME,
      pass: VALID_DB.DB_PASS,
      port: VALID_DB.DB_PORT,
      user: VALID_DB.DB_USER,
    });
  });
});

describe('破坏性子进程环境构造（删除继承值 + 显式统一连接）', () => {
  const baseEnv = {
    ...VALID_DB,
    MIGRATION_DRILL_CREATE_TEMP_DB: 'false',
    MIGRATION_DRILL_DOTENV: '',
    PATH: '/usr/bin',
    SEED_DOTENV: '',
  };
  const dedicated = {
    host: VALID_DB.DB_HOST,
    name: DEDICATED_E2E_DB_NAME,
    pass: VALID_DB.DB_PASS,
    port: VALID_DB.DB_PORT,
    user: VALID_DB.DB_USER,
  };

  it('Migration 子进程：删除继承的可变变量，显式锁定目标库并授权', () => {
    const env = buildMigrationChildEnv(baseEnv, dedicated);

    for (const key of DEDICATED_DB_CONNECTION_KEYS) {
      expect(env[key]).toBe(VALID_DB[key]);
    }
    expect(env.MIGRATION_DRILL_DATABASE).toBe(DEDICATED_E2E_DB_NAME);
    expect(env.MIGRATION_DRILL_CREATE_TEMP_DB).toBe('false');
    expect(env.MIGRATION_DRILL_ALLOW_NON_TEST_DB).toBe('true');
    expect(env).not.toHaveProperty('MIGRATION_DRILL_DOTENV');
    expect(env).not.toHaveProperty('SEED_DOTENV');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('Seed 子进程：与 Migration 完全相同的五项连接 + 自身授权，无任何 MIGRATION_DRILL 变量', () => {
    const env = buildSeedChildEnv(baseEnv, dedicated);

    for (const key of DEDICATED_DB_CONNECTION_KEYS) {
      expect(env[key]).toBe(VALID_DB[key]);
    }
    expect(env.SEED_ALLOW_NON_TEST_DB).toBe('true');
    expect(env).not.toHaveProperty('MIGRATION_DRILL_DATABASE');
    expect(env).not.toHaveProperty('MIGRATION_DRILL_CREATE_TEMP_DB');
    expect(env).not.toHaveProperty('MIGRATION_DRILL_ALLOW_NON_TEST_DB');
    expect(env).not.toHaveProperty('MIGRATION_DRILL_DOTENV');
    expect(env).not.toHaveProperty('SEED_DOTENV');
  });

  it('不修改调用方传入的 baseEnv（返回全新对象）', () => {
    const snapshot = { ...baseEnv };

    buildMigrationChildEnv(baseEnv, dedicated);
    buildSeedChildEnv(baseEnv, dedicated);

    expect(baseEnv).toEqual(snapshot);
  });
});

describe('只读连接探针', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  const database = {
    host: VALID_DB.DB_HOST,
    name: DEDICATED_E2E_DB_NAME,
    pass: VALID_DB.DB_PASS,
    port: VALID_DB.DB_PORT,
    user: VALID_DB.DB_USER,
  };

  it('探针经 mysql CLI 以 -h/-P/-u/<db> 连接且密码经 MYSQL_PWD 注入（不进入进程参数）', () => {
    execFileSyncMock.mockReturnValue(PROBE_OUTPUT);
    probeDedicatedDatabaseConnection(database);

    const [file, args, options] = execFileSyncMock.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    expect(file).toBe('mysql');
    expect(args).toEqual(
      expect.arrayContaining([
        '-h',
        database.host,
        '-P',
        database.port,
        '-ue2e_user',
        database.name,
      ]),
    );
    expect(args.join(' ')).not.toContain(VALID_DB.DB_PASS);
    expect(options.env?.MYSQL_PWD).toBe(VALID_DB.DB_PASS);
  });

  it('探针失败时 message 与 cause 均经脱敏，绝不包含密码原文', () => {
    let caught: unknown;

    try {
      probeDedicatedDatabaseConnection(database, () => {
        throw new Error(`access denied for user e2e_user (password: ${VALID_DB.DB_PASS})`);
      });
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      caught = error;
    }

    const probeError = caught as Error & { cause?: Error };
    expect(probeError).toBeInstanceOf(Error);
    expect(probeError.message).toContain('只读连接探针失败');
    // 底层错误原文中的密码必须被替换为 ***，而非原样进入错误文本
    expect(probeError.message).toContain('***');
    expect(probeError.message).not.toContain(VALID_DB.DB_PASS);
    // cause 是脱敏副本：同样不含密码原文
    expect(probeError.cause).toBeInstanceOf(Error);
    expect(probeError.cause?.message).toContain('***');
    expect(probeError.cause?.message).not.toContain(VALID_DB.DB_PASS);
  });

  it('探针返回其他数据库或端口不一致时拒绝', () => {
    expect(() =>
      probeDedicatedDatabaseConnection(database, () => 'lithography_drill\t3331\th'),
    ).toThrow('目标不一致');
    expect(() =>
      probeDedicatedDatabaseConnection(database, () => `${DEDICATED_E2E_DB_NAME}\t3306\th`),
    ).toThrow('目标不一致');
    expect(() => probeDedicatedDatabaseConnection(database, () => '')).toThrow('目标不一致');
  });
});

describe('globalSetup 防回退（mock runner，不连真实数据库）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    acquireExecutionLockMock.mockReset();
    acquireExecutionLockMock.mockReturnValue(releaseMock);
    releaseMock.mockReset();
    for (const key of MANAGED_ENV_KEYS) {
      originalEnvValues[key] = process.env[key];
    }
    setEnv({
      ...VALID_DB,
      E2E_BACKEND_ORIGIN: 'http://127.0.0.1:3100',
      MIGRATION_DRILL_CREATE_TEMP_DB: undefined,
      MIGRATION_DRILL_DATABASE: undefined,
      MIGRATION_DRILL_DOTENV: undefined,
      SEED_DOTENV: undefined,
      npm_execpath: '/path/to/node_modules/npm/bin/npm-cli.js',
    });
    stubChildProcesses();
    readBackendEnvMock.mockReturnValue({ ...VALID_DB });
  });

  afterAll(() => {
    setEnv(originalEnvValues);
  });

  it('happy path：探针 + Migration + Seed 依次启动，且两者收到完全相同的五项连接', () => {
    expect(() => globalSetup()).not.toThrow();

    const calls = childProcessCalls();
    expect(calls).toHaveLength(2);

    const [migration, seed] = calls;
    expect(migration.args).toEqual([
      '/path/to/node_modules/npm/bin/npm-cli.js',
      'run',
      'migration:drill:empty-db',
    ]);
    expect(seed.args).toEqual(['/path/to/node_modules/npm/bin/npm-cli.js', 'run', 'seed:mock']);

    for (const key of DEDICATED_DB_CONNECTION_KEYS) {
      expect(migration.env[key]).toBe(VALID_DB[key]);
      expect(seed.env[key]).toBe(VALID_DB[key]);
      expect(migration.env[key]).toBe(seed.env[key]);
    }
  });

  it('执行锁先于探针与破坏性子进程获取，且返回值即释放锁的 teardown', () => {
    const order: string[] = [];

    acquireExecutionLockMock.mockImplementation(() => {
      order.push('acquire-lock');

      return () => {
        order.push('release-lock');
      };
    });
    execFileSyncMock.mockImplementation((file: string) => {
      order.push(file === 'mysql' ? 'probe' : 'destructive-child');

      return file === 'mysql' ? PROBE_OUTPUT : '';
    });

    const teardown = globalSetup();

    // 取锁必须先于只读探针，探针必须先于两个破坏性子进程（Migration → Seed）
    expect(order).toEqual(['acquire-lock', 'probe', 'destructive-child', 'destructive-child']);
    // 锁按专用库名获取：两条链路只有命中同一把锁才可能互斥
    expect(acquireExecutionLockMock).toHaveBeenCalledExactlyOnceWith(DEDICATED_E2E_DB_NAME);

    // 未启动 teardown 时绝不提前释放锁：破坏性窗口全程持锁
    expect(releaseMock).not.toHaveBeenCalled();

    teardown();
    expect(order.at(-1)).toBe('release-lock');
  });

  it('DB_NAME 不是专用库时不启动任何子进程（含探针）', () => {
    setEnv({ DB_NAME: 'lithography_platform' });

    expect(() => globalSetup()).toThrow('必须以');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['MIGRATION_DRILL_DATABASE 指向其他库', { MIGRATION_DRILL_DATABASE: 'lithography_drill' }],
    ['MIGRATION_DRILL_CREATE_TEMP_DB=true', { MIGRATION_DRILL_CREATE_TEMP_DB: 'true' }],
    ['外部 MIGRATION_DRILL_DOTENV', { MIGRATION_DRILL_DOTENV: 'env/.env.local' }],
    ['外部 SEED_DOTENV', { SEED_DOTENV: 'env/.env.local' }],
    ['DB_HOST 非法', { DB_HOST: '' }],
    ['DB_PORT 非法', { DB_PORT: 'not-a-port' }],
  ])('%s 时失败关闭：不启动任何子进程', (_label, overrides) => {
    setEnv(overrides);

    expect(() => globalSetup()).toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('物理清理授权门先于一切子进程（授权门抛错时探针与 npm 均不启动）', () => {
    assertPhysicalCleanupAllowedMock.mockImplementationOnce(() => {
      throw new Error('物理清理被拒绝');
    });

    expect(() => globalSetup()).toThrow('物理清理被拒绝');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('npm_execpath 缺失时在启动子进程前明确失败（探针可先通过）', () => {
    setEnv({ npm_execpath: undefined });
    // npm_execpath 缺失属于启动形态问题，配置与探针不受影响；但 npm 子进程绝不启动
    expect(() => globalSetup()).toThrow('npm_execpath');

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe('mysql');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('模拟 Windows npm CLI 路径：以 process.execPath + npm_execpath 构造参数', () => {
    setEnv({ npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' });

    expect(() => globalSetup()).not.toThrow();

    const [migration] = childProcessCalls();
    expect(migration.file).toBe(process.execPath);
    expect(migration.args[0]).toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
    expect(migration.args.slice(1)).toEqual(['run', 'migration:drill:empty-db']);
  });

  it('只读探针失败时 Migration/Seed 均不得启动，且释放已获取的执行锁', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('connect timeout');
    });

    expect(() => globalSetup()).toThrow('只读连接探针失败');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // setup 抛错时 Playwright 不会调用返回值，必须自行释放，否则锁永久残留
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('只读探针返回其他数据库时 Migration/Seed 均不得启动', () => {
    execFileSyncMock.mockImplementation((file: string) =>
      file === 'mysql' ? 'lithography_drill\t3331\tdb-host.example' : '',
    );

    expect(() => globalSetup()).toThrow('目标不一致');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('globalSetup 将完整五项连接写入测试进程环境（SQL helper 读取同一份值）', () => {
    expect(() => globalSetup()).not.toThrow();

    for (const key of DEDICATED_DB_CONNECTION_KEYS) {
      expect(process.env[key]).toBe(VALID_DB[key]);
    }
  });

  it('SQL helper 配置与专用配置不一致时拒绝启动', () => {
    readBackendEnvMock.mockReturnValue({ ...VALID_DB, DB_NAME: 'lithography_drill' });

    expect(() => globalSetup()).toThrow('配置不一致');
    expect(execFileSyncMock).not.toHaveBeenCalled();
    // 取锁之后才做一致性校验，故此处同样必须释放
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('执行锁被占用（acquire 抛错）时机制不变：错误原样抛出，无需释放', () => {
    acquireExecutionLockMock.mockImplementationOnce(() => {
      throw new Error('已有真实联调在执行');
    });

    expect(() => globalSetup()).toThrow('已有真实联调在执行');
    // 未取到锁，不得调用释放（否则会删掉他人的锁）
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it.each([['migration:drill:empty-db'], ['seed:mock']])(
    '%s 失败时原样抛出原因，并释放执行锁恰好一次',
    (script) => {
      stubChildProcessFailure(script);

      expect(() => globalSetup()).toThrow(`${script} boom`);
      expect(releaseMock).toHaveBeenCalledTimes(1);
    },
  );

  it('setup 与释放锁同时失败时抛 AggregateError，并同时保留两个原因', () => {
    stubChildProcessFailure('seed:mock');
    releaseMock.mockImplementation(() => {
      throw new Error('release boom');
    });

    let caught: unknown;

    try {
      globalSetup();
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const reasons = (caught as AggregateError).errors as unknown as Error[];
    expect(reasons.map((error) => error.message)).toEqual(['seed:mock boom', 'release boom']);
    // 释放只尝试一次，不因失败而重试
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
