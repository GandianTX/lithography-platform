// src/modules/lithography/queries/content-submission.query.service.spec.ts

/// <reference types="jest" />
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { DataSource, type EntityManager, type FindOptionsOrder, type Repository } from 'typeorm';

import { AccountEntity } from '@modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@modules/account/base/entities/user-info.entity';

import { ContentSubmissionAttachmentEntity } from '../entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from '../entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from '../entities/content-submission-review.entity';
import { ContentSubmissionRevisionEntity } from '../entities/content-submission-revision.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { FaultCaseSubmissionDetailEntity } from '../entities/fault-case-submission-detail.entity';
import { MaterialSubmissionDetailEntity } from '../entities/material-submission-detail.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { ReferenceDocumentEntity } from '../entities/reference-document.entity';
import {
  ContentSubmissionQueryService,
  MINE_LIST_ORDER,
  REVIEW_LIST_ORDER,
} from './content-submission.query.service';

/**
 * 审核队列/本人列表排序字段验证（F1 修复配套）：
 *
 * 不使用 mock repository：直接加载真实 ContentSubmissionEntity 元数据构造
 * QueryBuilder.setFindOptions()，不建立数据库连接也能校验排序属性存在性
 * （TypeORM 在构造查询时即对 FindOptions 的 order 属性做强校验）。
 *
 * buildMetadatas() 是 DataSource 内部构建步骤（protected）：initialize() 会
 * 连带建立连接，本测试只需要元数据，因此显式调用该步骤而不初始化连接。
 */
type MetadataOnlyDataSource = DataSource & { buildMetadatas(): Promise<void> };

describe('ContentSubmissionQueryService 固定排序字段（真实 Entity 元数据）', () => {
  let dataSource: DataSource;
  let repository: Repository<ContentSubmissionEntity>;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'mysql',
      // 仅用于通过实体元数据校验，不建立连接、不访问数据库
      database: 'metadata-only-validation',
      // ContentSubmissionEntity 的 @ForeignKey 引用了组织/账号实体；账号实体又含
      // userInfo 反向关系，需一并注册才能完成元数据构建
      entities: [ContentSubmissionEntity, OrganizationEntity, AccountEntity, UserInfoEntity],
      synchronize: false,
    });
    // 仅构建元数据；不调用 initialize()，不访问任何数据库
    await (dataSource as MetadataOnlyDataSource).buildMetadatas();
    repository = dataSource.getRepository(ContentSubmissionEntity);
  });

  it('F1 复现锚点：旧排序字段 submittedAt 在真实实体上构造查询即失败', () => {
    expect(() =>
      repository
        .createQueryBuilder('submission')
        .setFindOptions({
          // 模拟修复前的运行时数据（该属性不存在于实体，编译期由下方类型断言绕过还原）
          order: {
            submittedAt: 'DESC',
            id: 'DESC',
          } as unknown as FindOptionsOrder<ContentSubmissionEntity>,
        })
        .getSql(),
    ).toThrow(/Property "submittedAt" was not found in "ContentSubmissionEntity"/);
  });

  it('审核队列排序常量有效：按 last_submitted_at DESC, id DESC 生成 SQL', () => {
    const sql = repository
      .createQueryBuilder('submission')
      .setFindOptions({ order: REVIEW_LIST_ORDER })
      .getSql();

    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('last_submitted_at` DESC');
    expect(sql).toContain('`submission`.`id` DESC');
  });

  it('本人列表排序常量有效：按 updated_at DESC, id DESC 生成 SQL', () => {
    const sql = repository
      .createQueryBuilder('submission')
      .setFindOptions({ order: MINE_LIST_ORDER })
      .getSql();

    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('updated_at` DESC');
    expect(sql).toContain('`submission`.`id` DESC');
  });
});

/** 事务 manager / Repository 替身：只记录调用，不访问数据库 */
type FakeRepository = {
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
};

const createFakeRepository = (findOneResult: unknown = null): FakeRepository => ({
  findOne: jest.fn().mockResolvedValue(findOneResult),
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
});

const createFakeManager = (repositories: ReadonlyMap<unknown, FakeRepository>) => {
  const getRepository = jest.fn((target: unknown) => {
    const repository = repositories.get(target);
    if (!repository) {
      throw new Error(`未配置事务假仓库: ${target as string}`);
    }
    return repository;
  });
  return { manager: { getRepository } as unknown as EntityManager, getRepository };
};

const buildService = (): ContentSubmissionQueryService =>
  new ContentSubmissionQueryService(
    null as unknown as Repository<ContentSubmissionEntity>,
    null as unknown as Repository<MaterialSubmissionDetailEntity>,
    null as unknown as Repository<FaultCaseSubmissionDetailEntity>,
    null as unknown as Repository<EquipmentModelEntity>,
    null as unknown as Repository<ContentSubmissionAttachmentEntity>,
    null as unknown as Repository<ContentSubmissionReviewEntity>,
    null as unknown as Repository<ContentSubmissionRevisionEntity>,
    null as unknown as Repository<ReferenceDocumentEntity>,
  );

