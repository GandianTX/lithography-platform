// src/usecases/reference-document/download-reference-document-source-attachment.usecase.spec.ts
// 任务 07 P2 定向测试：有权查看正式资料的读者可从资料详情下载来源报告冻结版本的原件。

/// <reference types="jest" />

import { Readable } from 'node:stream';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { MaintenanceAttachmentStatus } from '@app-types/models/maintenance-report.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import type { StoredFileDownloadFacts } from '@src/modules/lithography/lithography.types';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { StoredFileStorage } from '@src/usecases/common/ports/stored-file-storage.contract';
import { createHash } from 'node:crypto';

import { DownloadReferenceDocumentSourceAttachmentUsecase } from './download-reference-document-source-attachment.usecase';

const ORG_ID = 910001;
const DOCUMENT_ID = 970010;
const REPORT_ID = 960010;
const OLD_VERSION_ID = 990010;
const NEW_VERSION_ID = 990011;
const ATTACHMENT_ID = 880123;
const OTHER_ATTACHMENT_ID = 880456;
const FILE_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const FILE_BYTES = Buffer.from('source-report-original-bytes');

const engineerSession = {
  accountId: 900002,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

const levelOneAdminSession = {
  accountId: 900099,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const levelTwoAdminSession = {
  accountId: 900098,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const customerSession = {
  accountId: 900777,
  roles: ['CUSTOMER'],
  activeRole: 'CUSTOMER',
} as unknown as UsecaseSession;

const sha256Hex = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

const makeDetail = (overrides: Record<string, unknown> = {}) =>
  ({
    id: DOCUMENT_ID,
    title: '光刻机 Z 轴故障处置经验（报告来源）',
    documentType: 'EXPERIENCE',
    equipmentModelId: null,
    equipmentModelName: null,
    equipmentModelText: null,
    description: null,
    contentText: '生效正文',
    originalFilename: null,
    mimeType: null,
    hasFile: false,
    storageReference: null,
    organizationName: '甲方默认组织',
    ingestMethod: 'REVIEWED_SUBMISSION',
    sourceKind: 'INDEPENDENT_REPORT',
    sourceReportId: REPORT_ID,
    sourceReportVersionId: OLD_VERSION_ID,
    publicationStatus: 'ONLINE',
    ownershipStatus: 'CONFIRMED',
    effectiveRevisionNo: 0,
    caseDetail: null,
    createdByAccountId: 900001,
    creatorNickname: '工程师甲',
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    ...overrides,
  }) as never;

const makeAttachmentSnapshot = (overrides: Record<string, unknown> = {}) =>
  ({
    id: ATTACHMENT_ID,
    reportId: REPORT_ID,
    fileId: FILE_ID,
    originalFilename: 'Z轴报警原件.txt',
    mimeType: 'text/plain',
    byteSize: FILE_BYTES.byteLength,
    checksumSha256: sha256Hex(FILE_BYTES),
    storageBackend: 'LOCAL',
    storageReference: 'stored-files/mock/original.txt',
    sortOrder: 1,
    description: null,
    status: MaintenanceAttachmentStatus.CURRENT,
    uploadedByAccountId: 900001,
    retiredAt: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  }) as never;

const makeFacts = (overrides: Partial<StoredFileDownloadFacts> = {}): StoredFileDownloadFacts => ({
  fileId: FILE_ID,
  storageReference: 'stored-files/mock/original.txt',
  originalFilename: 'Z轴报警原件.txt',
  mimeType: 'text/plain',
  byteSize: FILE_BYTES.byteLength,
  checksumSha256: sha256Hex(FILE_BYTES),
  ...overrides,
});

const makeQueryService = () => ({
  findDetail: jest.fn().mockResolvedValue(makeDetail()),
  findRevision: jest.fn().mockResolvedValue(null),
});

/** 版本与附件查询替身：默认冻结版本存在、目标附件已绑定且 CURRENT */
const makeMaintenanceReportQueryService = () => ({
  readVersionById: jest.fn().mockResolvedValue({
    id: OLD_VERSION_ID,
    reportId: REPORT_ID,
    versionNo: 1,
  }),
  readVersionAttachments: jest
    .fn()
    .mockResolvedValue([
      { versionId: OLD_VERSION_ID, attachmentId: ATTACHMENT_ID, reportId: REPORT_ID },
    ]),
  readAttachmentsByIds: jest.fn().mockResolvedValue([makeAttachmentSnapshot()]),
});

const makeStoredFileQueryService = () => ({
  findReportAttachmentDownloadFacts: jest.fn().mockResolvedValue(makeFacts()),
});

const makeAccountQueryService = (adminLevel: number | null = null) => ({
  findAdminLevelByAccountId: jest.fn().mockResolvedValue(adminLevel),
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORG_ID, memberRole: 'MEMBER' }),
});

const makeStorage = (content: Readable | Error) =>
  ({
    open: jest
      .fn()
      .mockImplementation(() =>
        content instanceof Error ? Promise.reject(content) : Promise.resolve(content),
      ),
  }) as unknown as StoredFileStorage;

const notFound = { code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND };

const makeUsecase = (
  params: {
    queryService?: ReturnType<typeof makeQueryService>;
    maintenanceReportQueryService?: ReturnType<typeof makeMaintenanceReportQueryService>;
    storedFileQueryService?: ReturnType<typeof makeStoredFileQueryService>;
    accountQueryService?: ReturnType<typeof makeAccountQueryService>;
    storage?: StoredFileStorage;
  } = {},
) => {
  const queryService = params.queryService ?? makeQueryService();
  const maintenanceReportQueryService =
    params.maintenanceReportQueryService ?? makeMaintenanceReportQueryService();
  const storedFileQueryService = params.storedFileQueryService ?? makeStoredFileQueryService();
  const accountQueryService = params.accountQueryService ?? makeAccountQueryService();
  const storage = params.storage ?? makeStorage(Readable.from([FILE_BYTES]));
  const usecase = new DownloadReferenceDocumentSourceAttachmentUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    maintenanceReportQueryService as unknown as MaintenanceReportQueryService,
    storedFileQueryService as unknown as StoredFileQueryService,
    accountQueryService as unknown as AccountQueryService,
    makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    storage,
  );
  return { queryService, maintenanceReportQueryService, storedFileQueryService, storage, usecase };
};

