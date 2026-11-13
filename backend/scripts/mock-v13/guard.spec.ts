// scripts/mock-v13/guard.spec.ts

/**
 * 离线守卫测试：只验证“是否允许连接/写入”的判定，不连接任何数据库。
 * 覆盖 A5（错库/错实例/非白名单拒绝）与凭据目录约束。
 */

/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GuardViolationError, exitCodeOf } from './errors';
import {
  MockV13CliOptions,
  MockV13Env,
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  WRITE_ACK_PHRASE,
  assertCredentialsPathOutsideRepository,
  assertGuardConfig,
  assertMockDirectories,
  assertOutputPathVacant,
  assertSchemaColumns,
  assertSchemaTables,
  assertTargetFacts,
  parseCliArgs,
  parseMockEnv,
  resolveRepositoryRoot,
} from './guard';

const UUID = '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42';
const DB_NAME = 'lithography_v13_dev';

function buildEnv(overrides: Partial<MockV13Env> = {}): MockV13Env {
  return {
    nodeEnv: 'development',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'mock_writer',
    dbPassword: 'secret',
    dbName: DB_NAME,
    dbTimezone: 'Z',
    dbCharset: 'utf8mb4',
    fieldEncryptionKey: '0123456789abcdef',
    fieldEncryptionIv: 'fedcba9876543210',
    mockPassword: 'MockV13#Passw0rd',
    writeAck: WRITE_ACK_PHRASE,
    ...overrides,
  };
}

function buildOptions(overrides: Partial<MockV13CliOptions> = {}): MockV13CliOptions {
  return {
    help: false,
    envFile: '/tmp/mock-v13.env',
    database: DB_NAME,
    confirmDatabase: DB_NAME,
    expectedInstanceUuid: UUID,
    allowedDatabases: [DB_NAME],
    write: true,
    packs: ['p0-org-accounts'],
    credentialsOut: null,
    jsonOut: null,
    mockFileDir: '/tmp/mock-v13/files',
    referenceStorageDir: '/tmp/mock-v13/references',
    failAfterPack: null,
    ...overrides,
  };
}

function expectGuardViolation(run: () => unknown, pattern: RegExp): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GuardViolationError);
    expect((error as Error).message).toMatch(pattern);
    expect(exitCodeOf(error)).toBe(2);
    return;
  }
  throw new Error('期望抛出 GuardViolationError，但调用成功返回');
}

describe('parseCliArgs', () => {
  it('--help 只返回帮助标记，不要求其它参数', () => {
    const options = parseCliArgs(['--help']);
    expect(options.help).toBe(true);
    expect(options.envFile).toBeNull();
    expect(options.packs).toEqual([]);
  });

  it('解析完整写入参数', () => {
    const options = parseCliArgs([
      '--env-file',
      '/secure/dev.env',
      '--database',
      DB_NAME,
      '--confirm-database',
      DB_NAME,
      '--expected-instance-uuid',
      UUID,
      '--allow-database',
      DB_NAME,
      '--allow-database',
      'lithography_v13_test',
      '--pack',
      'p0-org-accounts',
      '--pack',
      'p0-repair',
      '--write',
      '--fail-after-pack',
      'p0-repair',
    ]);
    expect(options.envFile).toBe('/secure/dev.env');
    expect(options.database).toBe(DB_NAME);
    expect(options.allowedDatabases).toEqual([DB_NAME, 'lithography_v13_test']);
    expect(options.packs).toEqual(['p0-org-accounts', 'p0-repair']);
    expect(options.write).toBe(true);
    expect(options.failAfterPack).toBe('p0-repair');
  });

  it('未知参数直接拒绝', () => {
    expectGuardViolation(() => parseCliArgs(['--drop-database']), /未知参数/u);
  });

  it('参数缺少取值时拒绝', () => {
    expectGuardViolation(() => parseCliArgs(['--database', '--write']), /缺少取值/u);
  });
});

