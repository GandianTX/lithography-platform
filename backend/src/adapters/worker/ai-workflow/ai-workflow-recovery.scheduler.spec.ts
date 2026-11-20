// src/adapters/worker/ai-workflow/ai-workflow-recovery.scheduler.spec.ts
// 任务05 S2.1-5／S2.1-6 纠偏：恢复必须由正式 Worker 生命周期触发，且受能力门禁约束。

import {
  AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
  AI_WORKFLOW_RECOVERY_INTERVAL_MS,
  AI_WORKFLOW_RECOVERY_LOOKBACK_MS,
  AiWorkflowRecoveryScheduler,
} from './ai-workflow-recovery.scheduler';

type PhaseResult = { scanned: number; succeeded: number; failed: number; skipped: number };

function createPhaseResult(): PhaseResult {
  return { scanned: 0, succeeded: 0, failed: 0, skipped: 0 };
}

describe('AiWorkflowRecoveryScheduler', () => {
  let shouldRun: jest.Mock<boolean, []>;
  let execute: jest.Mock<Promise<unknown>, [unknown]>;
  let sweep: jest.Mock<Promise<{ scanned: number; settled: number; skipped: number }>, [unknown]>;
  let logger: { setContext: jest.Mock; info: jest.Mock; warn: jest.Mock; debug: jest.Mock };
  let scheduler: AiWorkflowRecoveryScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    shouldRun = jest.fn().mockReturnValue(true);
    execute = jest.fn().mockResolvedValue({
      admission: createPhaseResult(),
      staleQueued: createPhaseResult(),
      asyncTaskReconcile: createPhaseResult(),
    });
    sweep = jest.fn().mockResolvedValue({ scanned: 0, settled: 0, skipped: 0 });
    logger = { debug: jest.fn(), info: jest.fn(), setContext: jest.fn(), warn: jest.fn() };

    scheduler = new AiWorkflowRecoveryScheduler(
      { shouldRun } as never,
      { execute } as never,
      { sweep } as never,
      logger as never,
    );
  });

  afterEach(() => {
    scheduler.stop();
    jest.useRealTimers();
  });

  it('能力未启用时不启动调度，也不执行任何恢复', async () => {
    shouldRun.mockReturnValue(false);

    scheduler.onApplicationBootstrap();
    await Promise.resolve();

    expect(scheduler.isRunning()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('能力启用时启动后立即跑一轮并按下发间隔重复', async () => {
    scheduler.onApplicationBootstrap();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.isRunning()).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(AI_WORKFLOW_RECOVERY_INTERVAL_MS);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('先做工作流侧恢复，再按回看窗口补写 analysis', async () => {
    const now = new Date('2026-11-20T02:00:00.000Z');

    await scheduler.tick(now);

    expect(execute).toHaveBeenCalledWith({ now, limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT });
    expect(sweep).toHaveBeenCalledWith({
      since: new Date(now.getTime() - AI_WORKFLOW_RECOVERY_LOOKBACK_MS),
      limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
    });
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(sweep.mock.invocationCallOrder[0]);
  });

  it('单飞：上一轮未结束时跳过新一轮', async () => {
    const gate: { release?: () => void } = {};
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({
              admission: createPhaseResult(),
              staleQueued: createPhaseResult(),
              asyncTaskReconcile: createPhaseResult(),
            });
        }),
    );

    const first = scheduler.tick(new Date('2026-11-20T02:00:00.000Z'));
    await scheduler.tick(new Date('2026-11-20T02:00:01.000Z'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(sweep).not.toHaveBeenCalled();

    gate.release?.();
    await first;
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('单轮失败只记日志，不把异常抛给进程', async () => {
    execute.mockRejectedValue(new Error('db down'));

    await expect(scheduler.tick(new Date())).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('停机释放定时器后不再发起新一轮', async () => {
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.isRunning()).toBe(true);

    scheduler.onApplicationShutdown();
    const callsAfterStop = execute.mock.calls.length;
    await jest.advanceTimersByTimeAsync(AI_WORKFLOW_RECOVERY_INTERVAL_MS * 3);

    expect(scheduler.isRunning()).toBe(false);
    expect(execute.mock.calls.length).toBe(callsAfterStop);
  });

  it('窗口命中批量上限时给出可观测告警（避免长期追不上而无人发现）', async () => {
    sweep.mockResolvedValue({ scanned: AI_WORKFLOW_RECOVERY_BATCH_LIMIT, settled: 0, skipped: 0 });

    await scheduler.tick(new Date());

    expect(logger.warn).toHaveBeenCalledWith(
      { scanned: AI_WORKFLOW_RECOVERY_BATCH_LIMIT, batchLimit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT },
      '恢复扫描达到批量上限，窗口内仍有未结算执行',
    );
  });

  it('有实际推进时记录可诊断日志', async () => {
    execute.mockResolvedValue({
      admission: { scanned: 1, succeeded: 1, failed: 0, skipped: 0 },
      staleQueued: createPhaseResult(),
      asyncTaskReconcile: createPhaseResult(),
    });
    sweep.mockResolvedValue({ scanned: 1, settled: 1, skipped: 0 });

    await scheduler.tick(new Date());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ settlement: { scanned: 1, settled: 1, skipped: 0 } }),
      'AI workflow 恢复扫描完成',
    );
  });
});