describe('ContentSubmissionQueryService R01 写前当前读锁契约', () => {
  it('资料明细写前读取使用传入事务 manager，且 lock.mode 为 pessimistic_write', async () => {
    const detailRepository = createFakeRepository({
      title: '标题',
      documentType: null,
      equipmentModelId: null,
      equipmentModelText: null,
      description: null,
      contentText: null,
    });
    const { manager, getRepository } = createFakeManager(
      new Map([[MaterialSubmissionDetailEntity, detailRepository]]),
    );
    const transactionContext = createTypeOrmPersistenceTransactionContext(manager);

    const result = await buildService().readMaterialDetailForWrite({
      submissionId: 970001,
      transactionContext,
    });

    expect(result).toMatchObject({ title: '标题' });
    expect(getRepository).toHaveBeenCalledWith(MaterialSubmissionDetailEntity);
    expect(detailRepository.findOne).toHaveBeenCalledTimes(1);
    expect(detailRepository.findOne).toHaveBeenCalledWith({
      where: { submissionId: 970001 },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('案例明细写前读取使用传入事务 manager，且 lock.mode 为 pessimistic_write', async () => {
    const detailRepository = createFakeRepository({
      title: '案例',
      equipmentModelId: null,
      equipmentModelText: null,
      errorCode: null,
      phenomenon: '现象',
      conditionText: null,
      reproductionSteps: '步骤',
      diagnosis: null,
      actionTaken: null,
      handlingStatus: 'UNRESOLVED',
      resolution: null,
    });
    const { manager, getRepository } = createFakeManager(
      new Map([[FaultCaseSubmissionDetailEntity, detailRepository]]),
    );
    const transactionContext = createTypeOrmPersistenceTransactionContext(manager);

    const result = await buildService().readFaultCaseDetailForWrite({
      submissionId: 970001,
      transactionContext,
    });

    expect(result).toMatchObject({ title: '案例' });
    expect(getRepository).toHaveBeenCalledWith(FaultCaseSubmissionDetailEntity);
    expect(detailRepository.findOne).toHaveBeenCalledWith({
      where: { submissionId: 970001 },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('送审附件当前读使用传入事务 manager，按 CURRENT 读取并加 pessimistic_write', async () => {
    const attachmentRepository = createFakeRepository({ id: 980001 });
    const { manager, getRepository } = createFakeManager(
      new Map([[ContentSubmissionAttachmentEntity, attachmentRepository]]),
    );
    const transactionContext = createTypeOrmPersistenceTransactionContext(manager);

    const result = await buildService().readCurrentAttachmentsForSubmit({
      submissionId: 970001,
      transactionContext,
    });

    expect(result).toEqual({ attachmentId: 980001 });
    expect(getRepository).toHaveBeenCalledWith(ContentSubmissionAttachmentEntity);
    expect(attachmentRepository.findOne).toHaveBeenCalledWith({
      where: { submissionId: 970001, status: 'CURRENT' },
      select: { id: true },
      order: { id: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  const withoutTransactionInvocations: ReadonlyArray<
    [string, (service: ContentSubmissionQueryService) => Promise<unknown>]
  > = [
    [
      'readMaterialDetailForWrite',
      (service) =>
        service.readMaterialDetailForWrite({
          submissionId: 970001,
          transactionContext: undefined as unknown as PersistenceTransactionContext,
        }),
    ],
    [
      'readFaultCaseDetailForWrite',
      (service) =>
        service.readFaultCaseDetailForWrite({
          submissionId: 970001,
          transactionContext: undefined as unknown as PersistenceTransactionContext,
        }),
    ],
    [
      'readCurrentAttachmentsForSubmit',
      (service) =>
        service.readCurrentAttachmentsForSubmit({
          submissionId: 970001,
          transactionContext: undefined as unknown as PersistenceTransactionContext,
        }),
    ],
  ];

  it.each(withoutTransactionInvocations)(
    '%s 无有效事务上下文时 fail-closed，不允许无事务调用',
    async (_name, invoke) => {
      await expect(invoke(buildService())).rejects.toThrow(
        'Invalid TypeORM persistence transaction context',
      );
    },
  );

  it('W08 普通详情读取保持无锁（不因写前当前读给共享读取加锁）', async () => {
    const submissionRepository = createFakeRepository({
      id: 970001,
      submissionKind: 'MATERIAL',
      status: 'DRAFT',
      currentRevisionNo: 0,
      lastSubmittedAt: null,
      publishedAt: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const detailRepository = createFakeRepository({
      title: '标题',
      documentType: 'MANUAL',
      equipmentModelId: null,
      equipmentModelText: null,
      description: null,
      contentText: '正文',
    });
    const equipmentModelRepository = createFakeRepository(null);
    const attachmentRepository = createFakeRepository(null);
    const reviewRepository = createFakeRepository(null);
    const referenceDocumentRepository = createFakeRepository(null);
    const repositories = new Map<unknown, FakeRepository>([
      [ContentSubmissionEntity, submissionRepository],
      [MaterialSubmissionDetailEntity, detailRepository],
      [EquipmentModelEntity, equipmentModelRepository],
      [ContentSubmissionAttachmentEntity, attachmentRepository],
      [ContentSubmissionReviewEntity, reviewRepository],
      [ReferenceDocumentEntity, referenceDocumentRepository],
    ]);
    const { manager } = createFakeManager(repositories);
    const transactionContext = createTypeOrmPersistenceTransactionContext(manager);

    const detail = await buildService().findMineDetail({
      submissionId: 970001,
      submittedByAccountId: 900001,
      ownerOrganizationId: 910001,
      transactionContext,
    });

    expect(detail.material?.title).toBe('标题');
    const allOptions = Array.from(repositories.values()).flatMap((repository) => [
      ...repository.findOne.mock.calls.map((call) => call[0] as Record<string, unknown>),
      ...repository.find.mock.calls.map((call) => call[0] as Record<string, unknown>),
    ]);
    expect(allOptions.length).toBeGreaterThan(0);
    for (const options of allOptions) {
      expect(options).not.toHaveProperty('lock');
    }
  });
});
