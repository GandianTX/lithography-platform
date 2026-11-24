/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { InterruptRepairRequestUsecase } from './interrupt-repair-request.usecase';

const requestId = 301;
const organizationId = 77;
const engineerSession: UsecaseSession = {
  accountId: 5,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
};

const target = (overrides: Record<string, unknown> = {}) => ({
  id: requestId,
  ownerOrganizationId: organizationId,
  serviceOrganizationId: organizationId,
  isAccepted: true,
  acceptedByEngineerAccountId: engineerSession.accountId,
  deprecated: false,
  handlingStatus: null,
  closureStatus: null,
  ...overrides,
});

const makeUsecase = () => {
  const repairRequestService = {
    findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(target()),
    recordInterruption: jest.fn().mockResolvedValue(1),
  };
  const trustedOrganizationContext = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId }),
  };
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;
  const transactionRunner: TransactionRunner = {
    run: jest.fn(async (callback) => await callback(transactionContext)),
  };
  const usecase = new InterruptRepairRequestUsecase(
    repairRequestService as unknown as RepairRequestService,
    trustedOrganizationContext as unknown as TrustedOrganizationContextQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertBusinessWritableInTransaction: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertCompanyWritableInTransaction: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    transactionRunner,
  );
  return { usecase, repairRequestService, transactionRunner };
};

const command = (overrides: Record<string, unknown> = {}) => ({
  session: engineerSession,
  requestId,
  reason: '客户暂停生产，等待下周复机',
  ...overrides,
});

describe('InterruptRepairRequestUsecase', () => {
  it('接单人本人记录中断：只写原因与处理状态，不写结单/结束时间', async () => {
    const { usecase, repairRequestService } = makeUsecase();
    const before = Date.now();

    const result = await usecase.execute(command());

    const data = repairRequestService.recordInterruption.mock.calls[0][0];
    expect(data).toMatchObject({
      requestId,
      engineerAccountId: engineerSession.accountId,
      reason: '客户暂停生产，等待下周复机',
    });
    expect((data.recordedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(result).toEqual({
      requestId,
      closureStatus: null,
      closedAt: null,
      closureReason: '客户暂停生产，等待下周复机',
      handlingResult: RepairRequestHandlingResult.INTERRUPTED,
      handlingStatus: RepairRequestHandlingStatus.IN_PROGRESS,
      handlingEndedAt: null,
    });
  });

  it('中断原因必填，空白原因在开启事务前拒绝', async () => {
    const { usecase, transactionRunner, repairRequestService } = makeUsecase();

    await expect(usecase.execute(command({ reason: '   ' }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.recordInterruption).not.toHaveBeenCalled();
  });

  it.each([
    { target: target({ serviceOrganizationId: 920002 }), code: REPAIR_REQUEST_ERROR.NOT_FOUND },
    { target: target({ serviceOrganizationId: null }), code: REPAIR_REQUEST_ERROR.NOT_FOUND },
    { target: null, code: REPAIR_REQUEST_ERROR.NOT_FOUND },
    { target: target({ deprecated: true }), code: REPAIR_REQUEST_ERROR.NOT_FOUND },
    {
      target: target({ acceptedByEngineerAccountId: 999 }),
      code: REPAIR_REQUEST_ERROR.NOT_ACCEPTED,
    },
    {
      target: target({ closureStatus: 'CLOSED' }),
      code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
    },
    {
      target: target({ handlingStatus: RepairRequestHandlingStatus.COMPLETED }),
      code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
    },
  ])('拒绝不可中断目标：$code', async ({ target: targetValue, code }) => {
    const { usecase, repairRequestService } = makeUsecase();
    repairRequestService.findProcessWriteTargetForUpdate.mockResolvedValue(targetValue);

    await expect(usecase.execute(command())).rejects.toMatchObject({ code });
    expect(repairRequestService.recordInterruption).not.toHaveBeenCalled();
  });

  it('条件更新未命中（并发结单）时失败关闭', async () => {
    const { usecase, repairRequestService } = makeUsecase();
    repairRequestService.recordInterruption.mockResolvedValue(0);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
    });
  });
});
