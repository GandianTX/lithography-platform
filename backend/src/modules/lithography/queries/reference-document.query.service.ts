// src/modules/lithography/queries/reference-document.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { FindOptionsWhere, In, Raw, Repository } from 'typeorm';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { ReferenceDocumentCaseDetailEntity } from '../entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from '../entities/reference-document.entity';
import {
  ReferenceDocumentCaseDetailView,
  ReferenceDocumentDetailQueryResult,
  ReferenceDocumentListFilter,
  ReferenceDocumentListPage,
  ReferenceDocumentListPagination,
  ReferenceDocumentListItemQueryResult,
} from '../lithography.types';

/** 列表固定排序：创建时间倒序，次级主键倒序（与维修申请读模型同口径） */
const LIST_ORDER = { createdAt: 'DESC', id: 'DESC' } as const;

/** 组织展示名缺失时的展示回落（与创建人昵称「未知用户」同口径，FK 保证实际不会发生） */
const UNKNOWN_ORGANIZATION_NAME = '未知组织';

/** 标题模糊搜索：转义 LIKE 通配符，避免用户输入 % / _ 意外扩大匹配范围 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * FAULT_CASE 保留类型判定（与 usecases 层 normalize 同口径：大小写不敏感，
 * 与数据库列排序规则 utf8mb4_0900_ai_ci 一致）——锁定读仅对「案例明细定式」
 * 的案例类型继续锁定明细行，普通资料不触发明细间隙锁。
 */
function isFaultCaseType(documentType: string): boolean {
  return documentType.trim().toUpperCase() === 'FAULT_CASE';
}

/**
 * AI 参考资料读侧查询服务
 *
 * 职责范围：
 * - 未软删、本组织（owner_organization_id）资料列表（分页 + 标题模糊搜索 +
 *   文档类型等值 + 设备型号等值 + 案例处理状态筛选）
 * - 未软删、本组织资料详情（完整元数据 + 文本内容 + 案例明细）
 * - 列表批量装配设备型号名称/组织展示名/案例处理状态，避免逐行查询
 *
 * 不包含：
 * - 角色准入判定（读准入 ENGINEER/SUPER_ADMIN 由守卫与 usecase 决策）
 * - 组织解析（可信组织上下文由 usecase 经 TrustedOrganizationContextQueryService 决议后传入）
 * - 任何写入（创建/编辑/软删除由写服务与各自 Usecase 编排）
 * - 创建人昵称富集（装配结果含 createdByAccountId，由 usecase 跨域关联账号域昵称后对外输出）
 * - 存储引用与服务器路径输出（storageBackend/storageReference 不进入任何对外视图）
 */
@Injectable()
export class ReferenceDocumentQueryService {
  constructor(
    @InjectRepository(ReferenceDocumentEntity)
    private readonly documentRepository: Repository<ReferenceDocumentEntity>,
    @InjectRepository(EquipmentModelEntity)
    private readonly equipmentModelRepository: Repository<EquipmentModelEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,
    @InjectRepository(ReferenceDocumentCaseDetailEntity)
    private readonly caseDetailRepository: Repository<ReferenceDocumentCaseDetailEntity>,
  ) {}

