// src/modules/lithography/queue/intake-analysis-queue.service.spec.ts
// 状态感知补投逻辑单测（替身 producer）。
//
// 核心语义（BullMQ 5.x 同 jobId）：
// - 在途（waiting/active/delayed）→ in_flight，不产生 enqueue；
// - 终态保留（completed/failed）→ 先 remove（removed=true 才继续）再 enqueue；
//   removed=false → skipped，绝不假称恢复成功；
// - 不存在（unknown）→ 直接 enqueue（崩溃恢复主路径）。

import type { PinoLogger } from 'nestjs-pino';
import type { BullMqProducerGateway } from '@src/infrastructure/bullmq/producer.gateway';
import {
  INTAKE_ANALYSIS_CAPABILITY_ID,
  IntakeAnalysisQueueService,
} from './intake-analysis-queue.service';

const buildInput = { intakeId: 21, generationNo: 0, traceId: 'trace-1' } as const;

describe('IntakeAnalysisQueueService.redeliverIntakeAnalysis', () => {
  const createService = (
    overrides: {
      getJobState?: jest.Mock;
      removeJob?: jest.Mock;
      enqueue?: jest.Mock;
    } = {},
  ) => {
    const producer = {
      getJobState: overrides.getJobState ?? jest.fn().mockResolvedValue({ state: 'unknown' }),
      removeJob: overrides.removeJob ?? jest.fn().mockResolvedValue({ removed: true }),
      enqueue:
        overrides.enqueue ??
        jest.fn().mockResolvedValue({ jobId: 'intake-analysis:21:g0', traceId: 'trace-1' }),
      hasJob: jest.fn(),
    };
    const capabilityStateReader = {
      requireEnabled: jest.fn(),
      getState: jest.fn(),
    };
    const logger = { setContext: jest.fn(), info: jest.fn() };
    const service = new IntakeAnalysisQueueService(
      producer as unknown as BullMqProducerGateway,
      logger as unknown as PinoLogger,
      capabilityStateReader,
    );
    return { producer, capabilityStateReader, service };
  };

  it('能力被禁用：requireEnabled 直接拒绝，任何投递动作都不发生', async () => {
    const { capabilityStateReader, producer, service } = createService();
    capabilityStateReader.requireEnabled.mockImplementation(() => {
      throw new Error('capability_disabled');
    });

    await expect(service.redeliverIntakeAnalysis(buildInput)).rejects.toThrow(
      'capability_disabled',
    );
    expect(producer.getJobState).not.toHaveBeenCalled();
    expect(producer.removeJob).not.toHaveBeenCalled();
    expect(producer.enqueue).not.toHaveBeenCalled();
  });

  it('job 在途（waiting/active/delayed）→ in_flight，不 enqueue', async () => {
    for (const state of ['waiting', 'active', 'delayed'] as const) {
      const { producer, service } = createService({
        getJobState: jest.fn().mockResolvedValue({ state }),
      });
      await expect(service.redeliverIntakeAnalysis(buildInput)).resolves.toEqual({
        kind: 'in_flight',
      });
      expect(producer.enqueue).not.toHaveBeenCalled();
      expect(producer.removeJob).not.toHaveBeenCalled();
    }
  });

  it('job 终态保留（completed/failed）且移除成功 → 先 remove 再 enqueue', async () => {
    for (const state of ['completed', 'failed'] as const) {
      const { producer, service } = createService({
        getJobState: jest.fn().mockResolvedValue({ state }),
      });
      await expect(service.redeliverIntakeAnalysis(buildInput)).resolves.toEqual({
        kind: 'redelivered',
        basis: 'job_terminal_removed',
      });
      expect(producer.removeJob).toHaveBeenCalledTimes(1);
      expect(producer.enqueue).toHaveBeenCalledTimes(1);
      expect(producer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: 'intake-analysis',
          jobName: 'analyze',
          explicitJobId: 'intake-analysis:21:g0',
          traceId: 'trace-1',
        }),
      );
    }
  });

  it('job 终态保留但移除失败（被锁定等）→ skipped，不 enqueue、不假称恢复', async () => {
    const { producer, service } = createService({
      getJobState: jest.fn().mockResolvedValue({ state: 'failed' }),
      removeJob: jest.fn().mockResolvedValue({ removed: false }),
    });

    await expect(service.redeliverIntakeAnalysis(buildInput)).resolves.toEqual({
      kind: 'skipped',
      reason: 'job_remove_failed',
    });
    expect(producer.enqueue).not.toHaveBeenCalled();
  });

  it('job 不存在（unknown）→ 直接 enqueue（崩溃恢复主路径）', async () => {
    const { producer, service } = createService({
      getJobState: jest.fn().mockResolvedValue({ state: 'unknown' }),
    });

    await expect(service.redeliverIntakeAnalysis(buildInput)).resolves.toEqual({
      kind: 'redelivered',
      basis: 'job_missing',
    });
    expect(producer.removeJob).not.toHaveBeenCalled();
    expect(producer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('终态移除成功但重新入队失败 → 抛错上抛（本轮不算恢复；账本行未动，下轮按 job_missing 再恢复）', async () => {
    const { producer, service } = createService({
      getJobState: jest.fn().mockResolvedValue({ state: 'failed' }),
      removeJob: jest.fn().mockResolvedValue({ removed: true }),
      enqueue: jest.fn().mockRejectedValue(new Error('redis write failed')),
    });

    await expect(service.redeliverIntakeAnalysis(buildInput)).rejects.toThrow('redis write failed');
    // 移除已发生，但入队失败 → 本轮不产生任何「恢复成功」结论；
    // 持久状态 = 账本行保持原状 + Redis 中 job 已不存在 → 下轮 job_missing 路径可恢复
    expect(producer.removeJob).toHaveBeenCalledTimes(1);
    expect(producer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('终态路径的 remove 严格发生在 enqueue 之前（调用顺序断言）', async () => {
    const { producer, service } = createService({
      getJobState: jest.fn().mockResolvedValue({ state: 'completed' }),
    });

    await service.redeliverIntakeAnalysis(buildInput);

    const removeOrder = producer.removeJob.mock.invocationCallOrder[0];
    const enqueueOrder = producer.enqueue.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(enqueueOrder);
  });

  it('并发补投同一终态 job：仅 remove=1 者补投，remove=0 者 skipped，恰好一次 enqueue', async () => {
    // 两个 housekeeping 实例共享同一 Redis：B 在 A 移除后 remove 返回 0
    const { producer, service } = createService({
      getJobState: jest.fn().mockResolvedValue({ state: 'failed' }),
      removeJob: jest
        .fn()
        .mockResolvedValueOnce({ removed: true })
        .mockResolvedValueOnce({ removed: false }),
    });

    const [first, second] = await Promise.all([
      service.redeliverIntakeAnalysis(buildInput),
      service.redeliverIntakeAnalysis(buildInput),
    ]);

    expect(first).toEqual({ kind: 'redelivered', basis: 'job_terminal_removed' });
    expect(second).toEqual({ kind: 'skipped', reason: 'job_remove_failed' });
    expect(producer.enqueue).toHaveBeenCalledTimes(1);
    // 失败方不产生任何持久写入：账本行由调用方保持原状，仍可恢复
  });

  it('并发 job_missing：两次补投携带同一确定性 jobId（BullMQ add 幂等吸收重复）', async () => {
    const { producer, service } = createService({
      getJobState: jest.fn().mockResolvedValue({ state: 'unknown' }),
    });

    await Promise.all([
      service.redeliverIntakeAnalysis(buildInput),
      service.redeliverIntakeAnalysis(buildInput),
    ]);

    expect(producer.enqueue).toHaveBeenCalledTimes(2);
    const jobIds = producer.enqueue.mock.calls.map(
      (call) => (call[0] as { explicitJobId: string }).explicitJobId,
    );
    expect(new Set(jobIds)).toEqual(new Set(['intake-analysis:21:g0']));
    // BullMQ addStandardJob 对已存在 jobId 走 handleDuplicatedJob：不重新入 wait，
    // 重复 add 不会形成第二个执行；真实 Redis 行为待验（见实库验收清单）
  });

  it('getIntakeAnalysisJobState 透传归一化状态', async () => {
    const { producer, service } = createService({
      getJobState: jest.fn().mockResolvedValue({ state: 'delayed' }),
    });

    await expect(
      service.getIntakeAnalysisJobState({ intakeId: 21, generationNo: 0 }),
    ).resolves.toBe('delayed');
    expect(producer.getJobState).toHaveBeenCalledWith({
      queueName: 'intake-analysis',
      jobId: 'intake-analysis:21:g0',
    });
  });

  it('enqueue 路径仍走能力门禁（requireEnabled）', async () => {
    const { capabilityStateReader, producer, service } = createService();
    await service.redeliverIntakeAnalysis(buildInput);
    expect(capabilityStateReader.requireEnabled).toHaveBeenCalledWith(
      INTAKE_ANALYSIS_CAPABILITY_ID,
    );
    expect(producer.enqueue).toHaveBeenCalledTimes(1);
  });
});
