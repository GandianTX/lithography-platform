/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { PERMISSION_ERROR, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { CloseRepairRequestUsecase } from './close-repair-request.usecase';

const transactionContext = { transaction: 'mock' } as unknown as PersistenceTransactionContext;
const organizationId = 910001;
const requestId = 42;

const engineerSession: UsecaseSession = {
  accountId: 900001,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as UsecaseSession;

const target = (overrides: Record<string, unknown> = {}) => ({
  id: requestId,
  ownerOrganizationId: organizationId,
  serviceOrganizationId: organizationId,
  isAccepted: true,
  acceptedByEngineerAccountId: engineerSession.accountId,
  deprecated: false,
  handlingStatus: null,
  closureStatus: null,
  maintenanceVersionNo: 3,
  ...overrides,
});

type RepairRequestServiceMock = {
  findProcessWriteTargetForUpdate: jest.Mock;
  closeRequest: jest.Mock;
};

const makeUsecase = (overrides: { repairRequestService?: RepairRequestServiceMock } = {}) => {
  const repairRequestService = overrides.repairRequestService ?? {
    findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(target()),
    closeRequest: jest.fn().mockResolvedValue(1),
  };
  const organizationContext = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId }),
  };
  const transactionRunner: TransactionRunner = {
    run: jest.fn(async (callback) => await callback(transactionContext)),
  };

  const usecase = new CloseRepairRequestUsecase(
    repairRequestService as unknown as RepairRequestService,
    organizationContext as unknown as TrustedOrganizationContextQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    transactionRunner,
  );

  return { usecase, repairRequestService, transactionRunner };
};

const command = (overrides: Partial<Parameters<CloseRepairRequestUsecase['execute']>[0]> = {}) => ({
  session: engineerSession,
  requestId,
  handlingResult: RepairRequestHandlingResult.FIXED,
  closureReason: null,
  maintenanceVersionNo: 3,
  ...overrides,
});

