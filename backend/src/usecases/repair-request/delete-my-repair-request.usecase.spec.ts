/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@src/core/common/errors/domain-error';
import type { RepairRequestDeleteOutcome } from '@src/modules/lithography/lithography.types';
import type { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import type { RepairRequestIntakeService } from '@src/modules/lithography/repair-request-intake.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { DeleteMyRepairRequestUsecase } from './delete-my-repair-request.usecase';
import type { DeleteMyRepairRequestCommand } from './delete-my-repair-request.types';

type RepairRequestServiceMock = {
  readonly softDeleteRequest: jest.Mock<Promise<RepairRequestDeleteOutcome>>;
  readonly findSnapshotById: jest.Mock<Promise<Record<string, unknown> | null>>;
};

type RepairRequestIntakeServiceMock = {
  readonly markDeletedByRequestId: jest.Mock<Promise<number>>;
};

type AsyncTaskRecordServiceMock = {
  readonly cancelActiveByQueueJobIds: jest.Mock<Promise<number>>;
};

describe('DeleteMyRepairRequestUsecase', () => {
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;

  let repairRequestService: RepairRequestServiceMock;
  let intakeService: RepairRequestIntakeServiceMock;
  let asyncTaskRecordService: AsyncTaskRecordServiceMock;
  let transactionRunner: TransactionRunner;
  let usecase: DeleteMyRepairRequestUsecase;

  const buildCommand = (
    overrides: Partial<DeleteMyRepairRequestCommand> = {},
  ): DeleteMyRepairRequestCommand => ({
    session: { accountId: 7, roles: ['CUSTOMER'] },
    requestId: 11,
    ...overrides,
  });

  beforeEach(() => {
    repairRequestService = {
      softDeleteRequest: jest
        .fn()
        .mockResolvedValue({ kind: 'DELETED', id: 11, requestNo: 'RR20260901' } as const),
      findSnapshotById: jest.fn().mockResolvedValue({
        id: 11,
        requestNo: 'RR20260901',
        customerAccountId: 7,
        isAccepted: false,
        deprecated: false,
        intakeId: 21,
      }),
    };
    intakeService = {
      markDeletedByRequestId: jest.fn().mockResolvedValue(1),
    };
    asyncTaskRecordService = {
      cancelActiveByQueueJobIds: jest.fn().mockResolvedValue(1),
    };
    transactionRunner = {
      run: jest.fn(async (callback) => await callback(transactionContext)),
    };
    usecase = new DeleteMyRepairRequestUsecase(
      repairRequestService as unknown as RepairRequestService,
      intakeService as unknown as RepairRequestIntakeService,
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      asyncTaskRecordService as unknown as AsyncTaskRecordService,
      transactionRunner,
    );
  });

  describe('成功路径（含幂等成功）', () => {
    it('CUSTOMER 删除成功返回申请标识，账号取自会话且事务内执行', async () => {
      const result = await usecase.execute(buildCommand());

      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(repairRequestService.softDeleteRequest).toHaveBeenCalledWith(
        { requestId: 11, customerAccountId: 7 },
        transactionContext,
      );
      expect(result).toEqual({ id: 11, requestNo: 'RR20260901' });
    });

    it('删除事务内同步软删原稿并取消首析投递账本行（两个代次）', async () => {
      await usecase.execute(buildCommand());

      expect(intakeService.markDeletedByRequestId).toHaveBeenCalledWith(
        { requestId: 11 },
        transactionContext,
      );
      expect(asyncTaskRecordService.cancelActiveByQueueJobIds).toHaveBeenCalledWith({
        queueName: 'intake-analysis',
        jobIds: ['intake-analysis:21:g0', 'intake-analysis:21:g1'],
        reason: 'intake_cancelled_by_request_deletion',
        transactionContext,
      });
    });

    it('旧工单无原稿关联（intakeId=null）时跳过首析取消', async () => {
      // 冻结闸门与原稿取消都会读工单快照：此处用常驻 mock 覆盖（不再是一次性 mock）
      repairRequestService.findSnapshotById.mockResolvedValue({
        id: 11,
        intakeId: null,
      });
      await usecase.execute(buildCommand());

      expect(asyncTaskRecordService.cancelActiveByQueueJobIds).not.toHaveBeenCalled();
    });

    it('本人重复删除（ALREADY_DELETED）幂等成功，返回与首次删除一致的结果', async () => {
      repairRequestService.softDeleteRequest.mockResolvedValueOnce({
        kind: 'ALREADY_DELETED',
        id: 11,
        requestNo: 'RR20260901',
      });

      await expect(usecase.execute(buildCommand())).resolves.toEqual({
        id: 11,
        requestNo: 'RR20260901',
      });
      // 幂等路径同样补齐原稿删除态与投递取消（条件更新天然幂等）
      expect(intakeService.markDeletedByRequestId).toHaveBeenCalledTimes(1);
    });
  });

  describe('角色决策（裁定 2：仅真实 CUSTOMER，不含 SUPER_ADMIN）', () => {
    it.each([[['ENGINEER']], [['SUPER_ADMIN']], [['ENGINEER', 'SUPER_ADMIN']], [[]]])(
      'roles=%j 时拒绝删除且不开事务',
      async (roles) => {
        await expect(
          usecase.execute(buildCommand({ session: { accountId: 7, roles } })),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
        expect(transactionRunner.run).not.toHaveBeenCalled();
        expect(repairRequestService.softDeleteRequest).not.toHaveBeenCalled();
      },
    );

    it('未归一化小写角色被精确匹配拒绝（归一化职责在 adapter 边界，usecase 不重复归一化）', async () => {
      await expect(
        usecase.execute(buildCommand({ session: { accountId: 7, roles: ['customer'] } })),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    });
  });

  describe('输入决策', () => {
    it.each([[0], [-1], [1.5], [Number.NaN]])('requestId=%j 时拒绝且不落库', async (requestId) => {
      await expect(usecase.execute(buildCommand({ requestId }))).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      });
      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(repairRequestService.softDeleteRequest).not.toHaveBeenCalled();
    });
  });

  describe('拒绝分支映射（裁定 5）', () => {
    it('不存在/非本人统一 NOT_FOUND，details 只含 id 不泄露存在性', async () => {
      repairRequestService.softDeleteRequest.mockResolvedValueOnce({
        kind: 'NOT_FOUND_OR_NOT_OWNER',
        id: 11,
      });

      let caught: unknown;
      try {
        await usecase.execute(buildCommand());
      } catch (error) {
        caught = error;
      }

      const domainError = caught as DomainError;
      expect(domainError).toBeInstanceOf(DomainError);
      expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.NOT_FOUND);
      expect(domainError.details).toEqual({ id: 11 });
      // 拒绝分支不做原稿/账本收尾
      expect(intakeService.markDeletedByRequestId).not.toHaveBeenCalled();
      expect(asyncTaskRecordService.cancelActiveByQueueJobIds).not.toHaveBeenCalled();
    });

    it('已接单拒绝映射为 REPAIR_REQUEST_ALREADY_ACCEPTED（接单/删除互斥）', async () => {
      repairRequestService.softDeleteRequest.mockResolvedValueOnce({
        kind: 'ALREADY_ACCEPTED',
        id: 11,
        requestNo: 'RR20260901',
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.ALREADY_ACCEPTED,
      });
      expect(intakeService.markDeletedByRequestId).not.toHaveBeenCalled();
    });
  });
});