describe('parseMockEnv', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-env-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('只读取显式指定的文件，并从密码文件读取测试密码', () => {
    const passwordFile = path.join(tempDir, 'password.txt');
    fs.writeFileSync(passwordFile, 'MockV13#Passw0rd\n', 'utf8');
    const envFile = path.join(tempDir, 'mock.env');
    fs.writeFileSync(
      envFile,
      [
        'NODE_ENV=development',
        `DB_HOST=127.0.0.1`,
        'DB_PORT=3306',
        'DB_USER=mock_writer',
        'DB_PASS=secret',
        `DB_NAME=${DB_NAME}`,
        'FIELD_ENCRYPTION_KEY=0123456789abcdef',
        'FIELD_ENCRYPTION_IV=fedcba9876543210',
        `MOCK_V13_PASSWORD_FILE=${passwordFile}`,
        `MOCK_V13_WRITE_ACK=${WRITE_ACK_PHRASE}`,
      ].join('\n'),
      'utf8',
    );

    const env = parseMockEnv(envFile);
    expect(env.dbName).toBe(DB_NAME);
    expect(env.mockPassword).toBe('MockV13#Passw0rd');
    expect(env.writeAck).toBe(WRITE_ACK_PHRASE);
  });

  it('环境文件不存在时拒绝，不回退默认环境', () => {
    expectGuardViolation(() => parseMockEnv(path.join(tempDir, 'missing.env')), /环境文件不存在/u);
  });

  it('缺少测试密码时拒绝', () => {
    const envFile = path.join(tempDir, 'no-password.env');
    fs.writeFileSync(
      envFile,
      [
        'NODE_ENV=development',
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_USER=mock_writer',
        `DB_NAME=${DB_NAME}`,
        'FIELD_ENCRYPTION_KEY=0123456789abcdef',
        'FIELD_ENCRYPTION_IV=fedcba9876543210',
      ].join('\n'),
      'utf8',
    );
    expectGuardViolation(() => parseMockEnv(envFile), /MOCK_V13_PASSWORD/u);
  });
});

describe('assertGuardConfig', () => {
  it('合法配置返回归一化守卫', () => {
    const guard = assertGuardConfig(buildOptions(), buildEnv());
    expect(guard.database).toBe(DB_NAME);
    expect(guard.expectedInstanceUuid).toBe(UUID);
    expect(guard.envFile).toBe(path.resolve('/tmp/mock-v13.env'));
  });

  it('拒绝生产环境', () => {
    expectGuardViolation(
      () => assertGuardConfig(buildOptions(), buildEnv({ nodeEnv: 'production' })),
      /production/u,
    );
  });

  it('拒绝缺失 --env-file', () => {
    expectGuardViolation(
      () => assertGuardConfig(buildOptions({ envFile: null }), buildEnv()),
      /--env-file/u,
    );
  });

  it('拒绝确认串不一致', () => {
    expectGuardViolation(
      () =>
        assertGuardConfig(buildOptions({ confirmDatabase: 'lithography_v13_test' }), buildEnv()),
      /--confirm-database/u,
    );
  });

  it('拒绝环境文件库名与参数不一致', () => {
    expectGuardViolation(
      () => assertGuardConfig(buildOptions(), buildEnv({ dbName: 'lithography_v13_test' })),
      /不一致/u,
    );
  });

  it('拒绝未命中开发关键字的库名', () => {
    const database = 'lithography_prod';
    expectGuardViolation(
      () =>
        assertGuardConfig(
          buildOptions({ database, confirmDatabase: database, allowedDatabases: [database] }),
          buildEnv({ dbName: database }),
        ),
      /未包含/u,
    );
  });

  it('拒绝不在白名单的库名', () => {
    expectGuardViolation(
      () => assertGuardConfig(buildOptions({ allowedDatabases: ['another_dev'] }), buildEnv()),
      /白名单/u,
    );
  });

  it('拒绝非 UUID 的预期实例标识', () => {
    expectGuardViolation(
      () => assertGuardConfig(buildOptions({ expectedInstanceUuid: 'not-a-uuid' }), buildEnv()),
      /--expected-instance-uuid/u,
    );
  });

  it('--write 时要求环境文件显式确认短语', () => {
    expectGuardViolation(
      () => assertGuardConfig(buildOptions(), buildEnv({ writeAck: 'yes' })),
      /MOCK_V13_WRITE_ACK/u,
    );
  });

  it('未选择数据包时拒绝', () => {
    expectGuardViolation(
      () => assertGuardConfig(buildOptions({ packs: [] }), buildEnv()),
      /数据包/u,
    );
  });
});

