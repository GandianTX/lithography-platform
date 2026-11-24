// src/usecases/repair-request/bind-repair-process-original.usecase.spec.ts

/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { PERMISSION_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
import {
  BindRepairProcessOriginalUsecase,
  type BindRepairProcessOriginalCommand,
} from './bind-repair-process-original.usecase';

const transactionContext = { transaction: 'mock' } as unknown as PersistenceTransactionContext;
const organizationId = 910001;
const fileId = '11111111-1111-4111-8111-111111111111';
const uploadContextId = '22222222-2222-4222-8222-222222222222';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const customer = session(['CUSTOMER']);

const fileSnapshot = (overrides: Record<string, unknown> = {}) => ({
  fileId,
  uploadedByAccountId: 900001,
  ownerOrganizationId: organizationId,
  storageReference: 'private/ref.pdf',
  originalFilename: '维修记录.pdf',
  mimeType: 'application/pdf',
  byteSize: 10,
  checksumSha256: 'checksum',
  status: 'VALID',
  businessType: 'REPAIR_PROCESS',
  businessId: null,
  uploadContextId,
  bindingStatus: 'TEMPORARY',
  createdAt: new Date('2026-11-14T00:00:00.000Z'),
  verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  ...overrides,
});

const targetSnapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  ownerOrganizationId: organizationId,
  intakeId: 7001,
  serviceOrganizationId: organizationId,
  isAccepted: true,
  acceptedByEngineerAccountId: 900001,
  deprecated: false,
  handlingStatus: null,
  closureStatus: null,
  ...overrides,
});

const makeStoredFileService = () => ({
  lockForBinding: jest.fn().mockResolvedValue(fileSnapshot()),
  bindIfTemporary: jest.fn().mockResolvedValue(1),
});

const makeStoredFileQueryService = () => ({
  isReferencedByRepairProcess: jest.fn().mockResolvedValue(false),
});

const makeRepairRequestService = () => ({
  findProcessBindingTargetForUpdate: jest.fn().mockResolvedValue(targetSnapshot()),
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({ organizationId }),
});

const makeStorage = () => ({
  save: jest.fn(),
  open: jest.fn(),
  delete: jest.fn(),
  verifyIntegrity: jest.fn().mockResolvedValue(true),
});

const command = (
  overrides: Partial<BindRepairProcessOriginalCommand> = {},
): BindRepairProcessOriginalCommand => ({
  session: engineer,
  requestId: 42,
  fileId,
  uploadContextId,
  ...overrides,
});

const makeUsecase = (
  overrides: {
    storedFileService?: ReturnType<typeof makeStoredFileService>;
    storedFileQueryService?: ReturnType<typeof makeStoredFileQueryService>;
    repairRequestService?: ReturnType<typeof makeRepairRequestService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    storage?: ReturnType<typeof makeStorage>;
  } = {},
) => {
  const storedFileService = overrides.storedFileService ?? makeStoredFileService();
  const storedFileQueryService = overrides.storedFileQueryService ?? makeStoredFileQueryService();
  const repairRequestService = overrides.repairRequestService ?? makeRepairRequestService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const storage = overrides.storage ?? makeStorage();

  const usecase = new BindRepairProcessOriginalUsecase(
    storedFileService as unknown as StoredFileService,
    storedFileQueryService as unknown as StoredFileQueryService,
    repairRequestService as unknown as RepairRequestService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertBusinessWritableInTransaction: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertCompanyWritableInTransaction: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    storage,
  );
  return {
    usecase,
    storedFileService,
    storedFileQueryService,
    repairRequestService,
    organizationContextService,
    storage,
  };
};

