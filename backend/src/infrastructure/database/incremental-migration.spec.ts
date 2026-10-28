// src/infrastructure/database/incremental-migration.spec.ts
/// <reference types="jest" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MigrationCleanupError,
  attachCleanupErrors,
  classifyHistoryIssues,
  collectCleanupErrors,
  loadExplicitEnvConfig,
  parseMigrationCliArgs,
} from './incremental-migration';

const writeEnvFile = (dir: string, name: string, content: string): string => {
  const filePath = path.resolve(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};

describe('parseMigrationCliArgs', () => {
  it('解析 status 的显式环境与目标参数', () => {
    const parsed = parseMigrationCliArgs([
      'status',
      '--config-file',
      'env/.env.e2e',
      '--database=lithography_e2e',
    ]);
    expect(parsed).toEqual({
      command: 'status',
      envFile: 'env/.env.e2e',
      database: 'lithography_e2e',
      confirmDatabase: undefined,
    });
  });

  it('run 必须提供一致的 --confirm-database', () => {
    expect(() =>
      parseMigrationCliArgs([
        'run',
        '--config-file',
        'env/.env.e2e',
        '--database',
        'lithography_e2e',
      ]),
    ).toThrow(/confirm-database/);
    expect(() =>
      parseMigrationCliArgs([
        'run',
        '--config-file',
        'env/.env.e2e',
        '--database',
        'lithography_e2e',
        '--confirm-database',
        'other_db',
      ]),
    ).toThrow(/目标确认不一致/);
    expect(
      parseMigrationCliArgs([
        'run',
        '--config-file',
        'env/.env.e2e',
        '--database',
        'lithography_e2e',
        '--confirm-database',
        'lithography_e2e',
      ]),
    ).toMatchObject({ command: 'run', confirmDatabase: 'lithography_e2e' });
  });

  it('缺少命令、环境文件、目标或出现未知参数时失败关闭', () => {
    expect(() => parseMigrationCliArgs([])).toThrow(/缺少有效命令/);
    expect(() => parseMigrationCliArgs(['verify', '--database', 'lithography_e2e'])).toThrow(
      /--config-file/,
    );
    expect(() => parseMigrationCliArgs(['status', '--config-file', 'env/.env.e2e'])).toThrow(
      /--database/,
    );
    expect(() =>
      parseMigrationCliArgs([
        'status',
        '--config-file',
        'env/.env.e2e',
        '--database',
        'lithography_e2e',
        '--unknown',
        'x',
      ]),
    ).toThrow(/不支持的参数/);
  });
});

describe('loadExplicitEnvConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-env-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const validEnv = [
    'DB_HOST=127.0.0.1',
    'DB_PORT=3306',
    'DB_USER=tester',
    'DB_PASS=secret',
    'DB_NAME=lithography_e2e',
  ].join('\n');

  it('读取显式文件且不回落其他环境', () => {
    const envFile = writeEnvFile(tempDir, '.env.e2e', validEnv);
    const config = loadExplicitEnvConfig(envFile, 'lithography_e2e', tempDir);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3306,
      username: 'tester',
      database: 'lithography_e2e',
    });
  });

  it('文件缺失、为空或缺少必填字段时立即失败', () => {
    expect(() => loadExplicitEnvConfig('missing.env', 'lithography_e2e', tempDir)).toThrow(
      /环境文件不存在/,
    );
    const emptyFile = writeEnvFile(tempDir, '.env.empty', '   \n');
    expect(() => loadExplicitEnvConfig(emptyFile, 'lithography_e2e', tempDir)).toThrow(
      /环境文件为空/,
    );
    const missingHost = writeEnvFile(
      tempDir,
      '.env.nohost',
      'DB_PORT=3306\nDB_USER=t\nDB_NAME=lithography_e2e',
    );
    expect(() => loadExplicitEnvConfig(missingHost, 'lithography_e2e', tempDir)).toThrow(/DB_HOST/);
  });

  it('目标库不一致、端口非法或声明 synchronize 时拒绝', () => {
    const envFile = writeEnvFile(tempDir, '.env.e2e', validEnv);
    expect(() => loadExplicitEnvConfig(envFile, 'other_db', tempDir)).toThrow(/目标库与参数不一致/);

    const badPort = writeEnvFile(
      tempDir,
      '.env.badport',
      'DB_HOST=h\nDB_PORT=abc\nDB_USER=u\nDB_NAME=lithography_e2e',
    );
    expect(() => loadExplicitEnvConfig(badPort, 'lithography_e2e', tempDir)).toThrow(/DB_PORT/);

    const sync = writeEnvFile(tempDir, '.env.sync', `${validEnv}\nDB_SYNCHRONIZE=true`);
    expect(() => loadExplicitEnvConfig(sync, 'lithography_e2e', tempDir)).toThrow(/DB_SYNCHRONIZE/);
  });
});

