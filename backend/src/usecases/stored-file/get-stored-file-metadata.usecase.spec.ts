// src/usecases/stored-file/get-stored-file-metadata.usecase.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { PERMISSION_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetStoredFileMetadataUsecase } from './get-stored-file-metadata.usecase';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const customer = session(['CUSTOMER']);
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
});

const makeUsecase = (
  overrides: {
    queryService?: ReturnType<typeof makeQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const usecase = new GetStoredFileMetadataUsecase(
    queryService as unknown as StoredFileQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
  );
  return { usecase, queryService, organizationContextService };
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
    const organizationContextService = {
      tryResolveForAccount: jest.fn().mockResolvedValue(null),
    };
    const { usecase, queryService } = makeUsecase({ organizationContextService });

    await usecase.execute({ session: engineer, fileId, uploadContextId: null });

    expect(queryService.findAuthorizedMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ viewerOrganizationId: null, uploadContextId: null }),
    );
  });
});
