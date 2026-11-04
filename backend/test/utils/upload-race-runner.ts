import type { QueryRunner } from 'typeorm';
import { destroyExclusiveQueryRunner } from './e2e-owned-fixture';

/** 竞争分支的初始化/收尾错误统一收集，便于调用方在断言前判断生命周期是否完整 */
export interface TwoBranchRaceOptions<T> {
  readonly createRunner: () => QueryRunner;
  readonly runFirst: (runner: QueryRunner) => Promise<T>;
  readonly runSecond: (runner: QueryRunner) => Promise<T>;
  readonly waitForCompetition: () => Promise<void>;
  readonly onFirstCommitted?: (value: T) => Promise<void>;
  readonly onSecondCommitted?: (value: T) => Promise<void>;
}

export interface TwoBranchRaceResult<T> {
  readonly first: PromiseSettledResult<T>;
  readonly second: PromiseSettledResult<T>;
  readonly errors: readonly string[];
}

/** 第一分支在等待竞争结果时收到取消信号，必须以回滚收尾而不是提交 */
export class RaceBranchCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaceBranchCancelledError';
  }
}

interface RunnerState {
  connected: boolean;
  destroyAttempted: boolean;
  destroyed: boolean;
}

const detailOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const destroyOnce = async (
  runner: QueryRunner,
  state: RunnerState,
  errors: string[],
  stage: string,
): Promise<void> => {
  if (state.destroyAttempted) return;
  state.destroyAttempted = true;
  const outcome = await destroyExclusiveQueryRunner(runner);
  state.destroyed = outcome.destroyed;
  if (!outcome.destroyed) {
    errors.push(`${stage}销毁独占连接未完成：${outcome.reason ?? '未知原因'}`);
  }
};

/**
 * 按驱动实际状态收尾（与 `runGuardedQueryRunnerTransaction` 相同的已验证模式）：
 * - 只要事务仍处于活动状态就尝试回滚，不依赖 `startTransaction()` 是否成功返回；
 * - 回滚失败或回滚后事务仍活动时，销毁本轮独占连接，禁止把活动事务以普通 `release()` 回池；
 * - 已销毁或销毁已尝试后不再执行 `release()`，避免把无法安全关闭的连接放回连接池；
 * - 仅对已建立连接的分支释放；未建立连接的分支不执行关闭；
 * - 主错误、回滚、销毁与释放错误分别收集，不相互覆盖。
 */
const settleRunner = async (
  runner: QueryRunner,
  state: RunnerState,
  errors: string[],
  label: string,
): Promise<void> => {
  let rollbackFailed = false;
  if (runner.isTransactionActive) {
    try {
      await runner.rollbackTransaction();
    } catch (error) {
      rollbackFailed = true;
      errors.push(`${label}回滚失败：${detailOf(error)}`);
    }
  }
  if (rollbackFailed || runner.isTransactionActive) {
    await destroyOnce(runner, state, errors, `${label}回滚后`);
  }
  if (state.destroyAttempted) {
    return;
  }
  if (runner.isTransactionActive) {
    await destroyOnce(runner, state, errors, `${label}收尾时`);
    return;
  }
  if (state.connected) {
    try {
      await runner.release();
    } catch (error) {
      errors.push(`${label}释放失败：${detailOf(error)}`);
    }
    state.connected = false;
  }
};

type FirstReady = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/**
 * 两分支事务竞争执行器。
 *
 * - A 先启动事务并执行，然后等待放行决定；B 在 A 就绪后启动。
 * - B 创建、连接或启动事务失败时向 A 发出取消信号，等待 A 回滚/销毁/释放后再返回。
 * - A 被取消后只回滚，不因放行 gate 误提交；只有观察到竞争或 B 已结束才允许提交。
 * - 返回前等待所有已启动分支完成收尾，分支错误、回滚、销毁与释放错误分别保留。
 */
