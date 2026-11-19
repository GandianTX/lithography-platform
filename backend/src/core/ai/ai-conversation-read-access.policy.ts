// src/core/ai/ai-conversation-read-access.policy.ts
// AI 会话读取授权边界（任务 05 · S4.1）
//
// 所有读详情、读列表与导出复用同一授权边界：
// - 工程师：本人独立会话；本公司工单会话（S1 既有语义，本策略只补管理员与导出侧）；
// - 管理员：一级管理员跨公司；二级管理员仅本公司（含工程师独立会话）；
// - 直传外公司会话 ID 一律拒绝（不泄露会话是否存在）。
//
// 组织范围只来自服务端可信事实（账号等级 + 唯一有效组织管理员成员关系），
// 客户端传入的公司 ID 一律不参与裁决。

import {
  AI_CONVERSATION_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';

/** 管理员读侧范围（一级全公司 / 二级本公司） */
export type AiAdminConversationScope =
  | { readonly kind: 'ADMIN_GLOBAL' }
  | { readonly kind: 'ADMIN_ORGANIZATION'; readonly organizationId: number };

export type AiConversationReadAccessResult =
  | { readonly allowed: true; readonly scope: AiAdminConversationScope }
  | { readonly allowed: false; readonly reason: AiConversationReadDeniedReason };

export type AiConversationReadDeniedReason =
  | 'NOT_ADMIN'
  | 'ADMIN_LEVEL_UNSUPPORTED'
  | 'ADMIN_MEMBERSHIP_MISSING'
  | 'ORGANIZATION_SCOPE_UNKNOWN'
  | 'OUTSIDE_ORGANIZATION';

export const AI_CONVERSATION_READ_DENIED_MESSAGES: Record<AiConversationReadDeniedReason, string> =
  {
    NOT_ADMIN: '仅管理员可以读取该会话',
    ADMIN_LEVEL_UNSUPPORTED: '仅一级或二级管理员可以读取该会话',
    ADMIN_MEMBERSHIP_MISSING: '管理员缺少有效的组织管理员成员关系，无法读取该会话',
    ORGANIZATION_SCOPE_UNKNOWN: '管理员公司范围不可确定，无法读取该会话',
    OUTSIDE_ORGANIZATION: '该会话不属于管理员所在公司，无法读取',
  };

/** 会话归属事实 */
export type AiConversationOwnershipFacts = {
  /** 会话归属账号 */
  readonly ownerAccountId: number;
  /** 会话归属公司（独立会话为工程师所属公司，工单会话为工单公司） */
  readonly ownerOrganizationId: number | null;
};

/** 管理员身份事实 */
export type AiAdminIdentityFacts = {
  readonly accountId: number;
  readonly roles: readonly string[];
  /** 当前生效角色 */
  readonly activeRole: string | null;
  /** 管理员等级：1=一级（全公司），2=二级（本公司），其他值非法 */
  readonly adminLevel: number | null;
  /** 管理员所属可信公司（来自唯一有效的组织管理员成员关系；一级不据此收窄范围） */
  readonly organizationId: number | null;
  /** 可信成员关系唯一有效公司（与 organizationId 一致时才算可信范围） */
  readonly trustedOrganizationId: number | null;
};

/** 管理员原始事实（由上层从服务端读取后传入本纯函数裁决） */
export type AiAdminRawFacts = {
  readonly accountId: number;
  readonly roles: readonly string[];
  readonly activeRole: string | null;
  /** 账号侧管理员等级（数据库当前事实，不是 JWT 声明） */
  readonly adminLevel: number | null;
  /** 唯一有效组织成员关系（无有效成员关系时为 null） */
  readonly membership: { readonly organizationId: number; readonly memberRole: string } | null;
};

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/**
 * 管理员的可信组织成员事实（纯函数）。
 *
 * 账号侧等级与组织侧成员角色必须同时成立：
 * - `admin_level` 不是 1/2 → 无可信公司（等级非法，由上层按等级不支持拒绝）；
 * - 无有效成员关系 → 无可信公司；
 * - 成员角色不是组织管理员（SUPER_ADMIN）→ 无可信公司
 *   （账号等级不能单独授予组织范围）。
 *
 * 一级管理员同样要求该成员关系成立：AI 会话读侧与既有管理员文档数据库端点保持
 * 同一准入边界，不因开放二级公司范围而放宽一级的成员关系要求。
 *
 * 返回 null 时上层按失败关闭拒绝，不回退全公司。
 */
export function resolveAiAdminTrustedOrganizationId(facts: {
  readonly adminLevel: number | null;
  readonly membership: { readonly organizationId: number; readonly memberRole: string } | null;
}): number | null {
  if (facts.adminLevel !== 1 && facts.adminLevel !== 2) {
    return null;
  }
  if (facts.membership === null) {
    return null;
  }
  if (facts.membership.memberRole !== SUPER_ADMIN_ROLE) {
    return null;
  }
  return facts.membership.organizationId;
}

/**
 * 校验管理员身份（失败关闭，先于任何读库）。
 *
 * `roles` 必须含 `SUPER_ADMIN` 且 `activeRole` 精确为 `SUPER_ADMIN`；
 * 缺失或矛盾一律拒绝，不查库、不降级。
 */
export function assertAiAdminIdentity(identity: {
  readonly roles: readonly string[];
  readonly activeRole: string | null;
}): void {
  if (!identity.roles.includes(SUPER_ADMIN_ROLE) || identity.activeRole !== SUPER_ADMIN_ROLE) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      AI_CONVERSATION_READ_DENIED_MESSAGES.NOT_ADMIN,
    );
  }
}

