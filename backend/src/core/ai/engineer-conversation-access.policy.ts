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
// 读侧 SQL（`AiConversationQueryService.applyVisibility`）必须与本文件判定等价，
// 任一处改动都要同步另一处与对应测试。

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
