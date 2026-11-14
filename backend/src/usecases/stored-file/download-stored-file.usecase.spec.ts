// src/usecases/stored-file/download-stored-file.usecase.spec.ts

/// <reference types="jest" />
import { Readable } from 'node:stream';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { PERMISSION_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { DownloadStoredFileUsecase } from './download-stored-file.usecase';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const customer = session(['CUSTOMER']);
const fileId = '11111111-1111-4111-8111-111111111111';
const uploadContextId = '22222222-2222-4222-8222-222222222222';

const downloadFacts = {
  fileId,
  storageReference: 'private/ref.pdf',
  originalFilename: '维修记录.pdf',
  mimeType: 'application/pdf',
};

const makeQueryService = () => ({
  findAuthorizedDownload: jest.fn().mockResolvedValue(downloadFacts),
});

const makeOrganizationContextService = () => ({
  tryResolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
});

const makeStorage = () => ({
  save: jest.fn(),
  open: jest.fn().mockResolvedValue(Readable.from([Buffer.from('pdf')])),
  delete: jest.fn(),
  verifyIntegrity: jest.fn(),
});

const makeUsecase = (
  overrides: {
    queryService?: ReturnType<typeof makeQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    storage?: ReturnType<typeof makeStorage>;
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const storage = overrides.storage ?? makeStorage();
  const usecase = new DownloadStoredFileUsecase(
    queryService as unknown as StoredFileQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    storage,
  );
  return { usecase, queryService, storage };
};

describe('DownloadStoredFileUsecase', () => {
  it('授权通过后只返回文件流，不暴露存储引用', async () => {
    const { usecase, storage } = makeUsecase();

    const result = await usecase.execute({ session: engineer, fileId, uploadContextId });

    expect(storage.open).toHaveBeenCalledWith('private/ref.pdf');
    expect(result).toMatchObject({
      fileId,
      originalFilename: '维修记录.pdf',
      mimeType: 'application/pdf',
    });
    expect(result).not.toHaveProperty('storageReference');
  });

  it('直接请求不属于自己的原件：授权失败且不触达存储', async () => {
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(null);
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId: 'wrong-context' }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('客户角色拒绝，且不触达存储', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute({ session: customer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('存储对象缺失时返回受控 FILE_NOT_AVAILABLE，不泄露路径', async () => {
    const storage = makeStorage();
    storage.open.mockRejectedValueOnce(new Error('ENOENT private/ref.pdf'));
    const { usecase } = makeUsecase({ storage });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
  });

  it('非法 fileId 拒绝', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, fileId: 'bad', uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INVALID_PARAMS });
  });
});
