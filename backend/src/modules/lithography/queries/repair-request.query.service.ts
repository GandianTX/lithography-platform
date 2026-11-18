// src/modules/lithography/queries/repair-request.query.service.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import {
  parseRepairRequestHandlingResult,
  parseRepairRequestHandlingStatus,
} from '@core/repair-request/policy/repair-request-handling.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { EngineerResponseEntity } from '../entities/engineer-response.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import { RepairProcessEntryQueryService } from './repair-process-entry.query.service';
import {
  EngineerResponseQueryResult,
  EquipmentModelView,
  RepairRequestDetailQueryResult,
  RepairRequestDetailReadScope,
  RepairRequestEngineerListFilterInternal,
  RepairRequestEngineerListItemQueryResult,
  RepairRequestEngineerListQueryPage,
  RepairRequestEngineerListScope,
  RepairRequestListItemView,
  RepairRequestListPage,
  RepairRequestListPagination,
} from '../lithography.types';

/** 列表固定排序：创建时间倒序，次级主键倒序（对接方案第二节） */
const LIST_ORDER = { createdAt: 'DESC', id: 'DESC' } as const;

/** 列表装配批量读取上下文：机型映射 + 申请维度最新处理状态（一次批量读取） */
type ListItemAssembleContext = {
  modelById: Map<number, EquipmentModelEntity>;
  latestStatusByRequestId: Map<number, EngineerResponseEntity['resolutionStatus']>;
};

/**
 * 维修申请读侧查询服务
 *
 * 职责范围：
 * - 客户维度有效申请列表（仅本人、未删除）
 * - 工程师四态列表（ALL / AVAILABLE / MINE / TAKEN_BY_OTHER，含设备与客户账号筛选）
 * - 客户与工程师详情（含回复时间线、机型、最新处理状态；按入口 scope 限定有效身份）
 * - 细粒度读权限判定（对接方案第三节权限矩阵 + 负责人 20260901 裁定）
 *
 * 不包含：
 * - 任何写入（接单 / 删除 / 回复由各自 Usecase 编排）
 * - 归属类账号 ID 输出（customerAccountId / acceptedByEngineerAccountId 不进入视图）
 * - 工程师昵称富集（回复携带工程师账号 ID 的内部装配结果，
 *   由 usecase 跨域关联账号域昵称后对外输出）
 */
@Injectable()
export class RepairRequestQueryService {
  constructor(
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(EngineerResponseEntity)
    private readonly responseRepository: Repository<EngineerResponseEntity>,
    @InjectRepository(EquipmentModelEntity)
    private readonly equipmentModelRepository: Repository<EquipmentModelEntity>,
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly intakeRepository: Repository<RepairRequestIntakeEntity>,
    private readonly repairProcessEntryQueryService: RepairProcessEntryQueryService,
  ) {}

  /**
   * 客户维度列表：仅本人且未删除的申请
   */
  async listByCustomer(params: {
    customerAccountId: number;
    pagination: RepairRequestListPagination;
  }): Promise<RepairRequestListPage> {
    const where = { customerAccountId: params.customerAccountId, deprecated: false };
    return this.listPage(where, params.pagination, (entities) => this.toListItemViews(entities));
  }

  /**
   * 工程师维度列表（四态，数据库侧完成全部筛选后再分页计数）：
   * - ALL：本人可信服务公司的全部未删除申请；
   * - AVAILABLE：可信服务公司内未删除且未接单（待接单池）；
   * - MINE：可信服务公司内本人已接单；
   * - TAKEN_BY_OTHER：可信服务公司内其他账号已接单。
   * 可信服务公司 = 工单服务公司列 与 原始报修 intake 服务公司 一致时的该值；
   * intake 缺失、服务公司缺失或两处冲突的工单不会进入工程师任何视角，
   * 也不按旧 owner、客户公司、客户端组织或历史接单人兜底。
   * 客户昵称筛选已由 usecase 解析为客户账号 ID 集合，在本方法内以 IN 条件
   * 参与分页与 total 计算；列表项为富集前装配结果（含归属类账号 ID，不对外输出）。
   */
  async listByEngineer(params: {
    engineerAccountId: number;
    scope: RepairRequestEngineerListScope;
    filter: RepairRequestEngineerListFilterInternal;
    pagination: RepairRequestListPagination;
    /** 可信组织上下文；为空表示无组织归属（无任何可见工单） */
    viewerOrganizationId?: number | null;
  }): Promise<RepairRequestEngineerListQueryPage> {
    const viewerOrganizationId = params.viewerOrganizationId ?? null;
    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);
    if (viewerOrganizationId === null) {
      // 无可信组织上下文：无任何可见组织事实，直接空页（不查库、不放宽）
      return {
        items: [],
        total: params.pagination.withTotal ? 0 : undefined,
        page,
        pageSize,
      };
    }
    if (params.filter.customerAccountIds && params.filter.customerAccountIds.length === 0) {
      return {
        items: [],
        total: params.pagination.withTotal ? 0 : undefined,
        page,
        pageSize,
      };
    }

