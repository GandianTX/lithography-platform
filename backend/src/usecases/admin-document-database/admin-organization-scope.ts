// src/usecases/admin-document-database/admin-organization-scope.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import {
  resolveAdminOrganizationScopeFromFacts,
  type AdminOrganizationScope,
} from '@core/repair-request/policy/repair-request-admin-scope.policy';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 管理员工单查询/修订的组织范围。
 *
 * - level 1（admin_level = 1）：全公司，organizationId 为 null；
 * - level 2（admin_level = 2）：仅服务端可信组织上下文确认的本公司，
 *   organizationId 必有值；
 * - admin_level 为 null 或非法值：失败关闭（拒绝），不按一级放行，
 *   见 `docs/database/v13-deployment/data-contracts.md` §5/§6.1。
 *
 * 组织 ID 只来自可信组织成员事实，绝不接收客户端参数；二级管理员没有
 * 唯一有效组织时失败关闭为 FORBIDDEN，不回退全库。
 *
 * 二级管理员还要求该唯一有效成员关系的 `memberRole` 仍为 `SUPER_ADMIN`：
 * 管理员等级是账号侧事实，成员关系是组织侧事实，两者必须同时成立。只有
 * ENGINEER/CUSTOMER 成员关系、关系被撤销或组织停用时一律失败关闭，不因
 * 账号 `admin_level = 2` 就按该组织放行。
 */
export type { AdminOrganizationScope };

export async function resolveAdminOrganizationScope(params: {
  session: UsecaseSession;
  accountQueryService: AccountQueryService;
  trustedOrganizationContext: TrustedOrganizationContextQueryService;
}): Promise<AdminOrganizationScope> {
  const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(
    params.session.accountId,
  );

  if (adminLevel === 1) {
    return { adminLevel: 1, organizationId: null };
  }
  if (adminLevel !== 2) {
    // null 或非法值统一由 core policy 失败关闭，不静默降级为全局
    return resolveAdminOrganizationScopeFromFacts({
      adminLevel,
      trustedOrganizationId: null,
    });
  }

  const membership = await params.trustedOrganizationContext.resolveForAccount({
    accountId: params.session.accountId,
  });
  if (membership.memberRole !== String(IdentityTypeEnum.SUPER_ADMIN)) {
    // 关系存在但角色不符：账号等级不能单独授予公司范围
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '二级管理员缺少有效的公司管理员成员关系',
    );
  }
  return resolveAdminOrganizationScopeFromFacts({
    adminLevel: 2,
    trustedOrganizationId: membership.organizationId,
  });
}
