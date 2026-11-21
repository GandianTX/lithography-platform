// src/core/ai/ai-conversation-export.policy.ts
// AI 诊断导出策略（任务 05 · S4.2）
//
// 需求口径（R039-01 / R040-01）：
// - 固定本次消息范围和版本 → 校验读取权 → 生成 PDF；
// - 不混入导出中新消息，不重算模型；未完成或失败如实标记；无模型名版本不编造；
// - 生成失败不返回空文件；
// - 原始 JSON 属受控技术操作，排除密码、令牌及无权公司数据，不做普通用户页面。

/** 导出目标格式 */
export type AiExportFormat = 'PDF' | 'RAW_JSON';

/** 导出快照中的单条消息 */
export interface AiExportMessageSnapshot {
  readonly messageId: number;
  readonly messageSeq: number;
  readonly turnNo: number | null;
  readonly role: string;
  readonly text: string;
  readonly contentVersion: number;
  readonly createdAt: string;
  /** 该消息所属轮次在本次固定版本内的状态（如实标记用） */
  readonly turnState: AiExportTurnState;
}

/**
 * 轮次状态（如实标记，不美化）。
 *
 * `SUCCEEDED` / `UNKNOWN` 是当前口径的产出：
 * - `SUCCEEDED`：本版本范围内已有该轮已保存的回答；
 * - `UNKNOWN`：本版本范围内没有该轮回答（PDF 显示「本版未收录回答」）。
 *
 * `FAILED` / `PENDING` / `RUNNING` 仅保留枚举兼容（旧 JSON 消费者与历史产物），
 * 固定版本快照不再根据当前 `analysis.status` 产出这三个值。
 */
export type AiExportTurnState = 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'RUNNING' | 'UNKNOWN';

/** 导出快照（服务端选定版本与消息范围） */
export interface AiExportSnapshot {
  readonly conversationId: number;
  /** 固定的内容版本（导出入口必须显式选定） */
  readonly contentVersion: number;
  /** 固定范围内的最后消息序号（用于声明截止点） */
  readonly lastMessageSeq: number;
  readonly requestNo: string | null;
  readonly requestId: number | null;
  /** 会话归属工程师昵称（导出正文展示用） */
  readonly engineerNickname: string;
  readonly messages: readonly AiExportMessageSnapshot[];
  readonly createdAt: string;
}

/**
 * 选择导出范围内消息：仅保留版本号 ≤ 选定版本的消息。
 *
 * P2-2 口径：轮次状态只由「本版本范围内保存了什么」推出，不读取当前 `analysis.status`。
 * - 范围内已有该轮 ASSISTANT 回答 → `SUCCEEDED`；
 * - 范围内没有该轮回答（含问题版本内、回答版本更晚的半轮）→ `UNKNOWN`（本版未收录回答）。
 *
 * 失败与正式重试会原地改写 `analysis.status`，若跟随当前状态，同一个 V 的 JSON/PDF
 * 会在两次读取之间漂移；按版本内消息推导后，同一 V 的产物只随消息追加而改变。
 */
export function selectAiExportMessages(input: {
  readonly messages: ReadonlyArray<{
    readonly messageId: number;
    readonly messageSeq: number;
    readonly turnNo: number | null;
    readonly role: string;
    readonly text: string;
    readonly contentVersion: number;
    readonly createdAt: string;
  }>;
  readonly contentVersion: number;
}): AiExportMessageSnapshot[] {
  const messages = input.messages
    .filter((message) => message.contentVersion <= input.contentVersion)
    .sort((left, right) => left.messageSeq - right.messageSeq);

  const answeredInScope = new Set<number>();
  for (const message of messages) {
    if (message.role === 'ASSISTANT' && message.turnNo !== null) {
      answeredInScope.add(message.turnNo);
    }
  }

  return messages.map((message) => ({
    messageId: message.messageId,
    messageSeq: message.messageSeq,
    turnNo: message.turnNo,
    role: message.role,
    text: message.text,
    contentVersion: message.contentVersion,
    createdAt: message.createdAt,
    turnState: resolveTurnStateInVersion(message.turnNo, answeredInScope),
  }));
}

/** 版本内轮次状态：有已保存回答才算成功，否则无法确定执行状态 */
function resolveTurnStateInVersion(
  turnNo: number | null,
  answeredInScope: ReadonlySet<number>,
): AiExportTurnState {
  if (turnNo === null) {
    return 'UNKNOWN';
  }
  return answeredInScope.has(turnNo) ? 'SUCCEEDED' : 'UNKNOWN';
}

/** 计算快照截止点（范围内最后一条消息序号；无消息时为 0） */
export function resolveAiExportCutoffSeq(messages: ReadonlyArray<AiExportMessageSnapshot>): number {
  return messages.length === 0 ? 0 : Math.max(...messages.map((message) => message.messageSeq));
}

/** 校验导出入口给定的内容版本：必须是正整数 */
export function isAiExportContentVersionValid(contentVersion: number): boolean {
  return Number.isInteger(contentVersion) && contentVersion > 0;
}

/** 导出文件名（不含路径分隔符，仅 ASCII 安全字符 + UTF-8 保留） */
export function buildAiExportFileName(input: {
  readonly conversationId: number;
  readonly contentVersion: number;
  readonly format: AiExportFormat;
}): string {
  const extension = input.format === 'PDF' ? 'pdf' : 'json';
  return `ai-conversation-${input.conversationId}-v${input.contentVersion}.${extension}`;
}

/**
 * 受控 JSON 的脱敏：排除令牌、密码类键值与账号联系方式，
 * 只保留迁移/排查需要的标识、时间与正文。
 */
export function buildAiExportRawJson(snapshot: AiExportSnapshot): Record<string, unknown> {
  return {
    schemaVersion: 1,
    conversation: {
      conversationId: snapshot.conversationId,
      contentVersion: snapshot.contentVersion,
      lastMessageSeq: snapshot.lastMessageSeq,
      requestId: snapshot.requestId,
      requestNo: snapshot.requestNo,
      engineerNickname: snapshot.engineerNickname,
      createdAt: snapshot.createdAt,
    },
    messages: snapshot.messages.map((message) => ({
      messageId: message.messageId,
      messageSeq: message.messageSeq,
      turnNo: message.turnNo,
      role: message.role,
      contentVersion: message.contentVersion,
      createdAt: message.createdAt,
      turnState: message.turnState,
      text: message.text,
    })),
  };
}
