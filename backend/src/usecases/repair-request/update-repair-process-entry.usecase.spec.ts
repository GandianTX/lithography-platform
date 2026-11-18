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
import { UpdateRepairProcessEntryUsecase } from './update-repair-process-entry.usecase';

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

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: '501',
  entryUuid: '33333333-3333-4333-8333-333333333333',
  requestId,
  authorAccountId: engineerSession.accountId,
  operationText: '更换光源模块',
  testResult: null,
  occurredAt: new Date('2026-11-14T02:00:00.000Z'),
  timeSource: 'MANUAL',
  fileId: '11111111-1111-4111-8111-111111111111',
  versionNo: 3,
  createdAt: new Date('2026-11-14T02:00:00.000Z'),
  ...overrides,
});

type RepairProcessEntryServiceMock = {
  findForUpdate: jest.Mock;
  updateWithVersion: jest.Mock;
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

const stagedFile = {
  fileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  uploadContextId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

const makeUsecase = (
  overrides: {
    repairProcessEntryService?: RepairProcessEntryServiceMock;
    repairRequestService?: RepairRequestServiceMock;
    bindUsecase?: BindUsecaseMock;
  } = {},
) => {
  const repairProcessEntryService = overrides.repairProcessEntryService ?? {
    findForUpdate: jest.fn().mockResolvedValue(entry()),
    updateWithVersion: jest.fn().mockResolvedValue(1),
  };
  const repairRequestService = overrides.repairRequestService ?? {
    findProcessWriteTargetForUpdate: jest.fn().mockResolvedValue(target()),
  };
  const organizationContext: OrganizationContextMock = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId }),
  };
  const bindUsecase: BindUsecaseMock = overrides.bindUsecase ?? {
    executeInTransaction: jest.fn().mockResolvedValue({
      fileId: stagedFile.fileId,
      businessType: 'REPAIR_PROCESS',
      businessId: String(requestId),
      bindingStatus: 'BOUND',
    }),
  };
  const transactionRunner: TransactionRunner = {
    run: jest.fn(async (callback) => await callback(transactionContext)),
  };

  const usecase = new UpdateRepairProcessEntryUsecase(
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

describe('UpdateRepairProcessEntryUsecase（任务 04 主链）', () => {
  it('作者本人按版本条件更新成功：版本递增，fileId 不变，全部使用调用方事务', async () => {
    const { usecase, repairProcessEntryService, transactionRunner } = makeUsecase();

    const result = await usecase.execute(command());

    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    expect(repairProcessEntryService.findForUpdate).toHaveBeenCalledWith(
      requestId,
      '501',
      transactionContext,
    );
    expect(repairProcessEntryService.updateWithVersion).toHaveBeenCalledWith(
      {
        requestId,
        entryId: '501',
        authorAccountId: engineerSession.accountId,
        expectedVersion: 3,
        operationText: '更换光源模块并复测',
        testResult: '均匀性通过',
        occurredAt: new Date('2026-11-14T02:00:00.000Z'),
        timeSource: 'MANUAL',
      },
      transactionContext,
    );
    expect(result.versionNo).toBe(4);
    expect(result.fileId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('expectedVersion 与当前版本不一致返回版本冲突，且不执行更新', async () => {
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn().mockResolvedValue(entry({ versionNo: 4 })),
      updateWithVersion: jest.fn(),
    };
    const { usecase } = makeUsecase({ repairProcessEntryService });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
    });
    expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
  });

  it('条件更新命中 0 行（并发变更）按版本冲突处理', async () => {
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn().mockResolvedValue(entry()),
      updateWithVersion: jest.fn().mockResolvedValue(0),
    };
    const { usecase } = makeUsecase({ repairProcessEntryService });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
    });
  });

  it('非作者编辑按过程不存在处理，不泄露他人过程', async () => {
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn().mockResolvedValue(entry({ authorAccountId: 900002 })),
      updateWithVersion: jest.fn(),
    };
    const { usecase } = makeUsecase({ repairProcessEntryService });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_NOT_FOUND,
    });
    expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
  });

  it('非接单人、跨公司、可信服务归属缺失、已结单均拒绝，且不读取过程行', async () => {
    const cases = [
      {
        target: target({ acceptedByEngineerAccountId: 900002 }),
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
      };
      const repairProcessEntryService: RepairProcessEntryServiceMock = {
        findForUpdate: jest.fn(),
        updateWithVersion: jest.fn(),
      };
      const { usecase } = makeUsecase({ repairRequestService, repairProcessEntryService });

      await expect(usecase.execute(command())).rejects.toMatchObject({ code: testCase.code });
      expect(repairProcessEntryService.findForUpdate).not.toHaveBeenCalled();
      expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
    }
  });

  it('客户角色拒绝且不开启事务', async () => {
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
    expect(repairProcessEntryService.findForUpdate).not.toHaveBeenCalled();
  });

  it('过程 ID 与版本号格式非法时在开启事务前拒绝', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(usecase.execute(command({ entryId: 'abc' }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
    });
    await expect(usecase.execute(command({ expectedVersion: 0 }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('执行操作为空、事件时间非法或缺少日期时间部分时在开启事务前拒绝', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(usecase.execute(command({ operationText: '  ' }))).rejects.toMatchObject({
      code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
    });
    await expect(usecase.execute(command({ occurredAt: 'not-a-date' }))).rejects.toMatchObject({
      code: TIME_ERROR.INVALID_TIME_INPUT,
    });
    await expect(usecase.execute(command({ occurredAt: '2026-11-14' }))).rejects.toMatchObject({
      code: TIME_ERROR.INVALID_BUSINESS_DATETIME,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('无原件过程补传暂存原件：先绑定（原件→工单）再锁过程，版本恰好递增一次', async () => {
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn().mockResolvedValue(entry({ fileId: null })),
      updateWithVersion: jest.fn().mockResolvedValue(1),
    };
    const { usecase, bindUsecase, repairRequestService, transactionRunner } = makeUsecase({
      repairProcessEntryService,
    });

    const result = await usecase.execute(command({ file: stagedFile }));

    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    expect(bindUsecase.executeInTransaction).toHaveBeenCalledWith(
      {
        session: engineerSession,
        requestId,
        fileId: stagedFile.fileId,
        uploadContextId: stagedFile.uploadContextId,
      },
      transactionContext,
    );
    expect(bindUsecase.executeInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      repairRequestService.findProcessWriteTargetForUpdate.mock.invocationCallOrder[0],
    );
    expect(
      repairRequestService.findProcessWriteTargetForUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(repairProcessEntryService.findForUpdate.mock.invocationCallOrder[0]);
    expect(repairProcessEntryService.findForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      repairProcessEntryService.updateWithVersion.mock.invocationCallOrder[0],
    );
    expect(repairProcessEntryService.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(repairProcessEntryService.updateWithVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: '501',
        expectedVersion: 3,
        fileId: stagedFile.fileId,
      }),
      transactionContext,
    );
    expect(result.fileId).toBe(stagedFile.fileId);
    expect(result.versionNo).toBe(4);
  });

  it('已有原件时传入新文件明确拒绝，不更新过程行也不覆盖原 fileId', async () => {
    const { usecase, repairProcessEntryService, bindUsecase } = makeUsecase();

    await expect(usecase.execute(command({ file: stagedFile }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_ORIGINAL_IMMUTABLE,
      message: expect.stringContaining('新建过程记录'),
    });
    // 绑定已在同一事务内执行，冲突由调用方事务整体回滚；离线替身只证明调用时序
    expect(bindUsecase.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
  });

  it('未传 file 时保持原 fileId：不调用绑定，条件更新不携带 fileId', async () => {
    const { usecase, repairProcessEntryService, bindUsecase } = makeUsecase();

    const result = await usecase.execute(command());

    expect(bindUsecase.executeInTransaction).not.toHaveBeenCalled();
    const updateData = repairProcessEntryService.updateWithVersion.mock.calls[0][0];
    expect(updateData).not.toHaveProperty('fileId');
    expect(result.fileId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.versionNo).toBe(4);
  });

  it('明确传 file: null 不被解释为移除原件，按输入错误拒绝且不开启事务', async () => {
    const { usecase, transactionRunner, bindUsecase } = makeUsecase();

    await expect(usecase.execute(command({ file: null }))).rejects.toMatchObject({
      code: STORED_FILE_ERROR.INVALID_PARAMS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(bindUsecase.executeInTransaction).not.toHaveBeenCalled();
  });

  it('绑定失败（异主/跨公司/错误上下文/已绑定/文件无效）失败关闭，不更新过程', async () => {
    const failureCodes = [
      STORED_FILE_ERROR.NOT_FOUND,
      STORED_FILE_ERROR.NOT_BINDABLE,
      STORED_FILE_ERROR.ALREADY_BOUND,
      STORED_FILE_ERROR.WORK_ORDER_NOT_BINDABLE,
      STORED_FILE_ERROR.INTEGRITY_FAILED,
    ];

    for (const code of failureCodes) {
      const bindUsecase: BindUsecaseMock = {
        executeInTransaction: jest.fn().mockRejectedValue(new Error(code)),
      };
      const repairProcessEntryService: RepairProcessEntryServiceMock = {
        findForUpdate: jest.fn().mockResolvedValue(entry({ fileId: null })),
        updateWithVersion: jest.fn(),
      };
      const { usecase } = makeUsecase({ bindUsecase, repairProcessEntryService });

      await expect(usecase.execute(command({ file: stagedFile }))).rejects.toThrow(code);
      expect(repairProcessEntryService.findForUpdate).not.toHaveBeenCalled();
      expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
    }
  });

  it('绑定成功后过程条件更新 affected=0：抛出版本冲突，调用方事务整体失败', async () => {
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn().mockResolvedValue(entry({ fileId: null })),
      updateWithVersion: jest.fn().mockResolvedValue(0),
    };
    const { usecase, bindUsecase, transactionRunner } = makeUsecase({
      repairProcessEntryService,
    });

    await expect(usecase.execute(command({ file: stagedFile }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
    });
    // 离线替身只证明：绑定已调用、过程更新已尝试、错误从事务回调抛出（真实事务据此回滚）
    expect(bindUsecase.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(repairProcessEntryService.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
  });

  it('绑定成功后过程版本已变：后续校验失败使同一事务整体失败，不再执行条件更新', async () => {
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn().mockResolvedValue(entry({ versionNo: 5 })),
      updateWithVersion: jest.fn(),
    };
    const { usecase, bindUsecase, transactionRunner } = makeUsecase({
      repairProcessEntryService,
    });

    await expect(usecase.execute(command({ file: stagedFile }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
    });
    // 离线替身只证明：绑定已执行、后续校验失败、错误从事务回调抛出（真实事务据此回滚绑定）
    expect(bindUsecase.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(repairProcessEntryService.updateWithVersion).not.toHaveBeenCalled();
    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
  });

  it('并发补不同文件的序列化替身：后到者看到已绑定原件即拒绝，只有一个 fileId 落库', async () => {
    let currentFileId: string | null = null;
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn(() => Promise.resolve(entry({ fileId: currentFileId }))),
      updateWithVersion: jest.fn((data: { fileId?: string }) => {
        currentFileId = data.fileId ?? null;
        return Promise.resolve(1);
      }),
    };
    const { usecase } = makeUsecase({ repairProcessEntryService });
    const secondFile = {
      fileId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      uploadContextId: stagedFile.uploadContextId,
    };

    await expect(usecase.execute(command({ file: stagedFile }))).resolves.toMatchObject({
      fileId: stagedFile.fileId,
    });
    await expect(usecase.execute(command({ file: secondFile }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_ORIGINAL_IMMUTABLE,
    });

    expect(repairProcessEntryService.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(currentFileId).toBe(stagedFile.fileId);
  });

  it('同一文件被并发绑定的序列化替身：后到者绑定失败且不触发过程更新', async () => {
    let bound = false;
    const bindUsecase: BindUsecaseMock = {
      executeInTransaction: jest.fn(() => {
        if (bound) {
          return Promise.reject(new Error(STORED_FILE_ERROR.ALREADY_BOUND));
        }
        bound = true;
        return Promise.resolve({
          fileId: stagedFile.fileId,
          businessType: 'REPAIR_PROCESS',
          businessId: String(requestId),
          bindingStatus: 'BOUND',
        });
      }),
    };
    let currentFileId: string | null = null;
    const repairProcessEntryService: RepairProcessEntryServiceMock = {
      findForUpdate: jest.fn(() => Promise.resolve(entry({ fileId: currentFileId }))),
      updateWithVersion: jest.fn((data: { fileId?: string }) => {
        currentFileId = data.fileId ?? null;
        return Promise.resolve(1);
      }),
    };
    const { usecase } = makeUsecase({ bindUsecase, repairProcessEntryService });

    await expect(usecase.execute(command({ file: stagedFile }))).resolves.toMatchObject({
      fileId: stagedFile.fileId,
    });
    await expect(usecase.execute(command({ file: stagedFile }))).rejects.toThrow(
      STORED_FILE_ERROR.ALREADY_BOUND,
    );

    expect(repairProcessEntryService.updateWithVersion).toHaveBeenCalledTimes(1);
  });
});