describe('classifyHistoryIssues', () => {
  const repository = [
    { name: 'CreateA1773889200000', timestamp: 1773889200000 },
    { name: 'CreateB1773924900000', timestamp: 1773924900000 },
    { name: 'CreateC1773925000000', timestamp: 1773925000000 },
  ];

  const historyOf = (count: number) =>
    repository.slice(0, count).map((entry, index) => ({ id: index + 1, ...entry }));

  it('完整前缀无问题', () => {
    expect(classifyHistoryIssues(repository, historyOf(2))).toEqual([]);
  });

  it('空历史、重复、未知、缺口与时间戳不一致均报告', () => {
    expect(classifyHistoryIssues(repository, [])).toHaveLength(1);

    const duplicated = [historyOf(1)[0], { id: 2, ...repository[0] }];
    expect(classifyHistoryIssues(repository, duplicated).join('\n')).toMatch(/重复/);

    const unknown = [{ id: 1, name: 'Legacy1900000000000', timestamp: 1900000000000 }];
    expect(classifyHistoryIssues(repository, unknown).join('\n')).toMatch(/不在当前仓库/);

    const gap = [historyOf(1)[0], { id: 2, ...repository[2] }];
    expect(classifyHistoryIssues(repository, gap).join('\n')).toMatch(/顺序与仓库不一致/);

    const wrongTimestamp = [{ id: 1, ...repository[0], timestamp: 1 }];
    expect(classifyHistoryIssues(repository, wrongTimestamp).join('\n')).toMatch(/时间戳不一致/);
  });
});

describe('收尾错误处理', () => {
  it('收集全部收尾错误且不吞掉成功任务', async () => {
    const order: string[] = [];
    const errors = await collectCleanupErrors([
      {
        name: '关闭连接',
        run: (): Promise<void> => {
          order.push('close');
          return Promise.reject(new Error('close failed'));
        },
      },
      {
        name: '释放锁',
        run: (): Promise<void> => {
          order.push('release');
          return Promise.resolve();
        },
      },
    ]);
    expect(order).toEqual(['close', 'release']);
    expect(errors).toEqual(['关闭连接 失败: close failed']);
  });

  it('有主因时保留主因并附加收尾错误；无主因时不假成功', () => {
    const mainError = new Error('migration failed');
    const preserved = attachCleanupErrors(mainError, ['关闭连接 失败: close failed']);
    expect(preserved).toBe(mainError);
    expect((preserved as Error & { cleanupErrors: string[] }).cleanupErrors).toEqual([
      '关闭连接 失败: close failed',
    ]);

    const cleanupOnly = attachCleanupErrors(null, ['关闭连接 失败: close failed']);
    expect(cleanupOnly).toBeInstanceOf(MigrationCleanupError);
    expect((cleanupOnly as MigrationCleanupError).cleanupErrors).toHaveLength(1);
  });
});

describe('新增迁移入口的破坏性行为静态约束（M10）', () => {
  const readSource = (relativePath: string): string =>
    fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

  it('入口不引用清表/Seed/Nest 启动/删库删表/TRUNCATE', () => {
    const sources = [
      readSource('./incremental-migration.ts'),
      readSource('../../../scripts/migration.ts'),
    ].join('\n');
    for (const forbidden of [
      'clearDatabaseTables',
      'seed-mock',
      'NestFactory',
      'DROP DATABASE',
      'DROP TABLE',
      'TRUNCATE',
      'verify-empty-db-migrations',
    ]) {
      expect(sources).not.toContain(forbidden);
    }
  });
});