  /**
   * 本组织未软删资料列表：默认过滤已软删（deprecated = 0）与组织范围（owner_organization_id），
   * 固定排序，OFFSET 分页。列表项为昵称富集前装配结果，由 usecase 富集创建人昵称后对外输出。
   *
   * 组织范围必须由 usecase 经可信组织上下文解析后传入（A-PR0 §2.1），本层不信任客户端自报。
   */
  async listDocuments(params: {
    filter: ReferenceDocumentListFilter;
    pagination: ReferenceDocumentListPagination;
    organizationId: number;
  }): Promise<
    Omit<ReferenceDocumentListPage, 'items'> & { items: ReferenceDocumentListItemQueryResult[] }
  > {
    const where: FindOptionsWhere<ReferenceDocumentEntity> = {
      deprecated: false,
      ownerOrganizationId: params.organizationId,
    };
    if (params.filter.title) {
      where.title = Raw((alias) => `${alias} LIKE :pattern`, {
        pattern: `%${escapeLikePattern(params.filter.title)}%`,
      });
    }
    if (params.filter.documentType) {
      where.documentType = params.filter.documentType;
    }
    if (params.filter.equipmentModelId !== undefined) {
      where.equipmentModelId = params.filter.equipmentModelId;
    }
    if (params.filter.caseHandlingStatus) {
      // 案例处理状态筛选：EXISTS 命中案例明细（普通资料无明细必然不命中），
      // 筛选值恒以参数注入（防注入），明细表名与列名为本服务固定字面量
      where.id = Raw(
        (alias) =>
          `EXISTS (SELECT 1 FROM reference_document_case_detail cd WHERE cd.document_id = ${alias} AND cd.handling_status = :caseHandlingStatus)`,
        { caseHandlingStatus: params.filter.caseHandlingStatus },
      );
    }

    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);
    const [entities, total] = await Promise.all([
      this.documentRepository.find({
        where,
        order: LIST_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      params.pagination.withTotal
        ? this.documentRepository.count({ where })
        : Promise.resolve(undefined),
    ]);
    return {
      items: await this.toListItemQueryResults(entities),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 本组织未软删资料详情：完整元数据 + 文本内容 + 案例明细
   *
   * 不存在、已软删与跨组织统一拒绝（统一 NOT_FOUND，不泄露删除状态与存在性）。
   * 携带 transactionContext 时改用事务内 EntityManager 的 Repository。
   *
   * 锁定读（G2/F01）：`forUpdate: true` 时对主资料行与案例明细行依次执行
   * `SELECT ... FOR UPDATE`（InnoDB 当前读：不受 REPEATABLE READ 旧事务快照
   * 影响，且与其他写事务的行锁互斥），固定锁顺序「主资料 → 案例明细」防死锁；
   * 更正与通用编辑两个写入口通过本入口建立同一资源互斥，避免「读-改-写」
   * 快照交错导致的全量覆盖丢补丁。锁保持到调用方事务结束（rollback/commit
   * 由调用方的 TransactionRunner 负责），本服务不持有锁生命周期。
   * 普通读路径（读详情/软删除核验等）保持原行为，不加锁。
   *
   * @throws DomainError REFERENCE_DOCUMENT_ERROR.NOT_FOUND（大类码 NOT_FOUND）
   */
  async findDetail(params: {
    documentId: number;
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
    forUpdate?: boolean;
  }): Promise<ReferenceDocumentDetailQueryResult> {
    const documentRepository = this.getDocumentRepository(params.transactionContext);
    const documentWhere = { id: params.documentId, ownerOrganizationId: params.organizationId };
    // 锁定读的 where 不含 deprecated：已软删行同样被锁定（与并发软删除写互斥），
    // 软删状态由下方判定统一拒绝——避免「拿到锁却仍按旧快照看到未软删」的穿透
    const entity =
      params.forUpdate === true
        ? await documentRepository.findOne({
            where: documentWhere,
            lock: { mode: 'pessimistic_write' },
          })
        : await documentRepository.findOne({ where: documentWhere });
    if (!entity || entity.deprecated) {
      // details 仅含资料标识，不区分「不存在」「已软删」「跨组织」，防删除状态与存在性探测
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: params.documentId,
      });
    }

    const model = entity.equipmentModelId
      ? await this.equipmentModelRepository.findOne({ where: { id: entity.equipmentModelId } })
      : null;
    const organization = await this.getOrganizationRepository(params.transactionContext).findOne({
      where: { id: entity.ownerOrganizationId },
    });
    const caseDetailRepository = this.getCaseDetailRepository(params.transactionContext);
    const caseDetail =
      params.forUpdate === true && isFaultCaseType(entity.documentType)
        ? await caseDetailRepository.findOne({
            where: { documentId: entity.id },
            lock: { mode: 'pessimistic_write' },
          })
        : await caseDetailRepository.findOne({ where: { documentId: entity.id } });

    return {
      id: entity.id,
      title: entity.title,
      documentType: entity.documentType,
      equipmentModelId: entity.equipmentModelId,
      equipmentModelName: model?.modelName ?? null,
      equipmentModelText: entity.equipmentModelText,
      description: entity.description,
      originalFilename: entity.originalFilename,
      mimeType: entity.mimeType,
      // 「有文件」权威判定（= storageReference 非空）：前端下载按钮与编辑放行均以本字段为准，
      // 不再从 originalFilename 推断——有文件名但无存储引用的行（如 seed/legacy）不承诺可下载
      hasFile: entity.storageReference !== null,
      contentText: entity.contentText,
      organizationName: organization?.name ?? UNKNOWN_ORGANIZATION_NAME,
      ingestMethod: entity.ingestMethod,
      caseDetail: caseDetail ? this.toCaseDetailView(caseDetail) : null,
      createdByAccountId: entity.createdByAccountId,
      // 内部装配字段：仅供下载用例定位存储对象，不进入对外 DTO
      storageReference: entity.storageReference,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  /**
   * 正式资料占用核查（带文件创建失败补偿专用，G1/F02）：按精确 storage_reference 计数。
   *
   * 刻意不过滤 deprecated：软删资料仍保留文件引用，行存在即视为占用——
   * 补偿删除只允许发生在「确认回滚且未被任何正式资料引用」时。
   * 刻意不提供 transactionContext 参数：失败补偿必须通过独立于失败事务的
   * 读取获得「已提交事实」，禁止复用失败事务上下文。返回 false 只代表
   * 「此刻无引用」，是否作为终局回滚证据由 usecase 结合事务阶段裁决。
   */
  async isStorageReferenceReferenced(storageReference: string): Promise<boolean> {
    const count = await this.documentRepository.count({ where: { storageReference } });
    return count > 0;
  }

  /** 事务上下文存在时改用事务内 EntityManager 的 Repository（与 EquipmentModelQueryService 同模式） */
  private getDocumentRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(ReferenceDocumentEntity) : this.documentRepository;
  }

  private getOrganizationRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<OrganizationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(OrganizationEntity) : this.organizationRepository;
  }

  private getCaseDetailRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentCaseDetailEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ReferenceDocumentCaseDetailEntity)
      : this.caseDetailRepository;
  }

  /** 案例明细实体 → 对外稳定读视图（不暴露 casePayloadJson / schemaVersion） */
  private toCaseDetailView(
    entity: ReferenceDocumentCaseDetailEntity,
  ): ReferenceDocumentCaseDetailView {
    return {
      errorCode: entity.errorCode,
      handlingStatus: entity.handlingStatus,
      phenomenon: entity.phenomenon,
      conditionText: entity.conditionText,
      reproductionSteps: entity.reproductionSteps,
      diagnosis: entity.diagnosis,
      actionTaken: entity.actionTaken,
      resolution: entity.resolution,
    };
  }

  /** 批量装配列表项：设备型号名称/组织展示名/案例处理状态各一次批量读取，避免逐行查询 */
  private async toListItemQueryResults(
    entities: ReferenceDocumentEntity[],
  ): Promise<ReferenceDocumentListItemQueryResult[]> {
    if (entities.length === 0) {
      return [];
    }
    const modelIds = [
      ...new Set(
        entities.map((entity) => entity.equipmentModelId).filter((id): id is number => id !== null),
      ),
    ];
    const models = modelIds.length
      ? await this.equipmentModelRepository.find({ where: { id: In(modelIds) } })
      : [];
    const nameByModelId = new Map(models.map((model) => [model.id, model.modelName]));

    const organizationIds = [...new Set(entities.map((entity) => entity.ownerOrganizationId))];
    const organizations = await this.organizationRepository.find({
      where: { id: In(organizationIds) },
    });
    const nameByOrganizationId = new Map(
      organizations.map((organization) => [organization.id, organization.name]),
    );

    const caseDetails = await this.caseDetailRepository.find({
      where: { documentId: In(entities.map((entity) => entity.id)) },
    });
    const handlingStatusByDocumentId = new Map(
      caseDetails.map((caseDetail) => [caseDetail.documentId, caseDetail.handlingStatus]),
    );

    return entities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      documentType: entity.documentType,
      equipmentModelId: entity.equipmentModelId,
      equipmentModelName: entity.equipmentModelId
        ? (nameByModelId.get(entity.equipmentModelId) ?? null)
        : null,
      equipmentModelText: entity.equipmentModelText,
      description: entity.description,
      originalFilename: entity.originalFilename,
      organizationName:
        nameByOrganizationId.get(entity.ownerOrganizationId) ?? UNKNOWN_ORGANIZATION_NAME,
      ingestMethod: entity.ingestMethod,
      // 案例处理状态来自案例明细（普通资料无明细，恒为 null）；列表不携带案例大段正文
      caseHandlingStatus: handlingStatusByDocumentId.get(entity.id) ?? null,
      createdByAccountId: entity.createdByAccountId,
      createdAt: entity.createdAt,
    }));
  }
}
