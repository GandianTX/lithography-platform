// src/modules/lithography/queries/repair-request.query.service.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Not, Repository } from 'typeorm';
import { EngineerResponseEntity } from '../entities/engineer-response.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
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
   * - ALL：本组织全部未删除申请；
   * - AVAILABLE：本组织未删除且未接单（待接单池）；
   * - MINE：本人已接单（含无归属存量，归属缺失不放大可见范围）；
   * - TAKEN_BY_OTHER：本组织内其他账号已接单。
   * 无组织上下文的账号在非 MINE 视角直接得到空页，不把归属缺失当作全库可见。
   * 客户昵称筛选已由 usecase 解析为客户账号 ID 集合，在本方法内以 IN 条件
   * 参与分页与 total 计算；列表项为富集前装配结果（含归属类账号 ID，不对外输出）。
   */
  async listByEngineer(params: {
    engineerAccountId: number;
    scope: RepairRequestEngineerListScope;
    filter: RepairRequestEngineerListFilterInternal;
    pagination: RepairRequestListPagination;
    /** 可信组织上下文；为空表示无组织归属（仅可见无归属存量工单） */
    viewerOrganizationId?: number | null;
  }): Promise<RepairRequestEngineerListQueryPage> {
    const where: FindOptionsWhere<RepairRequestEntity> = { deprecated: false };
    switch (params.scope) {
      case 'AVAILABLE':
        where.isAccepted = false;
        break;
      case 'MINE':
        where.acceptedByEngineerAccountId = params.engineerAccountId;
        break;
      case 'TAKEN_BY_OTHER':
        // 不变式：isAccepted=true ⇒ 接单账号非空（写契约保证），Not 等值安全
        where.isAccepted = true;
        where.acceptedByEngineerAccountId = Not(params.engineerAccountId);
        break;
      default:
        break;
    }
    if (params.filter.equipmentModelId !== undefined) {
      where.equipmentModelId = params.filter.equipmentModelId;
    }
    if (params.filter.customerAccountIds) {
      where.customerAccountId = In(params.filter.customerAccountIds);
    }
    // 组织范围：已归属工单仅本组织可见；无归属存量工单不向全体工程师开放，
    // 仅在 MINE（本人已接单）视角保留，避免用放宽权限掩盖归属缺失
    const viewerOrganizationId = params.viewerOrganizationId ?? null;
    const scopeVariants: FindOptionsWhere<RepairRequestEntity>[] = [];
    if (viewerOrganizationId !== null) {
      scopeVariants.push({ ...where, ownerOrganizationId: viewerOrganizationId });
    }
    if (params.scope === 'MINE') {
      scopeVariants.push({ ...where, ownerOrganizationId: IsNull() });
    }
    if (scopeVariants.length === 0) {
      // 无组织上下文且非 MINE：无任何可见组织事实，直接空页（不查库、不放宽）
      const page = Math.max(params.pagination.page, 1);
      const pageSize = Math.max(params.pagination.pageSize, 1);
      return {
        items: [],
        total: params.pagination.withTotal ? 0 : undefined,
        page,
        pageSize,
      };
    }
    return this.listPage(scopeVariants, params.pagination, (entities) =>
      this.toEngineerListItemQueryResults(entities),
    );
  }

  /**
   * 详情读取（客户 / 工程师入口共用），细粒度读权限在本方法内按 scope 判定。
   *
   * 权限口径（对接方案第三节 + 负责人 20260901 裁定 2）：
   * - scope=CUSTOMER：仅本人申请；已删除视为不可访问
   * - scope=ENGINEER：本组织未删除申请可读；无归属存量仅接单工程师本人可读
   *   （AVAILABLE / MINE / TAKEN_BY_OTHER 视角由 usecase 计算；未接单的
   *   无归属存量不因组织列缺失而开放），写权限仍由各写用例独立失败关闭
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
    if (
      !entity ||
      !this.canReadRequest(entity, params.session, params.scope) ||
      (params.scope === 'ENGINEER' && !this.isEngineerScopeVisible(entity, params))
    ) {
      // details 仅含申请标识，不泄露归属与存在性
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '维修申请不存在或不可查看', {
        id: params.requestId,
      });
    }

    const [model, responses] = await Promise.all([
      this.equipmentModelRepository.findOne({ where: { id: entity.equipmentModelId } }),
      this.responseRepository.find({
        where: { requestId: entity.id },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
    ]);

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
   * 工程师入口的组织范围判定（与列表口径一致）：
   * - 有归属工单：仅同组织可见；
   * - 无归属存量工单：仅接单工程师本人可见，不因组织列缺失而向全体工程师放开。
   */
  private isEngineerScopeVisible(
    entity: RepairRequestEntity,
    params: { session: UsecaseSession; viewerOrganizationId?: number | null },
  ): boolean {
    if (entity.ownerOrganizationId !== null) {
      return entity.ownerOrganizationId === (params.viewerOrganizationId ?? null);
    }
    return (
      entity.acceptedByEngineerAccountId !== null &&
      entity.acceptedByEngineerAccountId === params.session.accountId
    );
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
