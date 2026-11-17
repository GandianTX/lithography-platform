// src/usecases/organization/list-bound-level-two-admins.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { evaluateAdminBinding } from '@core/account/policy/admin-binding.policy';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import {
  DomainError,
  ORGANIZATION_MANAGEMENT_ERROR,
  PAGINATION_ERROR,
} from '@core/common/errors/domain-error';
import type { PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { OrganizationStatus } from '@src/modules/lithography/organization.types';
import { normalizeOrganizationKeyword } from './admin-organization.input.normalize';
import {
  assembleAdminBindingFacts,
  collectActiveMembershipAccountIds,
} from './company-admin-binding.support';
import type { BoundLevelTwoAdminPage, BoundLevelTwoAdminView } from './company-admin-binding.types';

/**
 * 受管公司扫描上限：绑定判定必须解密 `meta_digest` 后在三源角色上收敛，
 * 无法在 SQL 侧完成，因此只能按公司集批量水合。超过上限显式失败，不静默截断。
 */
const BOUND_LIST_SCAN_LIMIT = 500;

/** 单页上限：与其它管理端选择器口径一致 */
const BOUND_LIST_PAGE_SIZE_MAX = 50;

export type ListBoundLevelTwoAdminsCommand = {
  readonly session: UsecaseSession;
  readonly keyword?: string | null;
  readonly pagination: PaginationParams;
};

/**
 * 一级管理员「已绑定二级管理员」列表（S3，用户管理选择器专用）。
 *
 * 授权：仅一级管理员；二级管理员不得触达。
 *
 * 驱动方式：先取受管公司（硬上限 500 家），批量读 ACTIVE 成员关系与候选账号事实，
 * 逐公司复用 `evaluateAdminBinding` 判定，只保留 `BOUND` 项，再按关键字内存过滤与分页。
 *
 * 稳定性与一致性：公司按主键升序扫描，输出顺序稳定；任一公司判定为冲突 / 停用 /
 * 未配置都不影响其它公司，属于可展示的安全状态而非错误。
 */
@Injectable()
export class ListBoundLevelTwoAdminsUsecase {
  constructor(
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
  ) {}

  async execute(command: ListBoundLevelTwoAdminsCommand): Promise<BoundLevelTwoAdminPage> {
    resolveLevelOneAdminScope(command.session, '查看已绑定二级管理员');

    const { page, pageSize } = resolvePagination(command.pagination);
    const keyword = normalizeOrganizationKeyword(command.keyword);

    const companyRefs = await this.organizationQueryService.listManagedCompanyRefs({
      limit: BOUND_LIST_SCAN_LIMIT,
    });
    if (companyRefs.overflow) {
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
        '受管公司数量超过在线绑定盘点上限，请按公司逐家查询',
        undefined,
        { diagnostic: 'BOUND_LIST_SCAN_LIMIT_EXCEEDED', limit: BOUND_LIST_SCAN_LIMIT },
      );
    }

    const membershipsByOrganization =
      await this.organizationMembershipQueryService.listActiveMembershipsByOrganizationIds({
        organizationIds: companyRefs.items.map((item) => item.id),
      });

    const allAccountIds = new Set<number>();
    for (const memberships of membershipsByOrganization.values()) {
      for (const accountId of collectActiveMembershipAccountIds(memberships)) {
        allAccountIds.add(accountId);
      }
    }
    const accountFacts = await this.adminUserQueryService.findAdminBindingCandidateFacts({
      accountIds: [...allAccountIds],
    });

    const boundAdmins: BoundLevelTwoAdminView[] = [];
    for (const company of companyRefs.items) {
      const memberships = membershipsByOrganization.get(company.id) ?? [];
      const facts = assembleAdminBindingFacts({
        organizationId: company.id,
        organizationCode: company.organizationCode,
        companyStatus: company.status,
        isManagedCompany: true,
        memberships,
        accountFacts,
      });
      const evaluation = evaluateAdminBinding(facts);
      if (evaluation.status !== 'BOUND' || evaluation.boundAccountId === null) {
        continue;
      }
      const boundFacts = accountFacts.get(evaluation.boundAccountId);
      boundAdmins.push({
        organizationId: company.id,
        organizationCode: company.organizationCode,
        companyName: company.name,
        companyStatus: company.status as OrganizationStatus,
        accountId: evaluation.boundAccountId,
        loginName: boundFacts?.loginName ?? '',
        nickname: boundFacts?.nickname ?? null,
        accountDisabled: evaluation.accountDisabled,
      });
    }

    const filtered =
      keyword === undefined
        ? boundAdmins
        : boundAdmins.filter((item) => matchesKeyword(item, keyword));
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  }
}

/** 关键字匹配公司全称 / 编号 / 登录名 / 昵称（大小写不敏感，调用方已 trim） */
function matchesKeyword(item: BoundLevelTwoAdminView, keyword: string): boolean {
  const normalized = keyword.toLowerCase();
  return [item.companyName, item.organizationCode, item.loginName, item.nickname ?? ''].some(
    (value) => value.toLowerCase().includes(normalized),
  );
}

/** 仅支持 OFFSET 分页；页码/页大小下限归一，页大小按上限截断 */
function resolvePagination(pagination: PaginationParams): { page: number; pageSize: number } {
  if (pagination.mode !== 'OFFSET') {
    throw new DomainError(PAGINATION_ERROR.INVALID_PAGE_SIZE, '已绑定管理员列表仅支持 OFFSET 分页');
  }
  return {
    page: Math.max(pagination.page, 1),
    pageSize: Math.min(Math.max(pagination.pageSize, 1), BOUND_LIST_PAGE_SIZE_MAX),
  };
}
