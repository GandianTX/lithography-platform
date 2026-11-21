/// <reference types="jest" />
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IntakeAnalysisStatus } from '@app-types/models/repair-request.types';
import { REPAIR_REQUEST_ERROR } from '@src/core/common/errors/domain-error';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { EntityManager, Repository, QueryFailedError } from 'typeorm';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { RepairRequestIntakeInsertData } from './lithography.types';
import { RepairRequestIntakeService } from './repair-request-intake.service';

const RECORD_UUID = '6f0d1c62-2c66-4b1e-9f1e-2f1f0d1c6a11';

describe('RepairRequestIntakeService', () => {
  const createdAt = new Date('2026-11-19T00:00:00.000Z');
  const insertData: RepairRequestIntakeInsertData = {
    recordUuid: RECORD_UUID,
    customerAccountId: 7,
    customerOrganizationId: 77,
    serviceOrganizationId: 88,
    equipmentModelId: 3,
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    fileId: null,
  };

  let repository: ReturnType<typeof createMockRepository>;
  let transactionContext: PersistenceTransactionContext;
  let service: RepairRequestIntakeService;

  beforeEach(() => {
    repository = createMockRepository();
    repository.create.mockImplementation((data: Record<string, unknown>) => data);
    repository.save.mockImplementation((entity: Record<string, unknown>) => ({
      ...entity,
      id: 21,
      createdAt,
    }));
    transactionContext = createTypeOrmPersistenceTransactionContext({
      getRepository: () => repository,
    } as unknown as EntityManager);
    service = new RepairRequestIntakeService(
      repository as unknown as Repository<RepairRequestIntakeEntity>,
    );
  });

  it('插入原稿：分析意图固定 WAITING + 代次 0，工单关联初始为空', async () => {
    const snapshot = await service.insertIntake(insertData, transactionContext);

    const created = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.analysisStatus).toBe(IntakeAnalysisStatus.WAITING);
    expect(created.analysisGeneration).toBe(0);
    expect(created.convertedRequestId).toBeNull();
    expect(created.fileId).toBeNull();
    expect(snapshot).toEqual({
      ...insertData,
      id: 21,
      analysisStatus: IntakeAnalysisStatus.WAITING,
      analysisGeneration: 0,
      convertedRequestId: null,
      createdAt,
    });
  });

  it('提交标识撞唯一索引：抛出可区分的重复提交错误', async () => {
    const driverError = Object.assign(new Error('dup entry'), { code: 'ER_DUP_ENTRY' });
    repository.save.mockRejectedValue(new QueryFailedError('INSERT', [], driverError));

    await expect(service.insertIntake(insertData, transactionContext)).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.SUBMISSION_DUPLICATE,
    });
  });

  it('非唯一键的落库失败：包装为创建失败且不泄露数据库细节', async () => {
    repository.save.mockRejectedValue(new Error('connection lost'));

    await expect(service.insertIntake(insertData, transactionContext)).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
    });
  });

  it('按提交标识读取原稿（无条件可空）', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(service.findByRecordUuid(RECORD_UUID)).resolves.toBeNull();

    repository.findOne.mockResolvedValue({
      ...insertData,
      id: 21,
      analysisStatus: IntakeAnalysisStatus.WAITING,
      analysisGeneration: 0,
      convertedRequestId: 11,
      createdAt,
    });
    await expect(service.findByRecordUuid(RECORD_UUID)).resolves.toMatchObject({ id: 21 });
    expect(repository.findOne).toHaveBeenCalledWith({ where: { recordUuid: RECORD_UUID } });
  });

  it('回写工单关联：仅当转换列仍为空时条件更新', async () => {
    repository.queryBuilderExecute.mockResolvedValue({ affected: 1 });

    await service.markConverted({ intakeId: 21, requestId: 11 }, transactionContext);

    expect(repository.queryBuilderSet).toHaveBeenCalledWith({ convertedRequestId: 11 });
    expect(repository.queryBuilderAndWhere).toHaveBeenCalledWith('converted_request_id IS NULL');
  });

  it('回写工单关联未命中（已被占用）时判定失败', async () => {
    repository.queryBuilderExecute.mockResolvedValue({ affected: 0 });

    await expect(
      service.markConverted({ intakeId: 21, requestId: 11 }, transactionContext),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.CREATION_FAILED });
  });

  // PR #27 复审：重放状态核验的原稿侧锁读（删除与重放并发时取单一提交点事实）
  it('重放核验锁读：排他锁 + 最小状态列，删除事实按 deleted_at 判定', async () => {
    repository.findOne.mockResolvedValue({
      id: 21,
      customerAccountId: 7,
      convertedRequestId: 11,
      deletedAt: createdAt,
    });

    await expect(
      service.findReplayIntakeStateForUpdate(RECORD_UUID, transactionContext),
    ).resolves.toEqual({
      id: 21,
      customerAccountId: 7,
      convertedRequestId: 11,
      deleted: true,
    });
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { recordUuid: RECORD_UUID },
      select: { id: true, customerAccountId: true, convertedRequestId: true, deletedAt: true },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('重放核验锁读：未删除时 deleted 为 false，行缺失返回 null', async () => {
    repository.findOne.mockResolvedValueOnce({
      id: 21,
      customerAccountId: 7,
      convertedRequestId: 11,
      deletedAt: null,
    });
    await expect(
      service.findReplayIntakeStateForUpdate(RECORD_UUID, transactionContext),
    ).resolves.toEqual({
      id: 21,
      customerAccountId: 7,
      convertedRequestId: 11,
      deleted: false,
    });

    repository.findOne.mockResolvedValueOnce(null);
    await expect(
      service.findReplayIntakeStateForUpdate(RECORD_UUID, transactionContext),
    ).resolves.toBeNull();
  });
});

/**
 * 最小 Repository 替身：只覆盖原稿服务使用的 create / save / findOne
 * 与条件 UPDATE 的 QueryBuilder 链。
 */
function createMockRepository() {
  const queryBuilder = {
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

  return {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(() => queryBuilder),
    queryBuilderSet: queryBuilder.set,
    queryBuilderAndWhere: queryBuilder.andWhere,
    queryBuilderExecute: queryBuilder.execute,
  };
}
