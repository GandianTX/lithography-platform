// src/usecases/stored-file/upload-stored-file.usecase.spec.ts

/// <reference types="jest" />
import { createHash } from 'node:crypto';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, PERMISSION_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { STORED_FILE_UPLOAD_MAX_BYTES } from './stored-file-upload.contract';
import { UploadStoredFileUsecase } from './upload-stored-file.usecase';

const transactionContext = { transaction: 'mock' };
const organizationId = 910001;

const session = (roles: string[], activeRole?: string, accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole }) as UsecaseSession;

const engineer = session(['ENGINEER'], 'ENGINEER');
const customer = session(['CUSTOMER'], 'CUSTOMER');
const engineerWithoutActiveRole = session(['ENGINEER'], undefined);

/** 合法 PDF 内容（实际内容判定为 application/pdf） */
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii');

const makeStoredFileService = () => ({
  insertStagedFile: jest.fn().mockImplementation((data: Record<string, unknown>) => ({
    fileId: data.fileId,
    uploadedByAccountId: data.uploadedByAccountId,
    ownerOrganizationId: data.ownerOrganizationId,
    storageReference: data.storageReference,
    originalFilename: data.originalFilename,
    mimeType: data.mimeType,
    byteSize: data.byteSize,
    checksumSha256: data.checksumSha256,
    status: 'VALID',
    businessType: data.businessType,
    businessId: null,
    uploadContextId: data.uploadContextId,
    bindingStatus: 'TEMPORARY',
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
    verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  })),
});

const makeQueryService = () => ({
  isStorageReferenceReferenced: jest.fn().mockResolvedValue(false),
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId,
    organizationCode: 'SERVICE_DEFAULT',
    organizationName: '乙方默认组织',
    organizationKind: 'SERVICE',
    memberRole: 'ENGINEER',
  }),
});

const makeTransactionRunner = () =>
  ({
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
  }) as unknown as TransactionRunner & { run: jest.Mock };

const makeStorage = () => ({
  save: jest.fn().mockResolvedValue('0123456789abcdef0123456789abcdef.pdf'),
  open: jest.fn(),
  delete: jest.fn().mockResolvedValue(undefined),
  verifyIntegrity: jest.fn().mockResolvedValue(true),
});

const allowedMimeTypes = ['application/pdf', 'text/plain', 'image/png'];

const makeUsecase = (
  overrides: {
    storedFileService?: ReturnType<typeof makeStoredFileService>;
    queryService?: ReturnType<typeof makeQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    transactionRunner?: ReturnType<typeof makeTransactionRunner>;
    storage?: ReturnType<typeof makeStorage>;
  } = {},
) => {
  const storedFileService = overrides.storedFileService ?? makeStoredFileService();
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();
  const storage = overrides.storage ?? makeStorage();

  const usecase = new UploadStoredFileUsecase(
    storedFileService as unknown as StoredFileService,
    queryService as unknown as StoredFileQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    transactionRunner,
    storage,
    allowedMimeTypes,
  );

  return {
    usecase,
    storedFileService,
    queryService,
    organizationContextService,
    transactionRunner,
    storage,
  };
};

const command = (overrides: Record<string, unknown> = {}) => ({
  session: engineer,
  businessType: 'REPAIR_PROCESS',
  file: { buffer: pdfBytes, originalFilename: '维修记录.pdf' },
  ...overrides,
});

