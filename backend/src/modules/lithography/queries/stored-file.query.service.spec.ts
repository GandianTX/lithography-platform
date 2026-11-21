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
  maintenanceReport: { findOne: jest.fn().mockResolvedValue(null) },
  maintenanceReportAttachment: { findOne: jest.fn().mockResolvedValue(null) },
});

const makeService = () => {
  const repositories = makeRepositories();
  const service = new StoredFileQueryService(
    repositories.storedFile as unknown as Repository<StoredFileEntity>,
    repositories.processEntry as unknown as Repository<RepairProcessEntryEntity>,
    repositories.request as unknown as Repository<RepairRequestEntity>,
    repositories.intake as unknown as Repository<RepairRequestIntakeEntity>,
    repositories.maintenanceReport as unknown as Repository<never>,
    repositories.maintenanceReportAttachment as unknown as Repository<never>,
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

  describe('新版维修原件（repair_request.maintenance_attachment_file_id）', () => {
    const boundFile = (overrides: Partial<ReturnType<typeof fileRow>> = {}) =>
      fileRow({ bindingStatus: 'BOUND', businessId: '42', uploadContextId: 'ctx', ...overrides });
    const maintenanceRequest = (overrides: Record<string, unknown> = {}) => ({
      id: 42,
      intakeId: 7001,
      serviceOrganizationId: 910001,
      ownerOrganizationId: 920002,
      deprecated: false,
      isAccepted: true,
      acceptedByEngineerAccountId: 900001,
      maintenanceAttachmentFileId: fileRow().fileId,
      ...overrides,
    });
    const maintenanceQuery = (overrides: Partial<StoredFileAccessQuery> = {}) =>
      accessQuery({ uploadContextId: null, ...overrides });

    it('接单工程师本人可读取并下载新版维修原件，且授权按工单真实关联判定', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(null);
      repositories.request.findOne.mockResolvedValueOnce(maintenanceRequest());

      await expect(service.findAuthorizedMetadata(maintenanceQuery())).resolves.toMatchObject({
        fileId: fileRow().fileId,
        businessId: '42',
        bindingStatus: 'BOUND',
      });

      expect(repositories.request.findOne).toHaveBeenCalledWith({
        where: { id: 42 },
        select: expect.objectContaining({
          maintenanceAttachmentFileId: true,
          isAccepted: true,
          acceptedByEngineerAccountId: true,
        }),
      });

      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(null);
      repositories.request.findOne.mockResolvedValueOnce(maintenanceRequest());

      await expect(service.findAuthorizedDownload(maintenanceQuery())).resolves.toMatchObject({
        fileId: fileRow().fileId,
        storageReference: fileRow().storageReference,
        checksumSha256: 'checksum',
      });
    });

    it('已结单不阻止接单工程师下载已绑定原件（结单只限制写入）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(null);
      repositories.request.findOne.mockResolvedValueOnce(
        maintenanceRequest({
          closureStatus: 'CLOSED',
          closedAt: new Date('2026-11-19T03:33:44.000Z'),
        }),
      );

      await expect(service.findAuthorizedDownload(maintenanceQuery())).resolves.toMatchObject({
        fileId: fileRow().fileId,
        storageReference: fileRow().storageReference,
      });
    });

    it('客户、外厂家、同公司非接单工程师均不得因新关联获得内部原件权限', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(null);
      repositories.request.findOne.mockResolvedValue(maintenanceRequest());

      await expect(
        service.findAuthorizedMetadata(maintenanceQuery({ session: customer })),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedDownload(maintenanceQuery({ viewerOrganizationId: 920002 })),
      ).resolves.toBeNull();
      // 同公司但非接单人（account 900002）
      await expect(
        service.findAuthorizedDownload(maintenanceQuery({ session: otherEngineer })),
      ).resolves.toBeNull();
      await expect(
        service.findAuthorizedMetadata(maintenanceQuery({ session: nonEngineerSameOrg })),
      ).resolves.toBeNull();
    });

    it('工单引用缺失、指向其他文件或工单不存在时拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(null);

      // repair_request 没有实际引用该文件
      repositories.request.findOne.mockResolvedValueOnce(
        maintenanceRequest({ maintenanceAttachmentFileId: null }),
      );
      await expect(service.findAuthorizedDownload(maintenanceQuery())).resolves.toBeNull();

      // repair_request 引用了另一个文件
      repositories.request.findOne.mockResolvedValueOnce(
        maintenanceRequest({
          maintenanceAttachmentFileId: '33333333-3333-4333-8333-333333333333',
        }),
      );
      await expect(service.findAuthorizedDownload(maintenanceQuery())).resolves.toBeNull();

      // 工单不存在
      repositories.request.findOne.mockResolvedValueOnce(null);
      await expect(service.findAuthorizedMetadata(maintenanceQuery())).resolves.toBeNull();

      // BOUND 但缺少业务工单号
      repositories.storedFile.findOne.mockResolvedValue(boundFile({ businessId: null }));
      await expect(service.findAuthorizedMetadata(maintenanceQuery())).resolves.toBeNull();
    });

    it('旧 repair_process_entry 原件授权保持既有同公司工程师口径', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce({ id: 700001 });
      // 旧路径不要求读取者是接单人
      repositories.request.findOne.mockResolvedValueOnce(
        maintenanceRequest({
          isAccepted: true,
          acceptedByEngineerAccountId: 900002,
          maintenanceAttachmentFileId: null,
        }),
      );

      await expect(service.findAuthorizedDownload(maintenanceQuery())).resolves.toMatchObject({
        fileId: fileRow().fileId,
      });
    });

    it('管理员沿用既有工单组织范围：二级本公司可读，跨公司拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(null);
      repositories.request.findOne.mockResolvedValue(maintenanceRequest());
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        serviceOrganizationId: 910001,
      });

      await expect(
        service.findAuthorizedDownload(
          maintenanceQuery({
            session: admin,
            viewerOrganizationId: 910001,
            adminOrganizationId: 910001,
          }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });

      await expect(
        service.findAuthorizedMetadata(
          maintenanceQuery({
            session: admin,
            viewerOrganizationId: 700002,
            adminOrganizationId: 700002,
          }),
        ),
      ).resolves.toBeNull();
    });
  });

  describe('客户报修原件（BOUND REPAIR_REQUEST，任务 03 第三段）', () => {
    const boundRequestFile = (overrides: Record<string, unknown> = {}) =>
      fileRow({
        businessType: 'REPAIR_REQUEST',
        bindingStatus: 'BOUND',
        businessId: '7001',
        uploadContextId: null,
        ...overrides,
      });

    const customerQuery = (overrides: Partial<StoredFileAccessQuery> = {}) =>
      accessQuery({
        session: customer,
        expectedBusinessType: 'REPAIR_REQUEST',
        uploadContextId: null,
        viewerOrganizationId: null,
        ...overrides,
      });

    it('报修本人可读取真实绑定到本人原稿的原件（元数据与下载）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundRequestFile());
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        fileId: '11111111-1111-4111-8111-111111111111',
        customerAccountId: 900001,
        deletedAt: null,
      });

      const metadata = await service.findAuthorizedMetadata(customerQuery());
      expect(metadata).toMatchObject({
        fileId: '11111111-1111-4111-8111-111111111111',
        byteSize: 10,
      });
      expect(metadata).not.toHaveProperty('storageReference');
      await expect(service.findAuthorizedDownload(customerQuery())).resolves.toMatchObject({
        storageReference: 'private/ref.pdf',
      });
    });

    it('同公司其他客户 / 外公司账号不可借 ID 读取（不泄露存在性）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundRequestFile());
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        fileId: '11111111-1111-4111-8111-111111111111',
        customerAccountId: 900999,
        deletedAt: null,
      });

      await expect(service.findAuthorizedMetadata(customerQuery())).resolves.toBeNull();
      await expect(
        service.findAuthorizedDownload(customerQuery({ session: session(['CUSTOMER'], 900888) })),
      ).resolves.toBeNull();
    });

    it('原稿已删除后原件对客户关闭；intake.file_id 不实际引用该文件时拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundRequestFile());

      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        fileId: '11111111-1111-4111-8111-111111111111',
        customerAccountId: 900001,
        deletedAt: new Date('2026-11-20T00:00:00.000Z'),
      });
      await expect(service.findAuthorizedDownload(customerQuery())).resolves.toBeNull();

      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        fileId: '99999999-9999-4999-8999-999999999999',
        customerAccountId: 900001,
        deletedAt: null,
      });
      await expect(service.findAuthorizedDownload(customerQuery())).resolves.toBeNull();
    });

    it('工程师无真实关联工单时拒绝（不进入工单口径，不泄露存在性）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundRequestFile());
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        fileId: '11111111-1111-4111-8111-111111111111',
        customerAccountId: 900001,
        deletedAt: null,
      });

      // 无 repair_request 关联该原稿（原稿尚未转为工单）
      await expect(
        service.findAuthorizedMetadata(accessQuery({ uploadContextId: null })),
      ).resolves.toBeNull();
    });

    it('暂存（TEMPORARY）REPAIR_REQUEST 原件不对客户开放', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(
        fileRow({ businessType: 'REPAIR_REQUEST', businessId: null }),
      );
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        fileId: '11111111-1111-4111-8111-111111111111',
        customerAccountId: 900001,
        deletedAt: null,
      });

      await expect(service.findAuthorizedMetadata(customerQuery())).resolves.toBeNull();
    });
  });

  describe('指定厂家工程师读取客户报修原件（BOUND REPAIR_REQUEST，任务 03/04 交叉链路）', () => {
    const boundRequestFile = (overrides: Record<string, unknown> = {}) =>
      fileRow({
        businessType: 'REPAIR_REQUEST',
        bindingStatus: 'BOUND',
        businessId: '7001',
        uploadContextId: null,
        ...overrides,
      });

    const engineerIntake = (overrides: Record<string, unknown> = {}) => ({
      id: 7001,
      fileId: '11111111-1111-4111-8111-111111111111',
      customerAccountId: 900001,
      serviceOrganizationId: 910001,
      deletedAt: null,
      ...overrides,
    });

    const workOrder = (overrides: Record<string, unknown> = {}) => ({
      id: 42,
      serviceOrganizationId: 910001,
      deprecated: false,
      ...overrides,
    });

    const engineerQuery = (overrides: Partial<StoredFileAccessQuery> = {}) =>
      accessQuery({
        uploadContextId: null,
        viewerOrganizationId: 910001,
        ...overrides,
      });

    const arrangeLinked = (repositories: ReturnType<typeof makeRepositories>): void => {
      repositories.storedFile.findOne.mockResolvedValue(boundRequestFile());
      repositories.intake.findOne.mockResolvedValue(engineerIntake());
      repositories.request.findOne.mockResolvedValue(workOrder());
    };

    it('指定厂家工程师可下载真实关联工单的客户原件（元数据与下载事实）', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);

      const metadata = await service.findAuthorizedMetadata(engineerQuery());
      expect(metadata).toMatchObject({
        fileId: '11111111-1111-4111-8111-111111111111',
        businessType: 'REPAIR_REQUEST',
        byteSize: 10,
      });
      expect(metadata).not.toHaveProperty('storageReference');

      await expect(service.findAuthorizedDownload(engineerQuery())).resolves.toMatchObject({
        fileId: '11111111-1111-4111-8111-111111111111',
        storageReference: 'private/ref.pdf',
        byteSize: 10,
      });
    });

    it('同厂家未接单工单同样可读（与工单详情可见规则一致，不以接单为前提）', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);
      repositories.request.findOne.mockResolvedValue(
        workOrder({ isAccepted: false, acceptedByEngineerAccountId: null }),
      );

      await expect(service.findAuthorizedMetadata(engineerQuery())).resolves.toMatchObject({
        businessType: 'REPAIR_REQUEST',
      });
    });

    it('工单查询以 intake_id 真实关联为依据（不信任文件 business_id 或前端厂家参数）', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);

      await service.findAuthorizedMetadata(engineerQuery());

      expect(repositories.intake.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 7001 } }),
      );
      expect(repositories.request.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { intakeId: 7001 } }),
      );
    });

    it('工单未关联该原稿（无 repair_request 行）拒绝', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundRequestFile());
      repositories.intake.findOne.mockResolvedValue(engineerIntake());
      repositories.request.findOne.mockResolvedValue(null);

      await expect(service.findAuthorizedMetadata(engineerQuery())).resolves.toBeNull();
    });

    it('外公司工程师拒绝（工单服务公司不属于可信组织）', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);

      await expect(
        service.findAuthorizedDownload(engineerQuery({ viewerOrganizationId: 700002 })),
      ).resolves.toBeNull();
    });

    it('工单已删除时拒绝', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);
      repositories.request.findOne.mockResolvedValue(workOrder({ deprecated: true }));

      await expect(service.findAuthorizedMetadata(engineerQuery())).resolves.toBeNull();
    });

    it('工单与原稿服务公司冲突时拒绝（不使用 owner 或历史接单人兜底）', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);
      repositories.request.findOne.mockResolvedValue(workOrder({ serviceOrganizationId: 700002 }));

      await expect(service.findAuthorizedMetadata(engineerQuery())).resolves.toBeNull();

      repositories.request.findOne.mockResolvedValue(workOrder({ serviceOrganizationId: null }));
      await expect(service.findAuthorizedMetadata(engineerQuery())).resolves.toBeNull();
    });

    it('原稿已删除后工程师同样拒绝', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);
      repositories.intake.findOne.mockResolvedValue(
        engineerIntake({ deletedAt: new Date('2026-11-20T00:00:00.000Z') }),
      );

      await expect(service.findAuthorizedMetadata(engineerQuery())).resolves.toBeNull();
    });

    it('intake.file_id 不实际引用该文件时工程师拒绝', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);
      repositories.intake.findOne.mockResolvedValue(
        engineerIntake({ fileId: '99999999-9999-4999-8999-999999999999' }),
      );

      await expect(service.findAuthorizedMetadata(engineerQuery())).resolves.toBeNull();
    });

    it('管理员会话不因本分支放行（管理员口径不变）', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);

      await expect(
        service.findAuthorizedMetadata(
          engineerQuery({
            session: admin,
            adminOrganizationId: null,
            viewerOrganizationId: null,
          }),
        ),
      ).resolves.toBeNull();

      await expect(
        service.findAuthorizedMetadata(
          engineerQuery({
            session: admin,
            adminOrganizationId: 910001,
          }),
        ),
      ).resolves.toBeNull();
    });

    it('无可信组织归属的工程师拒绝（viewerOrganizationId 为空）', async () => {
      const { service, repositories } = makeService();
      arrangeLinked(repositories);

      await expect(
        service.findAuthorizedMetadata(engineerQuery({ viewerOrganizationId: null })),
      ).resolves.toBeNull();
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

    it('二级管理员可读取本公司工单原件（工单与报修服务公司一致）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 700002 }),
      );
      repositories.intake.findOne.mockResolvedValueOnce({
        id: 7001,
        serviceOrganizationId: 700002,
      });

      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });
    });

    it('方案 B：intake 已软删除但三方公司一致，二级管理员仍可读取原件', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValueOnce(boundFile());
      repositories.processEntry.findOne.mockResolvedValueOnce(entry);
      repositories.request.findOne.mockResolvedValueOnce(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 700002 }),
      );
      repositories.intake.findOne.mockResolvedValueOnce({
        id: 7001,
        serviceOrganizationId: 700002,
        deletedAt: new Date('2026-11-01T00:00:00.000Z'),
      });

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
      repositories.intake.findOne.mockResolvedValueOnce({
        id: 7001,
        serviceOrganizationId: 700002,
      });

      await expect(
        service.findAuthorizedMetadata(
          adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 }),
        ),
      ).resolves.toMatchObject({ fileId: fileRow().fileId });
    });

    it('工单、报修、二级管理员三方公司一致：元数据与下载均允许', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 920002 }),
      );
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        serviceOrganizationId: 700002,
      });
      const query = adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 });

      await expect(service.findAuthorizedMetadata(query)).resolves.toMatchObject({
        fileId: fileRow().fileId,
      });
      await expect(service.findAuthorizedDownload(query)).resolves.toMatchObject({
        fileId: fileRow().fileId,
        storageReference: fileRow().storageReference,
      });
    });

    it('工单与报修服务公司冲突：元数据与下载均拒绝（不使用 owner 回退）', async () => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(
        request({ serviceOrganizationId: 700002, ownerOrganizationId: 700002 }),
      );
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        serviceOrganizationId: 920002,
      });
      const query = adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 });

      await expect(service.findAuthorizedMetadata(query)).resolves.toBeNull();
      await expect(service.findAuthorizedDownload(query)).resolves.toBeNull();
    });

    it.each([
      ['工单未关联报修', { intakeId: null }, { id: 7001, serviceOrganizationId: 700002 }],
      ['报修不存在', {}, null],
      ['报修服务公司缺失', {}, { id: 7001, serviceOrganizationId: null }],
    ])('来源缺失（%s）：二级管理员元数据与下载均拒绝', async (_label, requestOverride, intake) => {
      const { service, repositories } = makeService();
      repositories.storedFile.findOne.mockResolvedValue(boundFile());
      repositories.processEntry.findOne.mockResolvedValue(entry);
      repositories.request.findOne.mockResolvedValue(
        request({
          serviceOrganizationId: 700002,
          ownerOrganizationId: 700002,
          ...requestOverride,
        }),
      );
      repositories.intake.findOne.mockResolvedValue(intake);
      const query = adminQuery({ viewerOrganizationId: 700002, adminOrganizationId: 700002 });

      await expect(service.findAuthorizedMetadata(query)).resolves.toBeNull();
      await expect(service.findAuthorizedDownload(query)).resolves.toBeNull();
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
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        serviceOrganizationId: 700002,
      });
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
      repositories.intake.findOne.mockResolvedValue({
        id: 7001,
        serviceOrganizationId: 700002,
      });
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