describe('assertTargetFacts', () => {
  const guard = assertGuardConfig(buildOptions(), buildEnv());

  it('实际库、实例 UUID 与只读状态全部匹配时通过', () => {
    expect(() =>
      assertTargetFacts(guard, { database: DB_NAME, instanceUuid: UUID, readOnly: 0 }),
    ).not.toThrow();
  });

  it('实际库与目标库不一致时拒绝（错库零写入）', () => {
    expectGuardViolation(
      () =>
        assertTargetFacts(guard, {
          database: 'lithography_drill',
          instanceUuid: UUID,
          readOnly: 0,
        }),
      /实际连接库/u,
    );
  });

  it('实例 UUID 不一致时拒绝', () => {
    expectGuardViolation(
      () =>
        assertTargetFacts(guard, {
          database: DB_NAME,
          instanceUuid: '00000000-0000-4000-8000-000000000000',
          readOnly: 0,
        }),
      /实例 UUID/u,
    );
  });

  it('只读实例拒绝写入', () => {
    expectGuardViolation(
      () => assertTargetFacts(guard, { database: DB_NAME, instanceUuid: UUID, readOnly: 1 }),
      /只读/u,
    );
  });
});

describe('assertSchemaTables', () => {
  it('V13 表齐全时通过', () => {
    expect(() => assertSchemaTables([...REQUIRED_TABLES])).not.toThrow();
  });

  it('缺表时指出缺项并拒绝', () => {
    const existing = REQUIRED_TABLES.filter((table) => table !== 'stored_file');
    expectGuardViolation(() => assertSchemaTables(existing), /stored_file/u);
  });
});

describe('assertSchemaColumns', () => {
  function buildCompleteColumns(): Map<string, Set<string>> {
    return new Map(
      Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => [table, new Set(columns)]),
    );
  }

  it('关键列齐全时通过', () => {
    expect(() => assertSchemaColumns(buildCompleteColumns())).not.toThrow();
  });

  it('缺列时指出表与列并拒绝（避免事务内 ER_BAD_FIELD_ERROR）', () => {
    const columns = buildCompleteColumns();
    const accountColumns = columns.get('base_user_account');
    accountColumns?.delete('login_password');
    expectGuardViolation(() => assertSchemaColumns(columns), /base_user_account.*login_password/u);
  });

  it('表完全缺失时不重复报错（交给缺表守卫）', () => {
    const columns = buildCompleteColumns();
    columns.delete('local_company_setting');
    expect(() => assertSchemaColumns(columns)).not.toThrow();
  });
});