describe('CloseRepairRequestUsecase（任务 04 主链）', () => {
  it('FIXED 结单：COMPLETED + 处理终结时间 + CLOSED，全部使用调用方事务', async () => {
    const { usecase, repairRequestService, transactionRunner } = makeUsecase();
    const before = Date.now();

    const result = await usecase.execute(command());

    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    expect(repairRequestService.findProcessWriteTargetForUpdate).toHaveBeenCalledWith(
      requestId,
      transactionContext,
    );
    const data = repairRequestService.closeRequest.mock.calls[0][0];
    expect(data).toMatchObject({
      requestId,
      engineerAccountId: engineerSession.accountId,
      handlingResult: RepairRequestHandlingResult.FIXED,
      handlingStatus: RepairRequestHandlingStatus.COMPLETED,
      closureReason: null,
    });
    expect(data.handlingEndedAt).toBeInstanceOf(Date);
    expect((data.closedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(result).toMatchObject({
      requestId,
      closureStatus: 'CLOSED',
      handlingResult: RepairRequestHandlingResult.FIXED,
      handlingStatus: RepairRequestHandlingStatus.COMPLETED,
    });
  });

  it.each([
    [RepairRequestHandlingResult.PART_PURCHASED, RepairRequestHandlingStatus.COMPLETED],
    [RepairRequestHandlingResult.PROVIDE_PLAN_SELF_EXECUTE, RepairRequestHandlingStatus.COMPLETED],
    [RepairRequestHandlingResult.UNREPAIRABLE, RepairRequestHandlingStatus.UNRESOLVED],
  ])('%s 映射为 %s，并写入处理终结时间', async (handlingResult, expectedStatus) => {
    const { usecase, repairRequestService } = makeUsecase();

    await usecase.execute(
      command({
        handlingResult,
        closureReason:
          handlingResult === RepairRequestHandlingResult.UNREPAIRABLE ? '主板烧毁' : null,
      }),
    );

    const data = repairRequestService.closeRequest.mock.calls[0][0];
    expect(data.handlingStatus).toBe(expectedStatus);
    expect(data.handlingEndedAt).toBeInstanceOf(Date);
  });

  it('INTERRUPTED 不通过结单写入，拒绝且不开启事务', async () => {
    const { usecase, transactionRunner, repairRequestService } = makeUsecase();

    await expect(
      usecase.execute(
        command({
          handlingResult: RepairRequestHandlingResult.INTERRUPTED,
          closureReason: '客户暂停生产',
        }),
      ),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });

    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.closeRequest).not.toHaveBeenCalled();
  });

  it('无法修复缺少原因时在开启事务前拒绝', async () => {
    const { usecase, transactionRunner, repairRequestService } = makeUsecase();

    await expect(
      usecase.execute(
        command({
          handlingResult: RepairRequestHandlingResult.UNREPAIRABLE,
          closureReason: '  ',
        }),
      ),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.closeRequest).not.toHaveBeenCalled();
  });

  it('缺少结单确认版本时拒绝，不把缺失当作 0，也不开启事务', async () => {
    const { usecase, transactionRunner, repairRequestService } = makeUsecase();

    await expect(
      usecase.execute(command({ maintenanceVersionNo: undefined as unknown as number })),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });

    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.closeRequest).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null])(
    '非法结单确认版本 %p 在开启事务前拒绝',
    async (maintenanceVersionNo) => {
      const { usecase, transactionRunner, repairRequestService } = makeUsecase();

      await expect(
        usecase.execute(
          command({ maintenanceVersionNo: maintenanceVersionNo as unknown as number }),
        ),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(repairRequestService.closeRequest).not.toHaveBeenCalled();
    },
  );

  it('合法的 0 版本可正常结单', async () => {
    const { usecase, repairRequestService } = makeUsecase({
      repairRequestService: {
        findProcessWriteTargetForUpdate: jest
          .fn()
          .mockResolvedValue(target({ maintenanceVersionNo: 0 })),
        closeRequest: jest.fn().mockResolvedValue(1),
      },
    });

    const result = await usecase.execute(command({ maintenanceVersionNo: 0 }));

    expect(result.closureStatus).toBe('CLOSED');
    expect(repairRequestService.closeRequest).toHaveBeenCalledTimes(1);
  });

  it('确认版本落后于当前维修版本：拒绝且不写结单状态与时间', async () => {
    const { usecase, repairRequestService } = makeUsecase({
      repairRequestService: {
        findProcessWriteTargetForUpdate: jest
          .fn()
          .mockResolvedValue(target({ maintenanceVersionNo: 4 })),
        closeRequest: jest.fn(),
      },
    });

    await expect(usecase.execute(command({ maintenanceVersionNo: 3 }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
    });

    expect(repairRequestService.closeRequest).not.toHaveBeenCalled();
  });

  it('非接单人、跨公司、可信服务归属缺失、已结单、已删除均拒绝且不写结单', async () => {
    const cases = [
      {
        target: target({ acceptedByEngineerAccountId: 900002 }),
        code: REPAIR_REQUEST_ERROR.NOT_ACCEPTED,
      },
      {
        target: target({ isAccepted: false, acceptedByEngineerAccountId: null }),
        code: REPAIR_REQUEST_ERROR.NOT_ACCEPTED,
      },
      {
        target: target({ serviceOrganizationId: 920002 }),
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      },
      {
        target: target({ serviceOrganizationId: null }),
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      },
      { target: null, code: REPAIR_REQUEST_ERROR.NOT_FOUND },
      { target: target({ deprecated: true }), code: REPAIR_REQUEST_ERROR.NOT_FOUND },
      {
        target: target({ closureStatus: 'CLOSED' }),
        code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
      },
      {
        target: target({ handlingStatus: 'COMPLETED' }),
        code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
      },
    ];

    for (const testCase of cases) {
      const repairRequestService: RepairRequestServiceMock = {
        findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(testCase.target),
        closeRequest: jest.fn(),
      };
      const { usecase } = makeUsecase({ repairRequestService });

      await expect(usecase.execute(command())).rejects.toMatchObject({ code: testCase.code });
      expect(repairRequestService.closeRequest).not.toHaveBeenCalled();
    }
  });

  it('结单条件更新命中 0 行（并发重复结单）按状态冲突处理', async () => {
    const repairRequestService: RepairRequestServiceMock = {
      findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(target()),
      closeRequest: jest.fn().mockResolvedValue(0),
    };
    const { usecase } = makeUsecase({ repairRequestService });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
    });
  });

  it('客户角色拒绝且不开启事务', async () => {
    const { usecase, transactionRunner, repairRequestService } = makeUsecase();
    const customerSession = {
      accountId: 900002,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
    } as UsecaseSession;

    await expect(usecase.execute(command({ session: customerSession }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.closeRequest).not.toHaveBeenCalled();
  });
});