    // 内连接 intake 并强制两处服务公司一致：冲突或缺失的工单天然被排除
    const query = this.requestRepository
      .createQueryBuilder('request')
      .innerJoin(
        RepairRequestIntakeEntity,
        'intake',
        'intake.id = request.intakeId AND intake.serviceOrganizationId = request.serviceOrganizationId',
      )
      .where('request.deprecated = :deprecated', { deprecated: false })
      .andWhere('request.serviceOrganizationId = :viewerOrganizationId', { viewerOrganizationId });

    switch (params.scope) {
      case 'AVAILABLE':
        query.andWhere('request.isAccepted = :isAccepted', { isAccepted: false });
        break;
      case 'MINE':
        query.andWhere('request.acceptedByEngineerAccountId = :engineerAccountId', {
          engineerAccountId: params.engineerAccountId,
        });
        break;
      case 'TAKEN_BY_OTHER':
        // 不变式：isAccepted=true ⇒ 接单账号非空（写契约保证）
        query
          .andWhere('request.isAccepted = :isAccepted', { isAccepted: true })
          .andWhere('request.acceptedByEngineerAccountId <> :engineerAccountId', {
            engineerAccountId: params.engineerAccountId,
          });
        break;
      default:
        break;
    }
    if (params.filter.equipmentModelId !== undefined) {
      query.andWhere('request.equipmentModelId = :equipmentModelId', {
        equipmentModelId: params.filter.equipmentModelId,
      });
    }
    if (params.filter.customerAccountIds) {
      query.andWhere('request.customerAccountId IN (:...customerAccountIds)', {
        customerAccountIds: params.filter.customerAccountIds,
      });
    }

