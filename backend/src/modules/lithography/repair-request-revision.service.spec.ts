// src/modules/lithography/repair-request-revision.service.spec.ts

import { DomainError, REPAIR_REQUEST_ERROR } from '@src/core/common/errors/domain-error';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { EntityManager, Repository } from 'typeorm';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairRequestDiagnosticStepEntity } from './entities/repair-request-diagnostic-step.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestFaultPanelEntity } from './entities/repair-request-fault-panel.entity';
import { RepairRequestRevisionEntity } from './entities/repair-request-revision.entity';
import { RepairRequestRevisionService } from './repair-request-revision.service';

describe('RepairRequestRevisionService', () => {
  const createdAt = new Date('2026-11-16T08:00:00.000Z');
  let requestRepository: ReturnType<typeof createMockRepository>;
  let intakeRepository: ReturnType<typeof createMockRepository>;
  let revisionRepository: ReturnType<typeof createMockRepository>;
  let processEntryRepository: ReturnType<typeof createMockRepository>;
  let responseRepository: ReturnType<typeof createMockRepository>;
  let stepRepository: ReturnType<typeof createMockRepository>;
  let panelRepository: ReturnType<typeof createMockRepository>;
  let service: RepairRequestRevisionService;

  const asContext = (repo: unknown) =>
    createTypeOrmPersistenceTransactionContext({
      getRepository: () => repo,
    } as unknown as EntityManager);

  const createUpdateBuilder = (affected: number) => {
    const execute = jest.fn().mockResolvedValue({ affected });
    const chain = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute,
    };
    chain.update.mockReturnValue(chain);
    chain.set.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.andWhere.mockReturnValue(chain);
    return chain;
  };

  beforeEach(() => {
    requestRepository = createMockRepository();
    intakeRepository = createMockRepository();
    (requestRepository as unknown as { manager: { getRepository: jest.Mock } }).manager = {
      getRepository: jest.fn(() => intakeRepository),
    };
    revisionRepository = createMockRepository();
    processEntryRepository = createMockRepository();
    responseRepository = createMockRepository();
    stepRepository = createMockRepository();
    panelRepository = createMockRepository();
    service = new RepairRequestRevisionService(
      requestRepository as unknown as Repository<RepairRequestEntity>,
      revisionRepository as unknown as Repository<RepairRequestRevisionEntity>,
      processEntryRepository as unknown as Repository<RepairProcessEntryEntity>,
      responseRepository as unknown as Repository<EngineerResponseEntity>,
      stepRepository as unknown as Repository<RepairRequestDiagnosticStepEntity>,
      panelRepository as unknown as Repository<RepairRequestFaultPanelEntity>,
    );
  });

  it('lockRequestForRevision 行锁读取并映射修订目标快照', async () => {
    requestRepository.findOne.mockResolvedValue({
      id: 11,
      requestNo: 'RR20261116000000ABC123',
      customerAccountId: 7,
      equipmentModelId: 3,
      errorCode: 'E-100',
      faultDescription: '设备无法启动',
      contentMd: '# 报修',
      serviceOrganizationId: 22,
      ownerOrganizationId: 22,
      createdAt,
      deprecated: false,
      isAccepted: true,
      acceptedByEngineerAccountId: 9,
      acceptedAt: createdAt,
      handlingResult: null,
      handlingStatus: 'IN_PROGRESS',
      handlingRecordedAt: null,
      handlingRecordedByAccountId: null,
      closureStatus: 'OPEN',
      closedAt: null,
      closureReason: null,
      handlingEndedAt: null,
      currentRevisionNo: 2,
      maintenanceDate: null,
      maintenanceEngineerNameSnapshot: null,
      resetResult: null,
      supplementaryNote: null,
      maintenanceVersionNo: 0,
      maintenanceAttachmentFileId: null,
      intakeId: null,
    });

    await expect(
      service.lockRequestForRevision(11, asContext(requestRepository)),
    ).resolves.toMatchObject({
      id: 11,
      requestNo: 'RR20261116000000ABC123',
      currentRevisionNo: 2,
      intakeId: null,
      intakeServiceOrganizationId: null,
      serviceOrganizationId: 22,
    });
    expect(requestRepository.findOne).toHaveBeenCalledWith({
      where: { id: 11 },
      lock: { mode: 'pessimistic_write' },
    });
    expect(intakeRepository.findOne).not.toHaveBeenCalled();

    requestRepository.findOne.mockResolvedValueOnce(null);
    await expect(
      service.lockRequestForRevision(99, asContext(requestRepository)),
    ).resolves.toBeNull();
  });

  it('lockRequestForRevision 有 intake 时在同一事务内共享锁读取 intake 服务公司', async () => {
    requestRepository.findOne.mockResolvedValue({
      id: 11,
      intakeId: 660001,
      serviceOrganizationId: 22,
      ownerOrganizationId: 22,
      deprecated: false,
      currentRevisionNo: 2,
      maintenanceDate: null,
      maintenanceEngineerNameSnapshot: null,
      resetResult: null,
      supplementaryNote: null,
      maintenanceVersionNo: 0,
      maintenanceAttachmentFileId: null,
    });
    intakeRepository.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 22 });

    await expect(
      service.lockRequestForRevision(11, asContext(requestRepository)),
    ).resolves.toMatchObject({
      intakeId: 660001,
      intakeServiceOrganizationId: 22,
      serviceOrganizationId: 22,
    });
    expect(intakeRepository.findOne).toHaveBeenCalledWith({
      where: { id: 660001 },
      select: { id: true, serviceOrganizationId: true },
      lock: { mode: 'pessimistic_read' },
    });
    // 锁顺序固定「工单 → intake」：工单行排他锁必须先于 intake 共享锁
    expect(requestRepository.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      intakeRepository.findOne.mock.invocationCallOrder[0],
    );
  });

  it('方案 B：intake 已软删除时仍以其服务公司作为归属事实，不因 deleted_at 置空', async () => {
    requestRepository.findOne.mockResolvedValue({
      id: 11,
      intakeId: 660001,
      serviceOrganizationId: 22,
      ownerOrganizationId: 22,
      deprecated: false,
      currentRevisionNo: 2,
      maintenanceDate: null,
      maintenanceEngineerNameSnapshot: null,
      resetResult: null,
      supplementaryNote: null,
      maintenanceVersionNo: 0,
      maintenanceAttachmentFileId: null,
    });
    intakeRepository.findOne.mockResolvedValue({
      id: 660001,
      serviceOrganizationId: 22,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });

    await expect(
      service.lockRequestForRevision(11, asContext(requestRepository)),
    ).resolves.toMatchObject({
      intakeId: 660001,
      intakeServiceOrganizationId: 22,
      serviceOrganizationId: 22,
    });
  });

  it('方案 B：intake 已软删除但服务公司冲突时仍原样返回，由用例失败关闭', async () => {
    requestRepository.findOne.mockResolvedValue({
      id: 11,
      intakeId: 660001,
      serviceOrganizationId: 22,
      ownerOrganizationId: 22,
      deprecated: false,
      currentRevisionNo: 2,
      maintenanceDate: null,
      maintenanceEngineerNameSnapshot: null,
      resetResult: null,
      supplementaryNote: null,
      maintenanceVersionNo: 0,
      maintenanceAttachmentFileId: null,
    });
    intakeRepository.findOne.mockResolvedValue({
      id: 660001,
      serviceOrganizationId: 23,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });

    await expect(
      service.lockRequestForRevision(11, asContext(requestRepository)),
    ).resolves.toMatchObject({
      intakeId: 660001,
      intakeServiceOrganizationId: 23,
      serviceOrganizationId: 22,
    });
  });

  it('lockRequestForRevision intake 关联缺失时返回空服务公司，交由用例失败关闭', async () => {
    requestRepository.findOne.mockResolvedValue({
      id: 11,
      intakeId: 660001,
      serviceOrganizationId: 22,
      ownerOrganizationId: 22,
      deprecated: false,
      currentRevisionNo: 2,
      maintenanceDate: null,
      maintenanceEngineerNameSnapshot: null,
      resetResult: null,
      supplementaryNote: null,
      maintenanceVersionNo: 0,
      maintenanceAttachmentFileId: null,
    });
    intakeRepository.findOne.mockResolvedValue(null);

    await expect(
      service.lockRequestForRevision(11, asContext(requestRepository)),
    ).resolves.toMatchObject({
      intakeId: 660001,
      intakeServiceOrganizationId: null,
    });
  });

  it('lockRequestForRevision 数据库异常包装为修订写失败且不泄漏 SQL', async () => {
    const dbError = new Error('SELECT * FROM repair_request FOR UPDATE');
    requestRepository.findOne.mockRejectedValue(dbError);

    let caught: unknown;
    try {
      await service.lockRequestForRevision(11, asContext(requestRepository));
    } catch (error) {
      caught = error;
    }

    const domainError = caught as DomainError;
    expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED);
    expect(domainError.details).toEqual({ requestId: 11 });
    expect(JSON.stringify(domainError.details)).not.toContain('repair_request');
    expect(domainError.cause).toBe(dbError);
  });

  it('lockProcessEntriesForRevision 按稳定顺序锁定全部过程行', async () => {
    processEntryRepository.find.mockResolvedValue([
      {
        id: 21,
        entryUuid: 'entry-1',
        requestId: 11,
        operationText: '更换部件',
        testResult: null,
        occurredAt: null,
        timeSource: 'SERVER',
        fileId: 'file-1',
        versionNo: 1,
        createdAt,
      },
    ]);

    await expect(
      service.lockProcessEntriesForRevision(11, asContext(processEntryRepository)),
    ).resolves.toEqual([
      {
        id: '21',
        entryUuid: 'entry-1',
        requestId: 11,
        operationText: '更换部件',
        testResult: null,
        occurredAt: null,
        timeSource: 'SERVER',
        fileId: 'file-1',
        versionNo: 1,
        createdAt,
      },
    ]);
    expect(processEntryRepository.find).toHaveBeenCalledWith({
      where: { requestId: 11 },
      order: { createdAt: 'ASC', id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('updateRequestRevisionFields 条件更新当前版本与白名单字段', async () => {
    const builder = createUpdateBuilder(1);
    requestRepository.createQueryBuilder.mockReturnValue(builder);

    const recordedAt = new Date('2026-11-16T08:30:00.000Z');
    await expect(
      service.updateRequestRevisionFields(
        {
          requestId: 11,
          expectedVersion: 2,
          nextVersion: 3,
          contentMd: '# 修订后',
          handlingResult: RepairRequestHandlingResult.FIXED,
          handlingStatus: RepairRequestHandlingStatus.COMPLETED,
          handlingRecordedAt: recordedAt,
          handlingRecordedByAccountId: 9,
          handlingEndedAt: recordedAt,
          closureReason: null,
        },
        asContext(requestRepository),
      ),
    ).resolves.toBe(1);

    expect(builder.set).toHaveBeenCalledWith({
      currentRevisionNo: 3,
      contentMd: '# 修订后',
      handlingResult: RepairRequestHandlingResult.FIXED,
      handlingStatus: RepairRequestHandlingStatus.COMPLETED,
      handlingRecordedAt: recordedAt,
      handlingRecordedByAccountId: 9,
      handlingEndedAt: recordedAt,
      closureReason: null,
    });
    expect(builder.where).toHaveBeenCalledWith('id = :requestId', { requestId: 11 });
    expect(builder.andWhere).toHaveBeenCalledWith('current_revision_no = :expectedVersion', {
      expectedVersion: 2,
    });
  });

  it('updateRequestRevisionFields 版本未命中返回 0，异常包装为修订写失败', async () => {
    requestRepository.createQueryBuilder.mockReturnValueOnce(createUpdateBuilder(0));
    await expect(
      service.updateRequestRevisionFields(
        { requestId: 11, expectedVersion: 1, nextVersion: 2 },
        asContext(requestRepository),
      ),
    ).resolves.toBe(0);

    requestRepository.createQueryBuilder.mockImplementationOnce(() => {
      throw new Error('connection lost');
    });
    await expect(
      service.updateRequestRevisionFields(
        { requestId: 11, expectedVersion: 1, nextVersion: 2 },
        asContext(requestRepository),
      ),
    ).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
      details: { requestId: 11 },
    });
  });

  it('updateProcessEntryRevision 按 (id, requestId, version_no) 条件更新并递增版本号', async () => {
    const builder = createUpdateBuilder(1);
    processEntryRepository.createQueryBuilder.mockReturnValue(builder);

    await expect(
      service.updateProcessEntryRevision(
        {
          entryId: '21',
          requestId: 11,
          expectedVersion: 1,
          operationText: '更换部件并复测',
          testResult: '通过',
        },
        asContext(processEntryRepository),
      ),
    ).resolves.toBe(1);

    const set = builder.set.mock.calls[0][0] as { versionNo: () => string };
    expect(set).toMatchObject({ operationText: '更换部件并复测', testResult: '通过' });
    expect(set.versionNo()).toBe('version_no + 1');
    expect(builder.andWhere.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['request_id = :requestId', 'version_no = :expectedVersion']),
    );
  });

  it('insertRevision 落库并返回修订记录摘要', async () => {
    revisionRepository.create.mockImplementation((entity: Record<string, unknown>) => entity);
    revisionRepository.save.mockImplementation((entity: Record<string, unknown>) => ({
      ...entity,
      createdAt,
    }));

    await expect(
      service.insertRevision(
        {
          requestId: 11,
          revisionNo: 3,
          previousVersion: 2,
          beforeSnapshot: '{"contentMd":"旧"}',
          afterSnapshot: '{"contentMd":"新"}',
          schemaVersion: 1,
          actorAccountId: 9,
          reason: '订正处理结果',
        },
        asContext(revisionRepository),
      ),
    ).resolves.toEqual({
      revisionNo: 3,
      previousVersion: 2,
      reason: '订正处理结果',
      actorAccountId: 9,
      createdAt,
    });
  });
});
