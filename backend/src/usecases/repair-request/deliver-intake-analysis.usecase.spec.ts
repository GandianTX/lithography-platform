// src/usecases/intake-analysis/deliver-intake-analysis.usecase.spec.ts
// 投递用例：入队成功 / 失败降级（不上抛，账本行交给 housekeeping）。

import type { IntakeAnalysisQueueService } from '@src/modules/lithography/queue/intake-analysis-queue.service';
import { DeliverIntakeAnalysisUsecase } from './deliver-intake-analysis.usecase';

describe('DeliverIntakeAnalysisUsecase', () => {
  let queueService: { enqueueIntakeAnalysis: jest.Mock };
  let usecase: DeliverIntakeAnalysisUsecase;

  beforeEach(() => {
    queueService = {
      enqueueIntakeAnalysis: jest
        .fn()
        .mockResolvedValue({ jobId: 'intake-analysis:21:g0', traceId: 'trace-1' }),
    };
    usecase = new DeliverIntakeAnalysisUsecase(
      queueService as unknown as IntakeAnalysisQueueService,
    );
  });

  it('入队成功：delivered=true 且 jobId/traceId 原样返回', async () => {
    const result = await usecase.execute({ intakeId: 21, generationNo: 0, traceId: 'trace-1' });

    expect(result).toEqual({ delivered: true, jobId: 'intake-analysis:21:g0', traceId: 'trace-1' });
    expect(queueService.enqueueIntakeAnalysis).toHaveBeenCalledWith({
      intakeId: 21,
      generationNo: 0,
      traceId: 'trace-1',
    });
  });

  it('入队抛错（如队列不可用 / 能力被禁用）：降级 delivered=false，不上抛', async () => {
    queueService.enqueueIntakeAnalysis.mockRejectedValueOnce(new Error('QUEUE_UNAVAILABLE'));

    await expect(
      usecase.execute({ intakeId: 21, generationNo: 0, traceId: 'trace-1' }),
    ).resolves.toEqual({ delivered: false, jobId: 'intake-analysis:21:g0', traceId: 'trace-1' });
  });

  it('代次进入投递意图：重试（g1）与首投（g0）是不同的投递目标', async () => {
    await usecase.execute({ intakeId: 21, generationNo: 0, traceId: 't1' });
    await usecase.execute({ intakeId: 21, generationNo: 1, traceId: 't2' });

    expect(queueService.enqueueIntakeAnalysis).toHaveBeenNthCalledWith(1, {
      intakeId: 21,
      generationNo: 0,
      traceId: 't1',
    });
    expect(queueService.enqueueIntakeAnalysis).toHaveBeenNthCalledWith(2, {
      intakeId: 21,
      generationNo: 1,
      traceId: 't2',
    });
  });
});
