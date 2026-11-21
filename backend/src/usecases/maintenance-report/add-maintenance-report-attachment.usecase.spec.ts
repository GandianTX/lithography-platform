// src/usecases/maintenance-report/add-maintenance-report-attachment.usecase.spec.ts
//
// R050-02/R045-02 附件挂接单测：暂存原件事实逐项核验（用途/上传者/公司/上下文/
// VALID/TEMPORARY）+ 原子绑定 + 按 stored_file 事实登记元数据；任一不成立即拒绝
// 且不触发绑定（事务整体回滚由 TransactionRunner 契约保证，替身按同一语义实现）。

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { MaintenanceReportStatus } from '@app-types/models/maintenance-report.types';
import { StoredFileBusinessType } from '@app-types/models/stored-file.types';
import { MAINTENANCE_REPORT_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { MaintenanceReportSnapshot } from '@src/modules/lithography/maintenance-report.types';
import { AddMaintenanceReportAttachmentUsecase } from './add-maintenance-report-attachment.usecase';

const ACCOUNT_ID = 900101;
const ORGANIZATION_ID = 910101;
const REPORT_ID = 960101;
const FILE_ID = '0f1e2d3c-4b5a-6978-8192-a3b4c5d6e7f8';
const UPLOAD_CONTEXT_ID = '1a2b3c4d-5e6f-4708-9192-b3c4d5e6f7a8';

const engineerSession = {
  accountId: ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

const makeStagedFile = (overrides: Record<string, unknown> = {}) => ({
  fileId: FILE_ID,
  uploadedByAccountId: ACCOUNT_ID,
  ownerOrganizationId: ORGANIZATION_ID,
  storageReference: 'mr/known.txt',
  originalFilename: 'known.txt',
  mimeType: 'text/plain',
  byteSize: 7,
  checksumSha256: 'a'.repeat(64),
  status: 'VALID',
  businessType: StoredFileBusinessType.MAINTENANCE_REPORT,
  businessId: null,
  uploadContextId: UPLOAD_CONTEXT_ID,
  bindingStatus: 'TEMPORARY',
  createdAt: new Date(),
  verifiedAt: new Date(),
  ...overrides,
});

const makeEditableReport = (
  overrides: Partial<MaintenanceReportSnapshot> = {},
): MaintenanceReportSnapshot =>
  ({
    id: REPORT_ID,
    status: 'DRAFT',
    maintenanceEngineerAccountId: ACCOUNT_ID,
    ownerOrganizationId: ORGANIZATION_ID,
    currentVersionNo: 0,
    ...overrides,
  }) as MaintenanceReportSnapshot;

const makeQueryService = () => ({
  readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue([]),
});

const makeWriteService = (report: MaintenanceReportSnapshot = makeEditableReport()) => ({
  lockReportForWrite: jest.fn().mockResolvedValue(report),
  insertAttachment: jest.fn().mockResolvedValue({ id: 1 }),
});

const makeStoredFileService = (staged: Record<string, unknown> | null = makeStagedFile()) => ({
  lockForBinding: jest.fn().mockResolvedValue(staged),
  bindIfTemporary: jest.fn().mockResolvedValue(1),
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORGANIZATION_ID }),
});

