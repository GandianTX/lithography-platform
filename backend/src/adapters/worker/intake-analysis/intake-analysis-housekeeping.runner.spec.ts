// src/adapters/worker/intake-analysis/intake-analysis-housekeeping.runner.spec.ts
// housekeeping 运行时触发的受控启停纪律（替身注入 + fake timers）：
// - 能力未启用不启动循环（quiet state，backlog 保持未认领）；
// - 能力启用即执行首轮并按间隔续跑；
// - 运行中能力关闭：当前轮完成后停止循环，不再补投；
// - 单轮失败仅记日志，循环继续；
// - 上一轮未结束不重叠执行；
// - onModuleDestroy 清除计时器并等待在途执行。

import { Logger } from '@nestjs/common';
import type { IntakeAnalysisHousekeepingResult } from '@src/usecases/intake-analysis/intake-analysis-housekeeping.types';
import type { RunIntakeAnalysisHousekeepingUsecase } from '@src/usecases/intake-analysis/run-intake-analysis-housekeeping.usecase';
import type { IntakeAnalysisWorkerActivationUsecase } from '@src/usecases/intake-analysis/intake-analysis-worker-activation.usecase';
import {
  INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS,
  IntakeAnalysisHousekeepingRunner,
} from './intake-analysis-housekeeping.runner';

const buildResult = (): IntakeAnalysisHousekeepingResult => ({
  redeliverStaleQueued: {
    scanned: 0,
    redelivered: 0,
    reconciled: 0,
    parked: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
  },
  recoverStaleProcessing: {
    scanned: 0,
    redelivered: 0,
    reconciled: 0,
    parked: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
  },
  cancelOrphanedIntents: {
    scanned: 0,
    redelivered: 0,
    reconciled: 0,
    parked: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
  },
});

describe('IntakeAnalysisHousekeepingRunner', () => {
  let housekeeping: { readonly execute: jest.Mock<Promise<IntakeAnalysisHousekeepingResult>> };
  let activation: { readonly shouldRun: jest.Mock<boolean, []> };
  let runner: IntakeAnalysisHousekeepingRunner;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    housekeeping = { execute: jest.fn().mockResolvedValue(buildResult()) };
    activation = { shouldRun: jest.fn(() => true) };
    runner = new IntakeAnalysisHousekeepingRunner(
      housekeeping as unknown as RunIntakeAnalysisHousekeepingUsecase,
      activation as unknown as IntakeAnalysisWorkerActivationUsecase,
    );
  });

  afterEach(async () => {
    await runner.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('能力未启用：bootstrap 不启动循环（quiet state）', async () => {
    activation.shouldRun.mockReturnValue(false);

    runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS * 3);

    expect(housekeeping.execute).not.toHaveBeenCalled();
  });

  it('能力启用：bootstrap 后先执行一轮，再按间隔续跑', async () => {
    runner.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(0);
    expect(housekeeping.execute).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS);
    expect(housekeeping.execute).toHaveBeenCalledTimes(2);
  });

  it('能力运行中被关闭：当前轮完成后停止循环，不再补投', async () => {
    runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(housekeeping.execute).toHaveBeenCalledTimes(1);

    activation.shouldRun.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS * 3);

    expect(housekeeping.execute).toHaveBeenCalledTimes(1);
  });

  it('单轮失败：记录错误且循环继续', async () => {
    const errorSpy = Logger.prototype.error as jest.Mock;
    housekeeping.execute.mockRejectedValueOnce(new Error('db unreachable'));

    runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(errorSpy).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS);
    expect(housekeeping.execute).toHaveBeenCalledTimes(2);
  });

  it('上一轮未结束：不重叠，顺延到结束后再跑下一轮', async () => {
    const gate: { release?: () => void } = {};
    housekeeping.execute.mockImplementationOnce(
      () =>
        new Promise<IntakeAnalysisHousekeepingResult>((resolve) => {
          gate.release = () => resolve(buildResult());
        }),
    );

    runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(housekeeping.execute).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS * 2);
    expect(housekeeping.execute).toHaveBeenCalledTimes(1);

    gate.release?.();
    await jest.advanceTimersByTimeAsync(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS);
    expect(housekeeping.execute).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy：等待在途执行结束后返回', async () => {
    const gate: { release?: () => void } = {};
    housekeeping.execute.mockImplementationOnce(
      () =>
        new Promise<IntakeAnalysisHousekeepingResult>((resolve) => {
          gate.release = () => resolve(buildResult());
        }),
    );

    runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    const destroy = runner.onModuleDestroy();
    expect(housekeeping.execute).toHaveBeenCalledTimes(1);
    gate.release?.();
    await destroy;

    // 销毁后不再续跑
    await jest.advanceTimersByTimeAsync(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS * 2);
    expect(housekeeping.execute).toHaveBeenCalledTimes(1);
  });
});
