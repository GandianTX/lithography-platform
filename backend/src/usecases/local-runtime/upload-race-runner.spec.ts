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
}

interface FakeRunner {
  readonly runner: QueryRunner;
  readonly calls: string[];
}

/**
 * 注入初始化/收尾失败的假连接，用来验证竞争执行器的取消、回滚、释放与错误聚合顺序。
 */
const createFakeRunner = (options: FakeRunnerOptions = {}): FakeRunner => {
  const calls: string[] = [];
  let transactionActive = false;
  const runner = {
    calls,
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
      transactionActive = false;
      return options.failRollback ? Promise.reject(options.failRollback) : Promise.resolve();
    },
    release: (): Promise<void> => {
      calls.push('release');
      return options.failRelease ? Promise.reject(options.failRelease) : Promise.resolve();
    },
  };
  return { runner: runner as unknown as QueryRunner, calls };
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

describe('上传竞争执行器生命周期', () => {
  it('B 连接失败：取消 A 并回滚释放，不提交', async () => {
    const first = createFakeRunner();
    const second = createFakeRunner({ failConnect: new Error('B 连接失败') });
    let competitionWaited = false;

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
    expect(result.first.status).toBe('rejected');
    if (result.first.status === 'rejected') {
      expect(result.first.reason).toBeInstanceOf(RaceBranchCancelledError);
      expect((result.first.reason as Error).message).toContain('取消');
    }
    expect(result.second.status).toBe('rejected');
    expect(result.errors).toEqual([expect.stringContaining('第二分支初始化失败')]);
  });

  it('B 启动事务失败：A 回滚释放且不提交，B 按已连接状态释放', async () => {
    const first = createFakeRunner();
    const second = createFakeRunner({
      failStartTransaction: new Error('B 启动事务失败'),
    });

    const result = await runTwoBranchTransactionRace({
      createRunner: createRunnerSequence([first.runner, second.runner]),
      runFirst: () => Promise.resolve('first-value'),
      runSecond: () => Promise.resolve('second-value'),
      waitForCompetition: () => Promise.reject(new Error('B 初始化失败时不应进入竞争等待')),
      onFirstCommitted: () => Promise.resolve(),
    });

    expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
    expect(second.calls).toEqual(['connect', 'startTransaction', 'release']);
    expect(result.first.status).toBe('rejected');
    expect(result.second.status).toBe('rejected');
    expect(result.errors).toEqual([expect.stringContaining('第二分支初始化失败')]);
  });

  it('B 启动事务已标记活动后抛错：按驱动状态回滚并释放，A 完成取消、回滚与释放', async () => {
    const initError = new Error('B 事务已激活后启动失败');
    const first = createFakeRunner();
    const second = createFakeRunner({ failStartTransactionAfterActivate: initError });

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
  });

  it('B 启动事务抛错后回滚失败：仍尝试释放且不覆盖原始初始化错误', async () => {
    const initError = new Error('B 事务已激活后启动失败');
    const first = createFakeRunner();
    const second = createFakeRunner({
      failStartTransactionAfterActivate: initError,
      failRollback: new Error('回滚连接已断开'),
      failRelease: new Error('释放连接已断开'),
    });

    const result = await runTwoBranchTransactionRace({
      createRunner: createRunnerSequence([first.runner, second.runner]),
      runFirst: () => Promise.resolve('first-value'),
      runSecond: () => Promise.resolve('second-value'),
      waitForCompetition: () => Promise.reject(new Error('B 初始化失败时不应进入竞争等待')),
      onFirstCommitted: () => Promise.resolve(),
    });

    expect(second.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
    expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
    expect(result.second.status).toBe('rejected');
    if (result.second.status === 'rejected') {
      expect(result.second.reason).toBe(initError);
    }
    expect(result.errors).toEqual([
      '第二分支初始化失败：B 事务已激活后启动失败',
      '第二分支回滚失败：回滚连接已断开',
      '第二分支释放失败：释放连接已断开',
    ]);
  });

  it('收尾失败不覆盖原始分支错误，并分别保留回滚与释放错误', async () => {
    const original = new Error('原始分支错误');
    const first = createFakeRunner({
      failRollback: new Error('回滚连接已断开'),
      failRelease: new Error('释放连接已断开'),
    });

    const result = await runTwoBranchTransactionRace({
      createRunner: createRunnerSequence([first.runner]),
      runFirst: () => Promise.reject(original),
      runSecond: () => Promise.resolve('second-value'),
      waitForCompetition: () => Promise.resolve(),
    });

    expect(first.calls).toEqual(['connect', 'startTransaction', 'rollback', 'release']);
    expect(result.first.status).toBe('rejected');
    if (result.first.status === 'rejected') {
      expect(result.first.reason).toBe(original);
    }
    expect(result.second.status).toBe('rejected');
    expect(result.errors).toEqual([
      '第一分支回滚失败：回滚连接已断开',
      '第一分支释放失败：释放连接已断开',
    ]);
  });

  it('正常竞争：观察到竞争后才提交，登记回调在提交之后执行', async () => {
    const first = createFakeRunner();
    const second = createFakeRunner();
    const committed: string[] = [];

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
    expect(result.first).toEqual({ status: 'fulfilled', value: 'first-value' });
    expect(result.second).toEqual({ status: 'fulfilled', value: 'second-value' });
    expect(committed).toEqual(expect.arrayContaining(['first:first-value', 'second:second-value']));
    expect(committed).toHaveLength(2);
  });
});
