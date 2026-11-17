// src/core/repair-request/policy/repair-request-admin-scope.policy.ts
// 管理员工单组织范围判定（单一口径，供管理员工单列表 / total / 详情 / 修订使用）。
//
// 服务公司字段当前存在两种历史语义：
// - service_organization_id：V13 新增的服务公司证据列；
// - owner_organization_id：既有一致性组织范围列（工程师读写与任务 11 绑定均使用）。
//
// 工单一旦关联原始报修 intake，服务公司事实必须以 intake 为准：
// `intake.service_organization_id` 与工单 `service_organization_id` 均存在、相等且
// 等于二级管理员可信组织时才可读取或修订；任一缺失、冲突或 intake 关联记录不可用
// 均失败关闭，绝不回退 owner_organization_id。
//
// 仅「无 intake」的历史工单沿用 `service_organization_id ?? owner_organization_id`，
// 避免历史数据因新列为空而整体不可见。一级管理员始终为全公司范围。

import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

export type RepairRequestOrganizationFacts = {
  serviceOrganizationId: number | null;
  ownerOrganizationId: number | null;
};

/** 管理员工单组织范围判定所需事实：历史回退列 + intake 关联 */
export type RepairRequestAdminScopeFacts = RepairRequestOrganizationFacts & {
  intakeId: number | null;
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
 * 管理员工单组织范围判定（列表 / total / 详情 / 修订共用语义）。
 *
 * @param facts 工单组织事实；`intakeId` 必须来自同一次读取/同一事务快照
 * @param organizationId 一级管理员为 null（全公司）；二级管理员为可信本公司 ID
 * @param intakeServiceOrganizationId 按 `intakeId` 读取到的 intake 服务公司；
 *   intake 关联记录不存在或不可用时传 null（失败关闭）
 *
 * 二级管理员规则：
 * - 有 intake：intake 必须存在，且工单 service 与 intake service 均存在、
 *   相等并等于本公司；不回退 owner；
 * - 无 intake（历史工单）：沿用 `service ?? owner` 既有口径；
 * - 其余冲突/缺失一律失败关闭。
 */
export function isRepairRequestVisibleToAdminOrganization(
  facts: RepairRequestAdminScopeFacts,
  organizationId: number | null,
  intakeServiceOrganizationId: number | null = null,
): boolean {
  if (organizationId === null) {
    return true;
  }
  if ((facts.intakeId ?? null) === null) {
    return resolveEffectiveServiceOrganizationId(facts) === organizationId;
  }
  return (
    facts.serviceOrganizationId !== null &&
    facts.serviceOrganizationId === organizationId &&
    intakeServiceOrganizationId === organizationId
  );
}
