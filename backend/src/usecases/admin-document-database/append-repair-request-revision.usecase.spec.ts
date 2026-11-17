// src/usecases/admin-document-database/append-repair-request-revision.usecase.spec.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import {
  REPAIR_REQUEST_ERROR,
  DomainError,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import {
  captureThrownError,
  createSuperAdminSession,
} from '../../../test/support/account/admin-user.fixture';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  RepairRequestProcessRevisionTarget,
  RepairRequestRevisionService,
  RepairRequestRevisionTargetSnapshot,
} from '@src/modules/lithography/repair-request-revision.service';
import type { TransactionRunner } from '../common/ports/transaction-runner.contract';
import {
  AppendRepairRequestRevisionUsecase,
  type AppendRepairRequestRevisionCommand,
} from './append-repair-request-revision.usecase';

const ADMIN_ACCOUNT_ID = 100001;
const TRANSACTION_CONTEXT = {} as PersistenceTransactionContext;

function buildTarget(
  overrides: Partial<RepairRequestRevisionTargetSnapshot> = {},
): RepairRequestRevisionTargetSnapshot {
  return {
    id: 880001,
    requestNo: 'RR-20260901-001',
    customerAccountId: 900001,
    equipmentModelId: 930001,
    errorCode: 'E-001',
    faultDescription: '曝光光路异常',
    contentMd: '# 原始正文',
    serviceOrganizationId: null,
    ownerOrganizationId: 700001,
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    deprecated: false,
    isAccepted: true,
    acceptedByEngineerAccountId: 110001,
    acceptedAt: new Date('2026-09-01T09:00:00.000Z'),
    handlingResult: null,
    handlingStatus: null,
    handlingRecordedAt: null,
    handlingRecordedByAccountId: null,
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingEndedAt: null,
    currentRevisionNo: 2,
    ...overrides,
  };
}

