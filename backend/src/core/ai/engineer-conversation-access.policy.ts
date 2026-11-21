// src/core/ai/engineer-conversation-access.policy.ts
// 任务05 F01：工程师 AI 会话读／写权限的单一真源。
//
// 背景（独立终审 F01）：此前写侧只校验「会话发起人 + ACTIVE」，读侧只信任
// 固定的 `owner_organization_id` 与 `deleted_at`，两处都没有随当前可信公司与
// 关联工单的当前资源事实复核，导致失去访问资格后仍可继续读取或提问。
//
// 本策略与 04 工单工程师可见性口径保持一致（见
// `RepairRequestQueryService.findDetail('ENGINEER')` 与 `findAssociationTarget`）：
// 工单当前「可信服务公司」= 工单 `service_organization_id` 与原始报修 intake
// `service_organization_id` 一致时的该值；缺失或冲突一律不可见（失败关闭）。
//
// 读侧 SQL 与本文件共用同一份可见性条件（`ENGINEER_*_VISIBILITY_CONDITIONS`）：
// 语义条件只在 core 定义一次，读侧只负责把条件翻译成 SQL 片段；
// `evaluateEngineerVisibilityConditions` 与判定函数的行为等价由本文件用例守护。

/** 工单当前资源事实（requestId 非空时由 04 查询服务提供） */
export interface EngineerConversationRequestFacts {
  readonly deletedAt: Date | null;
  readonly trustedServiceOrganizationId: number | null;
}

export interface EngineerConversationAccessFacts {
  readonly requestId: number | null;
  readonly conversationOwnerAccountId: number;
  readonly conversationOwnerOrganizationId: number | null;
  readonly viewerAccountId: number;
  readonly viewerOrganizationId: number | null;
  /** requestId 非空时必须提供；`null` 表示工单不存在（或已不可读） */
  readonly requestFacts: EngineerConversationRequestFacts | null;
}

/**
 * 读权限判定。
 *
 * - 独立会话（`requestId` 为空）：已确认规则是**仅发起工程师本人**，
 *   不因同公司而扩大；
 * - 工单会话：固定会话归属公司、工单未软删、工单当前可信服务公司三项
 *   必须同时等于查看者的当前可信公司。
 */
export function canReadEngineerConversation(facts: EngineerConversationAccessFacts): boolean {
  if (facts.requestId === null) {
    return facts.conversationOwnerAccountId === facts.viewerAccountId;
  }

  if (facts.viewerOrganizationId === null) {
    return false;
  }
  if (facts.conversationOwnerOrganizationId !== facts.viewerOrganizationId) {
    return false;
  }
  const request = facts.requestFacts;
  if (request === null || request.deletedAt !== null) {
    return false;
  }
  if (request.trustedServiceOrganizationId === null) {
    return false;
  }
  return request.trustedServiceOrganizationId === facts.viewerOrganizationId;
}

/**
 * 写权限（提问／重试）判定：读权限成立且为原会话所有者。
 *
 * 同公司可读不等于可续写；会话状态（ACTIVE）由调用方在锁内另行判定，
 * 以便区分 `CONVERSATION_NOT_ACTIVE` 与「不存在／不可见」。
 */
export function canWriteEngineerConversation(facts: EngineerConversationAccessFacts): boolean {
  if (facts.conversationOwnerAccountId !== facts.viewerAccountId) {
    return false;
  }
  return canReadEngineerConversation(facts);
}

/**
 * 工程师会话可见性条件（结构化单一真源）。
 *
 * 判定函数与读侧 SQL 条件共用本文件：
 * - 语义只在此定义一次，读侧（`AiConversationQueryService`）只把条件翻译成 SQL 片段，
 *   不再各自维护一份字符串；
 * - `evaluateEngineerVisibilityConditions` 是纯求值器，用例用它与判定函数对同一组
 *   事实做行为等价断言，防止两套口径漂移。
 */
