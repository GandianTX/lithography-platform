// src/modules/lithography/intake-analysis.service.spec.ts
// 认领 / 租约过期接管 / 写回归属 / 代次切换的单测（替身仓库）。
//
// 归属语义验证核心：
// - 接管后旧 attempt 行被删除、插入新行：旧执行持有的 attemptId 失效；
// - 写回按「attempt 行存在且仍 RUNNING」条件更新仲裁，affected≠1 → OWNERSHIP_LOST。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IntakeAnalysisStatus } from '@app-types/models/repair-request.types';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { EquipmentModelEntity } from './entities/equipment-model.entity';
import { IntakeAnalysisAttemptEntity } from './entities/intake-analysis-attempt.entity';
import type { RepairRequestIntakeEntity } from '@src/modules/lithography/entities/repair-request-intake.entity';
import { IntakeAnalysisService } from './intake-analysis.service';

jest.mock(
  '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context',
  () => ({
    getTypeOrmEntityManager: jest.fn(),
  }),
);

const transactionContext = Symbol('tx') as unknown as PersistenceTransactionContext;

type QueryBuilderStub = {
  setLock: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  getOne: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;
  execute: jest.Mock;
};

const makeQueryBuilder = (): QueryBuilderStub => {
  const qb: QueryBuilderStub = {
    setLock: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getOne: jest.fn(),
    update: jest.fn(),
    set: jest.fn(),
    execute: jest.fn(),
  };
  qb.setLock.mockReturnThis();
  qb.where.mockReturnThis();
  qb.andWhere.mockReturnThis();
  qb.update.mockReturnThis();
  qb.set.mockReturnThis();
  return qb;
};

type RepositoryStub = {
  createQueryBuilder: jest.Mock<QueryBuilderStub>;
  findOne: jest.Mock;
  delete: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
};

