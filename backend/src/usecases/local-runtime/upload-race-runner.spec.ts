/// <reference types="jest" />
import type { QueryRunner } from 'typeorm';
import {
  RaceBranchCancelledError,
  runTwoBranchTransactionRace,
} from '../../../test/utils/upload-race-runner';

interface FakeRunnerOptions {
  readonly failConnect?: Error;
  readonly failStartTransaction?: Error;
  /** 驱动已把事务标记为活动后才抛错，模拟 MySQL 这类“部分成功”的启动失败 */
  readonly failStartTransactionAfterActivate?: Error;
  readonly failRollback?: Error;
  readonly failRelease?: Error;
  readonly failDestroy?: Error;
  /** 模拟驱动未暴露 databaseConnection，无法安全销毁独占连接 */
  readonly destroyUnavailable?: boolean;
}

interface FakeRunner {
  readonly runner: QueryRunner;
  readonly calls: string[];
  /** 记录每次 release 时事务是否仍活动，用于断言不存在 release(active=true) */
  readonly activeAtRelease: boolean[];
}

/**
 * 注入初始化/收尾失败的假连接，用来验证竞争执行器的取消、回滚、销毁、释放与错误聚合顺序。
 * 独占连接通过 `databaseConnection.destroy` 暴露，与真实驱动收尾路径一致。
 */
const createFakeRunner = (options: FakeRunnerOptions = {}): FakeRunner => {
  const calls: string[] = [];
  const activeAtRelease: boolean[] = [];
  let transactionActive = false;
  const databaseConnection = options.destroyUnavailable
    ? undefined
    : {
        destroy: (): Promise<void> => {
          calls.push('destroy');
          if (options.failDestroy) {
            return Promise.reject(options.failDestroy);
          }
          // 销毁成功即连接已断开，事务不再活动
          transactionActive = false;
          return Promise.resolve();
        },
      };
  const runner = {
    calls,
    databaseConnection,
    get isTransactionActive() {
      return transactionActive;
    },
    connect: (): Promise<void> => {
      calls.push('connect');
      return options.failConnect ? Promise.reject(options.failConnect) : Promise.resolve();
    },
    startTransaction: (): Promise<void> => {
      calls.push('startTransaction');
      if (options.failStartTransaction) {
        return Promise.reject(options.failStartTransaction);
      }
      transactionActive = true;
      if (options.failStartTransactionAfterActivate) {
        return Promise.reject(options.failStartTransactionAfterActivate);
      }
      return Promise.resolve();
    },
    commitTransaction: (): Promise<void> => {
      calls.push('commit');
      transactionActive = false;
      return Promise.resolve();
    },
    rollbackTransaction: (): Promise<void> => {
      calls.push('rollback');
      // 与真实驱动一致：回滚失败时事务仍可能保持活动；这里保留活动状态由 settle 逻辑判定
      if (options.failRollback) {
        return Promise.reject(options.failRollback);
      }
      transactionActive = false;
      return Promise.resolve();
    },
    release: (): Promise<void> => {
      calls.push('release');
      activeAtRelease.push(transactionActive);
      return options.failRelease ? Promise.reject(options.failRelease) : Promise.resolve();
    },
  };
  return { runner: runner as unknown as QueryRunner, calls, activeAtRelease };
};

const createRunnerSequence = (runners: readonly QueryRunner[]) => {
  let index = 0;
  return (): QueryRunner => {
    const runner = runners[index];
    index += 1;
    if (!runner) {
      throw new Error('竞争执行器申请了超出预期的连接');
    }
    return runner;
  };
};

const expectInactive = (...runners: readonly QueryRunner[]): void => {
  for (const runner of runners) {
    expect(runner.isTransactionActive).toBe(false);
  }
};

