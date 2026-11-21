// src/core/ai/ai-question.policy.ts
// 纯策略：AI 问题正文的规范化与稳定问题 UUID 的格式判定（无 I/O、无框架、无副作用）。

/** 问题正文长度上限（UTF-16 码元，与模型 API 约定一致） */
export const AI_QUESTION_MAX_LENGTH = 2000;

/** 历史上下文条数上限（同会话最近 USER/ASSISTANT 条数，S2 组装使用） */
export const AI_HISTORY_MAX_MESSAGES = 12;

/** 单条历史正文长度上限（S2 组装使用） */
export const AI_HISTORY_MESSAGE_MAX_LENGTH = 2000;

/** 会话轮次上限（`ai_message.turn_no` 约束 1–100） */
export const AI_CONVERSATION_MAX_TURN = 100;

/** RFC 4122 v4 UUID 文本形态（小写十六进制；大小写不敏感） */
const QUESTION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 问题正文规范化（幂等比较口径）。
 *
 * 只做两种无损规范化：
 * - 去除首尾空白（与模型协议「去首尾空白后 1–2000」一致）；
 * - 换行统一为 `\n`（`\r\n`、`\r` 视作同一语义）。
 *
 * 刻意**不**折叠行内空格、不做大小写或全半角转换：那是语义改写，
 * 会让「不同内容」被误判为同一问题，从而静默返回旧答案。
 */
export function normalizeAiQuestionText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

/** 是否为受支持的稳定问题 UUID（前端生成，服务端只校验不重造） */
export function isAiQuestionUuid(value: string): boolean {
  return QUESTION_UUID_PATTERN.test(value);
}

/** 统一小写存储与比较（charset 非二进制，避免大小写造成的重复键歧义） */
export function normalizeAiQuestionUuid(value: string): string {
  return value.trim().toLowerCase();
}

/** 正文长度是否在允许范围内（按已规范化文本判定） */
export function isAiQuestionTextLengthValid(normalized: string): boolean {
  return normalized.length >= 1 && normalized.length <= AI_QUESTION_MAX_LENGTH;
}

/** 下一轮次是否仍可提问（超过 100 轮须另开会话） */
export function canStartNextTurn(nextTurnNo: number): boolean {
  return nextTurnNo <= AI_CONVERSATION_MAX_TURN;
}
