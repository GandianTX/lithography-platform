/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
  STORED_FILE_ERROR,
  TIME_ERROR,
} from '@core/common/errors/domain-error';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { RepairProcessEntryService } from '@src/modules/lithography/repair-process-entry.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { CreateRepairProcessEntryUsecase } from './create-repair-process-entry.usecase';

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
  ...overrides,
});

const entrySnapshot = {
  id: '501',
  entryUuid: '33333333-3333-4333-8333-333333333333',
  requestId,
  authorAccountId: engineerSession.accountId,
  operationText: '更换光源模块',
  testResult: '曝光均匀性恢复',
  occurredAt: new Date('2026-11-14T02:00:00.000Z'),
  timeSource: 'MANUAL',
  fileId: null,
  versionNo: 1,
  createdAt: new Date('2026-11-14T02:00:00.000Z'),
};

type RepairProcessEntryServiceMock = {
  insertEntry: jest.Mock;
};

type RepairRequestServiceMock = {
  findProcessWriteTargetForUpdate: jest.Mock;
};

type OrganizationContextMock = {
  resolveForAccount: jest.Mock;
};

type BindUsecaseMock = {
  executeInTransaction: jest.Mock;
};

const makeUsecase = (
  overrides: {
    repairProcessEntryService?: RepairProcessEntryServiceMock;
    repairRequestService?: RepairRequestServiceMock;
    organizationContext?: OrganizationContextMock;
    bindUsecase?: BindUsecaseMock;
  } = {},
) => {
  const repairProcessEntryService = overrides.repairProcessEntryService ?? {
    insertEntry: jest.fn().mockResolvedValue(entrySnapshot),
  };
  const repairRequestService = overrides.repairRequestService ?? {
    findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(target()),
  };
  const organizationContext = overrides.organizationContext ?? {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId }),
  };
  const bindUsecase = overrides.bindUsecase ?? {
    executeInTransaction: jest.fn().mockResolvedValue({
      fileId: '11111111-1111-4111-8111-111111111111',
      businessType: 'REPAIR_PROCESS',
      businessId: String(requestId),
      bindingStatus: 'BOUND',
    }),
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
    organizationContext,
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

describe('CreateRepairProcessEntryUsecase（任务 04 主链）', () => {
  it('接单人同组织创建成功：作者取自 Session，人工时间来源固定为 MANUAL，全部使用调用方事务', async () => {
    const { usecase, repairProcessEntryService, repairRequestService, transactionRunner } =
      makeUsecase();

    const result = await usecase.execute(command());

    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    expect(repairRequestService.findProcessWriteTargetForUpdate).toHaveBeenCalledWith(
      requestId,
      transactionContext,
    );
    const data = repairProcessEntryService.insertEntry.mock.calls[0][0];
    expect(data).toMatchObject({
      requestId,
      authorAccountId: engineerSession.accountId,
      operationText: '更换光源模块',
      testResult: '曝光均匀性恢复',
      timeSource: 'MANUAL',
      fileId: null,
    });
    expect(data.occurredAt).toEqual(new Date('2026-11-14T02:00:00.000Z'));
    expect(result).toEqual(entrySnapshot);
  });

  it('未提供事件时间时使用服务端时间并以 SERVER 记录来源', async () => {
    const before = Date.now();
    const { usecase, repairProcessEntryService } = makeUsecase();

    await usecase.execute(command({ occurredAt: null }));

    const data = repairProcessEntryService.insertEntry.mock.calls[0][0];
    expect(data.timeSource).toBe('SERVER');
    expect((data.occurredAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('携带原件时先绑定原件、再写过程，且共用同一事务', async () => {
    const { usecase, bindUsecase, repairProcessEntryService } = makeUsecase();

    await usecase.execute(
      command({
        file: {
          fileId: '11111111-1111-4111-8111-111111111111',
          uploadContextId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    );

    expect(bindUsecase.executeInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        fileId: '11111111-1111-4111-8111-111111111111',
        uploadContextId: '22222222-2222-4222-8222-222222222222',
      }),
      transactionContext,
    );
    expect(bindUsecase.executeInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      repairProcessEntryService.insertEntry.mock.invocationCallOrder[0],
    );
    expect(repairProcessEntryService.insertEntry.mock.calls[0][0].fileId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('原件绑定失败时事务内不写过程，错误原样上抛（整体回滚）', async () => {
    const bindUsecase: BindUsecaseMock = {
      executeInTransaction: jest.fn().mockRejectedValue(new Error('bind failed')),
    };
    const { usecase, repairProcessEntryService } = makeUsecase({ bindUsecase });

    await expect(
      usecase.execute(
        command({
          file: {
            fileId: '11111111-1111-4111-8111-111111111111',
            uploadContextId: '22222222-2222-4222-8222-222222222222',
          },
        }),
      ),
    ).rejects.toThrow('bind failed');
    expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
  });

  it('非接单人或他人接单拒绝，且不写过程', async () => {
    for (const currentTarget of [
      target({ isAccepted: false, acceptedByEngineerAccountId: null }),
      target({ acceptedByEngineerAccountId: 900002 }),
    ]) {
      const repairRequestService: RepairRequestServiceMock = {
        findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(currentTarget),
      };
      const { usecase, repairProcessEntryService } = makeUsecase({ repairRequestService });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_ACCEPTED,
      });
      expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
    }
  });

  it('跨公司、可信服务归属缺失或两处冲突统一按不存在处理，且不写过程', async () => {
    for (const currentTarget of [
      null,
      target({ serviceOrganizationId: 920002 }),
      target({ serviceOrganizationId: null }),
      target({ deprecated: true }),
    ]) {
      const repairRequestService: RepairRequestServiceMock = {
        findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(currentTarget),
      };
      const { usecase, repairProcessEntryService } = makeUsecase({ repairRequestService });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      });
      expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
    }
  });

  it('客户公司 A、服务公司 B：工程师属于 B 且本人接单 → 允许写过程', async () => {
    const serviceB = 920002;
    const repairRequestService: RepairRequestServiceMock = {
      findProcessWriteTargetForUpdate: jest
        .fn()
        .mockResolvedValue(
          target({ ownerOrganizationId: 910001, serviceOrganizationId: serviceB }),
        ),
    };
    const organizationContext: OrganizationContextMock = {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: serviceB }),
    };
    const { usecase, repairProcessEntryService } = makeUsecase({
      repairRequestService,
      organizationContext,
    });

    await expect(usecase.execute(command())).resolves.toMatchObject({ id: entrySnapshot.id });
    expect(repairProcessEntryService.insertEntry).toHaveBeenCalledTimes(1);
  });

  it('已结单或处理已终结拒绝写入，且不写过程', async () => {
    for (const currentTarget of [
      target({ closureStatus: 'CLOSED' }),
      target({ handlingStatus: 'COMPLETED' }),
      target({ handlingStatus: 'UNRESOLVED' }),
    ]) {
      const repairRequestService: RepairRequestServiceMock = {
        findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(currentTarget),
      };
      const { usecase, repairProcessEntryService } = makeUsecase({ repairRequestService });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
      });
      expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
    }
  });

  it('客户角色拒绝，且不开启事务、不锁工单、不写过程', async () => {
    const { usecase, repairRequestService, repairProcessEntryService, transactionRunner } =
      makeUsecase();
    const customerSession = {
      accountId: 900002,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
    } as UsecaseSession;

    await expect(usecase.execute(command({ session: customerSession }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(repairRequestService.findProcessWriteTargetForUpdate).not.toHaveBeenCalled();
    expect(repairProcessEntryService.insertEntry).not.toHaveBeenCalled();
  });

  it('执行操作为空、事件时间非法或缺少日期时间部分时在开启事务前拒绝', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(usecase.execute(command({ operationText: '   ' }))).rejects.toMatchObject({
      code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
    });
    await expect(usecase.execute(command({ occurredAt: 'not-a-date' }))).rejects.toMatchObject({
      code: TIME_ERROR.INVALID_TIME_INPUT,
    });
    // 纯日期不构成完整的事件时间
    await expect(usecase.execute(command({ occurredAt: '2026-11-14' }))).rejects.toMatchObject({
      code: TIME_ERROR.INVALID_BUSINESS_DATETIME,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('原件只提供 fileId 而无 uploadContextId 时拒绝', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute(
        command({
          file: {
            fileId: '11111111-1111-4111-8111-111111111111',
            uploadContextId: ' ',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INVALID_PARAMS });
  });
});