const makeUsecase = (
  overrides: {
    queryService?: ReturnType<typeof makeQueryService>;
    writeService?: ReturnType<typeof makeWriteService>;
    storedFileService?: ReturnType<typeof makeStoredFileService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const writeService = overrides.writeService ?? makeWriteService();
  const storedFileService = overrides.storedFileService ?? makeStoredFileService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const usecase = new AddMaintenanceReportAttachmentUsecase(
    writeService as unknown as MaintenanceReportService,
    queryService as unknown as MaintenanceReportQueryService,
    storedFileService as unknown as StoredFileService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    {
      run: async <T>(work: (context: never) => Promise<T>): Promise<T> => work({} as never),
    },
  );
  return { usecase, queryService, writeService, storedFileService };
};

const execute = (usecase: AddMaintenanceReportAttachmentUsecase) =>
  usecase.execute({
    session: engineerSession,
    reportId: REPORT_ID,
    fileId: FILE_ID,
    uploadContextId: UPLOAD_CONTEXT_ID,
    description: '现场照片',
    sortOrder: null,
  });

describe('AddMaintenanceReportAttachmentUsecase 暂存核验与绑定', () => {
  it('正向：核验通过后原子绑定并按 stored_file 事实登记元数据', async () => {
    // 挂接前的当前集合为空（上限裁决读 + 绑定排序读）；挂接后读回包含新附件行
    const queryService = makeQueryService();
    queryService.readCurrentAttachmentsForSubmit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 1, byteSize: 7, sortOrder: 1 }]);
    const { usecase, writeService, storedFileService } = makeUsecase({ queryService });
    const result = await execute(usecase);

    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      {
        fileId: FILE_ID,
        businessType: StoredFileBusinessType.MAINTENANCE_REPORT,
        businessId: String(REPORT_ID),
      },
      expect.anything(),
    );
    expect(writeService.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: REPORT_ID,
        fileId: FILE_ID,
        originalFilename: 'known.txt',
        mimeType: 'text/plain',
        byteSize: 7,
        checksumSha256: 'a'.repeat(64),
        storageBackend: 'LOCAL',
        storageReference: 'mr/known.txt',
        uploadedByAccountId: ACCOUNT_ID,
        description: '现场照片',
        sortOrder: 1,
      }),
      expect.anything(),
    );
    expect(result).toMatchObject({ reportId: REPORT_ID, attachmentIds: [1] });
  });

  it('用途不符（非 MAINTENANCE_REPORT）：拒绝且不触发绑定', async () => {
    const { usecase, storedFileService } = makeUsecase({
      storedFileService: makeStoredFileService(
        makeStagedFile({ businessType: StoredFileBusinessType.REPAIR_PROCESS }),
      ),
    });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: STORED_FILE_ERROR.NOT_BINDABLE,
    });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('上传者非本人：拒绝且不触发绑定', async () => {
    const { usecase, storedFileService } = makeUsecase({
      storedFileService: makeStoredFileService(makeStagedFile({ uploadedByAccountId: 999 })),
    });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: STORED_FILE_ERROR.NOT_BINDABLE,
    });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('原件归属公司与报告不一致：拒绝且不触发绑定', async () => {
    const { usecase, storedFileService } = makeUsecase({
      storedFileService: makeStoredFileService(makeStagedFile({ ownerOrganizationId: 910999 })),
    });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: STORED_FILE_ERROR.NOT_BINDABLE,
    });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('uploadContextId 与暂存登记不一致：统一 NOT_FOUND（不泄露存在性）', async () => {
    const { usecase, storedFileService } = makeUsecase();
    await expect(
      usecase.execute({
        session: engineerSession,
        reportId: REPORT_ID,
        fileId: FILE_ID,
        uploadContextId: 'wrong-context',
        description: null,
        sortOrder: null,
      }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('暂存状态非 VALID（上传未完成/已失效）：拒绝且不触发绑定', async () => {
    const { usecase, storedFileService } = makeUsecase({
      storedFileService: makeStoredFileService(makeStagedFile({ status: 'FAILED' })),
    });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
    });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('原件已被绑定（非 TEMPORARY）：ALREADY_BOUND 且不重复绑定', async () => {
    const { usecase, storedFileService } = makeUsecase({
      storedFileService: makeStoredFileService(
        makeStagedFile({ bindingStatus: 'BOUND', businessId: '960999' }),
      ),
    });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: STORED_FILE_ERROR.ALREADY_BOUND,
    });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('R062-01：已持 1 份有效原件再挂接 → ATTACHMENT_LIMIT_EXCEEDED，不触发绑定', async () => {
    const queryService = makeQueryService();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([
      { id: 11, byteSize: 7, sortOrder: 1, fileId: 'existing-file-id' },
    ]);
    const { usecase, storedFileService } = makeUsecase({ queryService });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
      message: expect.stringContaining('最多保留 1 份'),
    });
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('R062-01：历史多附件报告拒绝挂接，不静默隐藏历史数据', async () => {
    const queryService = makeQueryService();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([
      { id: 11, byteSize: 7, sortOrder: 1, fileId: null },
      { id: 12, byteSize: 7, sortOrder: 2, fileId: null },
    ]);
    const { usecase, storedFileService } = makeUsecase({ queryService });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
      message: expect.stringContaining('逐份移除'),
    });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('并发占用：绑定条件更新未命中 → ALREADY_BOUND（事务回滚不留半份关联）', async () => {
    const { usecase, writeService, storedFileService } = makeUsecase({
      storedFileService: makeStoredFileService(),
    });
    storedFileService.bindIfTemporary.mockResolvedValue(0);
    await expect(execute(usecase)).rejects.toMatchObject({
      code: STORED_FILE_ERROR.ALREADY_BOUND,
    });
    expect(writeService.insertAttachment).not.toHaveBeenCalled();
  });

  it('fileId 或 uploadContextId 缺失：参数拒绝，不进入行锁', async () => {
    const { usecase, storedFileService } = makeUsecase();
    await expect(
      usecase.execute({
        session: engineerSession,
        reportId: REPORT_ID,
        fileId: '  ',
        uploadContextId: UPLOAD_CONTEXT_ID,
        description: null,
        sortOrder: null,
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({
        session: engineerSession,
        reportId: REPORT_ID,
        fileId: FILE_ID,
        uploadContextId: '',
        description: null,
        sortOrder: null,
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
  });

  it('非本人报告（异主/跨公司）：报告行锁守卫统一 NOT_FOUND，不触暂存原件', async () => {
    const otherOwner = makeWriteService(makeEditableReport({ maintenanceEngineerAccountId: 999 }));
    const crossOrg = makeWriteService(makeEditableReport({ ownerOrganizationId: 910999 }));
    const { usecase: ownerUsecase, storedFileService } = makeUsecase({ writeService: otherOwner });
    await expect(execute(ownerUsecase)).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.NOT_FOUND,
    });
    const crossOrgCase = makeUsecase({ writeService: crossOrg });
    await expect(execute(crossOrgCase.usecase)).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.NOT_FOUND,
    });
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
    expect(crossOrgCase.storedFileService.lockForBinding).not.toHaveBeenCalled();
  });

  it('已冻结报告不可挂接：STATE_NOT_EDITABLE', async () => {
    const { usecase, storedFileService } = makeUsecase({
      writeService: makeWriteService(
        makeEditableReport({ status: MaintenanceReportStatus.SUBMITTED }),
      ),
    });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.STATE_NOT_EDITABLE,
    });
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
  });

  it('暂存原件不存在：NOT_FOUND', async () => {
    const { usecase } = makeUsecase({ storedFileService: makeStoredFileService(null) });
    await expect(execute(usecase)).rejects.toMatchObject({
      code: STORED_FILE_ERROR.NOT_FOUND,
    });
  });

  it('非工程师会话拒绝挂接', async () => {
    const { usecase } = makeUsecase();
    await expect(
      usecase.execute({
        session: {
          accountId: ACCOUNT_ID,
          roles: ['CUSTOMER'],
          activeRole: 'CUSTOMER',
        } as unknown as UsecaseSession,
        reportId: REPORT_ID,
        fileId: FILE_ID,
        uploadContextId: UPLOAD_CONTEXT_ID,
        description: null,
        sortOrder: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });
});
