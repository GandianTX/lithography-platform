// src/usecases/repair-request/list-engineer-repair-requests.usecase.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { applyDefaults, enforceMaxPageSize } from '@core/pagination/pagination.policy';
import { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import {
  REPAIR_REQUEST_ENGINEER_LIST_SCOPES,
  RepairRequestEngineerListFilter,
  RepairRequestEngineerListPage,
  RepairRequestEngineerListScope,
} from '@src/modules/lithography/lithography.types';
import { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { enrichEngineerListItems } from './enrich-repair-request-nicknames';
import { normalizeEngineerListFilter } from './repair-request-list-filter.input.normalize';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 查询工程师维修申请列表用例（scope = ALL / AVAILABLE / MINE / TAKEN_BY_OTHER，默认 ALL）
 *
 * - 范围入参在 GraphQL 层为字符串，由本用例对照共享类型常量校验，
 *   校验通过后才收窄类型（先验证后断言；adapter 不导入 lithography.types 枚举/常量）
 * - 跨域编排：客户昵称关键词先经账号域批量解析为客户账号 ID 集合，
 *   再随筛选条件进入维修读侧（分页与 total 计算前完成筛选）；
 *   装配结果中的归属账号 ID 由本用例批量富集为客户/接单工程师安全展示资料
 *   与当前会话视角状态（账号 ID 不进入对外视图）
 * - 账号仅取自 JWT/Session；角色准入由 adapter 层守卫决策（ENGINEER，
 *   SUPER_ADMIN 按角色继承规则同准入）；页大小上限在传输无关的用例层强制，不依赖入口校验
 */
@Injectable()
export class ListEngineerRepairRequestsUsecase {
  constructor(
    private readonly repairRequestQueryService: RepairRequestQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    scope: string;
    filter?: RepairRequestEngineerListFilter;
    pagination: PaginationParams;
  }): Promise<RepairRequestEngineerListPage> {
    const scopes: readonly string[] = REPAIR_REQUEST_ENGINEER_LIST_SCOPES;
    if (!scopes.includes(params.scope)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '工程师列表范围无效', {
        scope: params.scope,
      });
    }
    const scope = params.scope as RepairRequestEngineerListScope;
    if (params.pagination.mode !== 'OFFSET') {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.INVALID_PARAMS,
        '维修申请列表第一版仅支持 OFFSET 分页',
        { mode: params.pagination.mode },
      );
    }
    const { page, pageSize, withTotal } = enforceMaxPageSize(
      applyDefaults(params.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    const filter = normalizeEngineerListFilter(params.filter);

    // 客户昵称筛选：分页计数前先解析为客户账号 ID 集合；无匹配账号时直接空页返回
    let customerAccountIds: number[] | undefined;
    if (filter.customerNickname !== undefined) {
      customerAccountIds = await this.accountQueryService.findAccountIdsByNicknameKeyword(
        filter.customerNickname,
      );
      if (customerAccountIds.length === 0) {
        return { items: [], total: withTotal ? 0 : undefined, page, pageSize };
      }
    }

    const organizationFact = await this.organizationContextQueryService.tryResolveForAccount({
      accountId: params.session.accountId,
    });

    const queryPage = await this.repairRequestQueryService.listByEngineer({
      engineerAccountId: params.session.accountId,
      scope,
      filter: {
        equipmentModelId: filter.equipmentModelId,
        customerAccountIds,
      },
      pagination: { page, pageSize, withTotal: withTotal ?? false },
      viewerOrganizationId: organizationFact?.organizationId ?? null,
    });
    return {
      items: await enrichEngineerListItems(
        this.accountQueryService,
        queryPage.items,
        params.session.accountId,
      ),
      total: queryPage.total,
      page: queryPage.page,
      pageSize: queryPage.pageSize,
    };
  }
}
