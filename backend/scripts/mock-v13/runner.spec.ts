// scripts/mock-v13/runner.spec.ts

/**
 * 离线编排测试（A6 的可离线部分）：单事务、失败回滚、只回收本次文件、
 * 守卫失败时根本不建立数据库连接。
 */

/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DataSource } from 'typeorm';

import {
  CommitOutcomeUnknownError,
  MockConflictError,
  MockVerificationError,
  MockWriteError,
  RollbackUnconfirmedError,
  exitCodeOf,
  failureDiagnosticsOf,
} from './errors';
import {
  FileRegistry,
  MOCK_ROOT_OWNER_FILE,
  MockRootClaim,
  MockRootTarget,
  RootClaimHooks,
  RootOwner,
  claimMockRoots,
  mockPng,
} from './files';
import { REQUIRED_TABLES, WRITE_ACK_PHRASE } from './guard';
import { ACCOUNTS, ORGANIZATIONS, mockEmail } from './manifest';
import { PackDefinition } from './packs';
import { PackContext, buildFieldEncryptionCodec, organizationCodeOf } from './packs-shared';
import { Row } from './db';
import { RunReport } from './report';
import { TransactionQueryRunner, executePacks, main } from './runner';

class FakeQueryRunner implements TransactionQueryRunner {
  readonly calls: string[] = [];
  committed = false;
  rolledBack = false;
  released = false;
  lockAcquired = true;
  lockError: Error | null = null;
  startError: Error | null = null;
  commitError: Error | null = null;
  rollbackError: Error | null = null;

  query(sql: string): Promise<unknown> {
    this.calls.push(sql);
    if (sql.includes('GET_LOCK')) {
      if (this.lockError) return Promise.reject(this.lockError);
      return Promise.resolve([{ acquired: this.lockAcquired ? 1 : 0 }]);
    }
    return Promise.resolve([]);
  }

  connect(): Promise<void> {
    this.calls.push('connect');
    return Promise.resolve();
  }

  startTransaction(): Promise<void> {
    this.calls.push('startTransaction');
    if (this.startError) return Promise.reject(this.startError);
    return Promise.resolve();
  }

  commitTransaction(): Promise<void> {
    this.calls.push('commitTransaction');
    if (this.commitError) return Promise.reject(this.commitError);
    this.committed = true;
    return Promise.resolve();
  }

  rollbackTransaction(): Promise<void> {
    this.calls.push('rollbackTransaction');
    if (this.rollbackError) return Promise.reject(this.rollbackError);
    this.rolledBack = true;
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.released = true;
    this.calls.push('release');
    return Promise.resolve();
  }
}

function createContext(tempDir: string, queryRunner: FakeQueryRunner): PackContext {
  return {
    qr: queryRunner,
    report: new RunReport(),
    files: new FileRegistry([tempDir]),
    mockFileDir: tempDir,
    referenceStorageDir: tempDir,
    passwordHash: 'unused-in-offline-test',
    encryption: {
      encrypt: (plain: string) => `enc:${plain}`,
      decrypt: (cipher: string) => cipher.replace(/^enc:/u, ''),
    },
  };
}

function createPack(id: string, run: (context: PackContext) => Promise<void>): PackDefinition {
  return { id: id as PackDefinition['id'], title: id, run };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('期望 Promise 失败，但调用成功返回');
}