const readStream = async (content: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of content as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

describe('DownloadReferenceDocumentSourceAttachmentUsecase（来源报告冻结版本原件授权下载）', () => {
  it('同公司非作者工程师：按资料范围授权后核验冻结版本绑定，返回已校验字节', async () => {
    const { queryService, storedFileQueryService, storage, usecase } = makeUsecase();

    const payload = await usecase.execute({
      session: engineerSession,
      documentId: DOCUMENT_ID,
      attachmentId: ATTACHMENT_ID,
    });

    // 工程师范围为本公司（非作者也可读正式资料 → 可下载其来源报告原件）
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      scope: { kind: 'ORGANIZATION', organizationId: ORG_ID },
    });
    // 只按冻结版本定位存储对象，不回退当前附件列表
    expect(storedFileQueryService.findReportAttachmentDownloadFacts).toHaveBeenCalledWith(
      FILE_ID,
      REPORT_ID,
    );
    expect(payload.documentId).toBe(DOCUMENT_ID);
    expect(payload.originalFilename).toBe('Z轴报警原件.txt');
    expect(payload.mimeType).toBe('text/plain');
    await expect(readStream(payload.content)).resolves.toEqual(FILE_BYTES);
    expect((storage.open as jest.Mock).mock.calls[0][0]).toBe(makeFacts().storageReference);
  });

  it('一级管理员：范围 GLOBAL 可下载全公司资料的来源原件', async () => {
    const { queryService, usecase } = makeUsecase({
      accountQueryService: makeAccountQueryService(1),
    });

    await usecase.execute({
      session: levelOneAdminSession,
      documentId: DOCUMENT_ID,
      attachmentId: ATTACHMENT_ID,
    });

    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      scope: { kind: 'GLOBAL' },
    });
  });

  it('二级管理员：本公司资料的来源原件可下载', async () => {
    const { usecase } = makeUsecase({ accountQueryService: makeAccountQueryService(2) });

    await expect(
      usecase.execute({
        session: levelTwoAdminSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).resolves.toMatchObject({ documentId: DOCUMENT_ID });
  });

  it('客户直接调用：角色兜底拒绝，不进入任何查询', async () => {
    const { queryService, maintenanceReportQueryService, usecase } = makeUsecase();

    await expect(
      usecase.execute({
        session: customerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
    expect(maintenanceReportQueryService.readVersionById).not.toHaveBeenCalled();
  });

  it.each([
    ['外公司工程师（跨范围）', engineerSession],
    ['越权二级管理员（他司）', levelTwoAdminSession],
  ])('%s：QueryService 统一 NOT_FOUND，不触达存储', async (_name, session) => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问'),
    );
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: session,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
    expect(storage.open as jest.Mock).not.toHaveBeenCalled();
  });

  it('下架/删除/不存在：QueryService NOT_FOUND 原样上抛', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问'),
    );
    const { usecase } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
  });

  it('普通资料（无来源报告）：统一 NOT_FOUND，不读取版本与附件', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({ sourceKind: 'MATERIAL', sourceReportId: null, sourceReportVersionId: null }),
    );
    const { maintenanceReportQueryService, usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
    expect(maintenanceReportQueryService.readVersionById).not.toHaveBeenCalled();
    expect(storage.open as jest.Mock).not.toHaveBeenCalled();
  });

  it('冻结版本行缺失：失败关闭统一 NOT_FOUND（不猜测关联）', async () => {
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readVersionById.mockResolvedValue(null);
    const { usecase, storage } = makeUsecase({ maintenanceReportQueryService });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
    expect(maintenanceReportQueryService.readVersionAttachments).not.toHaveBeenCalled();
    expect(storage.open as jest.Mock).not.toHaveBeenCalled();
  });

  it('版本变化：资料引用旧冻结版本时只放行该版本绑定的附件（报告当前版本附件拒绝）', async () => {
    // 报告已有版本 2，其附件不在资料引用的冻结版本 1 绑定内
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readVersionAttachments.mockImplementation((versionId: number) =>
      versionId === OLD_VERSION_ID
        ? Promise.resolve([
            { versionId: OLD_VERSION_ID, attachmentId: ATTACHMENT_ID, reportId: REPORT_ID },
          ])
        : Promise.resolve([
            { versionId: NEW_VERSION_ID, attachmentId: OTHER_ATTACHMENT_ID, reportId: REPORT_ID },
          ]),
    );

    const { usecase } = makeUsecase({ maintenanceReportQueryService });

    // 资料引用旧冻结版本：旧版本附件可下载
    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).resolves.toMatchObject({ originalFilename: 'Z轴报警原件.txt' });

    // 报告当前版本（版本 2）的附件未被该冻结版本绑定：拒绝
    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: OTHER_ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
  });

  it('文件引用失效（附件行 fileId 为空）：拒绝且不触达存储', async () => {
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readAttachmentsByIds.mockResolvedValue([
      makeAttachmentSnapshot({ fileId: null }),
    ]);
    const { usecase, storedFileQueryService, storage } = makeUsecase({
      maintenanceReportQueryService,
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
    expect(storedFileQueryService.findReportAttachmentDownloadFacts).not.toHaveBeenCalled();
    expect(storage.open as jest.Mock).not.toHaveBeenCalled();
  });

  it('旧附件已 RETIRED、后续附件不属于该冻结版本：历史附件仍可下载，报告当前版本附件拒绝（任务 07 P2 生命周期回归）', async () => {
    // 生命周期：报告 v1 冻结绑定附件 1 → 审核驳回（RETURNED）→ 作者更换原件
    // （附件 1 合法退役、stored_file 解绑回 TEMPORARY）→ 重新提交产生 v2 绑定附件 2。
    // 资料引用旧冻结版本 v1：附件 1 的版本绑定仍在 → 历史读取权保留；
    // 附件 2 不在 v1 绑定清单 → 与资料不可访问统一 NOT_FOUND。
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readVersionAttachments.mockImplementation((versionId: number) =>
      versionId === OLD_VERSION_ID
        ? Promise.resolve([
            { versionId: OLD_VERSION_ID, attachmentId: ATTACHMENT_ID, reportId: REPORT_ID },
          ])
        : Promise.resolve([
            { versionId: NEW_VERSION_ID, attachmentId: OTHER_ATTACHMENT_ID, reportId: REPORT_ID },
          ]),
    );
    maintenanceReportQueryService.readAttachmentsByIds.mockResolvedValue([
      makeAttachmentSnapshot({
        status: MaintenanceAttachmentStatus.RETIRED,
        retiredAt: new Date('2026-11-03T00:00:00.000Z'),
      }),
    ]);

    const { usecase, storage } = makeUsecase({ maintenanceReportQueryService });

    // 旧冻结版本的 RETIRED 原件：经资料详情授权链仍可下载
    const payload = await usecase.execute({
      session: engineerSession,
      documentId: DOCUMENT_ID,
      attachmentId: ATTACHMENT_ID,
    });
    expect(payload.originalFilename).toBe('Z轴报警原件.txt');
    await expect(readStream(payload.content)).resolves.toEqual(FILE_BYTES);

    // 报告当前版本（v2）的附件未被该冻结版本绑定：拒绝
    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: OTHER_ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
    expect(storage.open as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('附件行与登记行存储引用不一致：失败关闭 FILE_NOT_AVAILABLE，不按附件行引用直读', async () => {
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readAttachmentsByIds.mockResolvedValue([
      makeAttachmentSnapshot({ storageReference: 'stored-files/mock/att-copy.txt' }),
    ]);
    const { usecase, storage } = makeUsecase({ maintenanceReportQueryService });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
    expect(storage.open as jest.Mock).not.toHaveBeenCalled();
  });

  it('原件登记形态不符（归属报告不一致）：统一 NOT_FOUND', async () => {
    const storedFileQueryService = makeStoredFileQueryService();
    storedFileQueryService.findReportAttachmentDownloadFacts.mockResolvedValue(null);
    const { usecase, storage } = makeUsecase({ storedFileQueryService });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
    expect(storage.open as jest.Mock).not.toHaveBeenCalled();
  });

  it('登记完整性无效（字节数越界）：FILE_NOT_AVAILABLE 且不打开存储', async () => {
    const storedFileQueryService = makeStoredFileQueryService();
    storedFileQueryService.findReportAttachmentDownloadFacts.mockResolvedValue(
      makeFacts({ byteSize: 0 }),
    );
    const { usecase, storage } = makeUsecase({ storedFileQueryService });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
    expect(storage.open as jest.Mock).not.toHaveBeenCalled();
  });

  it('存储对象不可用：FILE_NOT_AVAILABLE，不泄露路径与引用', async () => {
    const { usecase } = makeUsecase({
      storage: makeStorage(new Error('ENOENT: no such file')),
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
  });

  it('内容与登记 SHA-256 不匹配：FILE_NOT_AVAILABLE（不发未校验字节）', async () => {
    const { usecase } = makeUsecase({
      storage: makeStorage(Readable.from([Buffer.from('tampered-bytes')])),
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
  });

  it('附件 ID 非法输入：INVALID_PARAMS', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        documentId: DOCUMENT_ID,
        attachmentId: 0,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
  });
});