describe('BindRepairProcessOriginalUsecase（任务 04 接入契约）', () => {
  it('合法绑定：锁原件 → 核工单 → 核完整性 → 条件绑定，全部使用调用方事务', async () => {
    const { usecase, storedFileService, repairRequestService, storage } = makeUsecase();

    const result = await usecase.executeInTransaction(command(), transactionContext);

    expect(storedFileService.lockForBinding).toHaveBeenCalledWith(fileId, transactionContext);
    expect(repairRequestService.findProcessBindingTargetForUpdate).toHaveBeenCalledWith(
      42,
      transactionContext,
    );
    expect(storage.verifyIntegrity).toHaveBeenCalledWith('private/ref.pdf', 'checksum', 10);
    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      { fileId, businessType: 'REPAIR_PROCESS', businessId: '42' },
      transactionContext,
    );
    expect(result).toEqual({
      fileId,
      businessType: 'REPAIR_PROCESS',
      businessId: '42',
      bindingStatus: 'BOUND',
    });
  });

  it('客户角色拒绝，且不锁定原件', async () => {
    const { usecase, storedFileService } = makeUsecase();

    await expect(
      usecase.executeInTransaction(command({ session: customer }), transactionContext),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
  });

  it('他人原件 / 外公司原件按不存在处理，不锁定工单、不绑定', async () => {
    const storedFileService = makeStoredFileService();
    storedFileService.lockForBinding.mockResolvedValueOnce(
      fileSnapshot({ uploadedByAccountId: 900002 }),
    );
    const first = makeUsecase({ storedFileService });
    await expect(
      first.usecase.executeInTransaction(command(), transactionContext),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(first.repairRequestService.findProcessBindingTargetForUpdate).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();

    const otherCompany = makeUsecase();
    otherCompany.storedFileService.lockForBinding.mockResolvedValueOnce(
      fileSnapshot({ ownerOrganizationId: 920002 }),
    );
    await expect(
      otherCompany.usecase.executeInTransaction(command(), transactionContext),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(otherCompany.storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('错误上下文 / 错误用途 / 未通过校验时拒绝绑定', async () => {
    for (const file of [
      fileSnapshot({ uploadContextId: '33333333-3333-4333-8333-333333333333' }),
      fileSnapshot({ businessType: 'MAINTENANCE_REPORT' }),
      fileSnapshot({ status: 'STAGING', verifiedAt: null }),
    ]) {
      const storedFileService = makeStoredFileService();
      storedFileService.lockForBinding.mockResolvedValueOnce(file);
      const { usecase, repairRequestService } = makeUsecase({ storedFileService });

      await expect(
        usecase.executeInTransaction(command(), transactionContext),
      ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_BINDABLE });
      expect(repairRequestService.findProcessBindingTargetForUpdate).not.toHaveBeenCalled();
      expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
    }
  });

  it('已绑定原件拒绝重复绑定（ALREADY_BOUND）', async () => {
    const storedFileService = makeStoredFileService();
    storedFileService.lockForBinding.mockResolvedValueOnce(
      fileSnapshot({ bindingStatus: 'BOUND', businessId: '41' }),
    );
    const { usecase } = makeUsecase({ storedFileService });

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.ALREADY_BOUND },
    );
  });

  it('客户 A / 服务公司 B：owner 与可信服务公司不同时按服务公司放行', async () => {
    const repairRequestService = makeRepairRequestService();
    repairRequestService.findProcessBindingTargetForUpdate.mockResolvedValueOnce(
      targetSnapshot({ ownerOrganizationId: 920002 }),
    );
    const { usecase, storedFileService } = makeUsecase({ repairRequestService });

    await expect(
      usecase.executeInTransaction(command(), transactionContext),
    ).resolves.toMatchObject({ fileId, businessType: 'REPAIR_PROCESS', businessId: '42' });
    expect(storedFileService.bindIfTemporary).toHaveBeenCalled();
  });

  it('工单未接单 / 非本人接单 / 已结束 / 已作废均拒绝，且不核完整性、不绑定', async () => {
    for (const target of [
      null,
      targetSnapshot({ isAccepted: false, acceptedByEngineerAccountId: null }),
      targetSnapshot({ acceptedByEngineerAccountId: 900002 }),
      targetSnapshot({ handlingStatus: 'COMPLETED' }),
      targetSnapshot({ handlingStatus: 'UNRESOLVED' }),
      targetSnapshot({ closureStatus: 'CLOSED' }),
      targetSnapshot({ deprecated: true }),
    ]) {
      const repairRequestService = makeRepairRequestService();
      repairRequestService.findProcessBindingTargetForUpdate.mockResolvedValueOnce(target);
      const { usecase, storage, storedFileService } = makeUsecase({ repairRequestService });

      await expect(
        usecase.executeInTransaction(command(), transactionContext),
      ).rejects.toMatchObject({ code: STORED_FILE_ERROR.WORK_ORDER_NOT_BINDABLE });
      expect(storage.verifyIntegrity).not.toHaveBeenCalled();
      expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
    }
  });

  it('服务归属无法确认 / 与服务公司不一致时拒绝，且不核完整性、不绑定', async () => {
    for (const target of [
      targetSnapshot({ serviceOrganizationId: 920002 }),
      targetSnapshot({ intakeId: null }),
      targetSnapshot({ serviceOrganizationId: null }),
      targetSnapshot({ ownerOrganizationId: 920002, serviceOrganizationId: null }),
    ]) {
      const repairRequestService = makeRepairRequestService();
      repairRequestService.findProcessBindingTargetForUpdate.mockResolvedValueOnce(target);
      const { usecase, storage, storedFileService } = makeUsecase({ repairRequestService });

      await expect(
        usecase.executeInTransaction(command(), transactionContext),
      ).rejects.toMatchObject({ code: STORED_FILE_ERROR.WORK_ORDER_NOT_BINDABLE });
      expect(storage.verifyIntegrity).not.toHaveBeenCalled();
      expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
    }
  });

  it('原件已被维修过程占用时拒绝，不重复绑定', async () => {
    const storedFileQueryService = makeStoredFileQueryService();
    storedFileQueryService.isReferencedByRepairProcess.mockResolvedValueOnce(true);
    const { usecase, storedFileService, storage } = makeUsecase({ storedFileQueryService });

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.ALREADY_BOUND },
    );
    expect(storage.verifyIntegrity).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('存储对象缺失或字节数/SHA-256 不一致时阻断绑定', async () => {
    const storage = makeStorage();
    storage.verifyIntegrity.mockResolvedValueOnce(false);
    const first = makeUsecase({ storage });
    await expect(
      first.usecase.executeInTransaction(command(), transactionContext),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INTEGRITY_FAILED });
    expect(first.storedFileService.bindIfTemporary).not.toHaveBeenCalled();

    const throwingStorage = makeStorage();
    throwingStorage.verifyIntegrity.mockRejectedValueOnce(new Error('ENOENT'));
    const second = makeUsecase({ storage: throwingStorage });
    await expect(
      second.usecase.executeInTransaction(command(), transactionContext),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INTEGRITY_FAILED });
    expect(second.storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('并发重复绑定：条件更新命中 0 行时返回 ALREADY_BOUND（事务由任务 04 回滚）', async () => {
    const storedFileService = makeStoredFileService();
    storedFileService.bindIfTemporary.mockResolvedValueOnce(0);
    const { usecase } = makeUsecase({ storedFileService });

    await expect(usecase.executeInTransaction(command(), transactionContext)).rejects.toMatchObject(
      { code: STORED_FILE_ERROR.ALREADY_BOUND },
    );
  });

  it('无效请求参数在锁定前拒绝', async () => {
    const { usecase, storedFileService } = makeUsecase();

    await expect(
      usecase.executeInTransaction(command({ uploadContextId: 'not-a-uuid' }), transactionContext),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INVALID_PARAMS });
    await expect(
      usecase.executeInTransaction(command({ requestId: 0 }), transactionContext),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INVALID_PARAMS });
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
  });
});
