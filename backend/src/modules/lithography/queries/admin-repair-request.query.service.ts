// src/modules/lithography/queries/admin-repair-request.query.service.ts

import { DomainError, ADMIN_DOCUMENT_DATABASE_ERROR } from '@core/common/errors/domain-error';
import { isRepairRequestVisibleToAdminOrganization } from '@core/repair-request/policy/repair-request-admin-scope.policy';
import {
  parseRepairRequestHandlingResult,
  parseRepairRequestHandlingStatus,
} from '@core/repair-request/policy/repair-request-handling.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, In, IsNull, Raw, Repository } from 'typeorm';
import { EngineerResponseEntity } from '../entities/engineer-response.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from '../entities/repair-request-revision.entity';
import type {
  AdminListPagination,
  AdminRepairRequestListItemQueryResult,
  AdminRepairRequestListPage,
  AdminRepairRequestQueryFilter,
  AdminRepairRequestSummaryQueryResult,
} from '../admin-document-database.types';
import { RepairProcessEntryQueryService } from './repair-process-entry.query.service';

/** 列表固定排序：创建时间倒序，次级主键倒序（与既有维修申请读模型同口径） */
const LIST_ORDER = { createdAt: 'DESC', id: 'DESC' } as const;

/** 标题/编号模糊搜索：转义 LIKE 通配符，避免用户输入 % / _ 意外扩大匹配范围 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 管理员维修申请读侧查询服务（PR3 只读聚合）
 *
 * 职责范围：
 * - 全局未删除维修申请列表（分页 + 编号/机型/故障码/接单状态/时间范围筛选）
 * - 全局未删除维修申请摘要（单条详情入口）
 * - 设备型号名称与最新回复处理状态的批量装配（本域关联，避免逐行查询）
 *
 * 不包含（计划表 S2 分层边界）：
 * - 任何写入操作；
 * - 角色准入判定（由守卫与 usecase 的管理员权限断言决策）；
 * - 跨账户域读取（客户/工程师展示信息不在此富集：装配结果仅携带账号 ID，
 *   由 usecase 经账户域 QueryService 批量富集后对外输出）。
 */
@Injectable()
export class AdminRepairRequestQueryService {
  constructor(
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(EngineerResponseEntity)
    private readonly responseRepository: Repository<EngineerResponseEntity>,
    @InjectRepository(EquipmentModelEntity)
    private readonly equipmentModelRepository: Repository<EquipmentModelEntity>,
    @InjectRepository(RepairRequestRevisionEntity)
    private readonly revisionRepository: Repository<RepairRequestRevisionEntity>,
    private readonly repairProcessEntryQueryService: RepairProcessEntryQueryService,
  ) {}

