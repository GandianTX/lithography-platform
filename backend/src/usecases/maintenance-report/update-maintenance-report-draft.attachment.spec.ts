// src/usecases/maintenance-report/update-maintenance-report-draft.attachment.spec.ts
//
// R050-02/R062-01 续填草稿同事务附件绑定/更换单测：
// - 无有效原件：内容更新与绑定同一事务，绑定失败随内容一起回滚；
// - 更换：先退役旧附件行、解除旧 stored_file 绑定（file_id 非空时），再绑定新原件；
//   顺序固定为 retire → unbind → bind，任一步失败旧有效关联随事务回滚保留；
// - 同一 file_id 重发：幂等跳过，不重复退役/绑定；
// - 历史多附件行：拒绝，不为执行新规则静默删除或隐藏历史数据。

/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { MaintenanceAiUsage } from '@app-types/models/maintenance-report.types';
import { StoredFileBusinessType } from '@app-types/models/stored-file.types';
import { MAINTENANCE_REPORT_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { MaintenanceReportSnapshot } from '@src/modules/lithography/maintenance-report.types';
import { UpdateMaintenanceReportDraftUsecase } from './update-maintenance-report-draft.usecase';

const ACCOUNT_ID = 900201;
const ORGANIZATION_ID = 910201;
const REPORT_ID = 960201;
const OLD_FILE_ID = '2a1b2c3d-4e5f-4678-8293-a4b5c6d7e8f9';
const NEW_FILE_ID = '3b2c3d4e-5f6a-4789-9304-b5c6d7e8f9a0';
const UPLOAD_CONTEXT_ID = '4c3d4e5f-6a7b-4890-a415-c6d7e8f9a0b1';

const engineerSession = {
  accountId: ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

const makeEditableReport = (
  overrides: Partial<MaintenanceReportSnapshot> = {},
): MaintenanceReportSnapshot =>
  ({
    id: REPORT_ID,
    status: 'DRAFT',
    maintenanceEngineerAccountId: ACCOUNT_ID,
    ownerOrganizationId: ORGANIZATION_ID,
    currentVersionNo: 1,
    ...overrides,
  }) as MaintenanceReportSnapshot;

const makeDraftDetail = () => ({
  report: makeEditableReport({
    title: '原草稿标题',
    customerFactoryName: null,
    equipmentModelId: null,
    equipmentModelText: null,
    maintenanceDate: null,
    handlingResult: null,
    closureReason: null,
    resetResult: null,
    actualCause: null,
    repairActions: null,
    verificationResult: null,
    supplementaryNote: null,
    aiUsage: MaintenanceAiUsage.NOT_USED,
    aiSourceType: null,
    aiSourceId: null,
    aiSourceVersion: null,
    aiScore: null,
    aiCorrectness: null,
    aiHelpfulness: null,
    aiNote: null,
  }) as MaintenanceReportSnapshot & Record<string, unknown>,
  alarms: [],
  steps: [],
  faults: [],
});

const makeStagedFile = (fileId = NEW_FILE_ID) => ({
  fileId,
  uploadedByAccountId: ACCOUNT_ID,
  ownerOrganizationId: ORGANIZATION_ID,
  storageReference: 'mr/new.txt',
  originalFilename: 'new.txt',
  mimeType: 'text/plain',
  byteSize: 9,
  checksumSha256: 'b'.repeat(64),
  status: 'VALID',
  businessType: StoredFileBusinessType.MAINTENANCE_REPORT,
  businessId: null,
  uploadContextId: UPLOAD_CONTEXT_ID,
  bindingStatus: 'TEMPORARY',
  createdAt: new Date(),
  verifiedAt: new Date(),
});

const makeQueryService = () => ({
  readDraftDetail: jest.fn().mockResolvedValue(makeDraftDetail()),
  readReport: jest.fn().mockResolvedValue({
    id: REPORT_ID,
    status: 'DRAFT',
    currentVersionNo: 2,
    updatedAt: new Date(),
  }),
  readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue([]),
});

const makeWriteService = (report: MaintenanceReportSnapshot = makeEditableReport()) => ({
  lockReportForWrite: jest.fn().mockResolvedValue(report),
  updateDraft: jest.fn().mockResolvedValue(undefined),
  replaceAlarms: jest.fn().mockResolvedValue(undefined),
  replaceSteps: jest.fn().mockResolvedValue(undefined),
  replaceFaults: jest.fn().mockResolvedValue(undefined),
  retireAttachment: jest.fn().mockResolvedValue(true),
  insertAttachment: jest.fn().mockResolvedValue({ id: 99 }),
});

const makeStoredFileService = (staged: Record<string, unknown> | null = makeStagedFile()) => ({
  lockForBinding: jest.fn().mockResolvedValue(staged),
  bindIfTemporary: jest.fn().mockResolvedValue(1),
  unbindIfBoundTo: jest.fn().mockResolvedValue(1),
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORGANIZATION_ID }),
});

