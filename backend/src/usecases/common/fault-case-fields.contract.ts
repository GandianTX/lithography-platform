// src/usecases/common/fault-case-fields.contract.ts

import type { ContentSubmissionHandlingStatus } from '@src/modules/lithography/content-submission.types';

/**
 * 故障案例共享边界契约（usecases/common 契约位：跨域共用，架构规则豁免跨域导入）。
 *
 * 正式案例可读正文的格式化单一真源（A-PR0 §S5.2 / §S6.2）：
 * - 审核发布链路（usecases/content-submission）由冻结快照字段生成正式正文；
 * - 案例专属更正链路（usecases/reference-document）由合并后明细字段重新生成正文。
 * 两条链路必须产出同构正文（同字段、同顺序、同标签），因此格式化逻辑只在本位维护；
 * 各域禁止各自复制一份实现，避免更正后正文与发布口径静默漂移。
 */

/** 可读正文生成输入：错误码/条件/排查/措施/结果可空；现象/复现/状态必填（调用方校验后传入） */
export type FaultCaseReferenceContentInput = {
  errorCode: string | null;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  handlingStatus: ContentSubmissionHandlingStatus;
  resolution: string | null;
};

/** 案例处理状态中文标签（正式正文可读化；值域由受控常量保证） */
const FAULT_CASE_HANDLING_STATUS_LABELS: Record<ContentSubmissionHandlingStatus, string> = {
  UNRESOLVED: '未解决',
  IN_PROGRESS: '处理中',
  RESOLVED: '已解决',
};

/**
 * 正式案例可读正文生成（A-PR0 §2.3 案例行 + S5.2「由同一份字段生成可读正文」）：
 * 由与结构化明细同一份冻结字段确定性组装：现象/复现步骤/处理状态必填总出现，
 * 可选字段非空时列入；不引入 OCR/解析，字段原样放入（不重复转义）。
 */
export function formatFaultCaseReferenceContent(detail: FaultCaseReferenceContentInput): string {
  const blocks: string[] = [];
  if (detail.errorCode !== null) {
    blocks.push(`错误码：${detail.errorCode}`);
  }
  blocks.push(`故障现象：\n${detail.phenomenon}`);
  if (detail.conditionText !== null) {
    blocks.push(`触发条件：\n${detail.conditionText}`);
  }
  blocks.push(`复现步骤：\n${detail.reproductionSteps}`);
  if (detail.diagnosis !== null) {
    blocks.push(`排查过程：\n${detail.diagnosis}`);
  }
  if (detail.actionTaken !== null) {
    blocks.push(`处理措施：\n${detail.actionTaken}`);
  }
  blocks.push(`处理状态：${FAULT_CASE_HANDLING_STATUS_LABELS[detail.handlingStatus]}`);
  if (detail.resolution !== null) {
    blocks.push(`处理结果：\n${detail.resolution}`);
  }
  return blocks.join('\n\n');
}
