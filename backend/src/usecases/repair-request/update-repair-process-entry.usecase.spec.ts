/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { PERMISSION_ERROR, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { RepairProcessEntryService } from '@src/modules/lithography/repair-process-entry.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { UpdateRepairProcessEntryUsecase } from './update-repair-process-entry.usecase';

const transactionContext = { transaction: 'mock' } as unknown as PersistenceTransactionContext;
const requestId = 42;

const engineerSession: UsecaseSession = {
  accountId: 900001,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as UsecaseSession;

const stagedFile = {
  fileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  uploadContextId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

type RepairProcessEntryServiceMock = {
  findForUpdate: jest.Mock;
  updateWithVersion: jest.Mock;
};

type RepairRequestServiceMock = {
  findProcessWriteTargetForUpdate: jest.Mock;
};

type BindUsecaseMock = {
  executeInTransaction: jest.Mock;
};

const makeUsecase = (
  overrides: {
    repairProcessEntryService?: RepairProcessEntryServiceMock;
    repairRequestService?: RepairRequestServiceMock;
    bindUsecase?: BindUsecaseMock;
  } = {},
) => {
  const repairProcessEntryService = overrides.repairProcessEntryService ?? {
    findForUpdate: jest.fn(),
    updateWithVersion: jest.fn(),
  };
  const repairRequestService = overrides.repairRequestService ?? {
    findProcessWriteTargetForUpdate: jest.fn(),
  };
  const organizationContext = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
  };
  const bindUsecase = overrides.bindUsecase ?? {
    executeInTransaction: jest.fn(),
  };
  const transactionRunner: TransactionRunner = {
    run: jest.fn(async (callback) => await callback(transactionContext)),
  };

  const usecase = new UpdateRepairProcessEntryUsecase(
    repairRequestService as unknown as RepairRequestService,
    repairProcessEntryService as unknown as RepairProcessEntryService,
    bindUsecase as unknown as BindRepairProcessOriginalUsecase,
    organizationContext as unknown as TrustedOrganizationContextQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    transactionRunner,
  );

  return {
    usecase,
    repairProcessEntryService,
    repairRequestService,
    bindUsecase,
    transactionRunner,
  };
};

const command = (
  overrides: Partial<Parameters<UpdateRepairProcessEntryUsecase['execute']>[0]> = {},
) => ({
  session: engineerSession,
  requestId,
  entryId: '501',
  expectedVersion: 3,
  operationText: '更换光源模块并复测',
  testResult: '均匀性通过',
  occurredAt: '2026-11-14T10:00:00.000+08:00',
  ...overrides,
});

describe('UpdateRepairProcessEntryUsecase（旧过程只读）', () => {
  it('有效旧更新按 PROCESS_READONLY 拒绝：不开启事务、不读过程、不写过程', async () => {
    const { usecase, repairProcessEntryService, repairRequestService, transactionRunner } =
      makeUsecase();

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_READONLY,
    });

    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.findProcessWriteTargetForUpdate).not.toHaveBeenCalled();
    expect(repairProcessEntryService.findForUpdate).not.toHaveBeenCalled();
    expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
  });

  it('旧改绑携带原件同样拒绝：不绑定原件、不更新过程', async () => {
    const { usecase, repairProcessEntryService, bindUsecase, transactionRunner } = makeUsecase();

    await expect(usecase.execute(command({ file: stagedFile }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_READONLY,
    });

    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(bindUsecase.executeInTransaction).not.toHaveBeenCalled();
    expect(repairProcessEntryService.findForUpdate).not.toHaveBeenCalled();
    expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
  });

  it('客户角色仍先被权限拒绝，且不开启事务', async () => {
    const { usecase, transactionRunner, repairProcessEntryService } = makeUsecase();
    const customerSession = {
      accountId: 900002,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
    } as UsecaseSession;

    await expect(usecase.execute(command({ session: customerSession }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
  });

  it('非法工单号在只读拒绝前按参数错误拒绝', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(usecase.execute(command({ requestId: 0 }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});