describe('报告附件授权（BOUND MAINTENANCE_REPORT，R062-03）', () => {
  const REPORT_ID = 960101;
  const OWNER_ORG = 910101;
  const AUTHOR_ID = 900001;
  const boundReportFile = (overrides: Record<string, unknown> = {}) =>
    fileRow({
      businessType: 'MAINTENANCE_REPORT',
      businessId: String(REPORT_ID),
      bindingStatus: 'BOUND',
      uploadContextId: null,
      ...overrides,
    });
  const boundQuery = (overrides: Partial<StoredFileAccessQuery> = {}): StoredFileAccessQuery => ({
    fileId: '11111111-1111-4111-8111-111111111111',
    session: engineer,
    viewerOrganizationId: OWNER_ORG,
    uploadContextId: null,
    expectedBusinessType: 'MAINTENANCE_REPORT',
    ...overrides,
  });
  const reportRow = (overrides: Record<string, unknown> = {}) => ({
    id: REPORT_ID,
    ownerOrganizationId: OWNER_ORG,
    maintenanceEngineerAccountId: AUTHOR_ID,
    status: 'DRAFT',
    ...overrides,
  });

  const setupBoundReport = (
    repositories: ReturnType<typeof makeRepositories>,
    report: Record<string, unknown> | null,
    hasCurrentAttachment = true,
  ): void => {
    repositories.maintenanceReport.findOne.mockResolvedValue(report);
    repositories.maintenanceReportAttachment.findOne.mockResolvedValue(
      hasCurrentAttachment ? { id: 1 } : null,
    );
  };

  it('作者本人：草稿状态报告附件可读元数据并定位下载', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValue(boundReportFile());
    setupBoundReport(repositories, reportRow());

    const metadata = await service.findAuthorizedMetadata(boundQuery());
    expect(metadata).not.toBeNull();
    expect(metadata?.businessId).toBe(String(REPORT_ID));

    const facts = await service.findAuthorizedDownload(boundQuery());
    expect(facts).toMatchObject({
      fileId: '11111111-1111-4111-8111-111111111111',
      originalFilename: '维修记录.pdf',
    });
    // 元数据视图不暴露存储引用（下载事实仅服务端内部使用）
    expect(metadata).not.toHaveProperty('storageReference');
  });

  it('附件行缺失或已移除（无 CURRENT 行）：拒绝下载', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'SUBMITTED' }), false);

    await expect(service.findAuthorizedDownload(boundQuery())).resolves.toBeNull();
  });

  it('同公司非作者工程师：拒绝（不借同公司身份读报告附件）', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'SUBMITTED' }));

    await expect(
      service.findAuthorizedDownload(boundQuery({ session: otherEngineer })),
    ).resolves.toBeNull();
  });

  it('客户角色会话：拒绝（usecase 角色守卫之外的纵深防御）', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow());

    await expect(
      service.findAuthorizedDownload(boundQuery({ session: customer })),
    ).resolves.toBeNull();
  });

  it('一级管理员（adminOrganizationId=null）：可读 SUBMITTED 冻结报告附件', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'SUBMITTED' }));

    await expect(
      service.findAuthorizedDownload(boundQuery({ session: admin, adminOrganizationId: null })),
    ).resolves.not.toBeNull();
  });

  it('二级管理员（本公司）：可读 SUBMITTED 报告附件；跨公司拒绝', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'SUBMITTED' }));
    await expect(
      service.findAuthorizedDownload(
        boundQuery({ session: admin, adminOrganizationId: OWNER_ORG }),
      ),
    ).resolves.not.toBeNull();

    const cross = makeService();
    cross.repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(cross.repositories, reportRow({ status: 'SUBMITTED' }));
    await expect(
      cross.service.findAuthorizedDownload(
        boundQuery({ session: admin, adminOrganizationId: 919999 }),
      ),
    ).resolves.toBeNull();
  });

  it('管理员不可读他人 DRAFT 草稿附件（即使本公司）', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'DRAFT' }));

    await expect(
      service.findAuthorizedDownload(
        boundQuery({ session: admin, adminOrganizationId: OWNER_ORG }),
      ),
    ).resolves.toBeNull();
  });

  it('一级管理员跨公司：可读 APPROVED 正式报告附件（旧审核流冻结态，与管理员报告查看权限对齐）', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'APPROVED' }));

    await expect(
      service.findAuthorizedDownload(boundQuery({ session: admin, adminOrganizationId: null })),
    ).resolves.not.toBeNull();
  });

  it('二级管理员（本公司）：可读 APPROVED 报告附件；跨公司 APPROVED 拒绝', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'APPROVED' }));
    await expect(
      service.findAuthorizedDownload(
        boundQuery({ session: admin, adminOrganizationId: OWNER_ORG }),
      ),
    ).resolves.not.toBeNull();

    const cross = makeService();
    cross.repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(cross.repositories, reportRow({ status: 'APPROVED' }));
    await expect(
      cross.service.findAuthorizedDownload(
        boundQuery({ session: admin, adminOrganizationId: 919999 }),
      ),
    ).resolves.toBeNull();
  });

  it('一级管理员：可读 PENDING_REVIEW 报告附件（与管理员报告查看口径一致）', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'PENDING_REVIEW' }));

    await expect(
      service.findAuthorizedDownload(boundQuery({ session: admin, adminOrganizationId: null })),
    ).resolves.not.toBeNull();
  });

  it('RETURNED 工作态报告附件：管理员拒绝（与导出管理员状态门一致）', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(repositories, reportRow({ status: 'RETURNED' }));

    await expect(
      service.findAuthorizedDownload(boundQuery({ session: admin, adminOrganizationId: null })),
    ).resolves.toBeNull();
  });

  it('businessId 不是合法报告 ID 或报告不存在：拒绝', async () => {
    const { service, repositories } = makeService();
    repositories.storedFile.findOne.mockResolvedValueOnce(
      boundReportFile({ businessId: 'not-a-number' }),
    );
    setupBoundReport(repositories, reportRow({ status: 'SUBMITTED' }));
    await expect(service.findAuthorizedDownload(boundQuery())).resolves.toBeNull();

    const missing = makeService();
    missing.repositories.storedFile.findOne.mockResolvedValueOnce(boundReportFile());
    setupBoundReport(missing.repositories, null);
    await expect(missing.service.findAuthorizedDownload(boundQuery())).resolves.toBeNull();
  });
});
