// src/usecases/maintenance-report/maintenance-report-ai-evaluation.helpers.ts
//
// 任务 06 AI 评价与任务 05 真实会话读侧的适配（不改变任务 05 的任何行为）：
// - 候选会话：按来源工单 `ai_conversation.request_id` 过滤（任务 05 可见性不变），
//   只保留所选内容版本内「已有成功回答」的会话；
// - 有效回复：与任务 05 评价范围契约同一口径——`selectAiExportMessages`（core）
//   按版本截断后，`role === 'ASSISTANT'` 且 `turnState === 'SUCCEEDED'`；
// - 冻结范围：以会话 `contentVersion` 为不可变版本，`lastMessageSeq` 为版本内截止点；
//   之后追加的消息 `contentVersion` 更高，不会再进入同一版本范围；
// - 客户首析（任务 03）存放在 `intake_analysis_attempt`，不在 `ai_conversation`，
//   因此按工单读取会话天然不会把客户首析当成工程师辅助排查会话。

import type { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import type { AiConversationDetailQueryResult } from '@src/modules/lithography/ai-conversation.types';
import type { WorkOrderSummaryAiConversationView } from '@src/modules/lithography/maintenance-report.types';
import {
  resolveAiExportCutoffSeq,
  selectAiExportMessages,
} from '@core/ai/ai-conversation-export.policy';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportDraftInput } from './maintenance-report-command.types';

/**
 * 报告 AI 评价来源类型：任务 05 的工单辅助排查会话。
 * 报告侧 `ai_source_type` 仍是自由文本列，这里用固定字面量收束，禁止其它来源冒充。
 */
export const WORK_ORDER_SUMMARY_AI_SOURCE_TYPE = 'AI_CONVERSATION';

/** 单页读取数量（与任务 05 查询服务默认上限一致） */
const AI_CANDIDATE_PAGE_SIZE = 50;
/** 工单会话翻页上限：超过则显式失败，不静默只取前若干页 */
const AI_CANDIDATE_MAX_PAGES = 20;

/** 评价候选项（读侧视图；不含会话正文） */
export type WorkOrderSummaryAiConversationCandidate = WorkOrderSummaryAiConversationView;

/** 评价引用在所选版本内的冻结范围 */
export type WorkOrderSummaryAiEvaluationScope = {
  conversationId: number;
  contentVersion: number;
  lastMessageSeq: number;
  effectiveReplyCount: number;
};

export type MaintenanceReportAiEvaluationFields = Pick<
  MaintenanceReportDraftInput,
  | 'aiUsage'
  | 'aiSourceType'
  | 'aiSourceId'
  | 'aiSourceVersion'
  | 'aiScore'
  | 'aiCorrectness'
  | 'aiHelpfulness'
  | 'aiNote'
>;

/**
 * 读取当前工程师可选的真实会话（按工单过滤、只看有效回复）。
 *
 * 空数组表示「确认没有符合条件的会话」；查询失败会向上抛出异常，
 * 调用方不得把失败当成无会话。
 */
export async function listWorkOrderSummaryAiConversations(params: {
  viewerAccountId: number;
  viewerOrganizationId: number;
  repairRequestId: number;
  aiConversationQueryService: AiConversationQueryService;
}): Promise<WorkOrderSummaryAiConversationCandidate[]> {
  // 逐页读取该工单的全部可见会话，不能只凭第一页宣称「已找全」；
  // 到达翻页上限仍有整页结果时显式失败，避免静默截断。
  const items: Array<{ id: number; requestId: number | null }> = [];
  for (let page = 1; ; page += 1) {
    if (page > AI_CANDIDATE_MAX_PAGES) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
        '该工单的 AI 会话数量超出单次评价可读取范围',
        { repairRequestId: params.repairRequestId, pageSize: AI_CANDIDATE_PAGE_SIZE },
      );
    }
    const result = await params.aiConversationQueryService.listVisible({
      viewer: {
        accountId: params.viewerAccountId,
        organizationId: params.viewerOrganizationId,
      },
      pagination: { page, pageSize: AI_CANDIDATE_PAGE_SIZE, withTotal: false },
      requestId: params.repairRequestId,
    });
    items.push(...result.items);
    if (result.items.length < AI_CANDIDATE_PAGE_SIZE) break;
  }

  const candidates: WorkOrderSummaryAiConversationCandidate[] = [];
  for (const item of items) {
    // 双保险：可见性已由查询服务裁决，这里再收束工单归属，避免跨工单混入
    if (item.requestId !== params.repairRequestId) continue;
    const detail = await params.aiConversationQueryService.findVisibleDetail({
      conversationId: item.id,
      viewer: {
        accountId: params.viewerAccountId,
        organizationId: params.viewerOrganizationId,
      },
    });
    if (detail === null) continue;
    const scope = resolveEvaluationScope(detail, detail.contentVersion);
    if (scope === null) continue;
    candidates.push({
      conversationId: detail.id,
      contentVersion: scope.contentVersion,
      lastMessageSeq: scope.lastMessageSeq,
      effectiveReplyCount: scope.effectiveReplyCount,
      createdAt: detail.createdAt,
      completedAt: detail.completedAt,
    });
  }
  return candidates;
}

