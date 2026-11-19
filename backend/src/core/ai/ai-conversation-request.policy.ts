// src/core/ai/ai-conversation-request.policy.ts
// 纯策略：组装 AI 对话的模型请求信封（历史截断、阶段/故障/机型上下文归一）。
// 无 I/O、无框架、无副作用；不读取数据库，也不决定派发与保存。

/** 模型协议版本（与 02/03、04/04 样例一致） */
export const AI_CONVERSATION_SCHEMA_VERSION = 1;

/** 场景标识（光刻维护工作流） */
export const AI_CONVERSATION_SCENE_ID = 'LITHO_WORKFLOW_V1';

/** 历史条数上限（不含本轮问题） */
export const AI_CONVERSATION_HISTORY_LIMIT = 12;

/** 单条历史正文上限（UTF-16 码元） */
export const AI_CONVERSATION_HISTORY_ITEM_MAX_UNITS = 2000;

/** 问题正文上限（UTF-16 码元） */
export const AI_CONVERSATION_QUESTION_MAX_UNITS = 2000;

/** 阶段范围 */
export const AI_CONVERSATION_STAGE_MIN = 1;
export const AI_CONVERSATION_STAGE_MAX = 10;

/** 上下文模式 */
export type AiConversationContextMode = 'INDEPENDENT' | 'WORK_ORDER';

export type AiConversationHistoryRole = 'USER' | 'ASSISTANT';

export type AiConversationHistoryItem = {
  readonly role: AiConversationHistoryRole;
  readonly content: string;
};

/**
 * 故障事实八字段（API 约定：mainError、unitError、source、errorType、
 * gpibStatus、description、action、status；均为 string 或 null，保留字符串 "0"）。
 * 工单通用 error_code 只有经业务确认属于 Main Error 时才填 mainError。
 */
export type AiConversationFaultFacts = {
  readonly mainError?: string | null;
  readonly unitError?: string | null;
  readonly source?: string | null;
  readonly errorType?: string | null;
  readonly gpibStatus?: string | null;
  readonly description?: string | null;
  readonly action?: string | null;
  readonly status?: string | null;
};

/** 信封 fault 的固定键序（未知值填 null，符合 API 约定） */
export const AI_CONVERSATION_FAULT_KEYS = [
  'mainError',
  'unitError',
  'source',
  'errorType',
  'gpibStatus',
  'description',
  'action',
  'status',
] as const;

export type AiConversationRequestContext = {
  readonly mode: AiConversationContextMode;
  readonly equipmentModelCode: string | null;
  readonly stage: number | null;
  readonly fault: AiConversationFaultFacts | null;
};

export type AiConversationRequestEnvelope = {
  readonly schemaVersion: typeof AI_CONVERSATION_SCHEMA_VERSION;
  readonly requestId: string;
  readonly sceneId: typeof AI_CONVERSATION_SCENE_ID;
  readonly question: string;
  readonly history: ReadonlyArray<AiConversationHistoryItem>;
  readonly context: AiConversationRequestContext;
};

export type BuildAiConversationRequestInput = {
  readonly questionUuid: string;
  readonly question: string;
  /** 会话内历史，按 message_seq 升序（实现方负责只取本轮之前） */
  readonly history: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly mode: AiConversationContextMode;
  readonly equipmentModelCode?: string | null;
  readonly stage?: number | null;
  readonly fault?: AiConversationFaultFacts | null;
};

/**
 * 按 UTF-16 码元截断且不切断代理对。
 *
 * 协议以 UTF-16 码元计数，直接 `slice` 可能把 emoji 等代理对切成半个字符，
 * 使模型侧解码失败或产生乱码。
 */
export function truncateAiHistoryText(raw: string, maxUnits: number): string {
  if (raw.length <= maxUnits) {
    return raw;
  }
  let end = maxUnits;
  const lastCode = raw.charCodeAt(end - 1);
  // 高代理项（0xD800–0xDBFF）被截在末尾时，退一格避免半个代理对
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return raw.slice(0, end);
}

/** 阶段是否合法（1–10 或 null） */
export function isAiConversationStageValid(value: number | null): boolean {
  if (value === null) {
    return true;
  }
  return (
    Number.isInteger(value) &&
    value >= AI_CONVERSATION_STAGE_MIN &&
    value <= AI_CONVERSATION_STAGE_MAX
  );
}

/** 只保留 USER/ASSISTANT 且正文非空的历史条目，按原顺序截取最近 N 条 */
export function selectAiConversationHistory(
  history: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): AiConversationHistoryItem[] {
  const usable = history.filter(
    (item) => (item.role === 'USER' || item.role === 'ASSISTANT') && item.text.trim().length > 0,
  );
  const selected = usable.slice(Math.max(usable.length - AI_CONVERSATION_HISTORY_LIMIT, 0));
  return selected.map((item) => ({
    role: item.role as AiConversationHistoryRole,
    content: truncateAiHistoryText(item.text.trim(), AI_CONVERSATION_HISTORY_ITEM_MAX_UNITS),
  }));
}

/**
 * 组装请求信封。
 *
 * - `requestId` 恒等于稳定问题 UUID（协议层唯一标识，重试不改变）；
 * - 上下文只放服务端已确认为真的信息：机型编码来自关联工单，故障事实缺省为 null；
 * - 不投递任何文件 URL、账号或公司标识。
 */
export function buildAiConversationRequest(
  input: BuildAiConversationRequestInput,
): AiConversationRequestEnvelope {
  const stage = input.stage === undefined ? null : input.stage;
  if (!isAiConversationStageValid(stage)) {
    throw new Error('ai_conversation_stage_invalid');
  }

  return {
    schemaVersion: AI_CONVERSATION_SCHEMA_VERSION,
    requestId: input.questionUuid,
    sceneId: AI_CONVERSATION_SCENE_ID,
    question: input.question.trim(),
    history: selectAiConversationHistory(input.history),
    context: {
      mode: input.mode,
      equipmentModelCode: normalizeOptionalCode(input.equipmentModelCode),
      stage,
      fault: normalizeFaultFacts(input.fault),
    },
  };
}

function normalizeOptionalCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeFaultFacts(
  fault: AiConversationFaultFacts | null | undefined,
): AiConversationFaultFacts | null {
  if (!fault) {
    return null;
  }
  // API 约定：八字段全部出现，未知值填 null（保留字符串 "0"）；
  // 全部未知时整体填 null（「未知填 null」针对 fault 对象本身）。
  let known = false;
  const normalized = Object.fromEntries(
    AI_CONVERSATION_FAULT_KEYS.map((key) => {
      const raw = fault[key];
      const value = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
      if (value !== null) {
        known = true;
      }
      return [key, value];
    }),
  ) as AiConversationFaultFacts;
  return known ? normalized : null;
}