function buildProcessEntry(
  overrides: Partial<RepairRequestProcessRevisionTarget> = {},
): RepairRequestProcessRevisionTarget {
  return {
    id: '11',
    entryUuid: '11111111-1111-4111-8111-111111111111',
    requestId: 880001,
    operationText: '原始操作',
    testResult: null,
    occurredAt: new Date('2026-09-01T10:00:00.000Z'),
    timeSource: 'SERVER',
    fileId: null,
    versionNo: 1,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

function createHarness(options: {
  adminLevel?: number | null;
  organizationId?: number;
  memberRole?: string;
  target?: RepairRequestRevisionTargetSnapshot;
  processEntries?: RepairRequestProcessRevisionTarget[];
}) {
  const target = options.target ?? buildTarget();
  const processEntries = options.processEntries ?? [buildProcessEntry()];
  const revisionService = {
    lockRequestForRevision: jest.fn().mockResolvedValue(target),
    lockProcessEntriesForRevision: jest.fn().mockResolvedValue(processEntries),
    listResponsesForSnapshot: jest.fn().mockResolvedValue([]),
    updateRequestRevisionFields: jest.fn().mockResolvedValue(1),
    updateProcessEntryRevision: jest.fn().mockResolvedValue(1),
    insertRevision: jest.fn().mockResolvedValue({
      revisionNo: target.currentRevisionNo + 1,
      previousVersion: target.currentRevisionNo,
      reason: '订正已提交事实',
      actorAccountId: ADMIN_ACCOUNT_ID,
      createdAt: new Date('2026-09-02T08:00:00.000Z'),
    }),
  };
  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(options.adminLevel ?? 1),
    findNicknamesByAccountIds: jest
      .fn()
      .mockResolvedValue(new Map([[ADMIN_ACCOUNT_ID, '管理员甲']])),
  };
  const trustedOrganizationContext = {
    resolveForAccount: jest.fn().mockResolvedValue({
      organizationId: options.organizationId ?? 700001,
      memberRole: options.memberRole ?? IdentityTypeEnum.SUPER_ADMIN,
    }),
  };
  const transactionRunner = {
    run: jest.fn(async (callback: (context: PersistenceTransactionContext) => Promise<unknown>) =>
      callback(TRANSACTION_CONTEXT),
    ),
  };

  const usecase = new AppendRepairRequestRevisionUsecase(
    revisionService as unknown as RepairRequestRevisionService,
    accountQueryService as unknown as AccountQueryService,
    trustedOrganizationContext as unknown as TrustedOrganizationContextQueryService,
    transactionRunner as unknown as TransactionRunner,
  );

  return { usecase, revisionService, accountQueryService, trustedOrganizationContext };
}

const baseCommand: AppendRepairRequestRevisionCommand = {
  session: createSuperAdminSession({ accountId: ADMIN_ACCOUNT_ID }),
  requestId: 880001,
  expectedVersion: 2,
  reason: '订正已提交事实',
  contentMd: '# 订正后正文',
};

describe('AppendRepairRequestRevisionUsecase', () => {
  it('一级管理员可跨公司修订：条件更新当前版本、写修订历史并保留原始事实快照', async () => {
    const { usecase, revisionService } = createHarness({
      adminLevel: 1,
      target: buildTarget({ ownerOrganizationId: 700002, currentRevisionNo: 2 }),
      processEntries: [buildProcessEntry({ operationText: '原始操作', versionNo: 1 })],
    });

    const result = await usecase.execute({
      ...baseCommand,
      processEntries: [
        { entryId: '11', expectedVersion: 1, operationText: '订正操作', testResult: null },
      ],
    });

    expect(result).toMatchObject({
      requestId: 880001,
      revisionNo: 3,
      previousVersion: 2,
      currentRevisionNo: 3,
      actorNickname: '管理员甲',
    });
    expect(revisionService.updateRequestRevisionFields).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 880001,
        expectedVersion: 2,
        nextVersion: 3,
        contentMd: '# 订正后正文',
      }),
      TRANSACTION_CONTEXT,
    );
    expect(revisionService.updateProcessEntryRevision).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: '11', expectedVersion: 1, operationText: '订正操作' }),
      TRANSACTION_CONTEXT,
    );
    expect(revisionService.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        revisionNo: 3,
        previousVersion: 2,
        schemaVersion: 1,
        actorAccountId: ADMIN_ACCOUNT_ID,
        reason: '订正已提交事实',
      }),
      TRANSACTION_CONTEXT,
    );

    const revisionData = revisionService.insertRevision.mock.calls[0][0] as {
      beforeSnapshot: string;
      afterSnapshot: string;
    };
    const before = JSON.parse(revisionData.beforeSnapshot) as {
      request: { content_md: string; customer_account_id: number };
      process_entries: Array<{ operation_text: string }>;
    };
    const after = JSON.parse(revisionData.afterSnapshot) as {
      request: { content_md: string; current_revision_no: number };
      process_entries: Array<{ operation_text: string; version_no: number }>;
    };
    expect(before.request.content_md).toBe('# 原始正文');
    expect(before.request.customer_account_id).toBe(900001);
    expect(before.process_entries[0].operation_text).toBe('原始操作');
    expect(after.request.content_md).toBe('# 订正后正文');
    expect(after.request.current_revision_no).toBe(3);
    expect(after.process_entries[0]).toMatchObject({
      operation_text: '订正操作',
      version_no: 2,
    });
  });

  it('二级管理员 A/B 双向越权修订均按 NOT_FOUND 拒绝，且不产生任何写入', async () => {
    const cases = [
      { organizationId: 700001, targetOwner: 700002 },
      { organizationId: 700002, targetOwner: 700001 },
    ];

    for (const item of cases) {
      const { usecase, revisionService } = createHarness({
        adminLevel: 2,
        organizationId: item.organizationId,
        target: buildTarget({ ownerOrganizationId: item.targetOwner, serviceOrganizationId: null }),
      });

      const error = await captureThrownError(usecase.execute(baseCommand));

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(REPAIR_REQUEST_ERROR.NOT_FOUND);
      expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
      expect(revisionService.updateProcessEntryRevision).not.toHaveBeenCalled();
      expect(revisionService.insertRevision).not.toHaveBeenCalled();
    }
  });

  it('二级管理员本公司修订放行（service_organization_id 优先）', async () => {
    const { usecase } = createHarness({
      adminLevel: 2,
      organizationId: 700001,
      target: buildTarget({ serviceOrganizationId: 700001, ownerOrganizationId: 700002 }),
    });

    await expect(usecase.execute(baseCommand)).resolves.toMatchObject({ revisionNo: 3 });
  });

  it('二级管理员只有 ENGINEER 成员关系：失败关闭，不进入事务与任何写入', async () => {
    const { usecase, revisionService } = createHarness({
      adminLevel: 2,
      organizationId: 700001,
      memberRole: IdentityTypeEnum.ENGINEER,
    });

    const error = await captureThrownError(usecase.execute(baseCommand));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(revisionService.lockRequestForRevision).not.toHaveBeenCalled();
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
    expect(revisionService.updateProcessEntryRevision).not.toHaveBeenCalled();
    expect(revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('旧版本修订按 PROCESS_VERSION_CONFLICT 拒绝，条件更新与历史写入都不发生', async () => {
    const { usecase, revisionService } = createHarness({
      target: buildTarget({ currentRevisionNo: 5 }),
    });

    const error = await captureThrownError(usecase.execute({ ...baseCommand, expectedVersion: 4 }));

    expect((error as DomainError).code).toBe(REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT);
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
    expect(revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('过程版本冲突中途失败：不写修订历史（真实事务由集成验证整体回滚）', async () => {
    const { usecase, revisionService } = createHarness({
      processEntries: [buildProcessEntry({ id: '11' }), buildProcessEntry({ id: '12' })],
    });
    revisionService.updateProcessEntryRevision.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const error = await captureThrownError(
      usecase.execute({
        ...baseCommand,
        processEntries: [
          { entryId: '11', expectedVersion: 1, operationText: '订正一', testResult: null },
          { entryId: '12', expectedVersion: 1, operationText: '订正二', testResult: null },
        ],
      }),
    );

    expect((error as DomainError).code).toBe(REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT);
    expect(revisionService.updateProcessEntryRevision).toHaveBeenCalledTimes(2);
    expect(revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('中断/无法修复未填结单原因时按 BAD_USER_INPUT 拒绝，不进入写流程', async () => {
    const { usecase, revisionService } = createHarness({
      target: buildTarget({ handlingResult: null, isAccepted: true }),
    });

    const error = await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession({ accountId: ADMIN_ACCOUNT_ID }),
        requestId: 880001,
        expectedVersion: 2,
        reason: '订正结果',
        handlingResult: RepairRequestHandlingResult.INTERRUPTED,
        closureReason: '',
      }),
    );

    expect((error as DomainError).code).toBe(REPAIR_REQUEST_ERROR.INVALID_PARAMS);
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
  });

  it('同值回传处理结果不写处理事实：只订正正文，处理时间/记录人/终结时间原样保留', async () => {
    const recordedAt = new Date('2026-09-01T09:30:00.000Z');
    const { usecase, revisionService } = createHarness({
      target: buildTarget({
        handlingResult: RepairRequestHandlingResult.FIXED,
        handlingStatus: RepairRequestHandlingStatus.COMPLETED,
        handlingRecordedAt: recordedAt,
        handlingRecordedByAccountId: 110001,
        handlingEndedAt: recordedAt,
      }),
    });

    await usecase.execute({
      ...baseCommand,
      handlingResult: RepairRequestHandlingResult.FIXED,
    });

    expect(revisionService.updateRequestRevisionFields).toHaveBeenCalledWith(
      expect.objectContaining({
        contentMd: '# 订正后正文',
        handlingResult: undefined,
        handlingStatus: undefined,
        handlingRecordedAt: undefined,
        handlingRecordedByAccountId: undefined,
        handlingEndedAt: undefined,
      }),
      TRANSACTION_CONTEXT,
    );

    const revisionData = revisionService.insertRevision.mock.calls[0][0] as {
      afterSnapshot: string;
    };
    const after = JSON.parse(revisionData.afterSnapshot) as {
      request: {
        handling_recorded_at: string | null;
        handling_recorded_by_account_id: number | null;
      };
    };
    expect(after.request.handling_recorded_at).toBe(recordedAt.toISOString());
    expect(after.request.handling_recorded_by_account_id).toBe(110001);
  });

  it('处理结果真实变化时写入处理事实，快照含记录时间/记录人与终结时间', async () => {
    const { usecase, revisionService } = createHarness({
      target: buildTarget({
        isAccepted: true,
        handlingResult: null,
        handlingStatus: null,
        handlingRecordedAt: null,
        handlingRecordedByAccountId: null,
        handlingEndedAt: null,
      }),
    });

    await usecase.execute({
      ...baseCommand,
      contentMd: undefined,
      handlingResult: RepairRequestHandlingResult.FIXED,
    });

    expect(revisionService.updateRequestRevisionFields).toHaveBeenCalledWith(
      expect.objectContaining({
        handlingResult: RepairRequestHandlingResult.FIXED,
        handlingStatus: RepairRequestHandlingStatus.COMPLETED,
        handlingRecordedAt: expect.any(Date),
        handlingRecordedByAccountId: ADMIN_ACCOUNT_ID,
        handlingEndedAt: expect.any(Date),
      }),
      TRANSACTION_CONTEXT,
    );

    const revisionData = revisionService.insertRevision.mock.calls[0][0] as {
      afterSnapshot: string;
    };
    const after = JSON.parse(revisionData.afterSnapshot) as {
      request: {
        handling_result: string | null;
        handling_status: string | null;
        handling_recorded_at: string | null;
        handling_recorded_by_account_id: number | null;
        handling_ended_at: string | null;
      };
    };
    expect(after.request.handling_result).toBe(RepairRequestHandlingResult.FIXED);
    expect(after.request.handling_status).toBe(RepairRequestHandlingStatus.COMPLETED);
    expect(after.request.handling_recorded_at).not.toBeNull();
    expect(after.request.handling_recorded_by_account_id).toBe(ADMIN_ACCOUNT_ID);
    expect(after.request.handling_ended_at).not.toBeNull();
  });

  it('未接单工单不能通过修订写入处理结果', async () => {
    const { usecase, revisionService } = createHarness({
      target: buildTarget({ isAccepted: false, handlingResult: null }),
    });

    const error = await captureThrownError(
      usecase.execute({
        ...baseCommand,
        handlingResult: RepairRequestHandlingResult.FIXED,
        contentMd: undefined,
      }),
    );

    expect((error as DomainError).code).toBe(REPAIR_REQUEST_ERROR.HANDLING_NOT_AVAILABLE);
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
  });
});