/**
 * 校验管理员的组织成员关系前提（失败关闭）。
 *
 * - 等级不是 1/2 → 返回 null（等级分支由调用方的策略裁决，不在此抛错）；
 * - 无有效成员关系 → `ORGANIZATION_NO_ACTIVE_MEMBERSHIP`
 *   （与既有管理员读侧「可信组织上下文」口径一致，对外同为 FORBIDDEN）；
 * - 成员角色不是组织管理员（SUPER_ADMIN）→ `INSUFFICIENT_PERMISSIONS`
 *   （账号等级不能单独授予组织范围）。
 *
 * @returns 可信公司 ID；等级非 1/2 时为 null
 */
export function assertAiAdminMembership(facts: {
  readonly adminLevel: number | null;
  readonly membership: { readonly organizationId: number; readonly memberRole: string } | null;
}): number | null {
  if (facts.adminLevel !== 1 && facts.adminLevel !== 2) {
    return null;
  }
  if (facts.membership === null) {
    throw new DomainError(
      ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
      '当前账号没有有效组织成员关系，无法执行组织范围操作',
    );
  }
  if (facts.membership.memberRole !== SUPER_ADMIN_ROLE) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '管理员缺少有效的组织管理员成员关系',
    );
  }
  return facts.membership.organizationId;
}

/** 装配管理员身份事实（等级 + 可信公司；不产生副作用） */
export function resolveAiAdminIdentityFacts(facts: AiAdminRawFacts): AiAdminIdentityFacts {
  const trustedOrganizationId = resolveAiAdminTrustedOrganizationId({
    adminLevel: facts.adminLevel,
    membership: facts.membership,
  });
  return {
    accountId: facts.accountId,
    roles: facts.roles,
    activeRole: facts.activeRole,
    adminLevel: facts.adminLevel,
    organizationId: trustedOrganizationId,
    trustedOrganizationId,
  };
}

/**
 * 判定管理员对会话的读取权。
 *
 * 失败关闭：等级缺失/非法、公司范围不可确定、外公司会话一律拒绝。
 */
