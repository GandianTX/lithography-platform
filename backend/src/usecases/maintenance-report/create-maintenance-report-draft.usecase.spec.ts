/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { CreateMaintenanceReportDraftUsecase } from './create-maintenance-report-draft.usecase';

/**
 * 建稿事务的读取顺序：
 * REPEATABLE READ 下普通读会建立事务快照，因此行锁必须是第一次读取；
 * 否则并发的「已有总结」预检会读到旧快照而被唯一键兜底拦下（表现为系统错误）。
 */
describe('CreateMaintenanceReportDraftUsecase 锁序', () => {
  const transactionContext = Object.freeze({});
  const engineerSession: UsecaseSession = {
    accountId: 900001,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
  } as UsecaseSession;

  const callOrder: string[] = [];

  const makeUsecase = (hasSummary = false) => {
    const reportService = {
      readRepairRequestWriteContext: jest.fn(() => {
        callOrder.push('lock-work-order');
        return Promise.resolve({
          repairRequestId: 955001,
          deprecated: false,
          isAccepted: true,
          acceptedEngineerAccountId: 900001,
          ownerOrganizationId: 920001,
          handlingStatus: null,
        });
      }),
      insertReport: jest.fn().mockResolvedValue({ id: 990001 }),
      updateDraft: jest.fn().mockResolvedValue(undefined),
      replaceAlarms: jest.fn().mockResolvedValue(undefined),
      replaceSteps: jest.fn().mockResolvedValue(undefined),
    };
    const reportQueryService = {
      hasWorkOrderSummary: jest.fn(() => {
        callOrder.push('has-summary');
        return Promise.resolve(hasSummary);
      }),
      readReport: jest.fn().mockResolvedValue({
        id: 990001,
        status: 'DRAFT',
        currentVersionNo: 0,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    };
    const organizationContextService = {
      resolveForAccount: jest.fn(() => {
        callOrder.push('resolve-organization');
        return Promise.resolve({ organizationId: 920001 });
      }),
    };
    const equipmentModelQueryService = { findModelById: jest.fn() };
    const accountQueryService = {
      findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map()),
    };
    const transactionRunner = {
      run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
    } as unknown as TransactionRunner;

    const usecase = new CreateMaintenanceReportDraftUsecase(
      reportService as unknown as MaintenanceReportService,
      reportQueryService as unknown as MaintenanceReportQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      accountQueryService as unknown as AccountQueryService,
      transactionRunner,
    );
    return { usecase, reportService, reportQueryService };
  };

  beforeEach(() => {
    callOrder.length = 0;
  });

  it('关联工单：先锁工单，再解析组织，最后做已存在总结预检', async () => {
    const { usecase } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: 955001,
      draft: {},
    });

    expect(callOrder).toEqual(['lock-work-order', 'resolve-organization', 'has-summary']);
  });

  it('锁后预检命中已有总结时返回业务冲突', async () => {
    const { usecase, reportService } = makeUsecase(true);

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: 955001,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED });

    expect(reportService.insertReport).not.toHaveBeenCalled();
  });

  it('历史案例不关联工单：不触达工单锁', async () => {
    const { usecase, reportService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      repairRequestId: null,
      draft: {},
    });

    expect(reportService.readRepairRequestWriteContext).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['resolve-organization']);
  });
});
