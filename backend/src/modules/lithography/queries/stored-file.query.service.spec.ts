// src/modules/lithography/queries/stored-file.query.service.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { Repository } from 'typeorm';

import type { RepairProcessEntryEntity } from '../entities/repair-process-entry.entity';
import type { RepairRequestEntity } from '../entities/repair-request.entity';
import type { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import type { StoredFileEntity } from '../entities/stored-file.entity';
import { StoredFileQueryService, type StoredFileAccessQuery } from './stored-file.query.service';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const otherEngineer = session(['ENGINEER'], 900002);
const customer = session(['CUSTOMER']);
const nonEngineerSameOrg = session(['CLIENT'], 900003);
/** 管理员会话：读写身份均以可信 JWT roles + activeRole 为准 */
const admin = session(['SUPER_ADMIN'], 900010);

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
  intake: {
    findOne: jest.fn().mockResolvedValue({ id: 7001, serviceOrganizationId: 910001 }),
  },
});

const makeService = () => {
  const repositories = makeRepositories();
  const service = new StoredFileQueryService(
    repositories.storedFile as unknown as Repository<StoredFileEntity>,
    repositories.processEntry as unknown as Repository<RepairProcessEntryEntity>,
    repositories.request as unknown as Repository<RepairRequestEntity>,
    repositories.intake as unknown as Repository<RepairRequestIntakeEntity>,
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

    it('原上传者 + 正确上下文可下载；缺上下文、错上下文、非上传者拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(fileRow());

      await expect(service.findAuthorizedDownload(accessQuery())).resolves.toMatchObject({
        fileId: '11111111-1111-4111-8111-111111111111',
        storageReference: 'private/ref.pdf',
        byteSize: 10,
        checksumSha256: 'checksum',
      });
      await expect(
        service.findAuthorizedDownload(accessQuery({ uploadContextId: null })),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedDownload(
          accessQuery({ uploadContextId: '33333333-3333-4333-8333-333333333333' }),
        ),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedDownload(accessQuery({ session: otherEngineer })),
      ).resolves.toBeNull();
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
      ownerOrganizationId: 920002,
      intakeId: 7001,
      serviceOrganizationId: 910001,
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

    it('客户 A / 服务公司 B：按可信服务公司放行 B 公司工程师，不放行客户公司', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request());

      await expect(
        service.findAuthorizedMetadata(accessQuery({ uploadContextId: null })),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });

      await expect(
        service.findAuthorizedMetadata(
          accessQuery({ uploadContextId: null, viewerOrganizationId: 920002 }),
        ),
      ).resolves.toBeNull();
    });

    it('工单与报修服务公司冲突时，双方工程师都不能读取元数据或下载', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request());
      repositories.intake.findOne.mockResolvedValue({ id: 7001, serviceOrganizationId: 920002 });

      for (const viewerOrganizationId of [910001, 920002]) {
        const query = accessQuery({ uploadContextId: null, viewerOrganizationId });
        await expect(service.findAuthorizedMetadata(query)).resolves.toBeNull();
        await expect(service.findAuthorizedDownload(query)).resolves.toBeNull();
      }
    });

    it('intake 缺失时拒绝，不使用工单旧 owner 兜底', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request());

      repositories.intake.findOne.mockResolvedValueOnce(null);
      await expect(
        service.findAuthorizedMetadata(accessQuery({ uploadContextId: null })),
      ).resolves.toBeNull();

      repositories.request.findOne.mockResolvedValue(
        request({ intakeId: null, serviceOrganizationId: 910001, ownerOrganizationId: 910001 }),
      );
      await expect(
        service.findAuthorizedMetadata(
          accessQuery({ uploadContextId: null, session: otherEngineer }),
        ),
      ).resolves.toBeNull();
    });

    it('无可信服务归属的工单：原接单人也不可读', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(
        request({ ownerOrganizationId: null, intakeId: null, serviceOrganizationId: null }),
      );

      await expect(
        service.findAuthorizedMetadata(
          accessQuery({ uploadContextId: null, viewerOrganizationId: null }),
        ),
      ).resolves.toBeNull();

      await expect(
        service.findAuthorizedMetadata(accessQuery({ uploadContextId: null })),
      ).resolves.toBeNull();

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
        byteSize: 10,
        checksumSha256: 'checksum',
      });
    });
  });

  describe('管理员读取（BOUND REPAIR_PROCESS）', () => {
    const boundFile = () =>
      fileRow({ bindingStatus: 'BOUND', businessId: '42', uploadContextId: 'ctx' });
    const entry = { id: 700001 };
    const request = (overrides: Record<string, unknown> = {}) => ({
      id: 42,
      intakeId: 7001,
      serviceOrganizationId: 920002,
      ownerOrganizationId: 920002,
      isAccepted: false,
      acceptedByEngineerAccountId: null,
      deprecated: false,
      ...overrides,
    });

    const adminQuery = (overrides: Partial<StoredFileAccessQuery> = {}) =>
      accessQuery({
        session: admin,
        viewerOrganizationId: null,
        uploadContextId: null,
        adminOrganizationId: null,
        ...overrides,
      });

    it('工单查询同时读取服务公司证据列（管理员组织范围判定所需）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(request());

      await service.findAuthorizedMetadata(adminQuery());

      expect(repositories.request.findOne).toHaveBeenCalledWith({
        where: { id: 42 },
        select: expect.objectContaining({
          serviceOrganizationId: true,
          ownerOrganizationId: true,
          deprecated: true,
        }),
      });
    });

    it('一级管理员（organizationId = null）可跨公司读取真实关联原件', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(request());

      const result = await service.findAuthorizedMetadata(adminQuery());

      expect(result).toMatchObject({ businessId: '42', bindingStatus: 'BOUND' });
      expect(result).not.toHaveProperty('storageReference');
    });

    it('二级管理员可读取本公司工单原件（按服务公司主口径）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 700002 }),
      );

      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });
    });

    it('二级管理员跨公司读取拒绝（即使存在真实过程关联）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request());

      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toBeNull();
    });

    it('服务公司为空时即使 owner 匹配也拒绝；两列都空同样拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);

      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: null, ownerOrganizationId: 700002 }),
      );
      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toBeNull();

      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: null, ownerOrganizationId: null }),
      );
      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toBeNull();
    });

    it('服务公司属于外公司时以服务公司为准，owner 匹配也拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(
        request({ serviceOrganizationId: 920002, ownerOrganizationId: 700002 }),
      );

      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toBeNull();
    });

    it('服务公司属于本公司时允许，owner 不同不影响', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 920002 }),
      );

      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });
    });

    it('一级管理员可跨公司定位下载；只返回流式所需事实', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(request());

      const facts = await service.findAuthorizedDownload(adminQuery());

      expect(facts).toMatchObject({
        fileId: fileRow().fileId,
        storageReference: fileRow().storageReference,
        mimeType: 'application/pdf',
        checksumSha256: 'checksum',
      });
      expect(facts).not.toHaveProperty('businessId');
      expect(facts).not.toHaveProperty('uploadedByAccountId');
    });

    it('二级管理员可下载本公司工单原件，跨公司下载拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);

      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 700002 }),
      );
      await expect(
        service.findAuthorizedDownload(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });

      repositories.request.findOne.mockResolvedValue(request());
      await expect(
        service.findAuthorizedDownload(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toBeNull();
    });

    it('二级管理员下载：服务公司为空或为外公司时即使 owner 匹配也拒绝；服务公司本公司时允许', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);

      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: null, ownerOrganizationId: 700002 }),
      );
      await expect(
        service.findAuthorizedDownload(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toBeNull();

      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: 920002, ownerOrganizationId: 700002 }),
      );
      await expect(
        service.findAuthorizedDownload(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toBeNull();

      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 920002 }),
      );
      await expect(
        service.findAuthorizedDownload(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });
    });

    it('缺少真实过程关联或工单已删除时管理员同样拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.request.findOne.mockResolvedValue(request());

      await expect(service.findAuthorizedMetadata(adminQuery())).resolves.toBeNull();

      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(request({ deprecated: true }));
      await expect(service.findAuthorizedMetadata(adminQuery())).resolves.toBeNull();
    });

    it('管理员身份不自动获得他人暂存文件', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(fileRow({ uploadedByAccountId: 900001 }));

      await expect(
        service.findAuthorizedMetadata(
          adminQuery({
            viewerOrganizationId: 910001,
            uploadContextId: '22222222-2222-4222-8222-222222222222',
          }),
        ),
      ).resolves.toBeNull();
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
