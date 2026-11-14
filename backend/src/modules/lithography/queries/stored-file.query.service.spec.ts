// src/modules/lithography/queries/stored-file.query.service.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { Repository } from 'typeorm';

import type { RepairProcessEntryEntity } from '../entities/repair-process-entry.entity';
import type { RepairRequestEntity } from '../entities/repair-request.entity';
import type { StoredFileEntity } from '../entities/stored-file.entity';
import { StoredFileQueryService, type StoredFileAccessQuery } from './stored-file.query.service';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const otherEngineer = session(['ENGINEER'], 900002);
const customer = session(['CUSTOMER']);
const nonEngineerSameOrg = session(['CLIENT'], 900003);

const createdAt = new Date('2026-11-14T00:00:00.000Z');

const fileRow = (overrides: Record<string, unknown> = {}) => ({
  fileId: '11111111-1111-4111-8111-111111111111',
  uploadedByAccountId: 900001,
  ownerOrganizationId: 910001,
  storageReference: 'private/ref.pdf',
  originalFilename: '维修记录.pdf',
  mimeType: 'application/pdf',
  byteSize: '10',
  checksumSha256: 'checksum',
  status: 'VALID',
  businessType: 'REPAIR_PROCESS',
  businessId: null,
  uploadContextId: '22222222-2222-4222-8222-222222222222',
  bindingStatus: 'TEMPORARY',
  createdAt,
  verifiedAt: createdAt,
  ...overrides,
});

const accessQuery = (overrides: Partial<StoredFileAccessQuery> = {}): StoredFileAccessQuery => ({
  fileId: '11111111-1111-4111-8111-111111111111',
  session: engineer,
  viewerOrganizationId: 910001,
  uploadContextId: '22222222-2222-4222-8222-222222222222',
  expectedBusinessType: 'REPAIR_PROCESS',
  ...overrides,
});

const makeRepositories = () => ({
  storedFile: {
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
  },
  processEntry: { findOne: jest.fn().mockResolvedValue(null) },
  request: { findOne: jest.fn().mockResolvedValue(null) },
});

const makeService = () => {
  const repositories = makeRepositories();
  const service = new StoredFileQueryService(
    repositories.storedFile as unknown as Repository<StoredFileEntity>,
    repositories.processEntry as unknown as Repository<RepairProcessEntryEntity>,
    repositories.request as unknown as Repository<RepairRequestEntity>,
  );
  return { service, repositories };
};

describe('StoredFileQueryService 读授权', () => {
  describe('暂存（TEMPORARY）', () => {
    it('原上传者 + 同公司 + 同用途 + 同上下文可读，且不暴露存储引用', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(fileRow());

      const result = await service.findAuthorizedMetadata(accessQuery());

      expect(result).toMatchObject({
        fileId: '11111111-1111-4111-8111-111111111111',
        byteSize: 10,
        status: 'VALID',
        bindingStatus: 'TEMPORARY',
        businessId: null,
      });
      expect(result).not.toHaveProperty('storageReference');
    });

    it('上传上下文缺失或不匹配时拒绝（不可只凭 fileId 读取）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(fileRow());

      await expect(
        service.findAuthorizedMetadata(accessQuery({ uploadContextId: null })),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedMetadata(
          accessQuery({ uploadContextId: '33333333-3333-4333-8333-333333333333' }),
        ),
      ).resolves.toBeNull();
    });

    it('他人账号 / 外公司 / 客户角色均拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(fileRow());

      await expect(
        service.findAuthorizedMetadata(accessQuery({ session: otherEngineer })),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedMetadata(accessQuery({ viewerOrganizationId: 920002 })),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedMetadata(accessQuery({ session: customer })),
      ).resolves.toBeNull();
    });

    it('未通过校验或已带 businessId 的暂存不可读', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(
        fileRow({ status: 'FAILED', verifiedAt: null }),
      );
      await expect(service.findAuthorizedMetadata(accessQuery())).resolves.toBeNull();

      repositories.storedFile.findOne.mockResolvedValue(fileRow({ businessId: '42' }));
      await expect(service.findAuthorizedMetadata(accessQuery())).resolves.toBeNull();
    });
  });

  describe('正式绑定（BOUND REPAIR_PROCESS）', () => {
    const boundFile = () =>
      fileRow({ bindingStatus: 'BOUND', businessId: '42', uploadContextId: 'ctx' });
    const entry = { id: 700001 };
    const request = (overrides: Record<string, unknown> = {}) => ({
      id: 42,
      ownerOrganizationId: 910001,
      isAccepted: true,
      acceptedByEngineerAccountId: 900001,
      deprecated: false,
      ...overrides,
    });

    it('同公司工程师且存在真实过程关联时可读（不要求 uploadContextId）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(request());

      const result = await service.findAuthorizedMetadata(
        accessQuery({ uploadContextId: null, session: otherEngineer }),
      );

      expect(result).toMatchObject({ businessId: '42', bindingStatus: 'BOUND' });
      expect(result).not.toHaveProperty('storageReference');
      expect(repositories.processEntry.findOne).toHaveBeenCalledWith({
        where: { fileId: fileRow().fileId, requestId: 42 },
        select: { id: true },
      });
    });

    it('客户、外公司、同公司非工程师账号均拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request());

      await expect(
        service.findAuthorizedMetadata(accessQuery({ session: customer, uploadContextId: null })),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedMetadata(
          accessQuery({ viewerOrganizationId: 920002, uploadContextId: null }),
        ),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedMetadata(
          accessQuery({ session: nonEngineerSameOrg, uploadContextId: null }),
        ),
      ).resolves.toBeNull();
    });

    it('没有真实维修过程关联、工单作废时拒绝（不信任文件自身 businessId）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.request.findOne.mockResolvedValue(request());

      await expect(
        service.findAuthorizedMetadata(accessQuery({ uploadContextId: null })),
      ).resolves.toBeNull();

      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request({ deprecated: true }));
      await expect(
        service.findAuthorizedMetadata(accessQuery({ uploadContextId: null })),
      ).resolves.toBeNull();
    });

    it('无归属公司工单：仅本人接单工程师可读', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request({ ownerOrganizationId: null }));

      await expect(
        service.findAuthorizedMetadata(
          accessQuery({ uploadContextId: null, viewerOrganizationId: null }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });

      await expect(
        service.findAuthorizedMetadata(
          accessQuery({
            uploadContextId: null,
            session: otherEngineer,
            viewerOrganizationId: null,
          }),
        ),
      ).resolves.toBeNull();
    });

    it('下载定位只返回流式所需事实，不暴露给元数据', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(request());

      const facts = await service.findAuthorizedDownload(accessQuery({ uploadContextId: null }));
      expect(facts).toEqual({
        fileId: fileRow().fileId,
        storageReference: 'private/ref.pdf',
        originalFilename: '维修记录.pdf',
        mimeType: 'application/pdf',
      });
    });
  });

  it('存储引用补偿判定按引用计数', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.count.mockResolvedValueOnce(1);
    await expect(service.isStorageReferenceReferenced('private/ref.pdf')).resolves.toBe(true);

    repositories.storedFile.count.mockResolvedValueOnce(0);
    await expect(service.isStorageReferenceReferenced('private/ref.pdf')).resolves.toBe(false);
  });
});