describe('executePacks', () => {
  let tempDir: string;
  let queryRunner: FakeQueryRunner;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-runner-'));
    queryRunner = new FakeQueryRunner();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('全部数据包成功且校验通过时提交', async () => {
    const executed: string[] = [];
    const packs = [
      createPack('p0-org-accounts', () => {
        executed.push('p0-org-accounts');
        return Promise.resolve();
      }),
      createPack('p0-repair', () => {
        executed.push('p0-repair');
        return Promise.resolve();
      }),
    ];
    const verify = jest.fn(() => Promise.resolve());

    await executePacks(queryRunner, packs, createContext(tempDir, queryRunner), {
      database: 'lithography_v13_dev',
      failAfterPack: null,
      verify,
    });

    expect(executed).toEqual(['p0-org-accounts', 'p0-repair']);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(queryRunner.committed).toBe(true);
    expect(queryRunner.rolledBack).toBe(false);
    expect(queryRunner.released).toBe(true);
  });

  it('写入中途失败时回滚，并只回收本次创建的文件', async () => {
    const preexisting = path.join(tempDir, 'preexisting.txt');
    fs.writeFileSync(preexisting, '人工放置', 'utf8');
    const created = path.join(tempDir, 'mock.png');
    const context = createContext(tempDir, queryRunner);

    const packs = [
      createPack('p0-org-accounts', (packContext) => {
        packContext.files.ensure(created, mockPng());
        return Promise.resolve();
      }),
      createPack('p0-repair', () => {
        throw new MockWriteError('模拟写入失败');
      }),
    ];

    const error = await captureRejection(
      executePacks(queryRunner, packs, context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    );

    expect(error).toBeInstanceOf(MockWriteError);
    expect(exitCodeOf(error)).toBe(4);
    expect(failureDiagnosticsOf(error).transactionState).toBe('ROLLBACK_CONFIRMED');
    expect(queryRunner.committed).toBe(false);
    expect(queryRunner.rolledBack).toBe(true);
    expect(queryRunner.released).toBe(true);
    expect(fs.existsSync(created)).toBe(false);
    expect(fs.existsSync(preexisting)).toBe(true);
  });

  it('COMMIT 已发出但响应丢失时保留文件，退出码 7 且给出可定位诊断', async () => {
    const created = path.join(tempDir, 'commit-unknown.png');
    const context = createContext(tempDir, queryRunner);
    queryRunner.commitError = new Error('socket hang up after COMMIT');

    const packs = [
      createPack('p0-org-accounts', (packContext) => {
        packContext.files.ensure(created, mockPng());
        return Promise.resolve();
      }),
    ];

    const error = await captureRejection(
      executePacks(queryRunner, packs, context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    );

    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(exitCodeOf(error)).toBe(7);
    expect(fs.existsSync(created)).toBe(true);
    expect(queryRunner.committed).toBe(false);
    expect(queryRunner.rolledBack).toBe(true);
    const unknown = error as CommitOutcomeUnknownError;
    expect(unknown.details.targetDatabase).toBe('lithography_v13_dev');
    expect(unknown.details.phase).toBe('COMMIT_SENT');
    expect(unknown.details.retainedFiles).toContain(created);
    expect(unknown.details.rollbackError).toBeNull();
  });

  it('COMMIT 响应丢失且回滚失败时仍保留文件，并同时保留回滚错误', async () => {
    const created = path.join(tempDir, 'commit-unknown-rollback-failed.png');
    const context = createContext(tempDir, queryRunner);
    queryRunner.commitError = new Error('COMMIT response lost');
    queryRunner.rollbackError = new Error('ROLLBACK refused');

    const packs = [
      createPack('p0-org-accounts', (packContext) => {
        packContext.files.ensure(created, mockPng());
        return Promise.resolve();
      }),
    ];

    const error = (await captureRejection(
      executePacks(queryRunner, packs, context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    )) as CommitOutcomeUnknownError;

    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(fs.existsSync(created)).toBe(true);
    expect(error.details.rollbackError?.message).toBe('ROLLBACK refused');
  });

  it('COMMIT 前回滚失败时退出码 8，保留文件并同时保留两个错误', async () => {
    const created = path.join(tempDir, 'rollback-failed.png');
    const context = createContext(tempDir, queryRunner);
    queryRunner.rollbackError = new Error('ROLLBACK 连接已断开');

    const packs = [
      createPack('p0-org-accounts', (packContext) => {
        packContext.files.ensure(created, mockPng());
        throw new MockWriteError('主错误：写库失败');
      }),
    ];

    const error = (await captureRejection(
      executePacks(queryRunner, packs, context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    )) as RollbackUnconfirmedError;

    expect(error).toBeInstanceOf(RollbackUnconfirmedError);
    expect(exitCodeOf(error)).toBe(8);
    expect(fs.existsSync(created)).toBe(true);
    expect(error.details.phase).toBe('ROLLBACK_FAILED');
    expect(error.details.primaryError.message).toContain('主错误');
    expect(error.details.rollbackError.message).toBe('ROLLBACK 连接已断开');
    expect(error.details.retainedFiles).toContain(created);
  });

  it('事务启动结果不明但回滚确认：退出码 4，回收本轮文件，预存哨兵不变且不走普通 release', async () => {
    const preexisting = path.join(tempDir, 'preexisting-start.txt');
    fs.writeFileSync(preexisting, '人工放置', 'utf8');
    const created = path.join(tempDir, 'start-uncertain.png');
    const context = createContext(tempDir, queryRunner);
    context.files.ensure(created, mockPng());
    queryRunner.startError = new MockWriteError('主错误：START 半成功后抛错');

    const error = await captureRejection(
      executePacks(queryRunner, [], context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    );

    expect(error).toBeInstanceOf(MockWriteError);
    expect(exitCodeOf(error)).toBe(4);
    expect((error as Error).message).toContain('START 半成功');
    const diagnostics = failureDiagnosticsOf(error);
    expect(diagnostics.transactionState).toBe('START_UNCERTAIN_ROLLBACK_CONFIRMED');
    expect(diagnostics.rollbackConfirmed).toBe(true);
    expect(queryRunner.rolledBack).toBe(true);
    expect(queryRunner.released).toBe(false);
    expect(fs.existsSync(created)).toBe(false);
    expect(fs.readFileSync(preexisting, 'utf8')).toBe('人工放置');
  });

  it('事务启动不明且回滚失败：退出码 8，跳过普通 release，主错误与回滚错误均保留', async () => {
    const created = path.join(tempDir, 'start-rollback-failed.png');
    const context = createContext(tempDir, queryRunner);
    context.files.ensure(created, mockPng());
    queryRunner.startError = new Error('主错误：START 半成功后抛错');
    queryRunner.rollbackError = new Error('回滚错误：ROLLBACK 拒绝');

    const error = (await captureRejection(
      executePacks(queryRunner, [], context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    )) as RollbackUnconfirmedError;

    expect(error).toBeInstanceOf(RollbackUnconfirmedError);
    expect(exitCodeOf(error)).toBe(8);
    expect(error.details.phase).toBe('START_UNCERTAIN');
    expect(error.details.primaryError.message).toContain('START 半成功');
    expect(error.details.rollbackError.message).toBe('回滚错误：ROLLBACK 拒绝');
    expect(error.details.retainedFiles).toContain(created);
    expect(queryRunner.released).toBe(false);
    expect(fs.existsSync(created)).toBe(true);
  });

  it('回滚成功后清理发现文件被替换：保留替换物并报告，主错误仍可见', async () => {
    const created = path.join(tempDir, 'replaced.png');
    const context = createContext(tempDir, queryRunner);
    const packs = [
      createPack('p0-org-accounts', (packContext) => {
        packContext.files.ensure(created, mockPng());
        fs.unlinkSync(created);
        fs.writeFileSync(created, '替换物', 'utf8');
        throw new MockWriteError('主错误：事务失败');
      }),
    ];

    const error = await captureRejection(
      executePacks(queryRunner, packs, context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    );

    expect((error as Error).message).toContain('主错误');
    expect(fs.readFileSync(created, 'utf8')).toBe('替换物');
    expect(failureDiagnosticsOf(error).retainedFiles?.join('\n')).toMatch(
      /对象身份已变化|内容已变化/,
    );
  });

  it('--fail-after-pack 注入点在事务内触发回滚', async () => {
    const packs = [createPack('p0-org-accounts', () => Promise.resolve())];

    await expect(
      executePacks(queryRunner, packs, createContext(tempDir, queryRunner), {
        database: 'lithography_v13_dev',
        failAfterPack: 'p0-org-accounts',
      }),
    ).rejects.toBeInstanceOf(MockWriteError);

    expect(queryRunner.committed).toBe(false);
    expect(queryRunner.rolledBack).toBe(true);
    expect(exitCodeOf(new MockWriteError('x'))).toBe(4);
  });

  it('异主冲突保留冲突语义（退出码 3）并回滚', async () => {
    const packs = [
      createPack('p0-org-accounts', () => {
        throw new MockConflictError('检测到异主记录');
      }),
    ];

    await expect(
      executePacks(queryRunner, packs, createContext(tempDir, queryRunner), {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    ).rejects.toBeInstanceOf(MockConflictError);

    expect(queryRunner.rolledBack).toBe(true);
    expect(queryRunner.committed).toBe(false);
  });

  it('定向校验不通过时回滚', async () => {
    const packs = [createPack('p0-org-accounts', () => Promise.resolve())];

    await expect(
      executePacks(queryRunner, packs, createContext(tempDir, queryRunner), {
        database: 'lithography_v13_dev',
        failAfterPack: null,
        verify: () => {
          throw new MockVerificationError('账号数量不足');
        },
      }),
    ).rejects.toBeInstanceOf(MockVerificationError);

    expect(queryRunner.committed).toBe(false);
    expect(queryRunner.rolledBack).toBe(true);
  });

  it('未取得运行锁时不进入事务，且诊断标记事务未开始', async () => {
    queryRunner.lockAcquired = false;

    const error = await captureRejection(
      executePacks(queryRunner, [], createContext(tempDir, queryRunner), {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    );

    expect(error).toBeInstanceOf(MockWriteError);
    expect(failureDiagnosticsOf(error).transactionState).toBe('NOT_STARTED');
    expect(failureDiagnosticsOf(error).rollbackConfirmed).toBeUndefined();
    expect(queryRunner.calls).not.toContain('startTransaction');
    expect(queryRunner.released).toBe(true);
  });

  it('运行锁查询抛错时仍走连接收尾并释放，不把连接留在外层', async () => {
    queryRunner.lockError = new Error('GET_LOCK 查询失败（模拟）');

    const error = await captureRejection(
      executePacks(queryRunner, [], createContext(tempDir, queryRunner), {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(queryRunner.calls).not.toContain('startTransaction');
    expect(queryRunner.released).toBe(true);
  });
});

describe('main 守卫短路', () => {
  it('--help 打印用法并返回 0，不建立连接', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const createQueryRunner = jest.fn();
    await expect(main(['--help'], { createQueryRunner })).resolves.toBe(0);
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(printed).toContain(
      '4 事务未开始，或回滚已确认；身份无法确认的文件会保留，并报告路径。',
    );
    expect(printed).toContain('4 不表示一定发生过回滚');
    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('缺少 --env-file 时以退出码 2 拒绝，且不建立连接', async () => {
    const errorSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const createQueryRunner = jest.fn();
    await expect(
      main(
        [
          '--database',
          'lithography_v13_dev',
          '--confirm-database',
          'lithography_v13_dev',
          '--expected-instance-uuid',
          '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42',
          '--allow-database',
          'lithography_v13_dev',
          '--pack',
          'all',
          '--write',
        ],
        { createQueryRunner },
      ),
    ).resolves.toBe(2);
    expect(createQueryRunner).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('环境文件不存在时以退出码 2 拒绝，且不建立连接', async () => {
    const errorSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const createQueryRunner = jest.fn();
    await expect(
      main(
        [
          '--env-file',
          path.join(os.tmpdir(), 'definitely-missing-mock-v13.env'),
          '--database',
          'lithography_v13_dev',
          '--confirm-database',
          'lithography_v13_dev',
          '--expected-instance-uuid',
          '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42',
          '--allow-database',
          'lithography_v13_dev',
          '--pack',
          'all',
          '--write',
        ],
        { createQueryRunner },
      ),
    ).resolves.toBe(2);
    expect(createQueryRunner).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('未选择账号包却传 --credentials-out：写入前拒绝且不产生凭据文件', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-cred-guard-'));
    const envFile = path.join(tempDir, 'mock-v13.env');
    const credentials = path.join(tempDir, 'credentials.json');
    fs.writeFileSync(
      envFile,
      [
        'NODE_ENV=development',
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_USER=mock_writer',
        'DB_PASS=secret',
        'DB_NAME=lithography_v13_dev',
        'DB_TIMEZONE=+08:00',
        'FIELD_ENCRYPTION_KEY=0123456789abcdef',
        'FIELD_ENCRYPTION_IV=fedcba9876543210',
        'MOCK_V13_PASSWORD=MockV13#Passw0rd',
        `MOCK_V13_WRITE_ACK=${WRITE_ACK_PHRASE}`,
      ].join('\n'),
      'utf8',
    );
    const errorSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const createQueryRunner = jest.fn();
    try {
      const code = await main(
        [
          '--env-file',
          envFile,
          '--database',
          'lithography_v13_dev',
          '--confirm-database',
          'lithography_v13_dev',
          '--expected-instance-uuid',
          '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42',
          '--allow-database',
          'lithography_v13_dev',
          '--pack',
          'p0-equipment',
          '--credentials-out',
          credentials,
          '--write',
        ],
        { createQueryRunner },
      );
      expect(code).toBe(2);
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(fs.existsSync(credentials)).toBe(false);
      expect(fs.readdirSync(tempDir)).toEqual([path.basename(envFile)]);
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('main 输出路径组合预检', () => {
  const TEST_UUID = '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42';

  function writeEnvFile(tempDir: string): string {
    const envFile = path.join(tempDir, 'mock-v13.env');
    fs.writeFileSync(
      envFile,
      [
        'NODE_ENV=development',
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_USER=mock_writer',
        'DB_PASS=secret',
        'DB_NAME=lithography_v13_dev',
        'DB_TIMEZONE=+08:00',
        'FIELD_ENCRYPTION_KEY=0123456789abcdef',
        'FIELD_ENCRYPTION_IV=fedcba9876543210',
        'MOCK_V13_PASSWORD=MockV13!Passw0rd',
        `MOCK_V13_WRITE_ACK=${WRITE_ACK_PHRASE}`,
      ].join('\n'),
      'utf8',
    );
    return envFile;
  }

  function buildArgs(
    tempDir: string,
    envFile: string,
    credentialsOut: string,
    jsonOut: string,
  ): string[] {
    return [
      '--env-file',
      envFile,
      '--database',
      'lithography_v13_dev',
      '--confirm-database',
      'lithography_v13_dev',
      '--allow-database',
      'lithography_v13_dev',
      '--expected-instance-uuid',
      TEST_UUID,
      '--mock-file-dir',
      path.join(tempDir, 'files'),
      '--reference-storage-dir',
      path.join(tempDir, 'reference'),
      '--pack',
      'p0-org-accounts',
      '--credentials-out',
      credentialsOut,
      '--json-out',
      jsonOut,
      '--write',
    ];
  }

  async function runAndCaptureConnectAttempts(args: string[]): Promise<{
    code: number;
    stderr: string;
    createDataSource: jest.Mock;
    createQueryRunner: jest.Mock;
  }> {
    const errors: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    const createDataSource = jest.fn(
      () =>
        ({
          initialize: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
          isInitialized: true,
        }) as unknown as DataSource,
    );
    const createQueryRunner = jest.fn();
    try {
      const code = await main(args, { createDataSource, createQueryRunner });
      return { code, stderr: errors.join(''), createDataSource, createQueryRunner };
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  it('两个参数完全相同：退出 2，未连接数据库且不新增目录或文件', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-same-out-'));
    const envFile = writeEnvFile(tempDir);
    const target = path.join(tempDir, 'run.json');
    try {
      const { code, stderr, createDataSource, createQueryRunner } =
        await runAndCaptureConnectAttempts(buildArgs(tempDir, envFile, target, target));

      expect(code).toBe(2);
      expect(stderr).toContain('--credentials-out 和 --json-out 必须使用不同文件');
      expect(createDataSource).not.toHaveBeenCalled();
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tempDir, 'files'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, 'reference'))).toBe(false);
      expect(fs.readdirSync(tempDir)).toEqual([path.basename(envFile)]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('两个参数等价（run.json 与 ./run.json）：退出 2，目录与文件均无新增', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-equivalent-out-'));
    const envFile = writeEnvFile(tempDir);
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const { code, stderr, createDataSource, createQueryRunner } =
        await runAndCaptureConnectAttempts(buildArgs(tempDir, envFile, 'run.json', './run.json'));

      expect(code).toBe(2);
      expect(stderr).toContain('--credentials-out 和 --json-out 必须使用不同文件');
      expect(createDataSource).not.toHaveBeenCalled();
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tempDir, 'files'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, 'reference'))).toBe(false);
      expect(fs.readdirSync(tempDir)).toEqual([path.basename(envFile)]);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['待生成 PNG', '--json-out', 'files/files/intake-a-in-progress.png', '--mock-file-dir'],
    ['Mock 根目录', '--json-out', 'files', '--mock-file-dir'],
    ['已有 PNG', '--credentials-out', 'files/files/existing.png', '--mock-file-dir'],
    ['参考资料子路径', '--json-out', 'reference/./run.json', '--reference-storage-dir'],
    ['原件根的父路径', '--json-out', '.', '--mock-file-dir'],
  ])('%s：拒绝输出冲突，未连接、未写文件', async (scenario, flag, target, rootFlag) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-root-output-'));
    const envFile = writeEnvFile(tempDir);
    const pngDir = path.join(tempDir, 'files', 'files');
    const png = path.join(pngDir, 'existing.png');
    const originalPng = mockPng();
    try {
      if (scenario === '已有 PNG' || scenario === '待生成 PNG') {
        fs.mkdirSync(pngDir, { recursive: true });
      }
      if (scenario === '已有 PNG') fs.writeFileSync(png, originalPng);
      const before = fs.readdirSync(tempDir, { recursive: true }).sort();
      const args = buildArgs(tempDir, envFile, 'unused-credentials.json', 'unused-stats.json');
      args.splice(args.indexOf('--credentials-out'), 4);
      args.push(flag, `${tempDir}/${target}`);

      const { code, stderr, createDataSource, createQueryRunner } =
        await runAndCaptureConnectAttempts(args);

      expect(code).toBe(2);
      expect(stderr).toContain(`${flag} 与 ${rootFlag} 路径冲突`);
      expect(createDataSource).not.toHaveBeenCalled();
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(fs.readdirSync(tempDir, { recursive: true }).sort()).toEqual(before);
      if (scenario === '已有 PNG') expect(fs.readFileSync(png)).toEqual(originalPng);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('main 收尾与退出码', () => {
  const TEST_UUID = '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42';

  class MainQueryRunner implements TransactionQueryRunner {
    readonly calls: string[] = [];
    committed = false;
    rolledBack = false;
    released = false;
    startError: Error | null = null;
    commitError: Error | null = null;
    rollbackError: Error | null = null;
    unlockError: Error | null = null;
    releaseError: Error | null = null;
    driverDestroyed = false;
    driverDestroyError: Error | null = null;
    databaseConnection?: { destroy(): void } = {
      destroy: () => {
        this.driverDestroyed = true;
        if (this.driverDestroyError) throw this.driverDestroyError;
      },
    };

    query(sql: string, _parameters?: readonly unknown[]): Promise<unknown> {
      if (sql.includes('SELECT DATABASE()')) {
        return Promise.resolve([{ db: 'lithography_v13_dev', uuid: TEST_UUID, ro: 0 }]);
      }
      if (sql.includes('information_schema.tables')) {
        return Promise.resolve(REQUIRED_TABLES.map((tableName) => ({ tableName })));
      }
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve([]);
      }
      if (sql.includes('GET_LOCK')) return Promise.resolve([{ acquired: 1 }]);
      if (sql.includes('RELEASE_LOCK')) {
        return this.unlockError ? Promise.reject(this.unlockError) : Promise.resolve([]);
      }
      if (sql.includes('FROM base_user_account')) {
        return Promise.resolve([{ total: ACCOUNTS.length }]);
      }
      return Promise.resolve([]);
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }

    startTransaction(): Promise<void> {
      this.calls.push('startTransaction');
      if (this.startError) return Promise.reject(this.startError);
      return Promise.resolve();
    }

    commitTransaction(): Promise<void> {
      if (this.commitError) return Promise.reject(this.commitError);
      this.committed = true;
      return Promise.resolve();
    }

    rollbackTransaction(): Promise<void> {
      if (this.rollbackError) return Promise.reject(this.rollbackError);
      this.rolledBack = true;
      return Promise.resolve();
    }

    release(): Promise<void> {
      this.released = true;
      return this.releaseError ? Promise.reject(this.releaseError) : Promise.resolve();
    }
  }

  /** 为 p0-org-accounts 收尾校验提供逐账号事实的离线查询器。 */
  class VerifiableAccountsQueryRunner extends MainQueryRunner {
    private readonly accountRows = new Map<string, Row>();
    private readonly infoRows = new Map<number, Row>();
    private readonly specsById = new Map<number, (typeof ACCOUNTS)[number]>();
    private readonly orgIds = new Map<string, number>();
    private readonly codec = buildFieldEncryptionCodec('0123456789abcdef', 'fedcba9876543210');

    constructor() {
      super();
      let nextOrgId = 10;
      for (const organization of ORGANIZATIONS) {
        this.orgIds.set(organization.code, nextOrgId++);
      }
      ACCOUNTS.forEach((spec, index) => {
        const id = 100 + index;
        this.specsById.set(id, spec);
        this.accountRows.set(spec.loginName, {
          id,
          login_name: spec.loginName,
          login_email: mockEmail(spec.loginName),
          status: spec.accountStatus,
          identity_hint: spec.role,
          admin_level: spec.adminLevel,
        });
        this.infoRows.set(id, {
          account_id: id,
          user_state: spec.userState,
          access_group: JSON.stringify([spec.role]),
          meta_digest: this.codec.encrypt(JSON.stringify([spec.role])),
          customer_organization_id:
            spec.profileOrganization === null
              ? null
              : (this.orgIds.get(organizationCodeOf(spec.profileOrganization)) ?? null),
        });
      });
    }

    override query(sql: string, parameters?: readonly unknown[]): Promise<unknown> {
      if (
        /FROM\s+`?base_user_account`?/u.test(sql) &&
        parameters &&
        parameters.length > 0 &&
        typeof parameters[0] === 'string'
      ) {
        const row = this.accountRows.get(parameters[0]);
        return Promise.resolve(row ? [row] : []);
      }
      if (/FROM\s+`?base_user_info`?/u.test(sql) && parameters && parameters.length > 0) {
        const row = this.infoRows.get(Number(parameters[0]));
        return Promise.resolve(row ? [row] : []);
      }
      if (
        /FROM\s+`?organization`?\s/u.test(sql) &&
        !sql.includes('organization_membership') &&
        parameters &&
        parameters.length > 0
      ) {
        const code = String(parameters[0]);
        const id = this.orgIds.get(code);
        return Promise.resolve(
          id === undefined ? [] : [{ id, organization_code: code, is_managed_company: 1 }],
        );
      }
      if (/organization_membership/u.test(sql) && parameters && parameters.length > 0) {
        const spec = this.specsById.get(Number(parameters[0]));
        if (!spec || spec.organization === null) return Promise.resolve([]);
        return Promise.resolve([
          {
            organization_code:
              spec.organization === 'PLATFORM'
                ? 'MOCK-V13-PLATFORM'
                : organizationCodeOf(spec.organization),
            is_managed_company: spec.organization === 'PLATFORM' ? 0 : 1,
            organization_status: 'ACTIVE',
            member_role: spec.role,
            status: 'ACTIVE',
          },
        ]);
      }
      if (
        /FROM\s+`?engineer_registration_application`?/u.test(sql) &&
        parameters &&
        parameters.length > 0
      ) {
        const spec = this.specsById.get(Number(parameters[0]));
        if (spec?.key === 'pending-engineer')
          return Promise.resolve([{ id: 1, status: 'PENDING' }]);
        if (spec?.key === 'rejected-engineer') {
          return Promise.resolve([{ id: 2, status: 'REJECTED' }]);
        }
        return Promise.resolve([]);
      }
      return super.query(sql, parameters);
    }
  }

  interface Harness {
    args: string[];
    dependencies: {
      createDataSource(): DataSource;
      createQueryRunner(): Promise<TransactionQueryRunner>;
      selectPacks(): readonly PackDefinition[];
      createFileRegistry?(roots: readonly string[]): FileRegistry;
      claimRoots?(
        targets: readonly MockRootTarget[],
        owner: RootOwner,
        hooks?: RootClaimHooks,
      ): MockRootClaim[];
    };
    runner: MainQueryRunner;
    pool: { ended: boolean; end(callback: (error?: Error | null) => void): void };
    tempDir: string;
    mockDir: string;
    referenceDir: string;
    cleanup(): void;
  }

  function createHarness(options: {
    destroyError?: Error;
    poolEndError?: Error;
    /** 自定义回调触发时机；不传时按真实异步回调返回 poolEndError。 */
    poolEnd?: (callback: (error?: Error | null) => void) => void;
    packId?: string;
    verifiableAccounts?: boolean;
    packRun(context: PackContext): Promise<void>;
  }): Harness {
    const packId = options.packId ?? 'p1-local';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-main-'));
    const mockDir = path.join(tempDir, 'files');
    const referenceDir = path.join(tempDir, 'reference');
    fs.mkdirSync(mockDir, { recursive: true });
    fs.mkdirSync(referenceDir, { recursive: true });
    const envFile = path.join(tempDir, 'mock-v13.env');
    fs.writeFileSync(
      envFile,
      [
        'NODE_ENV=development',
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_USER=mock_writer',
        'DB_PASS=secret',
        'DB_NAME=lithography_v13_dev',
        'DB_TIMEZONE=+08:00',
        'FIELD_ENCRYPTION_KEY=0123456789abcdef',
        'FIELD_ENCRYPTION_IV=fedcba9876543210',
        'MOCK_V13_PASSWORD=MockV13!Passw0rd',
        `MOCK_V13_WRITE_ACK=${WRITE_ACK_PHRASE}`,
      ].join('\n'),
      'utf8',
    );
    const runner = options.verifiableAccounts
      ? new VerifiableAccountsQueryRunner()
      : new MainQueryRunner();
    const pool = {
      ended: false,
      // 真实 mysql2 调用形态：end(callback) 返回 undefined，关闭结果只经回调到达。
      end: (callback: (error?: Error | null) => void): void => {
        pool.ended = true;
        if (options.poolEnd) {
          options.poolEnd(callback);
          return;
        }
        const error = options.poolEndError;
        setImmediate(() => callback(error ?? null));
      },
    };
    const fakeSource = {
      isInitialized: true,
      driver: { pool },
      initialize: () => Promise.resolve(),
      destroy: () =>
        options.destroyError ? Promise.reject(options.destroyError) : Promise.resolve(),
    } as unknown as DataSource;
    return {
      args: [
        '--env-file',
        envFile,
        '--database',
        'lithography_v13_dev',
        '--confirm-database',
        'lithography_v13_dev',
        '--allow-database',
        'lithography_v13_dev',
        '--expected-instance-uuid',
        TEST_UUID,
        '--mock-file-dir',
        mockDir,
        '--reference-storage-dir',
        referenceDir,
        '--pack',
        packId,
        '--write',
      ],
      dependencies: {
        createDataSource: () => fakeSource,
        createQueryRunner: () => Promise.resolve(runner),
        selectPacks: () => [createPack(packId, options.packRun)],
      },
      runner,
      pool,
      tempDir,
      mockDir,
      referenceDir,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  async function runAndCapture(
    harness: Harness,
    live?: { stdout: string[]; stderr: string[] },
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> {
    const output: string[] = live?.stdout ?? [];
    const errors: string[] = live?.stderr ?? [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    try {
      const code = await main(harness.args, harness.dependencies);
      return { code, stdout: output.join(''), stderr: errors.join('') };
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  it('确认提交后 destroy() 抛错：返回 6，明确已提交且不回滚', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      packRun: () => Promise.resolve(),
    });
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(6);
      expect(harness.runner.committed).toBe(true);
      expect(stderr).toContain('关闭连接失败');
      expect(stderr).toContain('数据已提交');
      expect(stderr).toContain('退出码 6');
      expect(stderr).toContain('不回收');
      expect(stderr).not.toContain('事务已回滚');
      // 已提交路径的连接已正常回池：只关闭本轮私有池，不再销毁该连接。
      expect(harness.runner.driverDestroyed).toBe(false);
      expect(harness.pool.ended).toBe(true);
      expect(stderr).toContain('已兜底关闭本轮私有池');
      expect(stderr).not.toContain('兜底断开');
    } finally {
      harness.cleanup();
    }
  });

  it('私有池关闭回调未触发前：CLI 不返回，也不打印兜底关闭成功（延迟成功）', async () => {
    const poolEndControl: { complete?: (error?: Error | null) => void } = {};
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      poolEnd: (callback) => {
        poolEndControl.complete = callback;
      },
      packRun: () => Promise.resolve(),
    });
    const live = { stdout: [] as string[], stderr: [] as string[] };
    let settled = false;
    let pending: Promise<{ code: number; stdout: string; stderr: string }> | null = null;
    try {
      pending = runAndCapture(harness, live).finally(() => {
        settled = true;
      });
      // 让 main 推进到注册关闭回调处；此时 mysql2 式回调尚未触发。
      await new Promise((resolve) => setImmediate(resolve));
      expect(poolEndControl.complete).toBeDefined();
      expect(settled).toBe(false);
      expect(live.stderr.join('')).toContain('关闭连接失败');
      expect(live.stderr.join('')).not.toContain('已兜底关闭本轮私有池');
      // 再等一轮仍无回调：依然不得提前返回或打印关闭成功。
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(live.stderr.join('')).not.toContain('已兜底关闭本轮私有池');

      const finishPoolEnd = poolEndControl.complete;
      if (!finishPoolEnd) throw new Error('私有池关闭回调未注册');
      finishPoolEnd(null);
      const { code, stderr } = await pending;
      expect(code).toBe(6);
      expect(stderr).toContain('已兜底关闭本轮私有池');
      expect(stderr).toContain('数据已提交');
    } finally {
      if (poolEndControl.complete && !settled) poolEndControl.complete(null);
      if (pending) await pending;
      harness.cleanup();
    }
  });

  it('私有池关闭回调异步报错：记录实际错误、不打印关闭成功，且不覆盖 6/7/8 结论', async () => {
    const scenarios: Array<{
      expectedCode: number;
      expectedHint: string;
      prepare(harness: Harness): void;
    }> = [
      { expectedCode: 6, expectedHint: '数据已提交', prepare: () => undefined },
      {
        expectedCode: 7,
        expectedHint: '提交结果仍未知',
        prepare: (harness) => {
          harness.runner.commitError = new Error('主错误：COMMIT 回执丢失');
        },
      },
      {
        expectedCode: 8,
        expectedHint: '保持退出码 8',
        prepare: (harness) => {
          harness.runner.rollbackError = new Error('ROLLBACK 连接已断开');
        },
      },
    ];
    for (const scenario of scenarios) {
      const harness = createHarness({
        destroyError: new Error('销毁连接失败（模拟）'),
        poolEndError: new Error('私有池关闭失败（模拟）'),
        packRun: () =>
          scenario.expectedCode === 8
            ? Promise.reject(new MockConflictError('异主冲突：组织归属不明'))
            : Promise.resolve(),
      });
      try {
        scenario.prepare(harness);
        const { code, stderr } = await runAndCapture(harness);
        expect(code).toBe(scenario.expectedCode);
        expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
        expect(stderr).toContain('兜底关闭本轮私有池失败：私有池关闭失败（模拟）');
        expect(stderr).not.toContain('已兜底关闭本轮私有池');
        expect(stderr).toContain(scenario.expectedHint);
      } finally {
        harness.cleanup();
      }
    }
  });

  it('确认提交后私有池兜底关闭也失败：退出码 6 不被覆盖，两条错误分别保留', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      poolEndError: new Error('私有池关闭失败（模拟）'),
      packRun: (context) => {
        context.files.ensure(path.join(context.mockFileDir, 'committed.png'), mockPng());
        return Promise.resolve();
      },
    });
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(6);
      expect(harness.pool.ended).toBe(true);
      expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
      expect(stderr).toContain('兜底关闭本轮私有池失败：私有池关闭失败（模拟）');
      expect(stderr).toContain('与上方关闭错误分别保留');
      expect(stderr).toContain('数据已提交');
      expect(stderr).toContain('退出码 6');
      expect(fs.existsSync(path.join(harness.mockDir, 'committed.png'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('COMMIT 回执丢失且私有池兜底失败：退出码 7 不被覆盖', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      poolEndError: new Error('私有池关闭失败（模拟）'),
      packRun: () => Promise.resolve(),
    });
    harness.runner.commitError = new Error('主错误：COMMIT 回执丢失');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(7);
      expect(harness.pool.ended).toBe(true);
      expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
      expect(stderr).toContain('兜底关闭本轮私有池失败：私有池关闭失败（模拟）');
      expect(stderr).toContain('提交结果仍未知');
      expect(stderr).toContain('退出码 7');
    } finally {
      harness.cleanup();
    }
  });

  it('回滚未确认且私有池兜底失败：退出码 8 不被覆盖', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      poolEndError: new Error('私有池关闭失败（模拟）'),
      packRun: () => Promise.reject(new MockConflictError('异主冲突：组织归属不明')),
    });
    harness.runner.rollbackError = new Error('ROLLBACK 连接已断开');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(8);
      expect(harness.pool.ended).toBe(true);
      expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
      expect(stderr).toContain('兜底关闭本轮私有池失败：私有池关闭失败（模拟）');
      expect(stderr).toContain('保持退出码 8');
    } finally {
      harness.cleanup();
    }
  });

  it('COMMIT 回执丢失且 destroy() 也抛错：返回 7，原件保留且两个错误都可见', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      packRun: (context) => {
        context.files.ensure(path.join(context.mockFileDir, 'kept.png'), mockPng());
        return Promise.resolve();
      },
    });
    harness.runner.commitError = new Error('主错误：COMMIT 回执丢失');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(7);
      expect(harness.runner.rolledBack).toBe(true);
      expect(fs.existsSync(path.join(harness.mockDir, 'kept.png'))).toBe(true);
      expect(stderr).toContain('主错误：COMMIT 回执丢失');
      expect(stderr).toContain('kept.png');
      expect(stderr).toContain('关闭连接失败');
      expect(stderr).toContain('提交结果仍未知');
      expect(stderr).toContain('退出码 7');
      // COMMIT 结果未知时连接未回池：destroy() 失败后必须兜底关闭本轮驱动连接，并关闭私有池。
      expect(harness.runner.driverDestroyed).toBe(true);
      expect(stderr).toContain('已用本轮独占驱动连接兜底断开');
      expect(harness.pool.ended).toBe(true);
      expect(stderr).toContain('已兜底关闭本轮私有池');
    } finally {
      harness.cleanup();
    }
  });

  it('异主冲突且回滚失败：退出码 8，保留主错误、回滚错误与文件，后续失败不覆盖', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      packRun: (context) => {
        context.files.ensure(path.join(context.mockFileDir, 'retained.png'), mockPng());
        return Promise.reject(new MockConflictError('异主冲突：组织归属不明'));
      },
    });
    harness.runner.rollbackError = new Error('ROLLBACK 连接已断开');
    harness.runner.unlockError = new Error('解锁失败（模拟）');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(8);
      expect(stderr).toContain('回滚未确认（退出码 8');
      expect(stderr).toContain('异主冲突：组织归属不明');
      expect(stderr).toContain('回滚错误=ROLLBACK 连接已断开');
      expect(stderr).toContain('retained.png');
      expect(stderr).toContain('解锁失败（模拟）');
      expect(stderr).toContain('跳过普通 release()');
      expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
      expect(stderr).toContain('保持退出码 8');
      // 回滚未确认时连接未回池：destroy() 失败后必须兜底关闭本轮驱动连接，并关闭私有池。
      expect(harness.runner.driverDestroyed).toBe(true);
      expect(stderr).toContain('已用本轮独占驱动连接兜底断开');
      expect(harness.pool.ended).toBe(true);
      expect(stderr).toContain('已兜底关闭本轮私有池');
      expect(fs.existsSync(path.join(harness.mockDir, 'retained.png'))).toBe(true);
      expect(harness.runner.rolledBack).toBe(false);
      expect(harness.runner.released).toBe(false);
      expect(stderr).not.toContain('事务已回滚');
      expect(stderr).not.toContain('已确认回滚');
    } finally {
      harness.cleanup();
    }
  });

  it('事务启动失败但回滚确认：退出码 4，日志区分启动结果不明且不走普通 release', async () => {
    const harness = createHarness({ packRun: () => Promise.resolve() });
    harness.runner.startError = new MockWriteError('主错误：START 半成功后抛错');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(4);
      expect(harness.runner.rolledBack).toBe(true);
      expect(harness.runner.released).toBe(false);
      expect(stderr).toContain('START 半成功后抛错');
      expect(stderr).toContain('事务启动结果不明，但 ROLLBACK 已确认');
      expect(stderr).not.toContain('事务已回滚');
    } finally {
      harness.cleanup();
    }
  });

  it('启动不明且回滚、关闭均失败：退出码 8，关闭错误不覆盖且连接不回池', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      packRun: () => Promise.resolve(),
    });
    harness.runner.startError = new Error('主错误：START 半成功后抛错');
    harness.runner.rollbackError = new Error('回滚错误：ROLLBACK 拒绝');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(8);
      expect(harness.runner.released).toBe(false);
      expect(harness.runner.committed).toBe(false);
      expect(stderr).toContain('阶段=START_UNCERTAIN');
      expect(stderr).toContain('START 半成功后抛错');
      expect(stderr).toContain('ROLLBACK 拒绝');
      expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
      expect(stderr).toContain('保持退出码 8');
      expect(harness.runner.driverDestroyed).toBe(true);
      expect(stderr).toContain('已用本轮独占驱动连接兜底断开');
    } finally {
      harness.cleanup();
    }
  });

  it('兜底断开也失败：退出码 8，关闭错误与兜底错误分别记录', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      packRun: (context) => {
        context.files.ensure(path.join(context.mockFileDir, 'retained.png'), mockPng());
        return Promise.reject(new MockConflictError('异主冲突：组织归属不明'));
      },
    });
    harness.runner.rollbackError = new Error('ROLLBACK 连接已断开');
    harness.runner.driverDestroyError = new Error('兜底断开失败（模拟）');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(8);
      expect(harness.runner.driverDestroyed).toBe(true);
      expect(stderr).toContain('回滚错误=ROLLBACK 连接已断开');
      expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
      expect(stderr).toContain('兜底断开本轮独占驱动连接失败：兜底断开失败（模拟）');
      expect(stderr).toContain('与上方关闭错误分别保留');
      expect(stderr).toContain('retained.png');
      expect(fs.existsSync(path.join(harness.mockDir, 'retained.png'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('未取得本轮驱动连接句柄：退出码 8 保持，并明确报告无法兜底', async () => {
    const harness = createHarness({
      destroyError: new Error('销毁连接失败（模拟）'),
      packRun: () => Promise.resolve(),
    });
    harness.runner.databaseConnection = undefined;
    harness.runner.startError = new Error('主错误：START 半成功后抛错');
    harness.runner.rollbackError = new Error('回滚错误：ROLLBACK 拒绝');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(8);
      expect(stderr).toContain('关闭连接失败：销毁连接失败（模拟）');
      expect(stderr).toContain('未取得本轮独占驱动连接句柄，无法兜底断开');
    } finally {
      harness.cleanup();
    }
  });

  it('回滚确认但保留身份未知原件：退出码 4，同时输出回滚结论与具体保留路径', async () => {
    const harness = createHarness({
      packRun: (context) => {
        context.files.ensure(path.join(context.mockFileDir, 'empty-identity.png'), mockPng());
        return Promise.resolve();
      },
    });
    // 排他创建后 fstat 失败，模拟身份未能登记的空原件。
    harness.dependencies.createFileRegistry = (roots) =>
      new FileRegistry(roots, {
        beforeReadFileIdentity: () => {
          throw new Error('注入：身份登记失败');
        },
      });
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(4);
      expect(harness.runner.rolledBack).toBe(true);
      expect(stderr).toContain('事务已确认回滚');
      expect(stderr).toContain('身份未能登记，无法证明仍是本轮创建对象');
      expect(stderr).toContain(path.join(harness.mockDir, 'empty-identity.png'));
      expect(fs.existsSync(path.join(harness.mockDir, 'empty-identity.png'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('第二根归属标记发布失败：业务事务未开始，第一根标记保留并有诊断', async () => {
    const packRun = jest.fn(() => Promise.resolve());
    const harness = createHarness({ packRun });
    harness.dependencies.claimRoots = (targets, owner) =>
      claimMockRoots(targets, owner, {
        beforePublish: (_claim, index) => {
          if (index === 1) throw new MockWriteError('注入：第二根发布失败');
        },
      });
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(4);
      expect(packRun).not.toHaveBeenCalled();
      expect(harness.runner.calls).not.toContain('startTransaction');
      expect(fs.existsSync(path.join(harness.mockDir, MOCK_ROOT_OWNER_FILE))).toBe(true);
      expect(fs.existsSync(path.join(harness.referenceDir, MOCK_ROOT_OWNER_FILE))).toBe(false);
      expect(stderr).toContain('第二根发布失败');
      expect(stderr).toContain('事务尚未开始');
      expect(stderr).not.toContain('事务已回滚');
    } finally {
      harness.cleanup();
    }
  });

  it('旧统计路径已占用：连接与写入前退出 2，原统计和目录不变', async () => {
    const harness = createHarness({ packRun: () => Promise.resolve() });
    const jsonOut = path.join(harness.tempDir, 'run-01.json');
    fs.writeFileSync(jsonOut, '{"old":true}\n', 'utf8');
    harness.args.push('--json-out', jsonOut);
    const createDataSource = jest.fn(harness.dependencies.createDataSource);
    harness.dependencies.createDataSource = createDataSource;
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(2);
      expect(stderr).toContain('--json-out 目标已存在');
      expect(createDataSource).not.toHaveBeenCalled();
      expect(harness.runner.committed).toBe(false);
      expect(fs.readFileSync(jsonOut, 'utf8')).toBe('{"old":true}\n');
      expect(fs.readdirSync(harness.mockDir)).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it('凭据目标为已有 PNG：连接与写入前退出 2，文件不变', async () => {
    const harness = createHarness({
      packId: 'p0-org-accounts',
      packRun: () => Promise.resolve(),
    });
    const occupied = path.join(harness.tempDir, 'existing.png');
    const original = mockPng();
    fs.writeFileSync(occupied, original);
    harness.args.push('--credentials-out', occupied);
    const createDataSource = jest.fn(harness.dependencies.createDataSource);
    harness.dependencies.createDataSource = createDataSource;
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(2);
      expect(stderr).toContain('--credentials-out 目标已占用');
      expect(createDataSource).not.toHaveBeenCalled();
      expect(fs.readFileSync(occupied)).toEqual(original);
      expect(fs.existsSync(path.join(harness.mockDir, '.mock-v13-owner.json'))).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('凭据目标为已有无关 JSON：连接与写入前退出 2，内容不变', async () => {
    const harness = createHarness({
      packId: 'p0-org-accounts',
      packRun: () => Promise.resolve(),
    });
    const occupied = path.join(harness.tempDir, 'unrelated.json');
    fs.writeFileSync(occupied, '{"keep":true}\n', 'utf8');
    harness.args.push('--credentials-out', occupied);
    const createDataSource = jest.fn(harness.dependencies.createDataSource);
    harness.dependencies.createDataSource = createDataSource;
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(2);
      expect(stderr).toContain('--credentials-out 目标已占用');
      expect(createDataSource).not.toHaveBeenCalled();
      expect(fs.readFileSync(occupied, 'utf8')).toBe('{"keep":true}\n');
    } finally {
      harness.cleanup();
    }
  });

  it('两个独立新凭据路径分别生成；省略参数重跑成功且不重复覆盖', async () => {
    const harnessA = createHarness({
      packId: 'p0-org-accounts',
      verifiableAccounts: true,
      packRun: () => Promise.resolve(),
    });
    const harnessB = createHarness({
      packId: 'p0-org-accounts',
      verifiableAccounts: true,
      packRun: () => Promise.resolve(),
    });
    const credentialsA = path.join(harnessA.tempDir, 'credentials-a.json');
    const credentialsB = path.join(harnessB.tempDir, 'credentials-b.json');
    harnessA.args.push('--credentials-out', credentialsA);
    harnessB.args.push('--credentials-out', credentialsB);
    try {
      const resultA = await runAndCapture(harnessA);
      if (resultA.code !== 0) throw new Error(resultA.stderr);
      const resultB = await runAndCapture(harnessB);
      if (resultB.code !== 0) throw new Error(resultB.stderr);
      expect(fs.statSync(credentialsA).mode & 0o777).toBe(0o600);
      expect(fs.statSync(credentialsB).mode & 0o777).toBe(0o600);
      const firstContent = fs.readFileSync(credentialsA, 'utf8');
      expect(JSON.parse(firstContent).mock).toBe(true);

      const credentialsIndex = harnessA.args.indexOf('--credentials-out');
      harnessA.args.splice(credentialsIndex, 2);
      const rerun = await runAndCapture(harnessA);
      expect(rerun.code).toBe(0);
      expect(fs.readFileSync(credentialsA, 'utf8')).toBe(firstContent);
      expect(
        fs.readdirSync(harnessA.tempDir).filter((name) => name.startsWith('credentials-')),
      ).toEqual(['credentials-a.json']);
    } finally {
      harnessA.cleanup();
      harnessB.cleanup();
    }
  });

  it('原件根已被另一库认领：退出 2，数据包未执行且目录不变', async () => {
    const packRun = jest.fn(() => Promise.resolve());
    const harness = createHarness({ packRun });
    claimMockRoots(
      [
        { flag: '--mock-file-dir', dir: harness.mockDir },
        { flag: '--reference-storage-dir', dir: harness.referenceDir },
      ],
      { instanceUuid: TEST_UUID, database: 'lithography_v13_other' },
    );
    const markerBefore = fs.readFileSync(path.join(harness.mockDir, MOCK_ROOT_OWNER_FILE), 'utf8');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(2);
      expect(stderr).toContain('其它实例或库');
      expect(packRun).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(harness.mockDir, MOCK_ROOT_OWNER_FILE), 'utf8')).toBe(
        markerBefore,
      );
    } finally {
      harness.cleanup();
    }
  });

  it('换新统计路径可重跑：退出 0，旧统计与已编辑文件均不变', async () => {
    const harness = createHarness({ packRun: () => Promise.resolve() });
    const occupied = path.join(harness.tempDir, 'run-01.json');
    fs.writeFileSync(occupied, '{"unrelated":true}\n', 'utf8');
    const jsonOut = path.join(harness.tempDir, 'run-02.json');
    harness.args.push('--json-out', jsonOut);
    try {
      const { code } = await runAndCapture(harness);
      expect(code).toBe(0);
      expect(JSON.parse(fs.readFileSync(jsonOut, 'utf8')).exitCode).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(jsonOut, 'utf8')).packs).toBeDefined();
      expect(fs.readFileSync(occupied, 'utf8')).toBe('{"unrelated":true}\n');

      const edited = path.join(harness.mockDir, 'edited.txt');
      fs.writeFileSync(edited, '已编辑内容', 'utf8');
      harness.runner.committed = false;
      harness.runner.rolledBack = false;
      harness.runner.released = false;
      const rerun = await runAndCapture(harness);
      expect(rerun.code).toBe(2);
      expect(rerun.stderr).toContain('--json-out 目标已存在');
      expect(fs.readFileSync(occupied, 'utf8')).toBe('{"unrelated":true}\n');
      expect(fs.readFileSync(edited, 'utf8')).toBe('已编辑内容');
    } finally {
      harness.cleanup();
    }
  });
});
