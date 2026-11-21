// src/usecases/repair-request/list-my-repair-requests.usecase.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { applyDefaults, enforceMaxPageSize } from '@core/pagination/pagination.policy';
import { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import {
  RepairRequestCustomerListItemView,
  RepairRequestListPage,
} from '@src/modules/lithography/lithography.types';
import { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 查询我的维修申请列表用例（客户维度）
 *
 * - 账号仅取自 JWT/Session（adapter 透传），不接受前端传入的账号 ID
 * - 第一版分页仅支持 OFFSET；排序由契约固定（创建时间倒序 + 主键倒序），
 *   不采纳客户端排序入参；页大小上限在传输无关的用例层强制，不依赖入口校验
 * - 角色准入由 adapter 层守卫决策（仅 CUSTOMER），本用例承载稳定读取流程
 */
@Injectable()
export class ListMyRepairRequestsUsecase {
  constructor(private readonly repairRequestQueryService: RepairRequestQueryService) {}

  async execute(params: {
    session: UsecaseSession;
    pagination: PaginationParams;
  }): Promise<
    Omit<RepairRequestListPage, 'items'> & { items: RepairRequestCustomerListItemView[] }
  > {
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
    return this.repairRequestQueryService.listByCustomer({
      customerAccountId: params.session.accountId,
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
  }
}
