/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { StoredFileBindingStatus, StoredFileStatus } from '@app-types/models/stored-file.types';
import {
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
  STORED_FILE_ERROR,
} from '@src/core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileSnapshot } from '@src/modules/lithography/lithography.types';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
import type { StoredFileStorage } from '@src/usecases/common/ports/stored-file-storage.contract';
import { BindRepairRequestOriginalUsecase } from './bind-repair-request-original.usecase';

const FILE_ID = '9b1f4f9e-9a1e-4b6e-8a10-3f1a2b3c4d5e';
const UPLOAD_CONTEXT_ID = '0c9f6c2e-1f1a-4b0d-9a2f-d0e1c2b3a4f5';
const INTAKE_ID = 21;
const ACCOUNT_ID = 7;
const COMPANY_ID = 77;

type StoredFileServiceMock = {
  readonly lockForBinding: jest.Mock<Promise<StoredFileSnapshot | null>>;
  readonly bindIfTemporary: jest.Mock<Promise<number>>;
};

describe('BindRepairRequestOriginalUsecase', () => {
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;
  const customer: UsecaseSession = { accountId: ACCOUNT_ID, roles: ['CUSTOMER'] };

  let storedFileService: StoredFileServiceMock;
  let accountQueryService: { findCustomerOrganizationId: jest.Mock };
  let storage: { verifyIntegrity: jest.Mock };
  let usecase: BindRepairRequestOriginalUsecase;

  const buildFile = (overrides: Partial<StoredFileSnapshot> = {}): StoredFileSnapshot => ({
    fileId: FILE_ID,
    uploadedByAccountId: ACCOUNT_ID,
    ownerOrganizationId: COMPANY_ID,
    storageReference: '0123456789abcdef.pdf',
    originalFilename: '报修原件.pdf',
    mimeType: 'application/pdf',
    byteSize: 1024,
    checksumSha256: 'a'.repeat(64),
    status: StoredFileStatus.VALID,
    businessType: 'REPAIR_REQUEST',
    businessId: null,
    uploadContextId: UPLOAD_CONTEXT_ID,
    bindingStatus: StoredFileBindingStatus.TEMPORARY,
    createdAt: new Date('2026-11-19T00:00:00.000Z'),
    verifiedAt: new Date('2026-11-19T00:00:00.000Z'),
    ...overrides,
  });

  const command = () => ({
    session: customer,
    intakeId: INTAKE_ID,
    fileId: FILE_ID,
    uploadContextId: UPLOAD_CONTEXT_ID,
  });

  beforeEach(() => {
    storedFileService = {
      lockForBinding: jest.fn().mockResolvedValue(buildFile()),
      bindIfTemporary: jest.fn().mockResolvedValue(1),
    };
    accountQueryService = {
      findCustomerOrganizationId: jest.fn().mockResolvedValue(COMPANY_ID),
    };
    storage = { verifyIntegrity: jest.fn().mockResolvedValue(true) };
    usecase = new BindRepairRequestOriginalUsecase(
      storedFileService as unknown as StoredFileService,
      accountQueryService as unknown as AccountQueryService,
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertBusinessWritableInTransaction: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertCompanyWritableInTransaction: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      storage as unknown as StoredFileStorage,
    );
  });

  it('合法绑定：以「原稿主键」为业务标识，用途固定 REPAIR_REQUEST', async () => {
    const result = await usecase.executeInTransaction(command(), transactionContext);

    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      {
        fileId: FILE_ID,
        businessType: 'REPAIR_REQUEST',
        businessId: String(INTAKE_ID),
      },
      transactionContext,
    );
    expect(result).toEqual({
      fileId: FILE_ID,
      businessType: 'REPAIR_REQUEST',
      businessId: String(INTAKE_ID),
      bindingStatus: StoredFileBindingStatus.BOUND,
    });
  });

  it('归属公司只来自客户账号事实，且在同一事务内复核', async () => {
    await usecase.executeInTransaction(command(), transactionContext);

    expect(accountQueryService.findCustomerOrganizationId).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      transactionContext,
    });
  });

  it('工程师不能绑定客户报修原件', async () => {
    await expect(
      usecase.executeInTransaction(
        { ...command(), session: { accountId: ACCOUNT_ID, roles: ['ENGINEER'] } },
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('客户缺公司归属时拒绝绑定', async () => {
    accountQueryService.findCustomerOrganizationId.mockResolvedValue(null);

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_REQUIRED },
    );
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it.each([
    ['上传者不同（异主）', { uploadedByAccountId: 8 }],
    ['归属公司不同（异司）', { ownerOrganizationId: 99 }],
  ])('%s：按不存在拒绝，且不执行绑定', async (_label, overrides) => {
    storedFileService.lockForBinding.mockResolvedValue(buildFile(overrides));

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.NOT_FOUND },
    );
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('用途不是 REPAIR_REQUEST 时拒绝（不得把过程原件挪到报修）', async () => {
    storedFileService.lockForBinding.mockResolvedValue(
      buildFile({ businessType: 'REPAIR_PROCESS' }),
    );

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.NOT_BINDABLE },
    );
  });

  it('上传上下文不匹配时拒绝', async () => {
    await expect(
      usecase.executeInTransaction(
        { ...command(), uploadContextId: '11111111-1111-4111-8111-111111111111' },
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_BINDABLE });
  });

  it('原件已绑定（临时态丢失）时拒绝', async () => {
    storedFileService.lockForBinding.mockResolvedValue(
      buildFile({ bindingStatus: StoredFileBindingStatus.BOUND, businessId: '99' }),
    );

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.ALREADY_BOUND },
    );
  });

  it('完整性核对不通过时拒绝绑定', async () => {
    storage.verifyIntegrity.mockResolvedValue(false);

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.INTEGRITY_FAILED },
    );
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('条件绑定未命中（并发占用）时按已绑定冲突拒绝', async () => {
    storedFileService.bindIfTemporary.mockResolvedValue(0);

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.ALREADY_BOUND },
    );
  });

  it('原件不存在时拒绝，不触达存储校验', async () => {
    storedFileService.lockForBinding.mockResolvedValue(null);

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.NOT_FOUND },
    );
    expect(storage.verifyIntegrity).not.toHaveBeenCalled();
  });

  it('原稿主键非法时拒绝（不查原件）', async () => {
    await expect(
      usecase.executeInTransaction({ ...command(), intakeId: 0 }, transactionContext),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
  });
});
