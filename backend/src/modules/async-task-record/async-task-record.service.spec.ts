// src/modules/async-task-record/async-task-record.service.spec.ts
// 账本条件收敛的写入契约（替身仓库）：
// - 只更新调用方观察到的来源状态（并发收尾后到者命中 0 行）；
// - 永不重写 succeeded 行；
// - 单条条件 UPDATE，不触碰任何业务表。

import type { CapabilityStateReader } from '@src/modules/common/capability-state-reader.contract';
import { AsyncTaskRecordEntity } from './async-task-record.entity';
import { AsyncTaskRecordService } from './async-task-record.service';

type QueryBuilderStub = {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  execute: jest.Mock;
};

const makeQueryBuilder = (affected: number | undefined): QueryBuilderStub => {
  const queryBuilder: QueryBuilderStub = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    execute: jest.fn(),
  };
  queryBuilder.update.mockReturnValue(queryBuilder);
  queryBuilder.set.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  queryBuilder.execute.mockResolvedValue({ affected });
  return queryBuilder;
};

describe('AsyncTaskRecordService.settleByQueueJob', () => {
  let queryBuilder: QueryBuilderStub;
  let repository: { createQueryBuilder: jest.Mock };
  let capabilityStateReader: { requireEnabled: jest.Mock };
  let service: AsyncTaskRecordService;

  beforeEach(() => {
    queryBuilder = makeQueryBuilder(1);
    repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
    capabilityStateReader = { requireEnabled: jest.fn() };
    service = new AsyncTaskRecordService(
      repository as unknown as never,
      capabilityStateReader as unknown as CapabilityStateReader,
    );
  });

  it('按 queueName + jobId + 来源状态条件更新，返回受影响行数', async () => {
    const finishedAt = new Date('2026-11-20T10:00:00.000Z');

    const affected = await service.settleByQueueJob({
      queueName: 'intake-analysis',
      jobId: 'intake-analysis:21:g0',
      fromStatuses: ['processing'],
      status: 'succeeded',
      reason: 'worker_completed:intake_reconciled',
      finishedAt,
    });

    expect(affected).toBe(1);
    expect(capabilityStateReader.requireEnabled).toHaveBeenCalledWith('runtime.async-task');
    expect(queryBuilder.update).toHaveBeenCalledWith(AsyncTaskRecordEntity);
    expect(queryBuilder.set).toHaveBeenCalledWith({
      status: 'succeeded',
      reason: 'worker_completed:intake_reconciled',
      finishedAt,
      occurredAt: finishedAt,
    });
    expect(queryBuilder.where).toHaveBeenCalledWith('queue_name = :queueName', {
      queueName: 'intake-analysis',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('job_id = :jobId', {
      jobId: 'intake-analysis:21:g0',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('status IN (:...fromStatuses)', {
      fromStatuses: ['processing'],
    });
  });

  it('并发收尾后到者：affected = 0 按跳过处理，不抛错', async () => {
    queryBuilder = makeQueryBuilder(0);
    repository.createQueryBuilder.mockReturnValue(queryBuilder);

    await expect(
      service.settleByQueueJob({
        queueName: 'intake-analysis',
        jobId: 'intake-analysis:21:g0',
        fromStatuses: ['failed'],
        status: 'cancelled',
        reason: 'intake_cancelled_target_deleted',
      }),
    ).resolves.toBe(0);
  });

  it('来源状态为空：不产生任何 UPDATE', async () => {
    const affected = await service.settleByQueueJob({
      queueName: 'intake-analysis',
      jobId: 'intake-analysis:21:g0',
      fromStatuses: [],
      status: 'failed',
      reason: 'worker_permanent:intake_job_id_unparsable',
    });

    expect(affected).toBe(0);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('拒绝以 succeeded 作为来源状态：成功结果不能被收敛改写', async () => {
    await expect(
      service.settleByQueueJob({
        queueName: 'intake-analysis',
        jobId: 'intake-analysis:21:g0',
        fromStatuses: ['succeeded'],
        status: 'failed',
        reason: 'worker_failed:intake_reconciled',
      }),
    ).rejects.toThrow('async_task_settle_from_succeeded_rejected');

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('未提供 reason/finishedAt 时不改写这两列（补投回 queued 意图态）', async () => {
    await service.settleByQueueJob({
      queueName: 'intake-analysis',
      jobId: 'intake-analysis:21:g0',
      fromStatuses: ['failed'],
      status: 'queued',
      reason: 'intake_housekeeping_redeliver',
    });

    const patch = queryBuilder.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: 'queued', reason: 'intake_housekeeping_redeliver' });
    expect(patch).not.toHaveProperty('finishedAt');
  });
});
