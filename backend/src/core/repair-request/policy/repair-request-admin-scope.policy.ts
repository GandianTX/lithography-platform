// src/core/repair-request/policy/repair-request-admin-scope.policy.ts
// 管理员工单组织范围判定（单一口径，供管理员工单列表 / total / 详情使用）。
//
// 服务公司字段当前存在两种历史语义：
// - service_organization_id：V13 新增的服务公司证据列；
// - owner_organization_id：既有一致性组织范围列（工程师读写与任务 11 绑定均使用）。
//
// 历史数据中 service_organization_id 可能为空，而 owner_organization_id 有值。
// 为避免二级管理员因新列为空而看不到本公司既有工单，统一取
// `service_organization_id ?? owner_organization_id` 作为有效服务公司；
// 两列都为空时视为无组织证据，仅一级管理员可见。

import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

export type RepairRequestOrganizationFacts = {
  serviceOrganizationId: number | null;
  ownerOrganizationId: number | null;
};

/** 管理员工单组织范围：level 1 为全公司（organizationId = null），level 2 为本公司 */
export type AdminOrganizationScope = {
  adminLevel: 1 | 2;
  organizationId: number | null;
};

/**
 * 管理员层级 → 工单组织范围（纯函数，管理员工单与工单原件的单一口径）。
 *
 * - `1`：一级管理员，全公司；
 * - `2`：二级管理员，必须提供可信组织上下文确认的本公司；
 * - `null` / 其他层级：失败关闭，不静默降级为全局。
 *
 * `null` 不按一级放行是既有的显式契约（`docs/database/v13-deployment/data-contracts.md`
 * §5「失败关闭：缺失/非法等级不提升为 1 级」、§6.1「未映射期间涉及等级范围的管理操作
 * 应失败关闭，而不是按 1 级放行」）。账号行缺失与等级为 null 必须在读取层区分：
 * 行缺失由 `AccountQueryService.findAdminLevelByAccountId` 抛错，本函数只裁决等级值。
 *
 * `trustedOrganizationId` 只能来自服务端可信成员事实，绝不接受客户端组织参数。
 */
export function resolveAdminOrganizationScopeFromFacts(facts: {
  adminLevel: number | null;
  trustedOrganizationId: number | null;
}): AdminOrganizationScope {
  if (facts.adminLevel === 1) {
    return { adminLevel: 1, organizationId: null };
  }
  if (facts.adminLevel !== 2) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '管理员层级缺失或不合法');
  }
  if (facts.trustedOrganizationId === null) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '二级管理员缺少可信组织范围');
  }
  return { adminLevel: 2, organizationId: facts.trustedOrganizationId };
}

/** 有效服务公司：优先新列，缺失时回落到既有一致性组织列 */
export function resolveEffectiveServiceOrganizationId(
  facts: RepairRequestOrganizationFacts,
): number | null {
  return facts.serviceOrganizationId ?? facts.ownerOrganizationId;
}

/**
 * 管理员工单组织范围判定。
 *
 * @param organizationId 一级管理员为 null（全公司）；二级管理员为可信本公司 ID
 */
export function isRepairRequestVisibleToAdminOrganization(
  facts: RepairRequestOrganizationFacts,
  organizationId: number | null,
): boolean {
  if (organizationId === null) {
    return true;
  }
  return resolveEffectiveServiceOrganizationId(facts) === organizationId;
}