describe('上传竞争执行器生命周期', () => {
  it('B 连接失败：取消 A 并回滚释放，不提交', async () => {
    const first = createFakeRunner();
    const second = createFakeRunner({ failConnect: new Error('B 连接失败') });
    let competitionWaited = false;

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner, second.runner]),
        runFirst: () => Promise.resolve('first-value'),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => {
          competitionWaited = true;
          return Promise.reject(new Error('B 初始化失败时不应进入竞争等待'));
        },
        onFirstCommitted: () => Promise.resolve(),
      });

      expect(competitionWaited).toBe(false);
      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(second.calls).toEqual(['connect']);
      expect(first.activeAtRelease).toEqual([false]);
      expect(result.first.status).toBe('rejected');
      if (result.first.status === 'rejected') {
        expect(result.first.reason).toBeInstanceOf(RaceBranchCancelledError);
        expect((result.first.reason as Error).message).toContain('取消');
      }
      expect(result.second.status).toBe('rejected');
      expect(result.errors).toEqual([expect.stringContaining('第二分支初始化失败')]);
    } finally {
      expectInactive(first.runner, second.runner);
    }
  });

  it('B 启动事务失败：A 回滚释放且不提交，B 按已连接状态释放', async () => {
    const first = createFakeRunner();
    const second = createFakeRunner({
      failStartTransaction: new Error('B 启动事务失败'),
    });

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner, second.runner]),
        runFirst: () => Promise.resolve('first-value'),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.reject(new Error('B 初始化失败时不应进入竞争等待')),
        onFirstCommitted: () => Promise.resolve(),
      });

      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(second.calls).toEqual(['connect', 'startTransaction', 'release']);
      expect(first.activeAtRelease).toEqual([false]);
      expect(second.activeAtRelease).toEqual([false]);
      expect(result.first.status).toBe('rejected');
      expect(result.second.status).toBe('rejected');
      expect(result.errors).toEqual([expect.stringContaining('第二分支初始化失败')]);
    } finally {
      expectInactive(first.runner, second.runner);
    }
  });

  it('B 启动事务已标记活动后抛错：按驱动状态回滚并释放，A 完成取消、回滚与释放', async () => {
    const initError = new Error('B 事务已激活后启动失败');
    const first = createFakeRunner();
    const second = createFakeRunner({ failStartTransactionAfterActivate: initError });

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner, second.runner]),
        runFirst: () => Promise.resolve('first-value'),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.reject(new Error('B 初始化失败时不应进入竞争等待')),
        onFirstCommitted: () => Promise.resolve(),
      });

      // startTransaction 未成功返回但驱动已标记活动：仍必须回滚
      expect(second.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(result.first.status).toBe('rejected');
      if (result.first.status === 'rejected') {
        expect(result.first.reason).toBeInstanceOf(RaceBranchCancelledError);
      }
      expect(result.second.status).toBe('rejected');
      if (result.second.status === 'rejected') {
        expect(result.second.reason).toBe(initError);
      }
      expect(result.errors).toEqual([expect.stringContaining('第二分支初始化失败')]);
    } finally {
      expectInactive(first.runner, second.runner);
    }
  });

  it('B 启动事务抛错后回滚失败：销毁独占连接，不执行普通释放，保留初始化与回滚错误', async () => {
    const initError = new Error('B 事务已激活后启动失败');
    const first = createFakeRunner();
    const second = createFakeRunner({
      failStartTransactionAfterActivate: initError,
      failRollback: new Error('回滚连接已断开'),
      failRelease: new Error('释放连接已断开'),
    });

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner, second.runner]),
        runFirst: () => Promise.resolve('first-value'),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.reject(new Error('B 初始化失败时不应进入竞争等待')),
        onFirstCommitted: () => Promise.resolve(),
      });

      expect(second.calls).toEqual(['connect', 'startTransaction', 'rollback', 'destroy']);
      expect(second.activeAtRelease).toEqual([]);
      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(result.second.status).toBe('rejected');
      if (result.second.status === 'rejected') {
        expect(result.second.reason).toBe(initError);
      }
      expect(result.errors).toEqual([
        '第二分支初始化失败：B 事务已激活后启动失败',
        '第二分支回滚失败：回滚连接已断开',
      ]);
    } finally {
      expectInactive(first.runner, second.runner);
    }
  });

  it('分支回滚抛错：销毁独占连接，无活动事务释放，原始错误仍保留', async () => {
    const original = new Error('原始分支错误');
    const first = createFakeRunner({ failRollback: new Error('回滚连接已断开') });

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner]),
        runFirst: () => Promise.reject(original),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.resolve(),
      });

      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'destroy']);
      expect(first.activeAtRelease).toEqual([]);
      expect(result.first.status).toBe('rejected');
      if (result.first.status === 'rejected') {
        expect(result.first.reason).toBe(original);
      }
      expect(result.errors).toEqual(['第一分支回滚失败：回滚连接已断开']);
    } finally {
      expectInactive(first.runner);
    }
  });

  it('回滚与销毁同时失败：原始错误与两个收尾错误均保留', async () => {
    const original = new Error('原始分支错误');
    const first = createFakeRunner({
      failRollback: new Error('回滚连接已断开'),
      failDestroy: new Error('销毁失败'),
    });

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner]),
        runFirst: () => Promise.reject(original),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.resolve(),
      });

      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'destroy']);
      expect(first.activeAtRelease).toEqual([]);
      expect(result.first.status).toBe('rejected');
      if (result.first.status === 'rejected') {
        expect(result.first.reason).toBe(original);
      }
      expect(result.errors).toEqual([
        '第一分支回滚失败：回滚连接已断开',
        '第一分支回滚后销毁独占连接未完成：销毁独占连接失败：销毁失败',
      ]);
    } finally {
      // 销毁失败时无法安全断开，只保证没有把活动事务普通归池
      expect(first.activeAtRelease).toEqual([]);
    }
  });

  it('回滚失败且驱动无法安全断连：明确报告，不普通归池', async () => {
    const original = new Error('原始分支错误');
    const first = createFakeRunner({
      failRollback: new Error('回滚连接已断开'),
      destroyUnavailable: true,
    });

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner]),
        runFirst: () => Promise.reject(original),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.resolve(),
      });

      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback']);
      expect(first.activeAtRelease).toEqual([]);
      expect(result.first.status).toBe('rejected');
      if (result.first.status === 'rejected') {
        expect(result.first.reason).toBe(original);
      }
      expect(result.errors).toEqual([
        '第一分支回滚失败：回滚连接已断开',
        '第一分支回滚后销毁独占连接未完成：驱动未暴露可销毁的独占连接，拒绝将活动事务连接回池',
      ]);
    } finally {
      expect(first.activeAtRelease).toEqual([]);
    }
  });

  it('回滚成功但释放失败：原始错误与释放错误均保留', async () => {
    const original = new Error('原始分支错误');
    const first = createFakeRunner({ failRelease: new Error('释放连接已断开') });

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner]),
        runFirst: () => Promise.reject(original),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.resolve(),
      });

      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(first.activeAtRelease).toEqual([false]);
      expect(result.first.status).toBe('rejected');
      if (result.first.status === 'rejected') {
        expect(result.first.reason).toBe(original);
      }
      expect(result.errors).toEqual(['第一分支释放失败：释放连接已断开']);
    } finally {
      expectInactive(first.runner);
    }
  });

  it('第二次 createRunner 同步抛错：取消第一分支、零提交，全部收尾后才拒绝', async () => {
    const first = createFakeRunner();
    let requested = 0;
    let competitionWaited = false;

    const createRunner = (): QueryRunner => {
      requested += 1;
      if (requested === 1) return first.runner;
      throw new Error('B 连接创建失败');
    };

    try {
      await expect(
        runTwoBranchTransactionRace({
          createRunner,
          runFirst: () => Promise.resolve('first-value'),
          runSecond: () => Promise.resolve('second-value'),
          waitForCompetition: () => {
            competitionWaited = true;
            return Promise.resolve();
          },
          onFirstCommitted: () => Promise.resolve(),
        }),
      ).rejects.toThrow('第二分支创建失败：B 连接创建失败');

      expect(competitionWaited).toBe(false);
      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(first.calls).not.toContain('commit');
      expect(first.activeAtRelease).toEqual([false]);
    } finally {
      expectInactive(first.runner);
    }
  });

  it('等待竞争失败：取消第一分支，不死等且不误提交', async () => {
    const first = createFakeRunner();
    const second = createFakeRunner();

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner, second.runner]),
        runFirst: () => Promise.resolve('first-value'),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.reject(new Error('等待锁竞争超时')),
        onFirstCommitted: () => Promise.resolve(),
      });

      expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
      expect(first.calls).not.toContain('commit');
      expect(first.activeAtRelease).toEqual([false]);
      expect(result.first.status).toBe('rejected');
      if (result.first.status === 'rejected') {
        expect(result.first.reason).toBeInstanceOf(RaceBranchCancelledError);
      }
      expect(result.errors).toEqual(['等待竞争失败：等待锁竞争超时']);
    } finally {
      expectInactive(first.runner, second.runner);
    }
  });

  it('正常竞争：观察到竞争后才提交，登记回调在提交之后执行', async () => {
    const first = createFakeRunner();
    const second = createFakeRunner();
    const committed: string[] = [];

    try {
      const result = await runTwoBranchTransactionRace({
        createRunner: createRunnerSequence([first.runner, second.runner]),
        runFirst: () => Promise.resolve('first-value'),
        runSecond: () => Promise.resolve('second-value'),
        waitForCompetition: () => Promise.resolve(),
        onFirstCommitted: (value: string): Promise<void> => {
          expect(first.calls).toContain('commit');
          committed.push(`first:${value}`);
          return Promise.resolve();
        },
        onSecondCommitted: (value: string): Promise<void> => {
          expect(second.calls).toContain('commit');
          committed.push(`second:${value}`);
          return Promise.resolve();
        },
      });

      expect(result.errors).toEqual([]);
      expect(first.calls).toEqual(['connect', 'startTransaction', 'commit', 'release']);
      expect(second.calls).toEqual(['connect', 'startTransaction', 'commit', 'release']);
      expect(first.activeAtRelease).toEqual([false]);
      expect(second.activeAtRelease).toEqual([false]);
      expect(result.first).toEqual({ status: 'fulfilled', value: 'first-value' });
      expect(result.second).toEqual({ status: 'fulfilled', value: 'second-value' });
      expect(committed).toEqual(
        expect.arrayContaining(['first:first-value', 'second:second-value']),
      );
      expect(committed).toHaveLength(2);
    } finally {
      expectInactive(first.runner, second.runner);
    }
  });
});
