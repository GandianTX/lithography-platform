// src/core/ai/ai-conversation-reply.policy.ts
// 纯策略：解析并校验模型回复信封；正文与图形分别裁决（图形非法只降级）。
// 无 I/O、无框架、无副作用。

import {
  AI_CONVERSATION_SCENE_ID,
  AI_CONVERSATION_SCHEMA_VERSION,
} from './ai-conversation-request.policy';

/** 回复正文上限（UTF-16 码元） */
export const AI_CONVERSATION_REPLY_TEXT_MAX_UNITS = 12000;

/** 图形部件白名单（11 个；几何与配色由前端定义，服务端只校验标识） */
export const AI_VISUALIZATION_PART_IDS = [
  'controller',
  'reticle_cassette',
  'reticle_arm',
  'reticle_table',
  'reticle_vacuum',
  'positioning_laser',
  'wafer_cassette',
  'wafer_arm',
  'alignment_table',
  'wafer_stage',
  'projection_lens',
] as const;

/** 部件展示态（API 约定：NORMAL/HIGHLIGHT/WARNING/HIDDEN；几何与配色由前端定义） */
export const AI_VISUALIZATION_DISPLAYS = ['NORMAL', 'WARNING', 'HIGHLIGHT', 'HIDDEN'] as const;

/** 图形必须给齐的部件数（API 约定：给齐 11 个部件，缺失即降级） */
export const AI_VISUALIZATION_REQUIRED_PART_COUNT = AI_VISUALIZATION_PART_IDS.length;

export type AiVisualizationPartId = (typeof AI_VISUALIZATION_PART_IDS)[number];
export type AiVisualizationDisplay = (typeof AI_VISUALIZATION_DISPLAYS)[number];

export type AiConversationVisualization = {
  readonly sceneId: string;
  /** 本轮推测阶段；模型证据不足时为 null（API 约定允许） */
  readonly stage: number | null;
  readonly parts: ReadonlyArray<{
    readonly partId: AiVisualizationPartId;
    readonly display: AiVisualizationDisplay;
  }>;
};

export type AiConversationReplyParseResult = {
  readonly text: string;
  readonly visualization: AiConversationVisualization | null;
  /** 图形缺失或非法而正文保留时为 true（用于诊断与前端提示） */
  readonly visualizationDegraded: boolean;
};

/** 回复无法使用的原因码（写入 `ai_message_analysis.failure_reason`） */
export type AiConversationReplyFailureReason =
  | 'invalid_json'
  | 'invalid_envelope'
  | 'unsupported_schema_version'
  | 'request_id_mismatch'
  | 'empty_text'
  | 'text_too_long';

export class AiConversationReplyError extends Error {
  constructor(
    readonly reason: AiConversationReplyFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'AiConversationReplyError';
  }
}

/**
 * 解析回复信封。
 *
 * 失败关闭的范围（整轮判失败）：
 * - 非 JSON / 非对象信封；
 * - `schemaVersion !== 1`；
 * - `requestId` 与请求不一致（防止串轮）；
 * - `content.text` 缺失、空白或超长。
 *
 * 只降级的范围（正文保留、图形置空并标记降级）：
 * - `content.visualization` 缺失、结构非法、部件不在白名单、展示态非法。
 */
export function parseAiConversationReply(
  rawOutputText: string,
  expectedRequestId: string,
): AiConversationReplyParseResult {
  const parsed = parseJsonObject(rawOutputText);
  if (parsed === null) {
    throw new AiConversationReplyError('invalid_json', '模型回复不是合法 JSON 对象');
  }

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== AI_CONVERSATION_SCHEMA_VERSION) {
    throw new AiConversationReplyError('unsupported_schema_version', '模型回复的协议版本不受支持');
  }
  if (typeof parsed.requestId !== 'string' || parsed.requestId !== expectedRequestId) {
    throw new AiConversationReplyError('request_id_mismatch', '模型回复的问题标识与请求不一致');
  }

  const content = parsed.content;
  if (!isPlainObject(content)) {
    throw new AiConversationReplyError('invalid_envelope', '模型回复缺少 content 对象');
  }

  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (text.length === 0) {
    throw new AiConversationReplyError('empty_text', '模型回复正文为空');
  }
  if (text.length > AI_CONVERSATION_REPLY_TEXT_MAX_UNITS) {
    throw new AiConversationReplyError('text_too_long', '模型回复正文超出长度上限');
  }

  const visualization = normalizeVisualization(content.visualization);
  return {
    text,
    visualization: visualization.visualization,
    visualizationDegraded: visualization.degraded,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVisualization(value: unknown): {
  visualization: AiConversationVisualization | null;
  degraded: boolean;
} {
  if (value === undefined || value === null) {
    return { visualization: null, degraded: false };
  }
  if (!isVisualizationEnvelope(value)) {
    return { visualization: null, degraded: true };
  }
  const parts = normalizeVisualizationParts(value.parts);
  if (parts === null) {
    return { visualization: null, degraded: true };
  }
  return {
    visualization: { sceneId: AI_CONVERSATION_SCENE_ID, stage: value.stage, parts },
    degraded: false,
  };
}

/** 信封级校验：sceneId、stage（1–10 或 null）、parts 必须为数组 */
function isVisualizationEnvelope(
  value: unknown,
): value is { sceneId: string; stage: number | null; parts: unknown[] } {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.sceneId !== AI_CONVERSATION_SCENE_ID) {
    return false;
  }
  // API 约定：回复 stage 为 1–10 或 null（模型证据不足时显式返回 null）。
  const stage = value.stage;
  if (
    stage !== null &&
    (typeof stage !== 'number' || !Number.isInteger(stage) || stage < 1 || stage > 10)
  ) {
    return false;
  }
  return Array.isArray(value.parts);
}

/** 部件级校验：给齐 11 个部件且不重复；缺失/重复/未知项 → 整体降级 */
function normalizeVisualizationParts(
  parts: unknown[],
): AiConversationVisualization['parts'] | null {
  if (parts.length !== AI_VISUALIZATION_REQUIRED_PART_COUNT) {
    return null;
  }
  const normalized: Array<{ partId: AiVisualizationPartId; display: AiVisualizationDisplay }> = [];
  const seen = new Set<string>();
  for (const item of parts) {
    const part = normalizeVisualizationPart(item);
    if (part === null || seen.has(part.partId)) {
      return null;
    }
    seen.add(part.partId);
    normalized.push(part);
  }
  return normalized;
}

function normalizeVisualizationPart(
  item: unknown,
): { partId: AiVisualizationPartId; display: AiVisualizationDisplay } | null {
  if (!isPlainObject(item)) {
    return null;
  }
  const partId = item.partId;
  const display = item.display;
  if (
    typeof partId !== 'string' ||
    !(AI_VISUALIZATION_PART_IDS as ReadonlyArray<string>).includes(partId)
  ) {
    return null;
  }
  if (
    typeof display !== 'string' ||
    !(AI_VISUALIZATION_DISPLAYS as ReadonlyArray<string>).includes(display)
  ) {
    return null;
  }
  return {
    partId: partId as AiVisualizationPartId,
    display: display as AiVisualizationDisplay,
  };
}
