/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { PERMISSION_ERROR, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { RepairProcessEntryService } from '@src/modules/lithography/repair-process-entry.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { CreateRepairProcessEntryUsecase } from './create-repair-process-entry.usecase';

const transactionContext = { transaction: 'mock' } as unknown as PersistenceTransactionContext;
const requestId = 42;

const engineerSession: UsecaseSession = {
  accountId: 900001,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as UsecaseSession;

type RepairProcessEntryServiceMock = {
  insertEntry: jest.Mock;
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
    insertEntry: jest.fn(),
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

  const usecase = new CreateRepairProcessEntryUsecase(
    repairRequestService as unknown as RepairRequestService,
    repairProcessEntryService as unknown as RepairProcessEntryService,
    bindUsecase as unknown as BindRepairProcessOriginalUsecase,
    organizationContext as unknown as TrustedOrganizationContextQueryService,
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
  overrides: Partial<Parameters<CreateRepairProcessEntryUsecase['execute']>[0]> = {},
) => ({
  session: engineerSession,
  requestId,
  operationText: '更换光源模块',
  testResult: '曝光均匀性恢复',
  occurredAt: '2026-11-14T10:00:00.000+08:00',
  ...overrides,
});

describe('CreateRepairProcessEntryUsecase（旧过程只读）', () => {
  it('有效旧新增按 PROCESS_READONLY 拒绝：不开启事务、不锁工单、不写过程', async () => {
    const { usecase, repairProcessEntryService, repairRequestService, transactionRunner } =
      makeUsecase();

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_READONLY,
    });

    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.findProcessWriteTargetForUpdate).not.toHaveBeenCalled();
    expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
  });

  it('携带原件的旧新增同样拒绝：不绑定原件、不写过程', async () => {
    const { usecase, repairProcessEntryService, bindUsecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute(
        command({
          file: {
            fileId: '11111111-1111-4111-8111-111111111111',
            uploadContextId: '22222222-2222-4222-8222-222222222222',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.PROCESS_READONLY });

    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(bindUsecase.executeInTransaction).not.toHaveBeenCalled();
    expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
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
    expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
  });

  it('非法工单号在只读拒绝前按参数错误拒绝', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(usecase.execute(command({ requestId: 0 }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});