  /**
   * 全局列表：默认仅未删除申请（与既有读模型口径一致），固定排序，OFFSET 分页。
   * 账号 ID 集合筛选由 usecase 解析后传入；空集合在进入查询前短路，不产生空 IN 查询。
   */
  async listAll(params: {
    filter?: AdminRepairRequestQueryFilter;
    pagination: AdminListPagination;
    /** 管理员工单组织范围：null 为一级（全公司），数字为二级（本公司） */
    organizationId: number | null;
  }): Promise<
    Omit<AdminRepairRequestListPage, 'items'> & { items: AdminRepairRequestListItemQueryResult[] }
  > {
    const filter = params.filter;
    if (filter?.customerAccountIds && filter.customerAccountIds.length === 0) {
      return this.emptyPage(params.pagination);
    }

    const where = this.buildListWhere(filter, params.organizationId);
    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);
    const [entities, total] = await Promise.all([
      this.requestRepository.find({
        where,
        order: LIST_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      params.pagination.withTotal
        ? this.requestRepository.count({ where })
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
   * 筛选条件收敛为 SQL where：全部筛选在 SQL 侧执行以保证分页正确性。
   *
   * 组织范围与详情共用 `resolveEffectiveServiceOrganizationId` 口径：
   * 优先 service_organization_id，缺失时回落 owner_organization_id。
   * 二级管理员（organizationId 非空）必须同时生成两个分支，否则会漏掉
   * 新列未回填的既有工单；一级管理员保持单条件全局查询。
   */
  private buildListWhere(
    filter: AdminRepairRequestQueryFilter | undefined,
    organizationId: number | null,
  ): FindOptionsWhere<RepairRequestEntity> | FindOptionsWhere<RepairRequestEntity>[] {
    const where: FindOptionsWhere<RepairRequestEntity> = { deprecated: false };
    if (filter?.requestNo) {
      where.requestNo = Raw((alias) => `${alias} LIKE :pattern`, {
        pattern: `%${escapeLikePattern(filter.requestNo)}%`,
      });
    }
    if (filter?.customerAccountIds) {
      where.customerAccountId = In([...filter.customerAccountIds]);
    }
    if (typeof filter?.equipmentModelId === 'number') {
      // R6 末端防御：仅真实 number 写入 where（显式 null 已在适配层规整为 undefined；
      // 若绕过适配层直达本层，null/undefined 一律视为未筛选，不生成 IS NULL 条件）
      where.equipmentModelId = filter.equipmentModelId;
    }
    if (filter?.errorCode) {
      where.errorCode = filter.errorCode;
    }
    if (typeof filter?.isAccepted === 'boolean') {
      // R6 末端防御：仅真实 boolean 写入 where（`false` 必须保留，禁止 truthy 过滤）
      where.isAccepted = filter.isAccepted;
    }
    this.applyCreatedAtRange(where, filter);
    if (organizationId === null) {
      return where;
    }
    return [
      { ...where, serviceOrganizationId: organizationId },
      { ...where, serviceOrganizationId: IsNull(), ownerOrganizationId: organizationId },
    ];
  }

  /** 时间范围筛选：区间端点缺省时收敛为开区间（下界取纪元，上界取当前时间） */
  private applyCreatedAtRange(
    where: FindOptionsWhere<RepairRequestEntity>,
    filter?: AdminRepairRequestQueryFilter,
  ): void {
    if (filter?.createdAtFrom || filter?.createdAtTo) {
      where.createdAt = Between(
        filter.createdAtFrom ?? new Date(0),
        filter.createdAtTo ?? new Date(),
      );
    }
  }

  /**
   * 未删除申请摘要（单条只读详情入口）。
   * 不存在与已删除统一 NOT_FOUND（与既有读模型口径一致，防删除状态探测）。
   *
   * 原件读取顺序：先完成二级管理员组织授权，再选择过程投影；
   * 无权路径只调用 `listByRequestTextOnly`，不读取 file_id/stored_file 元数据。
   *
   * @throws DomainError ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND（对外大类 NOT_FOUND）
   */
  async findSummaryById(
    requestId: number,
    organizationId: number | null,
  ): Promise<AdminRepairRequestSummaryQueryResult> {
    const entity = await this.requestRepository.findOne({ where: { id: requestId } });
    if (
      !entity ||
      entity.deprecated ||
      !isRepairRequestVisibleToAdminOrganization(entity, organizationId)
    ) {
      // details 仅含申请标识，不区分「不存在 / 已删除 / 越权」，防资源存在性探测
      throw new DomainError(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND, '维修申请不存在或不可访问', {
        requestId,
      });
    }

    // 原件组织授权必须先于任何原件标识/元数据读取：二级管理员不满足
    // service/intake 一致时只能执行仅过程文本投影，不得先联接 stored_file
    // 再在响应中隐藏。一级管理员无二级组织限制，直接走含原件事实的投影。
    // 一致性边界：授权事实（工单 service/intake 与组织范围）取自本次读取的
    // 工单/intake 快照；本读路径不开事务、不加锁，若这些列在读取后被外部改动，
    // 授权结论仍基于旧快照（与任务 11 下载读路径相同的快照边界）。
    const canExposeProcessFiles =
      organizationId === null
        ? true
        : await this.canExposeProcessFilesToAdmin(entity, organizationId);
    const processEntriesPromise = canExposeProcessFiles
      ? this.repairProcessEntryQueryService.listByRequest(entity.id)
      : this.repairProcessEntryQueryService.listByRequestTextOnly(entity.id);

    const [model, responses, processEntries, revisions] = await Promise.all([
      this.equipmentModelRepository.findOne({ where: { id: entity.equipmentModelId } }),
      this.responseRepository.find({
        where: { requestId: entity.id },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
      processEntriesPromise,
      this.revisionRepository.find({
        where: { requestId: entity.id },
        order: { revisionNo: 'DESC' },
      }),
    ]);

    return {
      id: entity.id,
      requestNo: entity.requestNo,
      customerAccountId: entity.customerAccountId,
      equipmentModel: this.toModelView(model),
      errorCode: entity.errorCode,
      faultDescription: entity.faultDescription,
      contentMd: entity.contentMd,
      createdAt: entity.createdAt,
      isAccepted: entity.isAccepted,
      acceptedAt: entity.acceptedAt,
      acceptedByEngineerAccountId: entity.acceptedByEngineerAccountId,
      latestResolutionStatus:
        responses.length > 0 ? responses[responses.length - 1].resolutionStatus : null,
      closureStatus: entity.closureStatus,
      closedAt: entity.closedAt,
      closureReason: entity.closureReason,
      handlingResult: parseRepairRequestHandlingResult(entity.handlingResult),
      handlingStatus: parseRepairRequestHandlingStatus(entity.handlingStatus),
      currentRevisionNo: entity.currentRevisionNo,
      responses: responses.map((response) => ({
        id: response.id,
        requestId: response.requestId,
        engineerAccountId: response.engineerAccountId,
        customerAccountId: response.customerAccountId,
        responseText: response.responseText,
        resolutionStatus: response.resolutionStatus,
        createdAt: response.createdAt,
      })),
      processEntries,
      revisions: revisions.map((revision) => ({
        revisionNo: revision.revisionNo,
        previousVersion: revision.previousVersion,
        reason: revision.reason,
        actorAccountId: revision.actorAccountId,
        createdAt: revision.createdAt,
      })),
    };
  }

  /** 管理员统计：与列表共用同一组织口径（null 全公司；数字为本公司） */
  /**
   * 二级管理员是否可见该工单的原件元数据。
   *
   * 与任务 11 `StoredFileQueryService.canAccessBoundAsAdmin` 同口径：
   * 工单 service 必须等于本公司、必须关联 intake，且 intake service 与工单一致。
   * 任一缺失或冲突失败关闭，不回退 owner。
   */
  private async canExposeProcessFilesToAdmin(
    entity: RepairRequestEntity,
    organizationId: number,
  ): Promise<boolean> {
    if (
      entity.serviceOrganizationId === null ||
      entity.serviceOrganizationId !== organizationId ||
      entity.intakeId === null
    ) {
      return false;
    }
    const intake = await this.requestRepository.manager
      .getRepository(RepairRequestIntakeEntity)
      .findOne({
        where: { id: entity.intakeId },
        select: { id: true, serviceOrganizationId: true },
      });
    return intake !== null && intake.serviceOrganizationId === organizationId;
  }

  async countAll(organizationId: number | null): Promise<number> {
    return this.requestRepository.count({ where: this.buildListWhere(undefined, organizationId) });
  }

  private emptyPage(pagination: AdminListPagination): Omit<AdminRepairRequestListPage, 'items'> & {
    items: AdminRepairRequestListItemQueryResult[];
  } {
    return {
      items: [],
      total: pagination.withTotal ? 0 : undefined,
      page: Math.max(pagination.page, 1),
      pageSize: Math.max(pagination.pageSize, 1),
    };
  }

  /**
   * 批量装配列表项：机型与最新回复处理状态一次批量读取，避免逐行查询
   */
  private async toListItemQueryResults(
    entities: RepairRequestEntity[],
  ): Promise<AdminRepairRequestListItemQueryResult[]> {
    if (entities.length === 0) {
      return [];
    }
    const modelIds = [...new Set(entities.map((entity) => entity.equipmentModelId))];
    const requestIds = entities.map((entity) => entity.id);
    const [models, latestStatusByRequestId] = await Promise.all([
      this.equipmentModelRepository.find({ where: { id: In(modelIds) } }),
      this.findLatestResolutionStatusByRequestIds(requestIds),
    ]);
    const modelById = new Map(models.map((model) => [model.id, model]));
    return entities.map((entity) => ({
      id: entity.id,
      requestNo: entity.requestNo,
      customerAccountId: entity.customerAccountId,
      equipmentModel: this.toModelView(modelById.get(entity.equipmentModelId)),
      errorCode: entity.errorCode,
      createdAt: entity.createdAt,
      isAccepted: entity.isAccepted,
      acceptedAt: entity.acceptedAt,
      acceptedByEngineerAccountId: entity.acceptedByEngineerAccountId,
      latestResolutionStatus: latestStatusByRequestId.get(entity.id) ?? null,
      closureStatus: entity.closureStatus,
      closedAt: entity.closedAt,
      handlingResult: parseRepairRequestHandlingResult(entity.handlingResult),
      handlingStatus: parseRepairRequestHandlingStatus(entity.handlingStatus),
    }));
  }

  /** 按申请维度取最新回复的处理状态（口径：创建时间倒序、主键倒序的末条，与既有读模型一致） */
  private async findLatestResolutionStatusByRequestIds(
    requestIds: number[],
  ): Promise<Map<number, EngineerResponseEntity['resolutionStatus']>> {
    const responses = await this.responseRepository.find({
      where: { requestId: In(requestIds) },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const latestByRequestId = new Map<number, EngineerResponseEntity['resolutionStatus']>();
    for (const response of responses) {
      if (!latestByRequestId.has(response.requestId)) {
        latestByRequestId.set(response.requestId, response.resolutionStatus);
      }
    }
    return latestByRequestId;
  }

  private toModelView(entity: EquipmentModelEntity | null | undefined): {
    id: number;
    modelCode: string;
    modelName: string;
  } {
    if (!entity) {
      // 外键保证申请必有型号；极端缺失时返回占位，避免单条记录整体不可读
      return { id: 0, modelCode: '', modelName: '' };
    }
    return {
      id: entity.id,
      modelCode: entity.modelCode,
      modelName: entity.modelName,
    };
  }
}