/**
 * 「确认无会话才不强制评分」的提交侧裁决（2026-11-21 需求）：
 * 客户端未提供 USED 评价时，必须在事务内逐页枚举适用会话确认确实没有；
 * 枚举失败按失败向上抛出（查询失败不得按无会话提交），仍有适用会话则拒绝提交。
 */
export async function assertNoApplicableWorkOrderSummaryAiConversation(params: {
  viewerAccountId: number;
  viewerOrganizationId: number;
  repairRequestId: number;
  aiConversationQueryService: AiConversationQueryService;
}): Promise<void> {
  const candidates = await listWorkOrderSummaryAiConversations(params);
  if (candidates.length > 0) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_REQUIRED,
      '该工单存在可评价的 AI 辅助排查会话，请选择会话并填写评价后再提交',
      { repairRequestId: params.repairRequestId, applicableCount: candidates.length },
    );
  }
}

/**
 * 校验并解析报告里的 AI 评价引用（工单总结）：
 * - `NOT_USED`：没有引用，返回 null；
 * - `USED`：来源必须是本人工单会话、同一公司、版本存在且该版本范围内有有效回复。
 *
 * 任何不成立都失败关闭，不把「查不到/查失败」当成「无会话」。
 */
export async function assertWorkOrderSummaryAiEvaluationReference(params: {
  ai: MaintenanceReportAiEvaluationFields;
  viewerAccountId: number;
  viewerOrganizationId: number;
  repairRequestId: number;
  aiConversationQueryService: AiConversationQueryService;
}): Promise<WorkOrderSummaryAiEvaluationScope | null> {
  if (params.ai.aiUsage !== 'USED') return null;

  const sourceType = params.ai.aiSourceType ?? '';
  if (sourceType !== WORK_ORDER_SUMMARY_AI_SOURCE_TYPE) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
      `AI 评价来源必须是工单辅助排查会话（${WORK_ORDER_SUMMARY_AI_SOURCE_TYPE}）`,
      { aiSourceType: sourceType },
    );
  }
  const conversationId = parsePositiveInt(params.ai.aiSourceId);
  const contentVersion = parsePositiveInt(params.ai.aiSourceVersion);
  if (conversationId === null || contentVersion === null) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
      'AI 评价必须绑定会话标识与不可变内容版本',
      { aiSourceId: params.ai.aiSourceId, aiSourceVersion: params.ai.aiSourceVersion },
    );
  }

  const detail = await params.aiConversationQueryService.findVisibleDetail({
    conversationId,
    viewer: {
      accountId: params.viewerAccountId,
      organizationId: params.viewerOrganizationId,
    },
  });
  // 不存在与无权按同口径拒绝，不泄露会话存在性
  if (detail === null) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
      'AI 评价来源会话不存在或无权访问',
      { conversationId },
    );
  }
  if (detail.requestId !== params.repairRequestId) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
      'AI 评价来源会话不属于当前工单',
      { conversationId, requestId: detail.requestId, repairRequestId: params.repairRequestId },
    );
  }
  if (
    detail.ownerOrganizationId !== null &&
    detail.ownerOrganizationId !== params.viewerOrganizationId
  ) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
      'AI 评价来源会话不属于当前公司',
      { conversationId },
    );
  }

  if (contentVersion > detail.contentVersion) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
      'AI 评价绑定的内容版本不存在',
      { conversationId, contentVersion, currentVersion: detail.contentVersion },
    );
  }
  const scope = resolveEvaluationScope(detail, contentVersion);
  if (scope === null) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_NOT_APPLICABLE,
      '该会话在所选内容版本内没有有效回复，不能作为评价来源',
      { conversationId, contentVersion },
    );
  }
  return scope;
}

