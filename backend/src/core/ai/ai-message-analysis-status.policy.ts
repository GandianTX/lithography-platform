// src/core/ai/ai-message-analysis-status.policy.ts
// 纯策略：AI 问题分析状态的解析与流转判定（无 I/O、无框架、无副作用）。

import { AiMessageAnalysisStatus } from '@app-types/models/ai-conversation.types';

const ANALYSIS_STATUS_VALUES: ReadonlyArray<string> = [
  AiMessageAnalysisStatus.PENDING,
  AiMessageAnalysisStatus.RUNNING,
  AiMessageAnalysisStatus.SUCCEEDED,
  AiMessageAnalysisStatus.FAILED,
];

/** 是否为受支持的分析状态字面值 */
export function isAiMessageAnalysisStatus(value: unknown): value is AiMessageAnalysisStatus {
  return typeof value === 'string' && ANALYSIS_STATUS_VALUES.includes(value);
}

/**
 * 把数据库 varchar 值收敛为正式枚举。
 *
 * 数据库列没有 CHECK 约束（历史原因），遇到未知值必须失败关闭，
 * 不得用默认值兜底冒充已知状态。
 *
 * @throws RangeError 当取值不在枚举范围内
 */
export function parseAiMessageAnalysisStatus(value: string): AiMessageAnalysisStatus {
  if (!isAiMessageAnalysisStatus(value)) {
    throw new RangeError(`unsupported_ai_message_analysis_status:${value}`);
  }
  return value;
}

/** 终态：不再接受新的执行回写 */
export function isAiMessageAnalysisTerminal(status: AiMessageAnalysisStatus): boolean {
  return status === AiMessageAnalysisStatus.SUCCEEDED || status === AiMessageAnalysisStatus.FAILED;
}

/** 允许重试的起点：仅已确认失败的问题可重试 */
export function canRetryAiMessageAnalysis(status: AiMessageAnalysisStatus): boolean {
  return status === AiMessageAnalysisStatus.FAILED;
}