const makeRepository = (): RepositoryStub => ({
  createQueryBuilder: jest.fn(),
  findOne: jest.fn(),
  delete: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

const buildIntakeRow = (
  overrides: Partial<RepairRequestIntakeEntity> = {},
): RepairRequestIntakeEntity => ({
  id: 21,
  recordUuid: '6f0d1c62-2c66-4b1e-9f1e-2f1f0d1c6a11',
  customerAccountId: 7,
  customerOrganizationId: 77,
  serviceOrganizationId: 88,
  equipmentModelId: 3,
  errorCode: 'E-100',
  faultDescription: '设备无法启动',
  fileId: null,
  analysisStatus: IntakeAnalysisStatus.WAITING,
  analysisGeneration: 0,
  convertedRequestId: 11,
  deletedAt: null,
  createdAt: new Date('2026-11-20T00:00:00.000Z'),
  ...overrides,
});

describe('IntakeAnalysisService', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');
  let intakeRepository: RepositoryStub;
  let attemptRepository: RepositoryStub;
  let equipmentModelRepository: RepositoryStub;
  let service: IntakeAnalysisService;

  const lockQbFor = (row: RepairRequestIntakeEntity | null): QueryBuilderStub => {
    const qb = makeQueryBuilder();
    qb.getOne.mockResolvedValue(row);
    return qb;
  };

  const updateQbWith = (affected: number): QueryBuilderStub => {
    const qb = makeQueryBuilder();
    qb.execute.mockResolvedValue({ affected });
    return qb;
  };

  beforeEach(() => {
    intakeRepository = makeRepository();
    attemptRepository = makeRepository();
    equipmentModelRepository = makeRepository();
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === IntakeAnalysisAttemptEntity) return attemptRepository;
        if (entity === EquipmentModelEntity) return equipmentModelRepository;
        return intakeRepository;
      }),
    };
    (getTypeOrmEntityManager as jest.Mock).mockReturnValue(manager);
    service = new IntakeAnalysisService(
      intakeRepository as never,
      attemptRepository as never,
      equipmentModelRepository as never,
    );
  });

  describe('claimForAnalysis', () => {
    it('WAITING 首次认领：置 RUNNING 并插入 RUNNING 尝试行（attemptId 是执行凭据）', async () => {
      const lockedRow = buildIntakeRow();
      intakeRepository.createQueryBuilder.mockReturnValueOnce(lockQbFor(lockedRow));
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));
      attemptRepository.create.mockImplementation((data) => data);
      attemptRepository.save.mockResolvedValue({ id: 501 });

      const result = await service.claimForAnalysis({
        intakeId: 21,
        generationNo: 0,
        now,
        transactionContext,
      });

      expect(result).toMatchObject({
        kind: 'CLAIMED',
        intakeId: 21,
        generationNo: 0,
        attemptId: 501,
        startedAt: now,
      });
      expect(attemptRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          intakeId: 21,
          generationNo: 0,
          status: IntakeAnalysisStatus.RUNNING,
          startedAt: now,
        }),
      );
    });

    it('RUNNING 且租约未过期：LEASE_ACTIVE，不争抢、不产生新尝试行', async () => {
      const lockedRow = buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING });
      intakeRepository.createQueryBuilder.mockReturnValueOnce(lockQbFor(lockedRow));
      attemptRepository.findOne.mockResolvedValue({
        id: 500,
        intakeId: 21,
        generationNo: 0,
        status: IntakeAnalysisStatus.RUNNING,
        startedAt: new Date(now.getTime() - 60 * 1000),
      });

      const result = await service.claimForAnalysis({
        intakeId: 21,
        generationNo: 0,
        now,
        transactionContext,
      });

      expect(result).toMatchObject({ kind: 'LEASE_ACTIVE' });
      expect(attemptRepository.delete).not.toHaveBeenCalled();
      expect(attemptRepository.save).not.toHaveBeenCalled();
    });

    it('租约过期接管：删除旧尝试行、插入新尝试行，旧执行凭据失效', async () => {
      const lockedRow = buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING });
      intakeRepository.createQueryBuilder.mockReturnValueOnce(lockQbFor(lockedRow));
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));
      attemptRepository.findOne.mockResolvedValue({
        id: 500,
        intakeId: 21,
        generationNo: 0,
        status: IntakeAnalysisStatus.RUNNING,
        startedAt: new Date(now.getTime() - 16 * 60 * 1000),
      });
      attemptRepository.delete.mockResolvedValue({ affected: 1 });
      attemptRepository.create.mockImplementation((data) => data);
      attemptRepository.save.mockResolvedValue({ id: 502 });

      const result = await service.claimForAnalysis({
        intakeId: 21,
        generationNo: 0,
        now,
        transactionContext,
      });

      expect(result).toMatchObject({ kind: 'CLAIMED', attemptId: 502 });
      expect(attemptRepository.delete).toHaveBeenCalledWith({ id: 500 });
      expect(attemptRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ startedAt: now }),
      );
    });

    it('原稿已终态：ALREADY_SUCCEEDED / ALREADY_FAILED 不再执行', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.SUCCEEDED })),
      );
      expect(
        await service.claimForAnalysis({ intakeId: 21, generationNo: 0, now, transactionContext }),
      ).toMatchObject({ kind: 'ALREADY_SUCCEEDED' });

      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.FAILED })),
      );
      expect(
        await service.claimForAnalysis({ intakeId: 21, generationNo: 0, now, transactionContext }),
      ).toMatchObject({ kind: 'ALREADY_FAILED' });
    });

    it('已删除 / 未转换工单 / 代次不匹配：NOT_EXECUTABLE', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ deletedAt: new Date(now) })),
      );
      expect(
        await service.claimForAnalysis({ intakeId: 21, generationNo: 0, now, transactionContext }),
      ).toMatchObject({ kind: 'NOT_EXECUTABLE', reason: 'DELETED' });

      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ convertedRequestId: null })),
      );
      expect(
        await service.claimForAnalysis({ intakeId: 21, generationNo: 0, now, transactionContext }),
      ).toMatchObject({ kind: 'NOT_EXECUTABLE', reason: 'NOT_CONVERTED' });

      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisGeneration: 1 })),
      );
      expect(
        await service.claimForAnalysis({ intakeId: 21, generationNo: 0, now, transactionContext }),
      ).toMatchObject({ kind: 'NOT_EXECUTABLE', reason: 'GENERATION_MISMATCH' });
    });
  });

  describe('finishIntakeAnalysis', () => {
    const succeededOutcome = {
      kind: 'SUCCEEDED' as const,
      outputText: '建议检查主控报警',
      providerCallId: 9,
    };

    it('归属有效：条件更新尝试行与意图行各命中 1 行 → WRITTEN', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING })),
      );
      attemptRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));

      const result = await service.finishIntakeAnalysis({
        input: { intakeId: 21, generationNo: 0, attemptId: 501, outcome: succeededOutcome },
        transactionContext,
      });

      expect(result).toMatchObject({ kind: 'WRITTEN' });
    });

    it('同代次租约接管：B 接管后 A 的旧执行先返回不得写入，B 随后写入成功', async () => {
      // A 首次认领代次 0 → 尝试行 500
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.WAITING })),
      );
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));
      attemptRepository.create.mockImplementation((data) => data);
      attemptRepository.save.mockResolvedValueOnce({ id: 500 });

      const claimA = await service.claimForAnalysis({
        intakeId: 21,
        generationNo: 0,
        now,
        transactionContext,
      });
      expect(claimA).toMatchObject({ kind: 'CLAIMED', attemptId: 500 });

      // 同一代次 0，租约过期后 B 接管：删除 500，插入 501
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING })),
      );
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));
      attemptRepository.findOne.mockResolvedValueOnce({
        id: 500,
        intakeId: 21,
        generationNo: 0,
        status: IntakeAnalysisStatus.RUNNING,
        startedAt: new Date(now.getTime() - 16 * 60 * 1000),
      });
      attemptRepository.delete.mockResolvedValueOnce({ affected: 1 });
      attemptRepository.save.mockResolvedValueOnce({ id: 501 });

      const claimB = await service.claimForAnalysis({
        intakeId: 21,
        generationNo: 0,
        now,
        transactionContext,
      });
      expect(claimB).toMatchObject({ kind: 'CLAIMED', attemptId: 501 });
      expect(attemptRepository.delete).toHaveBeenCalledWith({ id: 500 });

      // A 的旧执行先返回：尝试行 500 已被删除，同代次也必须 OWNERSHIP_LOST
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING })),
      );
      attemptRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(0));

      await expect(
        service.finishIntakeAnalysis({
          input: { intakeId: 21, generationNo: 0, attemptId: 500, outcome: succeededOutcome },
          transactionContext,
        }),
      ).resolves.toMatchObject({ kind: 'OWNERSHIP_LOST' });

      // B 的有效结果随后写入成功
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING })),
      );
      attemptRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));

      await expect(
        service.finishIntakeAnalysis({
          input: { intakeId: 21, generationNo: 0, attemptId: 501, outcome: succeededOutcome },
          transactionContext,
        }),
      ).resolves.toMatchObject({ kind: 'WRITTEN' });
    });

    it('旧执行迟到（attempt 行已被接管删除）：OWNERSHIP_LOST 且不写意图行', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING })),
      );
      const attemptQb = updateQbWith(0);
      attemptRepository.createQueryBuilder.mockReturnValueOnce(attemptQb);

      const result = await service.finishIntakeAnalysis({
        input: { intakeId: 21, generationNo: 0, attemptId: 500, outcome: succeededOutcome },
        transactionContext,
      });

      expect(result).toMatchObject({ kind: 'OWNERSHIP_LOST' });
      // 只发生尝试行一次条件更新尝试，不触碰意图行
      expect(intakeRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('报修已删除：REJECTED DELETED，不产生任何写入', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ deletedAt: new Date(now) })),
      );

      const result = await service.finishIntakeAnalysis({
        input: { intakeId: 21, generationNo: 0, attemptId: 501, outcome: succeededOutcome },
        transactionContext,
      });

      expect(result).toMatchObject({ kind: 'REJECTED', reason: 'DELETED' });
      expect(attemptRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('代次不匹配（已重试到第 1 代）：REJECTED，旧代次结果不得覆盖', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisGeneration: 1 })),
      );

      const result = await service.finishIntakeAnalysis({
        input: { intakeId: 21, generationNo: 0, attemptId: 501, outcome: succeededOutcome },
        transactionContext,
      });

      expect(result).toMatchObject({ kind: 'REJECTED', reason: 'GENERATION_MISMATCH' });
      expect(attemptRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('bumpAnalysisGenerationForRetry', () => {
    it('第 0 代已失败：原子切换到第 1 代 WAITING', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(1));

      const result = await service.bumpAnalysisGenerationForRetry({
        intakeId: 21,
        transactionContext,
      });

      expect(result.affected).toBe(1);
      const qb = intakeRepository.createQueryBuilder.mock.results[0].value as QueryBuilderStub;
      expect(qb.set).toHaveBeenCalledWith({
        analysisStatus: IntakeAnalysisStatus.WAITING,
        analysisGeneration: 1,
      });
    });

    it('条件未命中（非失败态 / 已重试 / 已删除）：affected=0', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(updateQbWith(0));

      const result = await service.bumpAnalysisGenerationForRetry({
        intakeId: 21,
        transactionContext,
      });

      expect(result.affected).toBe(0);
    });
  });

  describe('loadRetryFacts', () => {
    it('按 intake 行锁读取归属/代次/尝试行事实，只读不写', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(
          buildIntakeRow({
            analysisStatus: IntakeAnalysisStatus.FAILED,
            analysisGeneration: 0,
          }),
        ),
      );
      attemptRepository.findOne.mockResolvedValue({
        id: 501,
        intakeId: 21,
        generationNo: 0,
        status: IntakeAnalysisStatus.FAILED,
        failureReason: 'RAG_TIMEOUT',
      });

      const facts = await service.loadRetryFacts({ intakeId: 21, transactionContext });

      expect(facts).toEqual({
        intakeCustomerAccountId: 7,
        intakeDeleted: false,
        convertedRequestId: 11,
        generation: 0,
        status: IntakeAnalysisStatus.FAILED,
        attemptGenerationNo: 0,
        attemptStatus: IntakeAnalysisStatus.FAILED,
        attemptFailureReasonRecorded: true,
      });
      // 只读：不推进状态、不插入/删除尝试行
      const lockQb = intakeRepository.createQueryBuilder.mock.results[0].value as QueryBuilderStub;
      expect(lockQb.update).not.toHaveBeenCalled();
      expect(lockQb.set).not.toHaveBeenCalled();
      expect(attemptRepository.delete).not.toHaveBeenCalled();
      expect(attemptRepository.save).not.toHaveBeenCalled();
    });

    it('尝试行缺失：事实标记为不可确认（attempt 字段为空）', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(
        lockQbFor(buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.FAILED })),
      );
      attemptRepository.findOne.mockResolvedValue(null);

      const facts = await service.loadRetryFacts({ intakeId: 21, transactionContext });

      expect(facts).toMatchObject({
        attemptGenerationNo: null,
        attemptStatus: null,
        attemptFailureReasonRecorded: false,
      });
    });

    it('原稿行不存在：返回 null（由调用方失败关闭）', async () => {
      intakeRepository.createQueryBuilder.mockReturnValueOnce(lockQbFor(null));

      const facts = await service.loadRetryFacts({ intakeId: 21, transactionContext });

      expect(facts).toBeNull();
    });
  });

  describe('resolveIntakeDeliveryReadiness', () => {
    const expectReadiness = async (
      intakeRow: RepairRequestIntakeEntity | null,
      attemptRow: Partial<IntakeAnalysisAttemptEntity> | null,
      expected: Awaited<ReturnType<typeof service.resolveIntakeDeliveryReadiness>>,
    ): Promise<void> => {
      intakeRepository.findOne.mockResolvedValueOnce(intakeRow);
      if (attemptRow !== null) {
        attemptRepository.findOne.mockResolvedValueOnce(attemptRow);
      }
      await expect(
        service.resolveIntakeDeliveryReadiness({ intakeId: 21, generationNo: 0, now }),
      ).resolves.toBe(expected);
    };

    it('WAITING → claimable', async () => {
      await expectReadiness(buildIntakeRow(), null, 'claimable');
    });

    it('已删除 / 不存在 → deleted_or_missing', async () => {
      await expectReadiness(
        buildIntakeRow({ deletedAt: new Date(now) }),
        null,
        'deleted_or_missing',
      );
      await expectReadiness(null, null, 'deleted_or_missing');
    });

    it('代次不匹配 → generation_mismatch（stale 意图）', async () => {
      await expectReadiness(buildIntakeRow({ analysisGeneration: 1 }), null, 'generation_mismatch');
    });

    it('未关联工单（convertedRequestId 为空）→ not_converted（与认领同口径，不空转补投）', async () => {
      await expectReadiness(buildIntakeRow({ convertedRequestId: null }), null, 'not_converted');
      // 终态优先于结构异常：已落地的真实结果不会被误判为不可执行
      await expectReadiness(
        buildIntakeRow({
          convertedRequestId: null,
          analysisStatus: IntakeAnalysisStatus.SUCCEEDED,
        }),
        null,
        'intent_succeeded',
      );
      await expectReadiness(
        buildIntakeRow({ convertedRequestId: null, analysisStatus: IntakeAnalysisStatus.RUNNING }),
        null,
        'not_converted',
      );
    });

    it('已终态 → intent_succeeded / intent_failed（不补投）', async () => {
      await expectReadiness(
        buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.SUCCEEDED }),
        null,
        'intent_succeeded',
      );
      await expectReadiness(
        buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.FAILED }),
        null,
        'intent_failed',
      );
    });

    it('RUNNING 且租约未过期 → lease_in_flight', async () => {
      await expectReadiness(
        buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING }),
        {
          intakeId: 21,
          generationNo: 0,
          status: IntakeAnalysisStatus.RUNNING,
          startedAt: new Date(now.getTime() - 60 * 1000),
        },
        'lease_in_flight',
      );
    });

    it('RUNNING 且租约已过期 → claimable（允许状态感知补投）', async () => {
      await expectReadiness(
        buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING }),
        {
          intakeId: 21,
          generationNo: 0,
          status: IntakeAnalysisStatus.RUNNING,
          startedAt: new Date(now.getTime() - 16 * 60 * 1000),
        },
        'claimable',
      );
    });

    it('RUNNING 而尝试行缺失或非 RUNNING → attempt_inconsistent（失败关闭）', async () => {
      await expectReadiness(
        buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING }),
        null,
        'attempt_inconsistent',
      );
      await expectReadiness(
        buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING }),
        {
          intakeId: 21,
          generationNo: 0,
          status: IntakeAnalysisStatus.SUCCEEDED,
          startedAt: new Date(now.getTime() - 60 * 1000),
        },
        'attempt_inconsistent',
      );
    });

    it('与 claimForAnalysis 同一租约口径：claim LEASE_ACTIVE 的窗口内 readiness 为 lease_in_flight', async () => {
      // 与上方 claimForAnalysis 的 LEASE_ACTIVE 用例同一时刻（60s 前 startedAt）
      const attemptRow = {
        intakeId: 21,
        generationNo: 0,
        status: IntakeAnalysisStatus.RUNNING,
        startedAt: new Date(now.getTime() - 60 * 1000),
      };
      intakeRepository.findOne.mockResolvedValueOnce(
        buildIntakeRow({ analysisStatus: IntakeAnalysisStatus.RUNNING }),
      );
      attemptRepository.findOne.mockResolvedValueOnce(attemptRow);
      await expect(
        service.resolveIntakeDeliveryReadiness({ intakeId: 21, generationNo: 0, now }),
      ).resolves.toBe('lease_in_flight');
    });
  });
});