/**
 * 解析会话在指定版本内的评价范围；版本不存在或无有效回复时返回 null。
 * 与任务 05 `GetAiConversationEvaluationScopeUsecase` 共用同一 core 策略。
 */
function resolveEvaluationScope(
  detail: AiConversationDetailQueryResult,
  contentVersion: number,
): WorkOrderSummaryAiEvaluationScope | null {
  if (!Number.isInteger(contentVersion) || contentVersion <= 0) return null;
  if (contentVersion > detail.contentVersion) return null;
  const messages = selectAiExportMessages({
    messages: detail.messages.map((message) => ({
      messageId: message.id,
      messageSeq: message.messageSeq,
      turnNo: message.turnNo,
      role: message.role,
      text: message.contentText,
      contentVersion: message.contentVersion,
      createdAt: message.createdAt.toISOString(),
    })),
    contentVersion,
  });
  const effectiveReplyCount = messages.filter(
    (message) => message.role === 'ASSISTANT' && message.turnState === 'SUCCEEDED',
  ).length;
  if (effectiveReplyCount === 0) return null;
  return {
    conversationId: detail.id,
    contentVersion,
    lastMessageSeq: resolveAiExportCutoffSeq(messages),
    effectiveReplyCount,
  };
}

/** 解析稳定标识/版本号（字符串形态保存的整数）；非正整数返回 null */
function parsePositiveInt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 库内既有 AI 评价组（报告行事实） */
export type StoredWorkOrderSummaryAiEvaluation = {
  aiUsage: string | null;
  aiSourceType: string | null;
  aiSourceId: string | null;
  aiSourceVersion: string | null;
  aiScore: number | null;
  aiCorrectness: string | null;
  aiHelpfulness: number | null;
  aiNote: string | null;
};

/**
 * 合并 AI 评价组：客户端显式提供的字段优先，未提供沿用库内值。
 *
 * - 归一到 `NOT_USED` 时整组清空，避免「切换为未使用」后残留旧评分/引用；
 * - 不在这里校验评分范围（由 normalize 统一裁决），也不猜测会话来源。
 */
export function resolveWorkOrderSummaryAiEvaluationInput(
  patch: MaintenanceReportAiEvaluationFields,
  stored: StoredWorkOrderSummaryAiEvaluation | null,
): MaintenanceReportAiEvaluationFields {
  const pick = (key: keyof StoredWorkOrderSummaryAiEvaluation): unknown =>
    patch[key] !== undefined ? patch[key] : (stored?.[key] ?? null);
  const aiUsage = (pick('aiUsage') ?? 'NOT_USED') as string;
  if (aiUsage !== 'USED') {
    return {
      aiUsage: 'NOT_USED',
      aiSourceType: null,
      aiSourceId: null,
      aiSourceVersion: null,
      aiScore: null,
      aiCorrectness: null,
      aiHelpfulness: null,
      aiNote: null,
    };
  }
  return {
    aiUsage: 'USED',
    aiSourceType: (pick('aiSourceType') ?? null) as string | null,
    aiSourceId: (pick('aiSourceId') ?? null) as string | null,
    aiSourceVersion: (pick('aiSourceVersion') ?? null) as string | null,
    aiScore: (pick('aiScore') ?? null) as number | null,
    aiCorrectness: (pick('aiCorrectness') ?? null) as string | null,
    aiHelpfulness: (pick('aiHelpfulness') ?? null) as number | null,
    aiNote: (pick('aiNote') ?? null) as string | null,
  };
}
