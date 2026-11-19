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
  /** 该消息是否属于失败/未完成轮次（如实标记用） */
  readonly turnState: AiExportTurnState;
}

/** 轮次状态（如实标记，不美化） */
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

/** 选择导出范围内消息：仅保留版本号 ≤ 选定版本的消息 */
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
  readonly turnStates: ReadonlyMap<number, AiExportTurnState>;
}): AiExportMessageSnapshot[] {
  return input.messages
    .filter((message) => message.contentVersion <= input.contentVersion)
    .sort((left, right) => left.messageSeq - right.messageSeq)
    .map((message) => ({
      messageId: message.messageId,
      messageSeq: message.messageSeq,
      turnNo: message.turnNo,
      role: message.role,
      text: message.text,
      contentVersion: message.contentVersion,
      createdAt: message.createdAt,
      turnState:
        message.turnNo === null ? 'UNKNOWN' : (input.turnStates.get(message.turnNo) ?? 'UNKNOWN'),
    }));
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
