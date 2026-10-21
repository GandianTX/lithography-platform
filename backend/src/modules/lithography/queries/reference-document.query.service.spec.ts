// src/modules/lithography/queries/reference-document.query.service.spec.ts

import type { EntityManager } from 'typeorm';

import { REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { ReferenceDocumentEntity } from '../entities/reference-document.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { ReferenceDocumentCaseDetailEntity } from '../entities/reference-document-case-detail.entity';
import { ReferenceDocumentQueryService } from './reference-document.query.service';

/** 测试统一组织 ID（可信组织上下文解析产物；A-PR0 §2.1 不取客户端自报） */
const ORG_ID = 910001;

const makeDocumentRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
  findOne: jest.fn().mockResolvedValue(null),
});

const makeModelRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
});

const makeOrganizationRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
});

const makeCaseDetailRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
});

const documentEntity = (overrides: Partial<ReferenceDocumentEntity> = {}) => ({
  id: 970001,
  title: '错误码手册',
  documentType: 'ERROR_CODE_MANUAL',
  equipmentModelId: 930001,
  equipmentModelText: null,
  description: '说明',
  originalFilename: null,
  mimeType: null,
  contentText: 'E-CHUCK-101',
  storageBackend: null,
  storageReference: null,
  createdByAccountId: 900001,
  ownerOrganizationId: ORG_ID,
  ingestMethod: 'ADMIN_DIRECT',
  sourceSubmissionId: null,
  sourceRevisionId: null,
  updatedByAccountId: null,
  extensionJson: null,
  schemaVersion: 1,
  deprecated: false,
  deletedAt: null,
  createdAt: new Date('2026-01-02T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
  ...overrides,
});

const modelEntity = (overrides: Partial<EquipmentModelEntity> = {}) =>
  ({
    id: 930001,
    modelCode: 'ASML-TWINSCAN-NXT-1980DI',
    modelName: 'NXT:1980Di',
    enabled: true,
    ...overrides,
  }) as unknown as EquipmentModelEntity;

const organizationEntity = (overrides: Partial<OrganizationEntity> = {}) =>
  ({
    id: ORG_ID,
    organizationCode: 'CLIENT_DEFAULT',
    name: '甲方默认组织',
    kind: 'CLIENT',
    status: 'ACTIVE',
    ...overrides,
  }) as unknown as OrganizationEntity;

const caseDetailEntity = (overrides: Partial<ReferenceDocumentCaseDetailEntity> = {}) =>
  ({
    documentId: 970001,
    errorCode: 'E-CHUCK-101',
    handlingStatus: 'IN_PROGRESS',
    phenomenon: '晶圆吸附异常',
    conditionText: null,
    reproductionSteps: '复现步骤',
    diagnosis: null,
    actionTaken: null,
    resolution: null,
    casePayloadJson: null,
    schemaVersion: 1,
    ...overrides,
  }) as unknown as ReferenceDocumentCaseDetailEntity;

describe('ReferenceDocumentQueryService', () => {
  const pagination = { page: 1, pageSize: 10, withTotal: true };

  /** 读取 TypeORM FindOperator 私有字段（Raw 的注入参数 / In 的值集合），索引访问避免命名约定冲突 */
  const findOperatorField = (whereClause: unknown, key: string): unknown =>
    (whereClause as Record<string, unknown>)[key];

  const makeService = () => {
    const documentRepo = makeDocumentRepo();
    const modelRepo = makeModelRepo();
    const organizationRepo = makeOrganizationRepo();
    const caseDetailRepo = makeCaseDetailRepo();
    const service = new ReferenceDocumentQueryService(
      documentRepo as never,
      modelRepo as never,
      organizationRepo as never,
      caseDetailRepo as never,
    );
    return { documentRepo, modelRepo, organizationRepo, caseDetailRepo, service };
  };

  it('列表默认仅本组织未软删（deprecated = 0 且 owner_organization_id 命中），固定排序与 OFFSET 分页透传', async () => {
    const { documentRepo, service } = makeService();

    await service.listDocuments({ filter: {}, pagination, organizationId: ORG_ID });

    expect(documentRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deprecated: false, ownerOrganizationId: ORG_ID },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 10,
      }),
    );
    // count 与 find 必须使用同一 where（组织范围 + 未软删一致），防总数绕过组织范围
    expect(documentRepo.count).toHaveBeenCalledWith({
      where: { deprecated: false, ownerOrganizationId: ORG_ID },
    });
  });

  it('withTotal 为 false 时不执行 count 查询', async () => {
    const { documentRepo, service } = makeService();

    await service.listDocuments({
      filter: {},
      pagination: { page: 2, pageSize: 5, withTotal: false },
      organizationId: ORG_ID,
    });

    expect(documentRepo.count).not.toHaveBeenCalled();
    expect(documentRepo.find).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
  });

  it('非法分页参数（0/负数）在 QueryService 二级防御钳制，不产生负 skip/零 take SQL', async () => {
    const { documentRepo, service } = makeService();

    await service.listDocuments({
      filter: {},
      pagination: { page: 0, pageSize: -5, withTotal: true },
      organizationId: ORG_ID,
    });

    expect(documentRepo.find).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 1 }));
  });

  it('筛选条件透传：文档类型等值与设备型号等值；标题以 LIKE 模式注入', async () => {
    const { documentRepo, service } = makeService();

    await service.listDocuments({
      filter: { title: '手册', documentType: 'ERROR_CODE_MANUAL', equipmentModelId: 930001 },
      pagination,
      organizationId: ORG_ID,
    });

    const call = documentRepo.find.mock.calls[0][0];
    expect(call.where.documentType).toBe('ERROR_CODE_MANUAL');
    expect(call.where.equipmentModelId).toBe(930001);
    // 标题走 Raw LIKE；通配符转义由服务保证，断言注入的 pattern 参数
    const rawParams = findOperatorField(call.where.title, '_objectLiteralParameters') as {
      pattern?: string;
    };
    expect(rawParams.pattern).toBe('%手册%');
  });

  it('案例处理状态筛选：EXISTS 命中案例明细且筛选值参数化注入（防注入）', async () => {
    const { documentRepo, service } = makeService();

    await service.listDocuments({
      filter: { caseHandlingStatus: 'RESOLVED' },
      pagination,
      organizationId: ORG_ID,
    });

    const call = documentRepo.find.mock.calls[0][0];
    // 筛选值以命名参数注入（不拼接进 SQL 字面量），断言参数对象
    const rawParams = findOperatorField(call.where.id, '_objectLiteralParameters') as {
      caseHandlingStatus?: string;
    };
    expect(rawParams.caseHandlingStatus).toBe('RESOLVED');
    // 条件本身仍是组织范围 + 未软删
    expect(call.where.deprecated).toBe(false);
    expect(call.where.ownerOrganizationId).toBe(ORG_ID);
  });

  it('标题 LIKE 通配符转义：用户输入 % / _ 不扩大匹配范围', async () => {
    const { documentRepo, service } = makeService();

    await service.listDocuments({
      filter: { title: '100%_a\\b' },
      pagination,
      organizationId: ORG_ID,
    });

    const call = documentRepo.find.mock.calls[0][0];
    const rawParams = findOperatorField(call.where.title, '_objectLiteralParameters') as {
      pattern?: string;
    };
    expect(rawParams.pattern).toBe('%100\\%\\_a\\\\b%');
  });

  it('列表装配：型号名称/组织展示名/案例处理状态批量读取；普通资料为空；含创建人账号 ID 供 usecase 富集', async () => {
    const { documentRepo, modelRepo, organizationRepo, caseDetailRepo, service } = makeService();
    documentRepo.find.mockResolvedValue([
      documentEntity(),
      documentEntity({ id: 970003, equipmentModelId: null }),
    ]);
    modelRepo.find.mockResolvedValue([modelEntity()]);
    organizationRepo.find.mockResolvedValue([organizationEntity()]);
    caseDetailRepo.find.mockResolvedValue([caseDetailEntity()]);

    const page = await service.listDocuments({ filter: {}, pagination, organizationId: ORG_ID });

    // 批量型号查询用 In(...) FindOperator，内部值集合持有去重后的型号 ID
    const inValue = findOperatorField(
      (modelRepo.find.mock.calls[0][0] as { where: { id: unknown } }).where.id,
      '_value',
    );
    expect(inValue).toEqual([930001]);
    // 组织展示名批量装配（去重后的组织 ID 集合）
    const orgInValue = findOperatorField(
      (organizationRepo.find.mock.calls[0][0] as { where: { id: unknown } }).where.id,
      '_value',
    );
    expect(orgInValue).toEqual([ORG_ID]);
    // 案例处理状态批量装配（去重后的文档 ID 集合）
    const caseInValue = findOperatorField(
      (caseDetailRepo.find.mock.calls[0][0] as { where: { documentId: unknown } }).where.documentId,
      '_value',
    );
    expect(caseInValue).toEqual([970001, 970003]);

    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: 970001,
      equipmentModelName: 'NXT:1980Di',
      organizationName: '甲方默认组织',
      ingestMethod: 'ADMIN_DIRECT',
      caseHandlingStatus: 'IN_PROGRESS',
      createdByAccountId: 900001,
    });
    expect(page.items[1]).toMatchObject({
      id: 970003,
      equipmentModelId: null,
      equipmentModelName: null,
      caseHandlingStatus: null,
    });
    // 不携带 contentText 大字段与存储引用
    expect(page.items[0]).not.toHaveProperty('contentText');
    expect(page.items[0]).not.toHaveProperty('storageReference');
  });

  it('空列表不触发型号/组织/案例明细批量查询', async () => {
    const { modelRepo, organizationRepo, caseDetailRepo, service } = makeService();

    await service.listDocuments({ filter: {}, pagination, organizationId: ORG_ID });

    expect(modelRepo.find).not.toHaveBeenCalled();
    expect(organizationRepo.find).not.toHaveBeenCalled();
    expect(caseDetailRepo.find).not.toHaveBeenCalled();
  });

  it('详情返回完整元数据与文本内容、组织展示名、来源信息与案例明细；含内部装配字段 storageReference（DTO 视图由 usecase 剥离）', async () => {
    const { documentRepo, modelRepo, organizationRepo, caseDetailRepo, service } = makeService();
    documentRepo.findOne.mockResolvedValue(
      documentEntity({ storageBackend: 'LOCAL', storageReference: 'mock/reference/a.pdf' }),
    );
    modelRepo.findOne.mockResolvedValue(modelEntity());
    organizationRepo.findOne.mockResolvedValue(organizationEntity());
    caseDetailRepo.findOne.mockResolvedValue(caseDetailEntity());

    const detail = await service.findDetail({ documentId: 970001, organizationId: ORG_ID });

    // 详情读取以「主键 + 组织范围」为条件，跨组织行不可能被读出
    expect(documentRepo.findOne).toHaveBeenCalledWith({
      where: { id: 970001, ownerOrganizationId: ORG_ID },
    });
    expect(detail).toMatchObject({
      id: 970001,
      title: '错误码手册',
      equipmentModelName: 'NXT:1980Di',
      contentText: 'E-CHUCK-101',
      organizationName: '甲方默认组织',
      ingestMethod: 'ADMIN_DIRECT',
      caseDetail: {
        errorCode: 'E-CHUCK-101',
        handlingStatus: 'IN_PROGRESS',
        phenomenon: '晶圆吸附异常',
        reproductionSteps: '复现步骤',
        resolution: null,
      },
      createdByAccountId: 900001,
      hasFile: true,
    });
    expect(detail).not.toHaveProperty('storageBackend');
    // storageReference 为内部装配字段，仅供下载用例定位文件；对外 DTO 视图由 usecase 层剥离
    expect(detail).toHaveProperty('storageReference', 'mock/reference/a.pdf');
    // 案例明细不暴露内部扩展字段
    const caseDetail = detail.caseDetail as Record<string, unknown>;
    expect(caseDetail).not.toHaveProperty('casePayloadJson');
    expect(caseDetail).not.toHaveProperty('schemaVersion');
  });

  it('普通资料（无案例明细）详情 caseDetail 为 null，旧组件兼容', async () => {
    const { documentRepo, service } = makeService();
    documentRepo.findOne.mockResolvedValue(documentEntity());

    const detail = await service.findDetail({ documentId: 970001, organizationId: ORG_ID });

    expect(detail.caseDetail).toBeNull();
  });

  it('hasFile 权威判定 = 存储引用非空：有文件名但无存储引用的行 hasFile=false（不承诺可下载）', async () => {
    const { documentRepo, service } = makeService();
    documentRepo.findOne.mockResolvedValue(
      documentEntity({ originalFilename: 'legacy.pdf', mimeType: 'application/pdf' }),
    );

    const detail = await service.findDetail({ documentId: 970001, organizationId: ORG_ID });

    expect(detail).toMatchObject({ originalFilename: 'legacy.pdf', hasFile: false });
  });

  it('不存在、已软删与跨组织（where 未命中）详情统一 NOT_FOUND，不区分错误表述（防删除状态与存在性探测）', async () => {
    const { documentRepo, service } = makeService();

    await expect(
      service.findDetail({ documentId: 999999, organizationId: ORG_ID }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND,
      details: { id: 999999 },
    });

    documentRepo.findOne.mockResolvedValue(documentEntity({ deprecated: true }));
    await expect(
      service.findDetail({ documentId: 970004, organizationId: ORG_ID }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND,
    });

    // 跨组织：where 恒含 ownerOrganizationId，别的组织行读出必为 null → 同码 NOT_FOUND
    documentRepo.findOne.mockResolvedValue(null);
    await expect(
      service.findDetail({ documentId: 970001, organizationId: 910099 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
    expect(documentRepo.findOne).toHaveBeenLastCalledWith({
      where: { id: 970001, ownerOrganizationId: 910099 },
    });
  });

  it('findDetail 携带事务上下文时文档/组织/案例明细全部改用事务内 Repository 读取（写用例事务内读当前值）', async () => {
    const { documentRepo, organizationRepo, caseDetailRepo, modelRepo, service } = makeService();
    const transactionDocumentRepo = makeDocumentRepo();
    transactionDocumentRepo.findOne.mockResolvedValue(documentEntity());
    const transactionOrganizationRepo = makeOrganizationRepo();
    transactionOrganizationRepo.findOne.mockResolvedValue(organizationEntity());
    const transactionCaseDetailRepo = makeCaseDetailRepo();
    transactionCaseDetailRepo.findOne.mockResolvedValue(null);
    modelRepo.findOne.mockResolvedValue(modelEntity());
    const transactionContext = createTypeOrmPersistenceTransactionContext({
      getRepository: (entity: unknown) => {
        if (entity === OrganizationEntity) return transactionOrganizationRepo;
        if (entity === ReferenceDocumentCaseDetailEntity) return transactionCaseDetailRepo;
        return transactionDocumentRepo;
      },
    } as unknown as EntityManager);

    await service.findDetail({ documentId: 970001, organizationId: ORG_ID, transactionContext });

    expect(transactionDocumentRepo.findOne).toHaveBeenCalledTimes(1);
    expect(transactionOrganizationRepo.findOne).toHaveBeenCalledTimes(1);
    expect(transactionCaseDetailRepo.findOne).toHaveBeenCalledTimes(1);
    // 默认仓库不得被使用：事务内读取必须全部经由事务上下文
    expect(documentRepo.findOne).not.toHaveBeenCalled();
    expect(organizationRepo.findOne).not.toHaveBeenCalled();
    expect(caseDetailRepo.findOne).not.toHaveBeenCalled();
  });
});