describe('UploadStoredFileUsecase', () => {
  it('合法上传：先授权与可信公司，再写存储，最后在事务内登记 VALID + TEMPORARY', async () => {
    const { usecase, storedFileService, organizationContextService, storage } = makeUsecase();

    const result = await usecase.execute(command());

    expect(organizationContextService.resolveForAccount.mock.invocationCallOrder[0]).toBeLessThan(
      storage.save.mock.invocationCallOrder[0],
    );
    expect(storage.save).toHaveBeenCalledWith(pdfBytes, 'pdf');
    expect(storedFileService.insertStagedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedByAccountId: 900001,
        ownerOrganizationId: organizationId,
        storageReference: '0123456789abcdef0123456789abcdef.pdf',
        originalFilename: '维修记录.pdf',
        mimeType: 'application/pdf',
        byteSize: pdfBytes.byteLength,
        checksumSha256: createHash('sha256').update(pdfBytes).digest('hex'),
        businessType: 'REPAIR_PROCESS',
      }),
      transactionContext,
    );
    expect(result.status).toBe('VALID');
    expect(result.bindingStatus).toBe('TEMPORARY');
    expect(result.businessId).toBeNull();
    expect(result.uploadContextId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.fileId).not.toBe(result.uploadContextId);
  });

  it('尺寸边界：恰好 20,000,000 字节通过', async () => {
    const { usecase, storage } = makeUsecase();
    const atLimit = Buffer.concat([
      Buffer.from('%PDF-', 'ascii'),
      Buffer.alloc(STORED_FILE_UPLOAD_MAX_BYTES - 5),
    ]);

    await expect(
      usecase.execute(command({ file: { buffer: atLimit, originalFilename: 'limit.pdf' } })),
    ).resolves.toMatchObject({ byteSize: STORED_FILE_UPLOAD_MAX_BYTES });
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('尺寸边界：超过 20,000,000 字节拒绝，且不触达存储', async () => {
    const { usecase, storage } = makeUsecase();
    const overLimit = Buffer.alloc(STORED_FILE_UPLOAD_MAX_BYTES + 1);

    await expect(
      usecase.execute(command({ file: { buffer: overLimit, originalFilename: 'over.pdf' } })),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TOO_LARGE });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('空文件拒绝，且不触达存储', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute(
        command({ file: { buffer: Buffer.alloc(0), originalFilename: 'empty.pdf' } }),
      ),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_MISSING });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('实际内容与扩展名不符时拒绝（伪装 PDF 的文本）', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute(
        command({
          file: { buffer: Buffer.from('not-a-pdf'), originalFilename: 'fake.pdf' },
        }),
      ),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('用途不在当前白名单时拒绝，且不解析组织、不触达存储', async () => {
    const { usecase, organizationContextService, storage } = makeUsecase();

    await expect(
      usecase.execute(command({ businessType: 'MAINTENANCE_REPORT' })),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.PURPOSE_NOT_SUPPORTED });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('客户角色拒绝（未登录之外的角色边界），不写存储', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(usecase.execute(command({ session: customer }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('工程师缺少 activeRole 时失败关闭', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute(command({ session: engineerWithoutActiveRole })),
    ).rejects.toBeInstanceOf(DomainError);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('无可信公司归属时拒绝，不写存储', async () => {
    const organizationContextService = {
      resolveForAccount: jest
        .fn()
        .mockRejectedValue(new DomainError('ORGANIZATION_NO_ACTIVE_MEMBERSHIP', 'no org')),
    };
    const { usecase, storage } = makeUsecase({ organizationContextService });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: 'ORGANIZATION_NO_ACTIVE_MEMBERSHIP',
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('存储写入失败映射为受控错误，且不登记数据库', async () => {
    const storage = makeStorage();
    storage.save.mockRejectedValueOnce(new Error('disk full'));
    const { usecase, storedFileService } = makeUsecase({ storage });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: STORED_FILE_ERROR.UPLOAD_FAILED,
    });
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
  });

  it('落库失败后补偿删除未登记的存储对象，不留下半成品', async () => {
    const transactionRunner = makeTransactionRunner();
    transactionRunner.run.mockRejectedValueOnce(
      new DomainError(STORED_FILE_ERROR.UPLOAD_FAILED, 'db down'),
    );
    const { usecase, queryService, storage } = makeUsecase({ transactionRunner });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: STORED_FILE_ERROR.UPLOAD_FAILED,
    });
    expect(queryService.isStorageReferenceReferenced).toHaveBeenCalledWith(
      '0123456789abcdef0123456789abcdef.pdf',
    );
    expect(storage.delete).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef.pdf');
  });

  it('落库失败但存储引用已被登记时不删除（防误删已提交对象）', async () => {
    const transactionRunner = makeTransactionRunner();
    transactionRunner.run.mockRejectedValueOnce(new Error('commit uncertain'));
    const queryService = makeQueryService();
    queryService.isStorageReferenceReferenced.mockResolvedValueOnce(true);
    const { usecase, storage } = makeUsecase({ transactionRunner, queryService });

    await expect(usecase.execute(command())).rejects.toBeInstanceOf(Error);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