export const runTwoBranchTransactionRace = async <T>(
  options: TwoBranchRaceOptions<T>,
): Promise<TwoBranchRaceResult<T>> => {
  const errors: string[] = [];

  let first: QueryRunner;
  try {
    first = options.createRunner();
  } catch (error) {
    // 第一连接未创建成功：没有已启动分支需要收尾，直接拒绝
    throw new Error(`第一分支创建失败：${detailOf(error)}`, { cause: error });
  }
  const firstState: RunnerState = { connected: false, destroyAttempted: false, destroyed: false };

  let resolveDecision: (decision: 'commit' | 'cancel') => void = () => undefined;
  const decision = new Promise<'commit' | 'cancel'>((resolve) => {
    resolveDecision = resolve;
  });
  let resolveFirstReady: (ready: FirstReady) => void = () => undefined;
  const firstReady = new Promise<FirstReady>((resolve) => {
    resolveFirstReady = resolve;
  });
  let firstReadySignalled = false;
  const signalFirstReady = (ready: FirstReady): void => {
    if (firstReadySignalled) return;
    firstReadySignalled = true;
    resolveFirstReady(ready);
  };

  const firstPromise: Promise<PromiseSettledResult<T>> = (async () => {
    try {
      await first.connect();
      firstState.connected = true;
      await first.startTransaction();
      const value = await options.runFirst(first);
      signalFirstReady({ ok: true });
      const action = await decision;
      if (action === 'cancel') {
        throw new RaceBranchCancelledError('竞争分支初始化失败，第一分支已取消并回滚，未提交');
      }
      await first.commitTransaction();
      if (options.onFirstCommitted) {
        await options.onFirstCommitted(value);
      }
      return { status: 'fulfilled', value };
    } catch (error) {
      signalFirstReady({ ok: false, error });
      return { status: 'rejected', reason: error };
    } finally {
      await settleRunner(first, firstState, errors, '第一分支');
    }
  })();

  const firstReadyResult = await firstReady;
  if (!firstReadyResult.ok) {
    return {
      first: await firstPromise,
      second: {
        status: 'rejected',
        reason: new Error(`前置分支失败，未启动竞争分支：${detailOf(firstReadyResult.error)}`),
      },
      errors,
    };
  }

  let second: QueryRunner | undefined;
  const secondState: RunnerState = { connected: false, destroyAttempted: false, destroyed: false };
  try {
    second = options.createRunner();
  } catch (createError) {
    // 第二连接创建同步失败：取消 A，等待 A 完成回滚/释放后再拒绝，不进入竞争等待
    errors.push(`第二分支创建失败：${detailOf(createError)}`);
    resolveDecision('cancel');
    await firstPromise;
    const teardownErrors = errors.filter((item) => !item.startsWith('第二分支创建失败'));
    const message = teardownErrors.length
      ? `第二分支创建失败：${detailOf(createError)}；收尾错误：${teardownErrors.join('；')}`
      : `第二分支创建失败：${detailOf(createError)}`;
    throw new Error(message, { cause: createError });
  }
  if (!second) {
    throw new Error('第二分支创建失败：驱动未返回连接');
  }

  try {
    await second.connect();
    secondState.connected = true;
    await second.startTransaction();
  } catch (error) {
    errors.push(`第二分支初始化失败：${detailOf(error)}`);
    resolveDecision('cancel');
    const firstOutcome = await firstPromise;
    await settleRunner(second, secondState, errors, '第二分支');
    return { first: firstOutcome, second: { status: 'rejected', reason: error }, errors };
  }
  const secondRunner = second;

  const secondPromise: Promise<PromiseSettledResult<T>> = (async () => {
    try {
      const value = await options.runSecond(secondRunner);
      await secondRunner.commitTransaction();
      if (options.onSecondCommitted) {
        await options.onSecondCommitted(value);
      }
      return { status: 'fulfilled', value };
    } catch (error) {
      return { status: 'rejected', reason: error };
    } finally {
      await settleRunner(secondRunner, secondState, errors, '第二分支');
    }
  })();

  let competitionResolved = false;
  try {
    await Promise.race([
      options.waitForCompetition(),
      secondPromise.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    competitionResolved = true;
  } catch (error) {
    errors.push(`等待竞争失败：${detailOf(error)}`);
  }
  // 等待竞争异常时取消 A（回滚），只有正常观察到竞争或 B 已结束才允许提交
  resolveDecision(competitionResolved ? 'commit' : 'cancel');

  const firstOutcome = await firstPromise;
  const secondOutcome = await secondPromise;
  return { first: firstOutcome, second: secondOutcome, errors };
};