const makeEquipmentModelService = () => ({
  findModelById: jest.fn().mockResolvedValue(null),
});

const makeUsecase = (
  overrides: {
    queryService?: ReturnType<typeof makeQueryService>;
    writeService?: ReturnType<typeof makeWriteService>;
    storedFileService?: ReturnType<typeof makeStoredFileService>;
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const writeService = overrides.writeService ?? makeWriteService();
  const storedFileService = overrides.storedFileService ?? makeStoredFileService();
  const usecase = new UpdateMaintenanceReportDraftUsecase(
    writeService as unknown as MaintenanceReportService,
    queryService as unknown as MaintenanceReportQueryService,
    makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    makeEquipmentModelService() as unknown as EquipmentModelQueryService,
    storedFileService as unknown as StoredFileService,
    {
      findRecord: jest.fn().mockResolvedValue(null),
      listSteps: jest.fn().mockResolvedValue([]),
      listFaultPanels: jest.fn().mockResolvedValue([]),
      findIntakeSource: jest.fn().mockResolvedValue(null),
    } as never,
    {
      findOrganizationNameById: jest.fn().mockResolvedValue(null),
    } as never,
    // 历史维修记录不涉及 AI 会话读侧；该分支未被调用
    {
      listVisible: jest.fn(),
      findVisibleDetail: jest.fn().mockResolvedValue(null),
    } as never,
    {
      run: async <T>(work: (context: never) => Promise<T>): Promise<T> => work({} as never),
    },
  );
  return { usecase, queryService, writeService, storedFileService };
};

const execute = (
  usecase: UpdateMaintenanceReportDraftUsecase,
  attachment?: { fileId: string; uploadContextId: string },
) =>
  usecase.execute({
    session: engineerSession,
    reportId: REPORT_ID,
    draft: { title: '续填标题' },
    attachment: attachment ?? null,
  });

describe('UpdateMaintenanceReportDraftUsecase 续填同事务附件（R050-02/R062-01）', () => {
  it('未携带附件：只更新内容，不触达暂存原件与附件行', async () => {
    const { usecase, storedFileService, writeService } = makeUsecase();
    await execute(usecase);
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
    expect(writeService.updateDraft).toHaveBeenCalledTimes(1);
  });

  it('续填携带新原件（尚无有效附件）：内容更新与绑定同事务完成', async () => {
    const { usecase, queryService, storedFileService, writeService } = makeUsecase();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([]);
    await execute(usecase, { fileId: NEW_FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID });

    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      {
        fileId: NEW_FILE_ID,
        businessType: StoredFileBusinessType.MAINTENANCE_REPORT,
        businessId: String(REPORT_ID),
      },
      expect.anything(),
    );
    expect(writeService.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: REPORT_ID, fileId: NEW_FILE_ID }),
      expect.anything(),
    );
    expect(writeService.updateDraft).toHaveBeenCalledTimes(1);
  });

  it('更换原件：先退役旧附件行并解除旧绑定，再绑定新原件（同事务）', async () => {
    const { usecase, queryService, storedFileService, writeService } = makeUsecase();
    // 第一次读（上限裁决）看到旧附件行；退役后的重读（绑定排序）返回空集合
    queryService.readCurrentAttachmentsForSubmit
      .mockResolvedValueOnce([{ id: 31, byteSize: 7, sortOrder: 1, fileId: OLD_FILE_ID }])
      .mockResolvedValue([]);
    const callOrder: string[] = [];
    writeService.retireAttachment.mockImplementation(() => {
      callOrder.push('retire');
      return Promise.resolve(true);
    });
    storedFileService.unbindIfBoundTo.mockImplementation(() => {
      callOrder.push('unbind');
      return Promise.resolve(1);
    });
    storedFileService.bindIfTemporary.mockImplementation(() => {
      callOrder.push('bind');
      return Promise.resolve(1);
    });
    writeService.updateDraft.mockImplementation(() => {
      callOrder.push('updateDraft');
      return Promise.resolve(undefined);
    });

    await execute(usecase, { fileId: NEW_FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID });

    expect(writeService.retireAttachment).toHaveBeenCalledWith(
      REPORT_ID,
      31,
      expect.any(Date),
      expect.anything(),
    );
    expect(storedFileService.unbindIfBoundTo).toHaveBeenCalledWith(
      {
        fileId: OLD_FILE_ID,
        businessType: StoredFileBusinessType.MAINTENANCE_REPORT,
        businessId: String(REPORT_ID),
      },
      expect.anything(),
    );
    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: NEW_FILE_ID }),
      expect.anything(),
    );
    expect(callOrder).toEqual(['retire', 'unbind', 'bind', 'updateDraft']);
  });

  it('同一原件重发（fileId 相同）：幂等跳过，不重复退役/绑定', async () => {
    const { usecase, queryService, storedFileService, writeService } = makeUsecase();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([
      { id: 31, byteSize: 7, sortOrder: 1, fileId: NEW_FILE_ID },
    ]);
    await execute(usecase, { fileId: NEW_FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID });

    expect(writeService.retireAttachment).not.toHaveBeenCalled();
    expect(storedFileService.unbindIfBoundTo).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
    expect(writeService.insertAttachment).not.toHaveBeenCalled();
    expect(writeService.updateDraft).toHaveBeenCalledTimes(1);
  });

  it('历史多附件行：拒绝更换，不触发任何写入（不静默隐藏历史数据）', async () => {
    const { usecase, queryService, storedFileService, writeService } = makeUsecase();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([
      { id: 31, byteSize: 7, sortOrder: 1, fileId: null },
      { id: 32, byteSize: 7, sortOrder: 2, fileId: null },
    ]);
    await expect(
      execute(usecase, { fileId: NEW_FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID }),
    ).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
      message: expect.stringContaining('逐份移除'),
    });
    expect(writeService.retireAttachment).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
    expect(writeService.updateDraft).not.toHaveBeenCalled();
  });

  it('绑定失败（暂存原件不可用）：异常随事务传播，内容更新不落库', async () => {
    const { usecase, writeService } = makeUsecase({
      storedFileService: makeStoredFileService(null),
    });
    await expect(
      execute(usecase, { fileId: NEW_FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(writeService.updateDraft).not.toHaveBeenCalled();
    expect(writeService.insertAttachment).not.toHaveBeenCalled();
  });

  it('更换时旧附件行退役未命中：ATTACHMENT_NOT_FOUND，绑定与内容更新不执行', async () => {
    const { usecase, queryService, storedFileService, writeService } = makeUsecase();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([
      { id: 31, byteSize: 7, sortOrder: 1, fileId: OLD_FILE_ID },
    ]);
    writeService.retireAttachment.mockResolvedValue(false);
    await expect(
      execute(usecase, { fileId: NEW_FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND });
    expect(storedFileService.unbindIfBoundTo).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
    expect(writeService.updateDraft).not.toHaveBeenCalled();
  });
});
