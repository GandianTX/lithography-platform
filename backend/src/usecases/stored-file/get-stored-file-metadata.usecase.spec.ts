// src/usecases/stored-file/get-stored-file-metadata.usecase.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  ACCOUNT_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
  STORED_FILE_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetStoredFileMetadataUsecase } from './get-stored-file-metadata.usecase';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const customer = session(['CUSTOMER']);
const admin = session(['SUPER_ADMIN'], 900010);
const fileId = '11111111-1111-4111-8111-111111111111';
const uploadContextId = '22222222-2222-4222-8222-222222222222';

const metadataView = {
  fileId,
  businessType: 'REPAIR_PROCESS',
  originalFilename: '维修记录.pdf',
  mimeType: 'application/pdf',
  byteSize: 10,
  checksumSha256: 'checksum',
  status: 'VALID',
  bindingStatus: 'TEMPORARY',
  businessId: null,
  uploadContextId,
  verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  createdAt: new Date('2026-11-14T00:00:00.000Z'),
} as const;

const makeQueryService = () => ({
  findAuthorizedMetadata: jest.fn().mockResolvedValue(metadataView),
});

const makeOrganizationContextService = () => ({
  tryResolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
  resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
});

const makeAccountQueryService = () => ({
  findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
});

const makeUsecase = (
  overrides: {
    queryService?: ReturnType<typeof makeQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    accountQueryService?: ReturnType<typeof makeAccountQueryService>;
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const accountQueryService = overrides.accountQueryService ?? makeAccountQueryService();
  const usecase = new GetStoredFileMetadataUsecase(
    queryService as unknown as StoredFileQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    accountQueryService as unknown as AccountQueryService,
  );
  return { usecase, queryService, organizationContextService, accountQueryService };
};

describe('GetStoredFileMetadataUsecase', () => {
  it('合法读取：按可信公司、用途与上传上下文查询', async () => {
    const { usecase, queryService } = makeUsecase();

    const result = await usecase.execute({ session: engineer, fileId, uploadContextId });

    expect(queryService.findAuthorizedMetadata).toHaveBeenCalledWith({
      fileId,
      session: engineer,
      viewerOrganizationId: 910001,
      uploadContextId,
      expectedBusinessType: 'REPAIR_PROCESS',
    });
    expect(result).toEqual(metadataView);
  });

  it('非法 fileId 拒绝，且不访问查询服务', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, fileId: 'not-a-uuid', uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INVALID_PARAMS });
    expect(queryService.findAuthorizedMetadata).not.toHaveBeenCalled();
  });

  it('客户角色拒绝，且不访问查询服务', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute({ session: customer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findAuthorizedMetadata).not.toHaveBeenCalled();
  });

  it('查询服务判定不可访问时统一 NOT_FOUND', async () => {
    const queryService = makeQueryService();
    queryService.findAuthorizedMetadata.mockResolvedValueOnce(null);
    const { usecase } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
  });

  it('无当前公司时以 null 传入（仅无归属工单本人接单路径可能放行）', async () => {
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.tryResolveForAccount.mockResolvedValueOnce(null);
    const { usecase, queryService } = makeUsecase({ organizationContextService });

    await usecase.execute({ session: engineer, fileId, uploadContextId: null });

    expect(queryService.findAuthorizedMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ viewerOrganizationId: null, uploadContextId: null }),
    );
  });

  it('工程师读取不查询管理员层级，也不携带管理员范围', async () => {
    const { usecase, queryService, accountQueryService } = makeUsecase();

    await usecase.execute({ session: engineer, fileId, uploadContextId });

    expect(accountQueryService.findAdminLevelByAccountId).not.toHaveBeenCalled();
    const call = queryService.findAuthorizedMetadata.mock.calls[0][0] as Record<string, unknown>;
    expect('adminOrganizationId' in call).toBe(false);
  });

  it('一级管理员：范围来自管理员层级（null），不借用工程师成员组织', async () => {
    const { usecase, queryService, accountQueryService, organizationContextService } =
      makeUsecase();

    await usecase.execute({ session: admin, fileId, uploadContextId });

    expect(accountQueryService.findAdminLevelByAccountId).toHaveBeenCalledWith(900010);
    expect(organizationContextService.tryResolveForAccount).not.toHaveBeenCalled();
    expect(queryService.findAuthorizedMetadata).toHaveBeenCalledWith({
      fileId,
      session: admin,
      viewerOrganizationId: null,
      uploadContextId,
      expectedBusinessType: 'REPAIR_PROCESS',
      adminOrganizationId: null,
    });
  });

  it('二级管理员：使用可信组织上下文确认的本公司，不调用可选组织解析', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(2);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockResolvedValueOnce({
      organizationId: 700002,
    });
    const { usecase, queryService } = makeUsecase({
      accountQueryService,
      organizationContextService,
    });

    await usecase.execute({ session: admin, fileId, uploadContextId: null });

    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: 900010,
    });
    expect(organizationContextService.tryResolveForAccount).not.toHaveBeenCalled();
    expect(queryService.findAuthorizedMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        viewerOrganizationId: 700002,
        adminOrganizationId: 700002,
      }),
    );
  });

  it('二级管理员缺少可信组织事实：受控 NOT_FOUND，且不访问查询服务', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(2);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValueOnce(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '无有效组织'),
    );
    const { usecase, queryService } = makeUsecase({
      accountQueryService,
      organizationContextService,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(queryService.findAuthorizedMetadata).not.toHaveBeenCalled();
  });

  it('管理员等级为 NULL：受控 NOT_FOUND，不回退全局', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(null);
    const { usecase, queryService, organizationContextService } = makeUsecase({
      accountQueryService,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.findAuthorizedMetadata).not.toHaveBeenCalled();
  });

  it('管理员账号行缺失：受控 NOT_FOUND，不访问查询服务', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockRejectedValueOnce(
      new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账户不存在'),
    );
    const { usecase, queryService, organizationContextService } = makeUsecase({
      accountQueryService,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.findAuthorizedMetadata).not.toHaveBeenCalled();
  });

  it('非法管理员层级：受控 NOT_FOUND，不回退全局', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(3);
    const { usecase, queryService, organizationContextService } = makeUsecase({
      accountQueryService,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.findAuthorizedMetadata).not.toHaveBeenCalled();
  });
});
