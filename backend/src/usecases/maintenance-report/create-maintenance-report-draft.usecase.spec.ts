/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { RepairRequestWriteContext } from '@src/modules/lithography/maintenance-report.types';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
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
      readRepairRequestWriteContext: jest.fn((): Promise<RepairRequestWriteContext> => {
        callOrder.push('lock-work-order');
        return Promise.resolve({
          id: 955001,
          requestNo: 'RR-955001',
          customerAccountId: 880001,
          deprecated: false,
          isAccepted: true,
          acceptedEngineerAccountId: 900001,
          ownerOrganizationId: 920001,
          closureStatus: 'CLOSED',
          closedAt: new Date('2026-10-02T00:00:00.000Z'),
          handlingStatus: null,
          handlingResult: 'UNREPAIRABLE',
          closureReason: '客户不再推进维修',
          customerOrganizationId: 930001,
          currentRevisionNo: 1,
          equipmentModelId: 940001,
        });
      }),
      insertReport: jest.fn().mockResolvedValue({ id: 990001 }),
      updateDraft: jest.fn().mockResolvedValue(undefined),
      replaceAlarms: jest.fn().mockResolvedValue(undefined),
      replaceSteps: jest.fn().mockResolvedValue(undefined),
      replaceFaults: jest.fn().mockResolvedValue(undefined),
    };
    const reportQueryService = {
      hasWorkOrderSummary: jest.fn(() => {
        callOrder.push('has-summary');
        return Promise.resolve(hasSummary);
      }),
      readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue([]),
      readReport: jest.fn().mockResolvedValue({
        id: 990001,
        status: 'DRAFT',
        currentVersionNo: 0,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    };
    const storedFileService = {
      lockForBinding: jest.fn().mockResolvedValue(null),
      bindIfTemporary: jest.fn().mockResolvedValue(1),
    };
    const organizationContextService = {
      resolveForAccount: jest.fn(() => {
        callOrder.push('resolve-organization');
        return Promise.resolve({ organizationId: 920001 });
      }),
    };
    // 工单总结派生读侧（2026-11-20 需求调整）：预检通过后读取工单维修事实
    const maintenanceQueryService = {
      findRecord: jest.fn(() => {
        callOrder.push('maintenance-record');
        return Promise.resolve({
          maintenanceDate: '2026-10-02',
          resetResult: 'NORMAL',
          supplementaryNote: null,
          attachment: null,
        });
      }),
      listSteps: jest.fn(() => {
        callOrder.push('maintenance-steps');
        return Promise.resolve([
          {
            id: 'step-1',
            stepNo: 1,
            errorCode: null,
            partName: '激光器',
            actionText: '重新插拔线缆',
            resultCode: 'RESOLVED',
          },
        ]);
      }),
      findIntakeSource: jest.fn(() => Promise.resolve(null)),
      listFaultPanels: jest.fn(() => {
        callOrder.push('maintenance-panels');
        return Promise.resolve([
          {
            id: 'panel-1',
            panelType: 'INITIAL',
            stepId: null,
            phaseCode: 'PHASE_02',
            mainError: 'E-01',
            unitError: null,
            source: 'ALARM_HISTORY',
            errorType: null,
            gpibStatus: null,
            faultStatus: 'PERSISTENT',
            description: '上电报警',
            action: '检查供电',
          },
        ]);
      }),
    };
    const organizationQueryService = {
      findOrganizationNameById: jest.fn(() => {
        callOrder.push('customer-org-name');
        return Promise.resolve('客户公司A');
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
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      accountQueryService as unknown as AccountQueryService,
      storedFileService as unknown as StoredFileService,
      maintenanceQueryService as never,
      organizationQueryService as never,
      transactionRunner,
    );
    return { usecase, reportService, reportQueryService, storedFileService };
  };

  beforeEach(() => {
    callOrder.length = 0;
  });

  it('关联工单：先锁工单，再解析组织，预检后读取工单事实派生总结', async () => {
    const { usecase } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: 955001,
      draft: {},
    });

    expect(callOrder).toEqual([
      'lock-work-order',
      'resolve-organization',
      'has-summary',
      'maintenance-record',
      'maintenance-steps',
      'maintenance-panels',
      'customer-org-name',
    ]);
  });

  it('工单总结拒绝客户端重复填写的内容字段', async () => {
    const { usecase, reportService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: 955001,
        draft: { actualCause: '重复填写' },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });

    expect(reportService.insertReport).not.toHaveBeenCalled();
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

  it('未结单工单拒绝建稿，且不产生任何写入', async () => {
    const { usecase, reportService } = makeUsecase();
    reportService.readRepairRequestWriteContext.mockResolvedValueOnce({
      id: 955001,
      requestNo: 'RR-955001',
      customerAccountId: 880001,
      deprecated: false,
      isAccepted: true,
      acceptedEngineerAccountId: 900001,
      ownerOrganizationId: 920001,
      closureStatus: 'OPEN',
      closedAt: new Date('2026-10-02T00:00:00.000Z'),
      handlingStatus: null,
      handlingResult: null,
      closureReason: null,
      customerOrganizationId: 930001,
      currentRevisionNo: 1,
      equipmentModelId: 940001,
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: 955001,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_CLOSED });

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

describe('CreateMaintenanceReportDraftUsecase 首存同事务绑定附件（R050-01/R045-02）', () => {
  const transactionContext = Object.freeze({});
  const engineerSession: UsecaseSession = {
    accountId: 900001,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
  } as UsecaseSession;
  const FILE_ID = '0f1e2d3c-4b5a-4978-8192-a3b4c5d6e7f8';
  const UPLOAD_CONTEXT_ID = '1a2b3c4d-5e6f-4708-9192-b3c4d5e6f7a8';

  const makeUsecase = () => {
    const reportService = {
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(null),
      insertReport: jest.fn().mockResolvedValue({ id: 990001 }),
      updateDraft: jest.fn().mockResolvedValue(undefined),
      replaceAlarms: jest.fn().mockResolvedValue(undefined),
      replaceSteps: jest.fn().mockResolvedValue(undefined),
      replaceFaults: jest.fn().mockResolvedValue(undefined),
      insertAttachment: jest.fn().mockResolvedValue({ id: 1 }),
    };
    const reportQueryService = {
      hasWorkOrderSummary: jest.fn().mockResolvedValue(false),
      readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue([]),
      readReport: jest.fn().mockResolvedValue({
        id: 990001,
        status: 'DRAFT',
        currentVersionNo: 0,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    };
    const organizationContextService = {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 920001 }),
    };
    const equipmentModelQueryService = { findModelById: jest.fn() };
    const accountQueryService = {
      findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map()),
    };
    const storedFileService = {
      lockForBinding: jest.fn().mockResolvedValue({
        fileId: FILE_ID,
        uploadedByAccountId: 900001,
        ownerOrganizationId: 920001,
        storageReference: 'mr/a.txt',
        originalFilename: 'a.txt',
        mimeType: 'text/plain',
        byteSize: 7,
        checksumSha256: 'a'.repeat(64),
        status: 'VALID',
        businessType: 'MAINTENANCE_REPORT',
        businessId: null,
        uploadContextId: UPLOAD_CONTEXT_ID,
        bindingStatus: 'TEMPORARY',
        createdAt: new Date(),
        verifiedAt: new Date(),
      }),
      bindIfTemporary: jest.fn().mockResolvedValue(1),
    };
    const transactionRunner = {
      run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
    } as unknown as TransactionRunner;
    const usecase = new CreateMaintenanceReportDraftUsecase(
      reportService as unknown as MaintenanceReportService,
      reportQueryService as unknown as MaintenanceReportQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      accountQueryService as unknown as AccountQueryService,
      storedFileService as unknown as StoredFileService,
      {} as never,
      {} as never,
      transactionRunner,
    );
    return { usecase, reportService, storedFileService };
  };

  it('独立历史报告首存带暂存原件：报告根落库后绑定并登记含 file_id 的附件行', async () => {
    const { usecase, reportService, storedFileService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      draft: {},
      attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID },
    });

    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      {
        fileId: FILE_ID,
        businessType: 'MAINTENANCE_REPORT',
        businessId: '990001',
      },
      transactionContext,
    );
    expect(reportService.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 990001,
        fileId: FILE_ID,
        originalFilename: 'a.txt',
        uploadedByAccountId: 900001,
      }),
      transactionContext,
    );
  });

  it('绑定失败（暂存原件不可用）：异常随事务传播，不留草稿写入', async () => {
    const { usecase, reportService, storedFileService } = makeUsecase();
    storedFileService.lockForBinding.mockResolvedValue(null);

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        draft: {},
        attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID },
      }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });

    expect(reportService.updateDraft).not.toHaveBeenCalled();
    expect(reportService.replaceSteps).not.toHaveBeenCalled();
  });

  it('未附带附件时不触达暂存原件', async () => {
    const { usecase, storedFileService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      draft: {},
    });

    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('fileId 与 uploadContextId 只给其一：参数拒绝，不进入事务', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        draft: {},
        attachment: { fileId: FILE_ID, uploadContextId: ' ' },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
  });
});
