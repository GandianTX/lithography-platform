// scripts/mock-v13/runner.spec.ts

/**
 * 离线编排测试（A6 的可离线部分）：单事务、失败回滚、只回收本次文件、
 * 守卫失败时根本不建立数据库连接。
 */

/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockConflictError, MockVerificationError, MockWriteError, exitCodeOf } from './errors';
import { FileRegistry, mockPng } from './files';
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
    this.committed = true;
    this.calls.push('commitTransaction');
    return Promise.resolve();
  }

  rollbackTransaction(): Promise<void> {
    this.rolledBack = true;
    this.calls.push('rollbackTransaction');
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
});
