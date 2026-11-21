// src/adapters/worker/ai-workflow/ai-workflow-recovery.scheduler.spec.ts
// 任务05 S2.1-5／S2.1-6 纠偏：恢复必须由正式 Worker 生命周期触发，且受能力门禁约束。
// 2026-11-20 复验 P2-1：结算扫描改为键集游标推进，满批保留末键、到末尾回绕。

import {
  AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
  AI_WORKFLOW_RECOVERY_INTERVAL_MS,
  AiWorkflowRecoveryScheduler,
} from './ai-workflow-recovery.scheduler';

type PhaseResult = { scanned: number; succeeded: number; failed: number; skipped: number };

type SweepResult = {
  scanned: number;
  settled: number;
  skipped: number;
  failed: number;
  nextCursor: string | null;
  reachedEnd: boolean;
};

function createPhaseResult(): PhaseResult {
  return { scanned: 0, succeeded: 0, failed: 0, skipped: 0 };
}

function createSweepResult(overrides: Partial<SweepResult> = {}): SweepResult {
  return {
    scanned: 0,
    settled: 0,
    skipped: 0,
    failed: 0,
    nextCursor: null,
    reachedEnd: true,
    ...overrides,
  };
}

describe('AiWorkflowRecoveryScheduler', () => {
  let shouldRun: jest.Mock<boolean, []>;
  let execute: jest.Mock<Promise<unknown>, [unknown]>;
  let sweep: jest.Mock<Promise<SweepResult>, [unknown]>;
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
    sweep = jest.fn().mockResolvedValue(createSweepResult());
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

  it('先做工作流侧恢复，再从候选头部开始结算（启动即从头扫）', async () => {
    const now = new Date('2026-11-20T02:00:00.000Z');

    await scheduler.tick(now);

    expect(execute).toHaveBeenCalledWith({ now, limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT });
    expect(sweep).toHaveBeenCalledWith({
      afterQuestionUuid: null,
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

  it('满批时保留末键，下一轮从末键之后继续（不重复扫同一批）', async () => {
    sweep
      .mockResolvedValueOnce(
        createSweepResult({
          scanned: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
          nextCursor: 'q-050',
          reachedEnd: false,
        }),
      )
      .mockResolvedValueOnce(createSweepResult({ scanned: 1, nextCursor: null, reachedEnd: true }));

    await scheduler.tick(new Date());
    await scheduler.tick(new Date());

    expect(sweep).toHaveBeenNthCalledWith(1, {
      afterQuestionUuid: null,
      limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
    });
    expect(sweep).toHaveBeenNthCalledWith(2, {
      afterQuestionUuid: 'q-050',
      limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      { scanned: AI_WORKFLOW_RECOVERY_BATCH_LIMIT, nextCursor: 'q-050' },
      '恢复扫描本批已满，下一轮从末键继续',
    );
  });

  it('读到候选末尾后下一轮回绕到头部（重新覆盖跳过与异常项）', async () => {
    sweep
      .mockResolvedValueOnce(
        createSweepResult({ scanned: 3, nextCursor: 'q-003', reachedEnd: false }),
      )
      .mockResolvedValueOnce(createSweepResult({ scanned: 1, nextCursor: null, reachedEnd: true }))
      .mockResolvedValueOnce(createSweepResult({ scanned: 2, nextCursor: null, reachedEnd: true }));

    await scheduler.tick(new Date());
    await scheduler.tick(new Date());
    await scheduler.tick(new Date());

    expect(sweep.mock.calls[1]?.[0]).toEqual({
      afterQuestionUuid: 'q-003',
      limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
    });
    expect(sweep.mock.calls[2]?.[0]).toEqual({
      afterQuestionUuid: null,
      limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
    });
  });

  it('候选读取抛错时保留原游标，不会跳到未处理区间', async () => {
    sweep
      .mockResolvedValueOnce(
        createSweepResult({ scanned: 50, nextCursor: 'q-050', reachedEnd: false }),
      )
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce(createSweepResult());

    await scheduler.tick(new Date());
    await scheduler.tick(new Date());
    await scheduler.tick(new Date());

    expect(sweep.mock.calls[1]?.[0]).toEqual({
      afterQuestionUuid: 'q-050',
      limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
    });
    // 读取失败后游标仍是 q-050，而不是被重置为 null
    expect(sweep.mock.calls[2]?.[0]).toEqual({
      afterQuestionUuid: 'q-050',
      limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
    });
  });

  it('有实际推进或单条异常时记录可诊断日志', async () => {
    execute.mockResolvedValue({
      admission: { scanned: 1, succeeded: 1, failed: 0, skipped: 0 },
      staleQueued: createPhaseResult(),
      asyncTaskReconcile: createPhaseResult(),
    });
    sweep.mockResolvedValue(createSweepResult({ scanned: 2, settled: 1, skipped: 0, failed: 1 }));

    await scheduler.tick(new Date());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        settlement: expect.objectContaining({ scanned: 2, settled: 1, failed: 1 }),
      }),
      'AI workflow 恢复扫描完成',
    );
  });
});
