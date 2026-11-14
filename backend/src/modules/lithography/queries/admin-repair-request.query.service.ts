// src/modules/lithography/queries/admin-repair-request.query.service.ts

import { DomainError, ADMIN_DOCUMENT_DATABASE_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, In, Raw, Repository } from 'typeorm';
import { EngineerResponseEntity } from '../entities/engineer-response.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import type {
  AdminListPagination,
  AdminRepairRequestListItemQueryResult,
  AdminRepairRequestListPage,
  AdminRepairRequestQueryFilter,
  AdminRepairRequestSummaryQueryResult,
} from '../admin-document-database.types';

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
  ) {}

  /**
   * 全局列表：默认仅未删除申请（与既有读模型口径一致），固定排序，OFFSET 分页。
   * 账号 ID 集合筛选由 usecase 解析后传入；空集合在进入查询前短路，不产生空 IN 查询。
   */
  async listAll(params: {
    filter?: AdminRepairRequestQueryFilter;
    pagination: AdminListPagination;
  }): Promise<
    Omit<AdminRepairRequestListPage, 'items'> & { items: AdminRepairRequestListItemQueryResult[] }
  > {
    const filter = params.filter;
    if (filter?.customerAccountIds && filter.customerAccountIds.length === 0) {
      return this.emptyPage(params.pagination);
    }

    const where = this.buildListWhere(filter);
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

  /** 筛选条件收敛为 SQL where：全部筛选在 SQL 侧执行以保证分页正确性 */
  private buildListWhere(
    filter?: AdminRepairRequestQueryFilter,
  ): FindOptionsWhere<RepairRequestEntity> {
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
    return where;
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
   * @throws DomainError ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND（对外大类 NOT_FOUND）
   */
  async findSummaryById(requestId: number): Promise<AdminRepairRequestSummaryQueryResult> {
    const entity = await this.requestRepository.findOne({ where: { id: requestId } });
    if (!entity || entity.deprecated) {
      // details 仅含申请标识，不区分「不存在」与「已删除」，防删除状态探测
      throw new DomainError(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND, '维修申请不存在或不可访问', {
        requestId,
      });
    }

    const [model, responses] = await Promise.all([
      this.equipmentModelRepository.findOne({ where: { id: entity.equipmentModelId } }),
      this.responseRepository.find({
        where: { requestId: entity.id },
        order: { createdAt: 'DESC', id: 'DESC' },
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
      latestResolutionStatus: responses.length > 0 ? responses[0].resolutionStatus : null,
    };
  }

  /** 管理员统计：全局未删除申请总数（口径与默认列表过滤一致） */
  async countAll(): Promise<number> {
    return this.requestRepository.count({ where: { deprecated: false } });
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