describe('assertMockDirectories', () => {
  it('默认的两个目录可通过', () => {
    expect(() =>
      assertMockDirectories('/tmp/mock-v13/files', '/tmp/mock-v13/references'),
    ).not.toThrow();
  });

  it('两个目录相同时拒绝', () => {
    expectGuardViolation(
      () => assertMockDirectories('/tmp/mock-v13/files', '/tmp/mock-v13/files'),
      /必须指向不同目录/u,
    );
  });

  it('后端源码目录内拒绝写入', () => {
    expectGuardViolation(
      () =>
        assertMockDirectories(
          path.join(resolveRepositoryRoot(), 'backend', 'src', 'mock-files'),
          '/tmp/mock-v13/references',
        ),
      /受保护目录/u,
    );
  });

  it('后端依赖目录内拒绝写入', () => {
    expectGuardViolation(
      () =>
        assertMockDirectories(
          path.join(resolveRepositoryRoot(), 'backend', 'node_modules', 'mock-v13'),
          '/tmp/mock-v13/references',
        ),
      /受保护目录/u,
    );
  });

  it('后端构建产物目录内拒绝写入', () => {
    expectGuardViolation(
      () =>
        assertMockDirectories(
          path.join(resolveRepositoryRoot(), 'backend', 'dist', 'mock-v13'),
          '/tmp/mock-v13/references',
        ),
      /受保护目录/u,
    );
  });

  it('参考资料目录落在后端源码内同样拒绝', () => {
    expectGuardViolation(
      () =>
        assertMockDirectories(
          '/tmp/mock-v13/files',
          path.join(resolveRepositoryRoot(), 'backend', 'src', 'references'),
        ),
      /受保护目录/u,
    );
  });

  it('受保护目录同前缀但不同路径组件时仍可写入', () => {
    expect(() =>
      assertMockDirectories(
        path.join(resolveRepositoryRoot(), 'backend', 'src-mock', 'files'),
        path.join(resolveRepositoryRoot(), 'backend', 'dist-mock', 'references'),
      ),
    ).not.toThrow();
  });

  it('文件系统根目录拒绝', () => {
    expectGuardViolation(() => assertMockDirectories('/', '/tmp/mock-v13/references'), /根目录/u);
  });

  it('原件 files 子目录为符号链接时在首次写入前拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-outside-'));
    const reference = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-ref-'));
    fs.symlinkSync(outside, path.join(root, 'files'));
    try {
      expectGuardViolation(() => assertMockDirectories(root, reference), /符号链接/u);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(reference, { recursive: true, force: true });
    }
  });
});

describe('assertOutputPathVacant', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-json-out-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('尚不存在的统计路径接受', () => {
    const target = path.join(tempDir, 'run-01.json');
    expect(assertOutputPathVacant(target, '--json-out')).toBe(path.resolve(target));
  });

  it('已存在的统计路径在写入前拒绝（同内容也不复用）', () => {
    const target = path.join(tempDir, 'run-01.json');
    fs.writeFileSync(target, '{"total":1}\n', 'utf8');
    expectGuardViolation(() => assertOutputPathVacant(target, '--json-out'), /已存在/u);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"total":1}\n');
  });

  it('目标为目录时拒绝，且目录内容不变', () => {
    const target = path.join(tempDir, 'run-01.json');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'sentinel.txt'), '哨兵', 'utf8');
    expectGuardViolation(() => assertOutputPathVacant(target, '--json-out'), /已存在/u);
    expect(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8')).toBe('哨兵');
  });
});

describe('assertCredentialsPathOutsideRepository', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-cred-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('仓库内路径拒绝', () => {
    const inside = path.join(resolveRepositoryRoot(), 'mock-v13-credentials.json');
    expectGuardViolation(() => assertCredentialsPathOutsideRepository(inside), /仓库内/u);
  });

  it('仓库外且父目录存在时接受', () => {
    const outside = path.join(tempDir, 'credentials.json');
    expect(assertCredentialsPathOutsideRepository(outside)).toBe(path.resolve(outside));
  });

  it('父目录不存在时拒绝', () => {
    expectGuardViolation(
      () =>
        assertCredentialsPathOutsideRepository(path.join(tempDir, 'nested', 'credentials.json')),
      /父目录不存在/u,
    );
  });

  it('父目录为指向仓库的链接时拒绝（按真实路径判定）', () => {
    const linkedParent = path.join(tempDir, 'repo-link');
    fs.symlinkSync(fs.realpathSync(resolveRepositoryRoot()), linkedParent);
    expectGuardViolation(
      () => assertCredentialsPathOutsideRepository(path.join(linkedParent, 'credentials.json')),
      /符号链接|仓库内/u,
    );
  });

  it('凭据目标本身为链接时拒绝', () => {
    const sentinel = path.join(tempDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, '哨兵', 'utf8');
    const target = path.join(tempDir, 'credentials.json');
    fs.symlinkSync(sentinel, target);
    expectGuardViolation(() => assertCredentialsPathOutsideRepository(target), /符号链接/u);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('哨兵');
  });
});
