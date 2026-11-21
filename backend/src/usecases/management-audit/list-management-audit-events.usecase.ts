// src/usecases/management-audit/list-management-audit-events.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { resolveOrganizationScopedAdminScope } from '@core/account/policy/admin-scope.policy';
import { DomainError, MANAGEMENT_AUDIT_ERROR } from '@core/common/errors/domain-error';
import {
  applyDefaults,
  enforceMaxPageSize,
  isOffsetMode,
} from '@core/pagination/pagination.policy';
import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { ManagementAuditEventListPage } from '@src/modules/lithography/management-audit.types';
import { ManagementAuditEventQueryService } from '@src/modules/lithography/queries/management-audit-event.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';

import { collectDistinctOrganizationIds } from './list-management-audit-events.organization-ids.normalize';

/** 页大小上限：与 GraphQL 边界 `PaginationArgs` 的 @Max(100) 对齐。 */
const MAX_PAGE_SIZE = 100;

/**
 * 关键操作记录只读列表用例（任务 10，R089／R092）。
 *
 * 授权口径（失败关闭）：
 * - `resolveOrganizationScopedAdminScope` 同时裁决角色（roles 含 SUPER_ADMIN）、
 *   `activeRole` 精确为 SUPER_ADMIN、`adminLevel ∈ {1,2}`；等级缺失或非法直接
 *   FORBIDDEN，不降级为一级；二级必须带请求期解析出的可信公司；
 * - 一级归一为 `organizationId: null`（全公司，含 NULL 公司记录），二级只用可信公司
 *   做等值过滤（NULL 行因此不可见）；
 * - 公司 ID 只来自服务端会话事实，客户端无法传入。
 *
 * 读侧口径：
 * - 仅 OFFSET 分页，排序由查询服务固定（发生时间倒序 + 事件主键倒序）；
 * - 三类 operation 白名单在 QueryService 内固定，本用例不提供任何筛选放大入口；
 * - `detail` 已由 QueryService 投影为白名单摘要，本层只做跨域展示富集（昵称、公司名）。
 */
@Injectable()
export class ListManagementAuditEventsUsecase {
  constructor(
    private readonly managementAuditEventQueryService: ManagementAuditEventQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    pagination: PaginationParams;
  }): Promise<ManagementAuditEventListPage> {
    const scope = resolveOrganizationScopedAdminScope(params.session, '查看关键操作记录');

    if (!isOffsetMode(params.pagination)) {
      throw new DomainError(
        MANAGEMENT_AUDIT_ERROR.INVALID_PARAMS,
        '关键操作记录仅支持 OFFSET 分页',
        { mode: params.pagination.mode },
      );
    }
    const { page, pageSize } = enforceMaxPageSize(
      applyDefaults(params.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    // 本列表页固定展示总数：GraphQL 边界的 `withTotal` 默认 false，若沿用它，
    // 客户端漏传时会得到 total=0 导致分页控件失效。审计表为追加式且页大小上限
    // 100，统计成本可控，故此处恒为 true（协议字段保留，以便后续需要时再开放）。
    const { items, total } = await this.managementAuditEventQueryService.listEvents({
      organizationId: scope.organizationId,
      pagination: { page, pageSize, withTotal: true },
    });

    if (items.length === 0) {
      return { items: [], total, page, pageSize };
    }

    // 跨域展示富集：两次批量读取，避免逐行查询；失败直接抛错，不返回半成品列表。
    const nicknames = await this.accountQueryService.findNicknamesByAccountIds(
      items.map((item) => item.actorAccountId),
    );
    const organizationIds = collectDistinctOrganizationIds(items);
    const organizationNames =
      organizationIds.length === 0
        ? new Map<number, string>()
        : await this.organizationQueryService.findOrganizationNamesByIds(organizationIds);

    return {
      items: items.map((item) => ({
        eventId: item.eventId,
        occurredAt: item.createdAt,
        actorAdminLevel: item.actorAdminLevel,
        actorNickname: nicknames.get(item.actorAccountId) ?? null,
        organizationId: item.organizationId,
        organizationName:
          item.organizationId === null
            ? null
            : (organizationNames.get(item.organizationId) ?? null),
        operation: item.operation,
        targetType: item.targetType,
        targetId: item.targetId,
        result: item.result,
        detail: item.detail,
      })),
      total,
      page,
      pageSize,
    };
  }
}
