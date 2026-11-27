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
import { ReferenceDocumentRevisionEntity } from '../entities/reference-document-revision.entity';
import { ReferenceDocumentEntity } from '../entities/reference-document.entity';
import {
  ReferenceDocumentCaseDetailView,
  ReferenceDocumentDetailQueryResult,
  ReferenceDocumentListFilter,
  ReferenceDocumentListPage,
  ReferenceDocumentListPagination,
  ReferenceDocumentListItemQueryResult,
  ReferenceDocumentReadScope,
  ReferenceDocumentRevisionSummaryView,
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
 * 修订快照 JSON 解析：列类型为 longtext，解析失败按空对象处理。
 * 调用方只读取白名单键（正文等），不把原始 JSON 透传给客户端。
 */
function parseSnapshotJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
 * 历史维修记录读侧查询服务
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
    @InjectRepository(ReferenceDocumentRevisionEntity)
    private readonly revisionRepository: Repository<ReferenceDocumentRevisionEntity>,
  ) {}

  /**
   * 普通资料库可见谓词（列表 / 详情 / 下载 / 历史版本共用，服务端唯一真源）：
   * 未软删 + 已上架（ONLINE）+ 归属已确认（CONFIRMED），组织范围由调用方按可信会话传入。
   *
   * 未知归属（PENDING，owner_organization_id 可为空）不得出现在普通列表；
   * 下架与软删同样从列表、详情和旧下载地址统一不可见（统一 NOT_FOUND 防探测）；
   * 他人未提交草稿不在本表，不因本范围可见。
   */
  private buildLibraryVisibilityWhere(
    scope: ReferenceDocumentReadScope,
  ): FindOptionsWhere<ReferenceDocumentEntity> {
    const where: FindOptionsWhere<ReferenceDocumentEntity> = {
      deprecated: false,
      publicationStatus: 'ONLINE',
      ownershipStatus: 'CONFIRMED',
    };
    if (scope.kind === 'ORGANIZATION') {
      where.ownerOrganizationId = scope.organizationId;
    }
    return where;
  }

  /**
   * 写路径谓词：仅未软删 + 范围收敛（不按上架/归属确认收紧）。
   * 下架资料仍允许管理员或原作者执行删除等管理动作，但跨公司一律不可见；
   * 写路径与工程师/二级管理员读取始终传入具体组织 ID。
   * AUTHOR 范围（任务 07 R053）：仅原作者本人条目，不按组织收敛。
   */
  private buildWritePathWhere(
    scope: ReferenceDocumentReadScope,
  ): FindOptionsWhere<ReferenceDocumentEntity> {
    const where: FindOptionsWhere<ReferenceDocumentEntity> = { deprecated: false };
    if (scope.kind === 'ORGANIZATION') {
      where.ownerOrganizationId = scope.organizationId;
    } else if (scope.kind === 'AUTHOR') {
      where.createdByAccountId = scope.accountId;
    }
    return where;
  }

  /**
   * 普通资料库列表：未软删 + 已上架 + 归属已确认，组织范围由 scope 决定
   * （ORGANIZATION = 本公司；GLOBAL = 一级管理员全范围），固定排序，OFFSET 分页。
   * 列表项为昵称富集前装配结果，由 usecase 富集创建人昵称后对外输出。
   *
   * 范围必须由 usecase 按可信会话与管理员等级解析后传入（A-PR0 §2.1），本层不信任客户端自报。
   */
  async listDocuments(params: {
    filter: ReferenceDocumentListFilter;
    pagination: ReferenceDocumentListPagination;
    scope: ReferenceDocumentReadScope;
  }): Promise<
    Omit<ReferenceDocumentListPage, 'items'> & { items: ReferenceDocumentListItemQueryResult[] }
  > {
    const where: FindOptionsWhere<ReferenceDocumentEntity> = this.buildLibraryVisibilityWhere(
      params.scope,
    );
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
   * 归属待核实清单（任务 07 R061-01，一级管理员专用入口）：
   * ownership_status = PENDING 且未软删，不按组织收敛、不筛选发布状态——
   * PENDING 是本清单唯一业务筛选维度（下架条目仍可经归属更正写路径读取）；
   * 软删行统一排除。范围恒为全公司，准入由调用 usecase 的一级管理员事实复核保证，
   * 本层不信任客户端自报；普通资料库列表（listDocuments）不读取本方法。
   *
   * 固定排序与分页口径同 listDocuments；列表项为昵称富集前装配结果。
   */
  async listPendingOwnershipDocuments(params: {
    pagination: ReferenceDocumentListPagination;
  }): Promise<
    Omit<ReferenceDocumentListPage, 'items'> & { items: ReferenceDocumentListItemQueryResult[] }
  > {
    const where: FindOptionsWhere<ReferenceDocumentEntity> = {
      deprecated: false,
      ownershipStatus: 'PENDING',
    };

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
   * 不存在、已软删与跨范围统一拒绝（统一 NOT_FOUND，不泄露删除状态与存在性）。
   * GLOBAL 仅表示读侧范围决议已判定的「一级管理员全范围」
   * （功能 V5.6 R055-02；见 reference-document-read-scope.ts），不按组织过滤；
   * 写路径锁定读始终传入具体范围，归属收窄语义不变。
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
    scope: ReferenceDocumentReadScope;
    transactionContext?: PersistenceTransactionContext;
    forUpdate?: boolean;
    /**
     * 写路径（编辑 / 下架 / 删除）复用本入口时置 true：仅放宽「上架 + 归属已确认」
     * 两个可见性谓词，组织范围仍由 scope 强制，已软删行仍统一 NOT_FOUND。
     * 读路径不得开启，避免下架资料经旧地址泄露。
     */
    includeUnpublished?: boolean;
  }): Promise<ReferenceDocumentDetailQueryResult> {
    const documentRepository = this.getDocumentRepository(params.transactionContext);
    const documentWhere: FindOptionsWhere<ReferenceDocumentEntity> = params.includeUnpublished
      ? this.buildWritePathWhere(params.scope)
      : this.buildLibraryVisibilityWhere(params.scope);
    documentWhere.id = params.documentId;
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
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问', {
        id: params.documentId,
      });
    }

    const model = entity.equipmentModelId
      ? await this.equipmentModelRepository.findOne({ where: { id: entity.equipmentModelId } })
      : null;
    const organization =
      entity.ownerOrganizationId === null
        ? null
        : await this.getOrganizationRepository(params.transactionContext).findOne({
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
      sourceKind: entity.sourceKind,
      sourceReportId: entity.sourceReportId,
      sourceReportVersionId: entity.sourceReportVersionId,
      publicationStatus: entity.publicationStatus,
      ownershipStatus: entity.ownershipStatus,
      effectiveRevisionNo: entity.currentRevisionNo,
      schemaVersion: entity.schemaVersion,
      caseDetail: caseDetail ? this.toCaseDetailView(caseDetail) : null,
      createdByAccountId: entity.createdByAccountId,
      ownerOrganizationId: entity.ownerOrganizationId,
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

  /**
   * 资料生效修订历史（升序）：摘要字段 + 该版本生效正文（after_snapshot 内容键）。
   *
   * 快照 JSON 整体（before/after）不对外输出；contentText 为授权追溯旧版本
   * 内容所需的最小读取（V5.6 版本追溯）。可见性由调用方先经 findDetail 校验
   * （不存在 / 下架 / 软删 / 跨公司统一 NOT_FOUND），本方法不再单独判断范围，
   * 避免两套口径。
   */
  async listRevisions(documentId: number): Promise<ReferenceDocumentRevisionSummaryView[]> {
    const rows = await this.revisionRepository.find({
      where: { documentId },
      order: { revisionNo: 'ASC' },
    });
    return rows.map((row) => {
      const afterSnapshot = parseSnapshotJson(row.afterSnapshot);
      const contentText = afterSnapshot.contentText;
      return {
        revisionNo: row.revisionNo,
        reason: row.reason,
        actorAccountId: row.actorAccountId,
        createdAt: row.createdAt,
        contentText: typeof contentText === 'string' ? contentText : null,
      };
    });
  }

  /** 指定生效修订号的管理修订快照（生效正文来源为 CURRENT_REVISION 时使用） */
  async findRevision(
    documentId: number,
    revisionNo: number,
  ): Promise<{ revisionNo: number; afterSnapshot: Record<string, unknown> } | null> {
    const row = await this.revisionRepository.findOne({ where: { documentId, revisionNo } });
    if (!row) return null;
    return { revisionNo: row.revisionNo, afterSnapshot: parseSnapshotJson(row.afterSnapshot) };
  }

  /**
   * 报告来源资料已发布的正式资料标识（批量；本人记录列表据此提供「查看成品」入口）。
   *
   * 只返回普通资料库可见的行（未软删 + ONLINE），避免下架/删除资料成为可点击入口；
   * 传入 ownerOrganizationId 时按普通资料库同一组织谓词收敛，与详情读侧口径一致
   * （归属更正迁出后旧公司不再出现可点击入口，点击后的详情授权同样拒绝）。
   */
  async listPublishedDocumentIdsByReportIds(
    reportIds: readonly number[],
    ownerOrganizationId?: number,
  ): Promise<Map<number, number>> {
    const uniqueReportIds = [...new Set(reportIds)].filter(
      (reportId) => Number.isInteger(reportId) && reportId > 0,
    );
    if (uniqueReportIds.length === 0) return new Map();
    const organizationPredicate =
      ownerOrganizationId !== undefined &&
      Number.isInteger(ownerOrganizationId) &&
      ownerOrganizationId > 0
        ? { ownerOrganizationId }
        : {};
    const rows = await this.documentRepository.find({
      where: {
        sourceReportId: In(uniqueReportIds),
        deprecated: false,
        publicationStatus: 'ONLINE',
        ...organizationPredicate,
      },
      select: { id: true, sourceReportId: true },
    });
    const documentIdByReportId = new Map<number, number>();
    for (const row of rows) {
      if (row.sourceReportId !== null) {
        documentIdByReportId.set(row.sourceReportId, row.id);
      }
    }
    return documentIdByReportId;
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

    const organizationIds = [
      ...new Set(entities.map((entity) => entity.ownerOrganizationId)),
    ].filter((id): id is number => id !== null);
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
        entity.ownerOrganizationId === null
          ? UNKNOWN_ORGANIZATION_NAME
          : (nameByOrganizationId.get(entity.ownerOrganizationId) ?? UNKNOWN_ORGANIZATION_NAME),
      ingestMethod: entity.ingestMethod,
      sourceKind: entity.sourceKind,
      effectiveRevisionNo: entity.currentRevisionNo,
      // 案例处理状态来自案例明细（普通资料无明细，恒为 null）；列表不携带案例大段正文
      caseHandlingStatus: handlingStatusByDocumentId.get(entity.id) ?? null,
      createdByAccountId: entity.createdByAccountId,
      createdAt: entity.createdAt,
    }));
  }
}
