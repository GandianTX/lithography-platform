import type { QueryRunner } from 'typeorm';

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

/**
 * 按驱动实际状态收尾：只要事务仍处于活动状态就尝试回滚（不依赖 startTransaction 是否成功返回），
 * 仅对已建立的连接释放；回滚与释放错误单独收集，不覆盖分支自身的失败原因。
 */
const settleRunner = async (
  runner: QueryRunner,
  state: RunnerState,
  errors: string[],
  label: string,
): Promise<void> => {
  if (runner.isTransactionActive) {
    try {
      await runner.rollbackTransaction();
    } catch (error) {
      errors.push(`${label}回滚失败：${detailOf(error)}`);
    }
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
 * - B 初始化失败时向 A 发出取消信号，等待 A 回滚并释放后再返回。
 * - 只有观察到竞争或 B 已结束才放行 A 提交；异常路径一律取消，不无条件提交。
 * - 返回前等待两个分支全部收尾，分支错误、回滚错误与释放错误分别保留。
 */
export const runTwoBranchTransactionRace = async <T>(
  options: TwoBranchRaceOptions<T>,
): Promise<TwoBranchRaceResult<T>> => {
  const errors: string[] = [];

  const first = options.createRunner();
  const firstState: RunnerState = { connected: false };

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

  const second = options.createRunner();
  const secondState: RunnerState = { connected: false };
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

  const secondPromise: Promise<PromiseSettledResult<T>> = (async () => {
    try {
      const value = await options.runSecond(second);
      await second.commitTransaction();
      if (options.onSecondCommitted) {
        await options.onSecondCommitted(value);
      }
      return { status: 'fulfilled', value };
    } catch (error) {
      return { status: 'rejected', reason: error };
    } finally {
      await settleRunner(second, secondState, errors, '第二分支');
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