export type EngineerVisibilityCondition =
  /** 独立会话（会话未绑定工单） */
  | { readonly kind: 'INDEPENDENT_SESSION' }
  /** 会话归属账号是查看者本人 */
  | { readonly kind: 'OWNED_BY_VIEWER' }
  /** 会话绑定了工单 */
  | { readonly kind: 'REQUEST_EXISTS' }
  /** 会话归属公司等于查看者当前可信公司 */
  | { readonly kind: 'OWNED_BY_VIEWER_ORGANIZATION' }
  /** 工单未软删 */
  | { readonly kind: 'REQUEST_NOT_DELETED' }
  /** 工单当前可信服务公司等于查看者当前可信公司 */
  | { readonly kind: 'REQUEST_IN_VIEWER_ORGANIZATION' }
  /** 工单存在可信服务公司（工单服务公司与 intake 服务公司一致才有取值） */
  | { readonly kind: 'INTAKE_SERVICE_ORGANIZATION_PRESENT' }
  /** intake 服务公司与工单服务公司一致（由可信服务公司的取值规则保证） */
  | { readonly kind: 'INTAKE_MATCHES_REQUEST_SERVICE_ORGANIZATION' };

/** 独立会话可见性条件：未绑定工单且归属本人 */
export const ENGINEER_INDEPENDENT_VISIBILITY_CONDITIONS: readonly EngineerVisibilityCondition[] = [
  { kind: 'INDEPENDENT_SESSION' },
  { kind: 'OWNED_BY_VIEWER' },
];

/** 工单会话可见性条件：归属公司一致、工单未软删、当前可信服务公司一致 */
export const ENGINEER_WORK_ORDER_VISIBILITY_CONDITIONS: readonly EngineerVisibilityCondition[] = [
  { kind: 'REQUEST_EXISTS' },
  { kind: 'OWNED_BY_VIEWER_ORGANIZATION' },
  { kind: 'REQUEST_NOT_DELETED' },
  { kind: 'REQUEST_IN_VIEWER_ORGANIZATION' },
  { kind: 'INTAKE_SERVICE_ORGANIZATION_PRESENT' },
  { kind: 'INTAKE_MATCHES_REQUEST_SERVICE_ORGANIZATION' },
];

/**
 * 求值单个可见性条件（纯函数）。
 *
 * 与判定函数同源：`trustedServiceOrganizationId` 的取值规则本身已要求
 * 「工单服务公司 = intake 服务公司」，缺失或冲突即不可见（失败关闭），
 * 因此 intake 一致性条件与其存在性条件同真同假。
 */
export function evaluateEngineerVisibilityCondition(
  condition: EngineerVisibilityCondition,
  facts: EngineerConversationAccessFacts,
): boolean {
  switch (condition.kind) {
    case 'INDEPENDENT_SESSION':
      return facts.requestId === null;
    case 'OWNED_BY_VIEWER':
      return facts.conversationOwnerAccountId === facts.viewerAccountId;
    case 'REQUEST_EXISTS':
      return facts.requestId !== null;
    case 'OWNED_BY_VIEWER_ORGANIZATION':
      return (
        facts.viewerOrganizationId !== null &&
        facts.conversationOwnerOrganizationId === facts.viewerOrganizationId
      );
    case 'REQUEST_NOT_DELETED':
      return facts.requestFacts !== null && facts.requestFacts.deletedAt === null;
    case 'REQUEST_IN_VIEWER_ORGANIZATION':
      return (
        facts.viewerOrganizationId !== null &&
        facts.requestFacts !== null &&
        facts.requestFacts.trustedServiceOrganizationId === facts.viewerOrganizationId
      );
    case 'INTAKE_SERVICE_ORGANIZATION_PRESENT':
      return (
        facts.requestFacts !== null && facts.requestFacts.trustedServiceOrganizationId !== null
      );
    case 'INTAKE_MATCHES_REQUEST_SERVICE_ORGANIZATION':
      return (
        facts.requestFacts !== null && facts.requestFacts.trustedServiceOrganizationId !== null
      );
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/** 求值一组可见性条件（全部成立才可见） */
export function evaluateEngineerVisibilityConditions(
  conditions: readonly EngineerVisibilityCondition[],
  facts: EngineerConversationAccessFacts,
): boolean {
  return conditions.every((condition) => evaluateEngineerVisibilityCondition(condition, facts));
}