    query
      .orderBy('request.createdAt', 'DESC')
      .addOrderBy('request.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const totalPromise = params.pagination.withTotal
      ? query.clone().getCount()
      : Promise.resolve(undefined);
    const entities = await query.getMany();
    const total = await totalPromise;
    return {
      items: await this.toEngineerListItemQueryResults(entities),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 详情读取（客户 / 工程师入口共用），细粒度读权限在本方法内按 scope 判定。
   *
   * 权限口径：
   * - scope=CUSTOMER：仅本人申请；已删除视为不可访问
   * - scope=ENGINEER：仅「工单服务公司 = 原始报修 intake 服务公司」且等于查看者
   *   可信组织的未删除申请可读；intake 缺失、服务公司缺失或两处冲突一律拒绝，
   *   不按旧 owner、客户公司、客户端组织或历史接单人兜底
   * - SUPER_ADMIN 按角色继承规则展开为 ENGINEER + CUSTOMER（roleHierarchy）
   *
   * 不存在、已删除与越权统一拒绝，不区分对外表述，防止资源存在性探测。
   *
   * @throws DomainError PERMISSION_ERROR.ACCESS_DENIED（大类码 FORBIDDEN）
   */
  async findDetail(params: {
    requestId: number;
    session: UsecaseSession;
    scope: RepairRequestDetailReadScope;
    /** 可信组织上下文（工程师入口）；为空表示无组织归属 */
    viewerOrganizationId?: number | null;
  }): Promise<RepairRequestDetailQueryResult> {
    const entity = await this.requestRepository.findOne({ where: { id: params.requestId } });
    if (!entity || !this.canReadRequest(entity, params.session, params.scope)) {
      // details 仅含申请标识，不泄露归属与存在性
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '维修申请不存在或不可查看', {
        id: params.requestId,
      });
    }
    if (params.scope === 'ENGINEER') {
      // 可信服务公司 = 工单服务公司 与 原始报修 intake 服务公司 一致时的该值；
      // 缺失或冲突时直接拒绝，不回退旧 owner、客户公司、客户端组织或历史接单人
      const trustedServiceOrganizationId = await this.resolveTrustedServiceOrganizationId(entity);
      if (
        trustedServiceOrganizationId === null ||
        trustedServiceOrganizationId !== (params.viewerOrganizationId ?? null)
      ) {
        throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '维修申请不存在或不可查看', {
          id: params.requestId,
        });
      }
    }

    const [model, responses] = await Promise.all([
      this.equipmentModelRepository.findOne({ where: { id: entity.equipmentModelId } }),
      this.responseRepository.find({
        where: { requestId: entity.id },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
    ]);
    // 内部维修过程仅对接单工程师本人开放；客户入口及其他工程师恒为空数组
    const processEntries =
      params.scope === 'ENGINEER' &&
      entity.acceptedByEngineerAccountId !== null &&
      entity.acceptedByEngineerAccountId === params.session.accountId
        ? await this.repairProcessEntryQueryService.listByRequest(entity.id)
        : [];

    return {
      id: entity.id,
      requestNo: entity.requestNo,
      equipmentModel: this.toModelView(model),
      errorCode: entity.errorCode,
      faultDescription: entity.faultDescription,
      contentMd: entity.contentMd,
      createdAt: entity.createdAt,
      isAccepted: entity.isAccepted,
      acceptedAt: entity.acceptedAt,
      latestResolutionStatus:
        responses.length > 0 ? responses[responses.length - 1].resolutionStatus : null,
      responses: responses.map((response) => this.toResponseQueryResult(response)),
      closureStatus: entity.closureStatus,
      closedAt: entity.closedAt,
      closureReason: entity.closureReason,
      handlingResult: parseRepairRequestHandlingResult(entity.handlingResult),
      handlingStatus: parseRepairRequestHandlingStatus(entity.handlingStatus),
      processEntries,
      // 内部富集输入：仅供 usecase 关联客户/接单工程师安全展示资料，不进入对外视图
      customerAccountId: entity.customerAccountId,
      acceptedByEngineerAccountId: entity.acceptedByEngineerAccountId,
    };
  }

  /**
   * 细粒度读权限判定（纯函数语义，防探测：不区分「不存在/无权限」）
   *
   * 角色按 roleHierarchy 展开（hasRole）：SUPER_ADMIN 继承 ENGINEER + CUSTOMER
   * 读能力（负责人 20260901 裁定 2）；写侧删除不继承（由删除用例另行约束）。
   * scope 限定本入口的有效身份：客户入口只按客户身份判，工程师入口只按工程师身份判。
   */
  private canReadRequest(
    entity: RepairRequestEntity,
    session: UsecaseSession,
    scope: RepairRequestDetailReadScope,
  ): boolean {
    if (scope === 'CUSTOMER') {
      if (!hasRole(session.roles, IdentityTypeEnum.CUSTOMER)) return false;
      // 客户本人申请：已删除后不可访问（超管以客户身份继承时同样只见本人申请）
      return entity.customerAccountId === session.accountId && !entity.deprecated;
    }
    if (!hasRole(session.roles, IdentityTypeEnum.ENGINEER)) return false;
    // 工程师：未删除申请中，仅本组织可见；无归属存量另由 isEngineerScopeVisible 限定为接单本人。
    // 写侧（接单/回复）仍按精确身份失败关闭，读权限继承不等于写权限继承
    return !entity.deprecated;
  }

  /**
   * 工程师入口的组织范围判定：
   * 只认「工单服务公司 = 原始报修 intake 服务公司」且等于查看者可信组织；
   * intake 缺失、服务公司缺失或两处冲突一律不可见（失败关闭）。
   */
  private async resolveTrustedServiceOrganizationId(
    entity: RepairRequestEntity,
  ): Promise<number | null> {
    if (entity.intakeId === null || entity.serviceOrganizationId === null) {
      return null;
    }
    const intake = await this.intakeRepository.findOne({
      where: { id: entity.intakeId },
      select: { id: true, serviceOrganizationId: true },
    });
    return intake !== null && intake.serviceOrganizationId === entity.serviceOrganizationId
      ? entity.serviceOrganizationId
      : null;
  }

  private async listPage<T>(
    where: FindOptionsWhere<RepairRequestEntity> | FindOptionsWhere<RepairRequestEntity>[],
    pagination: RepairRequestListPagination,
    assemble: (entities: RepairRequestEntity[]) => Promise<T[]>,
  ): Promise<Omit<RepairRequestListPage, 'items'> & { items: T[] }> {
    const page = Math.max(pagination.page, 1);
    const pageSize = Math.max(pagination.pageSize, 1);
    const [entities, total] = await Promise.all([
      this.requestRepository.find({
        where,
        order: LIST_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      pagination.withTotal ? this.requestRepository.count({ where }) : Promise.resolve(undefined),
    ]);
    return {
      items: await assemble(entities),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 列表装配批量读取上下文：机型一次批量读取；最新处理状态按申请维度批量取末条，避免逐行查询
   */
  private async loadListItemAssembleContext(
    entities: RepairRequestEntity[],
  ): Promise<ListItemAssembleContext> {
    const modelIds = [...new Set(entities.map((entity) => entity.equipmentModelId))];
    const requestIds = entities.map((entity) => entity.id);
    const [models, latestStatusByRequestId] = await Promise.all([
      this.equipmentModelRepository.find({ where: { id: In(modelIds) } }),
      this.findLatestResolutionStatusByRequestIds(requestIds),
    ]);
    return {
      modelById: new Map(models.map((model) => [model.id, model])),
      latestStatusByRequestId,
    };
  }

  /**
   * 单实体装配基础列表项视图（纯映射；输出顺序由调用方按实体顺序 map 决定）
   */
  private toListItemView(
    entity: RepairRequestEntity,
    context: ListItemAssembleContext,
  ): RepairRequestListItemView {
    return {
      id: entity.id,
      requestNo: entity.requestNo,
      equipmentModel: this.toModelView(context.modelById.get(entity.equipmentModelId)),
      errorCode: entity.errorCode,
      createdAt: entity.createdAt,
      isAccepted: entity.isAccepted,
      acceptedAt: entity.acceptedAt,
      latestResolutionStatus: context.latestStatusByRequestId.get(entity.id) ?? null,
    };
  }

  /**
   * 基础列表项批量装配：机型与最新处理状态一次批量读取，按实体顺序逐条映射
   */
  private async toListItemViews(
    entities: RepairRequestEntity[],
  ): Promise<RepairRequestListItemView[]> {
    if (entities.length === 0) {
      return [];
    }
    const context = await this.loadListItemAssembleContext(entities);
    return entities.map((entity) => this.toListItemView(entity, context));
  }

  /**
   * 工程师列表批量装配：按实体逐条装配基础视图并显式追加归属类账号 ID
   * （不依赖兄弟方法返回顺序；批量账号查询由 usecase 富集完成，禁止逐行 N+1）
   */
  private async toEngineerListItemQueryResults(
    entities: RepairRequestEntity[],
  ): Promise<RepairRequestEngineerListItemQueryResult[]> {
    if (entities.length === 0) {
      return [];
    }
    const context = await this.loadListItemAssembleContext(entities);
    return entities.map((entity) => ({
      ...this.toListItemView(entity, context),
      customerAccountId: entity.customerAccountId,
      acceptedByEngineerAccountId: entity.acceptedByEngineerAccountId,
      closureStatus: entity.closureStatus,
      closedAt: entity.closedAt,
      handlingResult: parseRepairRequestHandlingResult(entity.handlingResult),
      handlingStatus: parseRepairRequestHandlingStatus(entity.handlingStatus),
    }));
  }

  /**
   * 按申请维度取最新回复的处理状态（口径：按创建时间倒序、主键倒序的末条）
   */
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

  private toResponseQueryResult(entity: EngineerResponseEntity): EngineerResponseQueryResult {
    return {
      id: entity.id,
      engineerAccountId: entity.engineerAccountId,
      resolutionStatus: entity.resolutionStatus,
      responseText: entity.responseText,
      createdAt: entity.createdAt,
    };
  }

  private toModelView(entity: EquipmentModelEntity | null | undefined): EquipmentModelView {
    if (!entity) {
      // 外键保证申请必有型号；极端缺失时返回占位，避免详情整体不可读
      return { id: 0, modelCode: '', modelName: '' };
    }
    return {
      id: entity.id,
      modelCode: entity.modelCode,
      modelName: entity.modelName,
    };
  }
}