export function resolveAiAdminConversationReadAccess(input: {
  readonly admin: AiAdminIdentityFacts;
  readonly conversation: AiConversationOwnershipFacts;
}): AiConversationReadAccessResult {
  if (
    !input.admin.roles.includes(SUPER_ADMIN_ROLE) ||
    input.admin.activeRole !== SUPER_ADMIN_ROLE
  ) {
    return { allowed: false, reason: 'NOT_ADMIN' };
  }
  if (input.admin.adminLevel === 1) {
    // 一级管理员：跨公司，但必须保有有效的组织管理员成员关系
    if (input.admin.trustedOrganizationId === null) {
      return { allowed: false, reason: 'ADMIN_MEMBERSHIP_MISSING' };
    }
    return { allowed: true, scope: { kind: 'ADMIN_GLOBAL' } };
  }
  if (input.admin.adminLevel !== 2) {
    return { allowed: false, reason: 'ADMIN_LEVEL_UNSUPPORTED' };
  }
  // 二级管理员：范围必须是可信组织上下文里的唯一公司
  const organizationId = input.admin.trustedOrganizationId;
  if (organizationId === null || input.admin.organizationId !== organizationId) {
    return { allowed: false, reason: 'ORGANIZATION_SCOPE_UNKNOWN' };
  }
  const ownerOrganizationId = input.conversation.ownerOrganizationId;
  if (ownerOrganizationId === null || ownerOrganizationId !== organizationId) {
    return { allowed: false, reason: 'OUTSIDE_ORGANIZATION' };
  }
  return { allowed: true, scope: { kind: 'ADMIN_ORGANIZATION', organizationId } };
}

/**
 * 管理员列表的公司范围：一级返回全公司，二级返回本公司。
 *
 * 与 `resolveAiAdminConversationReadAccess` 同源，区别只在于列表不针对具体会话，
 * 因此不需要会话归属事实。
 */
export function resolveAiAdminConversationListScope(
  admin: AiAdminIdentityFacts,
): AiConversationReadAccessResult {
  if (!admin.roles.includes(SUPER_ADMIN_ROLE) || admin.activeRole !== SUPER_ADMIN_ROLE) {
    return { allowed: false, reason: 'NOT_ADMIN' };
  }
  if (admin.adminLevel === 1) {
    // 一级管理员：跨公司，但必须保有有效的组织管理员成员关系
    if (admin.trustedOrganizationId === null) {
      return { allowed: false, reason: 'ADMIN_MEMBERSHIP_MISSING' };
    }
    return { allowed: true, scope: { kind: 'ADMIN_GLOBAL' } };
  }
  if (admin.adminLevel !== 2) {
    return { allowed: false, reason: 'ADMIN_LEVEL_UNSUPPORTED' };
  }
  const organizationId = admin.trustedOrganizationId;
  if (organizationId === null || admin.organizationId !== organizationId) {
    return { allowed: false, reason: 'ORGANIZATION_SCOPE_UNKNOWN' };
  }
  return { allowed: true, scope: { kind: 'ADMIN_ORGANIZATION', organizationId } };
}

/**
 * 解析管理员读侧范围（失败关闭）。
 *
 * 非管理员身份、等级缺失或非法、管理员缺少有效组织管理员成员关系、
 * 二级管理员可信公司不可确定时一律拒绝（FORBIDDEN），不回退全公司。
 */
export function resolveAiAdminConversationScopeFromFacts(
  facts: AiAdminRawFacts,
): AiAdminConversationScope {
  const admin = resolveAiAdminIdentityFacts(facts);
  const result = resolveAiAdminConversationListScope(admin);
  if (!result.allowed) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      AI_CONVERSATION_READ_DENIED_MESSAGES[result.reason],
    );
  }
  return result.scope;
}

/**
 * 断言管理员对指定会话的读取权。
 *
 * 外公司会话按「不存在」处理（不区分事实，避免探测会话是否存在）。
 */
export function assertAiAdminConversationReadAccess(facts: {
  readonly admin: AiAdminIdentityFacts;
  readonly conversation: AiConversationOwnershipFacts;
}): void {
  const result = resolveAiAdminConversationReadAccess(facts);
  if (result.allowed) {
    return;
  }
  if (result.reason === 'OUTSIDE_ORGANIZATION') {
    throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, '会话不存在或无权访问');
  }
  throw new DomainError(
    PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    AI_CONVERSATION_READ_DENIED_MESSAGES[result.reason],
  );
}
