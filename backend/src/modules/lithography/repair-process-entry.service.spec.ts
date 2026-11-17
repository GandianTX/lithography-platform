// src/modules/lithography/repair-process-entry.service.spec.ts

import { DomainError, REPAIR_REQUEST_ERROR } from '@src/core/common/errors/domain-error';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { EntityManager, FindOperator, Repository } from 'typeorm';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairProcessEntryService } from './repair-process-entry.service';

describe('RepairProcessEntryService', () => {
  const createdAt = new Date('2026-11-16T09:00:00.000Z');
  let repository: ReturnType<typeof createMockRepository>;
  let service: RepairProcessEntryService;

  const asContext = (repo: unknown) =>
    createTypeOrmPersistenceTransactionContext({
      getRepository: () => repo,
    } as unknown as EntityManager);

  beforeEach(() => {
    repository = createMockRepository();
    service = new RepairProcessEntryService(
      repository as unknown as Repository<RepairProcessEntryEntity>,
    );
  });

  it('insertEntry 以 versionNo=1 与服务端 UUID 落库并映射稳定快照', async () => {
    const data = {
      requestId: 11,
      authorAccountId: 9,
      operationText: '更换光学模块',
      testResult: '通过',
      occurredAt: null,
      timeSource: 'SERVER',
      fileId: 'file-1',
    };
    repository.create.mockImplementation((entity: Record<string, unknown>) => entity);
    repository.save.mockImplementation((entity: Record<string, unknown>) => ({
      ...entity,
      id: 12,
      createdAt,
    }));

    const snapshot = await service.insertEntry(data, asContext(repository));

    const created = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created).toMatchObject({
      requestId: 11,
      authorAccountId: 9,
      operationText: '更换光学模块',
      testResult: '通过',
      timeSource: 'SERVER',
      fileId: 'file-1',
      versionNo: 1,
    });
    expect(created.entryUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(snapshot).toEqual({
      id: '12',
      entryUuid: created.entryUuid,
      requestId: 11,
      authorAccountId: 9,
      operationText: '更换光学模块',
      testResult: '通过',
      occurredAt: null,
      timeSource: 'SERVER',
      fileId: 'file-1',
      versionNo: 1,
      createdAt,
    });
  });

  it('insertEntry 落库异常包装为过程写失败，details 只含 requestId', async () => {
    repository.create.mockImplementation((entity: Record<string, unknown>) => entity);
    const dbError = new Error('INSERT INTO repair_process_entry failed');
    repository.save.mockRejectedValue(dbError);

    let caught: unknown;
    try {
      await service.insertEntry(
        {
          requestId: 11,
          authorAccountId: 9,
          operationText: '更换光学模块',
          testResult: null,
          occurredAt: null,
          timeSource: 'SERVER',
          fileId: null,
        },
        asContext(repository),
      );
    } catch (error) {
      caught = error;
    }

    const domainError = caught as DomainError;
    expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED);
    expect(domainError.details).toEqual({ requestId: 11 });
    expect(JSON.stringify(domainError.details)).not.toContain('repair_process_entry');
    expect(domainError.cause).toBe(dbError);
  });

  it('findForUpdate 使用 (id, requestId) 主键条件与 pessimistic_write 锁读', async () => {
    repository.findOne.mockResolvedValue({
      id: 12,
      entryUuid: 'entry-1',
      requestId: 11,
      authorAccountId: 9,
      operationText: '更换光学模块',
      testResult: null,
      occurredAt: null,
      timeSource: 'SERVER',
      fileId: null,
      versionNo: 2,
      createdAt,
    });

    await expect(service.findForUpdate(11, '12', asContext(repository))).resolves.toMatchObject({
      id: '12',
      requestId: 11,
      versionNo: 2,
    });
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: '12', requestId: 11 },
      lock: { mode: 'pessimistic_write' },
    });

    repository.findOne.mockResolvedValueOnce(null);
    await expect(service.findForUpdate(11, '99', asContext(repository))).resolves.toBeNull();
  });

  it('updateWithVersion 按作者与期望版本条件更新并递增版本号', async () => {
    repository.update.mockResolvedValue({ affected: 1 });
    const data = {
      entryId: '12',
      requestId: 11,
      authorAccountId: 9,
      expectedVersion: 2,
      operationText: '更换光学模块并复测',
      testResult: '通过',
      occurredAt: null,
      timeSource: 'SERVER',
    };

    await expect(service.updateWithVersion(data, asContext(repository))).resolves.toBe(1);

    expect(repository.update).toHaveBeenCalledWith(
      { id: '12', requestId: 11, authorAccountId: 9, versionNo: 2 },
      expect.objectContaining({
        operationText: '更换光学模块并复测',
        testResult: '通过',
      }),
    );
    const patch = repository.update.mock.calls[0][1] as { versionNo: () => string };
    expect(patch.versionNo()).toBe('version_no + 1');
  });

  it('updateWithVersion 补传原件时同时约束 file_id IS NULL 并写入新 fileId', async () => {
    repository.update.mockResolvedValue({ affected: 1 });

    await expect(
      service.updateWithVersion(
        {
          entryId: '12',
          requestId: 11,
          authorAccountId: 9,
          expectedVersion: 2,
          operationText: '补传现场照片',
          testResult: null,
          occurredAt: null,
          timeSource: 'SERVER',
          fileId: 'file-new',
        },
        asContext(repository),
      ),
    ).resolves.toBe(1);

    const [criteria, patch] = repository.update.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown> & { versionNo: () => string },
    ];
    expect(criteria).toMatchObject({ id: '12', requestId: 11, authorAccountId: 9, versionNo: 2 });
    expect(criteria.fileId).toBeInstanceOf(FindOperator);
    expect((criteria.fileId as FindOperator<unknown>).type).toBe('isNull');
    expect(patch.fileId).toBe('file-new');
    expect(patch.versionNo()).toBe('version_no + 1');
  });

  it('updateWithVersion 未传 fileId 时条件与补丁都不含 file_id，保持原绑定', async () => {
    repository.update.mockResolvedValue({ affected: 1 });

    await service.updateWithVersion(
      {
        entryId: '12',
        requestId: 11,
        authorAccountId: 9,
        expectedVersion: 2,
        operationText: '仅改文字',
        testResult: null,
        occurredAt: null,
        timeSource: 'SERVER',
      },
      asContext(repository),
    );

    const [criteria, patch] = repository.update.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(criteria).not.toHaveProperty('fileId');
    expect(patch).not.toHaveProperty('fileId');
  });

  it('updateWithVersion 未命中返回 0；数据库异常包装为过程写失败', async () => {
    repository.update.mockResolvedValueOnce({ affected: 0 });
    await expect(
      service.updateWithVersion(
        {
          entryId: '12',
          requestId: 11,
          authorAccountId: 9,
          expectedVersion: 1,
          operationText: '并发后旧版本',
          testResult: null,
          occurredAt: null,
          timeSource: 'SERVER',
        },
        asContext(repository),
      ),
    ).resolves.toBe(0);

    repository.update.mockRejectedValueOnce(new Error('deadlock found'));
    await expect(
      service.updateWithVersion(
        {
          entryId: '12',
          requestId: 11,
          authorAccountId: 9,
          expectedVersion: 1,
          operationText: '并发后旧版本',
          testResult: null,
          occurredAt: null,
          timeSource: 'SERVER',
        },
        asContext(repository),
      ),
    ).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
      details: { requestId: 11 },
    });
  });
});
