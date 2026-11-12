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
  exitCodeOf,
  failureDiagnosticsOf,
} from './errors';
import { FileRegistry, mockPng } from './files';
import { REQUIRED_TABLES, WRITE_ACK_PHRASE } from './guard';
import { ACCOUNTS } from './manifest';
import { PackDefinition } from './packs';
import { PackContext } from './packs-shared';
import { RunReport } from './report';
import { TransactionQueryRunner, executePacks, main } from './runner';

class FakeQueryRunner implements TransactionQueryRunner {
  readonly calls: string[] = [];
  committed = false;
  rolledBack = false;
  released = false;
  lockAcquired = true;
  commitError: Error | null = null;
  rollbackError: Error | null = null;

  query(sql: string): Promise<unknown> {
    this.calls.push(sql);
    if (sql.includes('GET_LOCK')) {
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

    await expect(
      executePacks(queryRunner, packs, context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    ).rejects.toBeInstanceOf(MockWriteError);

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

  it('COMMIT 前回滚失败时保留文件，主错误不被回滚错误覆盖', async () => {
    const created = path.join(tempDir, 'rollback-failed.png');
    const context = createContext(tempDir, queryRunner);
    queryRunner.rollbackError = new Error('ROLLBACK 连接已断开');

    const packs = [
      createPack('p0-org-accounts', (packContext) => {
        packContext.files.ensure(created, mockPng());
        throw new MockWriteError('主错误：写库失败');
      }),
    ];

    const error = await captureRejection(
      executePacks(queryRunner, packs, context, {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    );

    expect(error).toBeInstanceOf(MockWriteError);
    expect((error as Error).message).toContain('主错误');
    expect(fs.existsSync(created)).toBe(true);
    const diagnostics = failureDiagnosticsOf(error);
    expect(diagnostics.rollbackError?.message).toContain('ROLLBACK');
    expect(diagnostics.retainedFiles).toContain(created);
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
      /inode 已变化|内容已变化/,
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

  it('未取得运行锁时不进入事务', async () => {
    queryRunner.lockAcquired = false;

    await expect(
      executePacks(queryRunner, [], createContext(tempDir, queryRunner), {
        database: 'lithography_v13_dev',
        failAfterPack: null,
      }),
    ).rejects.toBeInstanceOf(MockWriteError);

    expect(queryRunner.calls).not.toContain('startTransaction');
    expect(queryRunner.released).toBe(true);
  });
});

describe('main 守卫短路', () => {
  it('--help 打印用法并返回 0，不建立连接', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const createQueryRunner = jest.fn();
    await expect(main(['--help'], { createQueryRunner })).resolves.toBe(0);
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

describe('main 收尾与退出码', () => {
  const TEST_UUID = '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42';

  class MainQueryRunner implements TransactionQueryRunner {
    committed = false;
    rolledBack = false;
    released = false;
    commitError: Error | null = null;
    rollbackError: Error | null = null;

    query(sql: string): Promise<unknown> {
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
      if (sql.includes('RELEASE_LOCK')) return Promise.resolve([]);
      if (sql.includes('FROM base_user_account')) {
        return Promise.resolve([{ total: ACCOUNTS.length }]);
      }
      return Promise.resolve([]);
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }

    startTransaction(): Promise<void> {
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
      return Promise.resolve();
    }
  }

  interface Harness {
    args: string[];
    dependencies: {
      createDataSource(): DataSource;
      createQueryRunner(): Promise<TransactionQueryRunner>;
      selectPacks(): readonly PackDefinition[];
    };
    runner: MainQueryRunner;
    tempDir: string;
    mockDir: string;
    referenceDir: string;
    cleanup(): void;
  }

  function createHarness(options: {
    destroyError?: Error;
    packRun(context: PackContext): Promise<void>;
  }): Harness {
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
    const runner = new MainQueryRunner();
    const fakeSource = {
      isInitialized: true,
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
        'p1-local',
        '--write',
      ],
      dependencies: {
        createDataSource: () => fakeSource,
        createQueryRunner: () => Promise.resolve(runner),
        selectPacks: () => [createPack('p1-local', options.packRun)],
      },
      runner,
      tempDir,
      mockDir,
      referenceDir,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  async function runAndCapture(harness: Harness): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> {
    const output: string[] = [];
    const errors: string[] = [];
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
    } finally {
      harness.cleanup();
    }
  });

  it('异主冲突且回滚失败：保留退出码 3，报告无法确认回滚，不声称已回滚', async () => {
    const harness = createHarness({
      packRun: () => Promise.reject(new MockConflictError('异主冲突：组织归属不明')),
    });
    harness.runner.rollbackError = new Error('ROLLBACK 连接已断开');
    try {
      const { code, stderr } = await runAndCapture(harness);
      expect(code).toBe(3);
      expect(harness.runner.rolledBack).toBe(false);
      expect(stderr).toContain('异主冲突：组织归属不明');
      expect(stderr).toContain('无法确认回滚');
      expect(stderr).toContain('ROLLBACK 连接已断开');
      expect(stderr).not.toContain('事务已回滚');
    } finally {
      harness.cleanup();
    }
  });
});
