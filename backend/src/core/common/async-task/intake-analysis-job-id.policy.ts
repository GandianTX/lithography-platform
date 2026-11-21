// src/core/common/async-task/intake-analysis-job-id.policy.ts
// 首析投递 jobId 策略（任务 03 第二段）。
//
// jobId 是首析自己的持久任务标识：
// - 账本（base_async_task_record）与 BullMQ 共用同一确定性 jobId；
// - 提交/重试事务内登记账本行，提交后 enqueue 失败或进程退出时，
//   housekeeping 只凭「queueName = intake-analysis」的账本行定位并补投，
//   不扫描 repair_request_intake 的 WAITING 行，开发 Seed 的待分析样例不会进入投递；
// - 代次进入 jobId：主动重试 0→1 产生新 jobId，旧代次任务不会被新代次复用或覆盖。
//
// BullMQ 5.x 对自定义 jobId 的实际校验（以安装版本 5.79.2 源码为准）：
// - Queue.add：jobId 不得为 '0' 或以 '0:' 开头（"JobId cannot be '0' or start with 0:"）；
// - Job.validateOptions：纯数字字符串拒绝（"Custom Id cannot be integers"）；
// - Job.validateOptions：含 ':' 时必须恰好 3 段，否则抛 "Custom Id cannot contain :"
//   （源码注明下个大版本计划改为一律禁止冒号）。
// 本策略 `intake-analysis:{intakeId}:g{generationNo}` 恰好 3 段、非纯数字、
// 不以 '0:' 开头，当前版本可用；intakeId 与代次均不含冒号，段数恒为 3。
// 升级 BullMQ 大版本前必须复核该校验：若冒号被全面禁止，需把本策略改为
// 无冒号格式，并同步账本行 jobId、housekeeping 解析与 Worker 归属核对口径，
// 由本文件单一收口（parseIntakeAnalysisJobId 的正则随之调整）。
// 注意：已存在的终态保留 job 即使同 jobId 再次 add 也不会自动进入 waiting，
// 恢复必须经由 housekeeping 的「终态移除 + 补投」路径。

export const INTAKE_ANALYSIS_QUEUE_NAME = 'intake-analysis' as const;
export const INTAKE_ANALYSIS_JOB_NAME = 'analyze' as const;

/** 首析审计 bizType（AI 链路统一 bizKey = traceId） */
export const INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE = 'intake_analysis';

/** 与 queue-registry 的 intake-analysis attempts 保持一致（账本行 maxAttempts 记录值） */
export const INTAKE_ANALYSIS_MAX_ATTEMPTS = 3;

const JOB_ID_PATTERN = /^intake-analysis:(\d+):g([01])$/;

/** 构造确定性 jobId：intake-analysis:{intakeId}:g{generationNo} */
export function buildIntakeAnalysisJobId(input: {
  readonly intakeId: number;
  readonly generationNo: number;
}): string {
  if (!Number.isSafeInteger(input.intakeId) || input.intakeId <= 0) {
    throw new Error('intake_analysis_job_id_invalid_intake_id');
  }
  if (input.generationNo !== 0 && input.generationNo !== 1) {
    throw new Error('intake_analysis_job_id_invalid_generation');
  }
  return `${INTAKE_ANALYSIS_QUEUE_NAME}:${input.intakeId}:g${input.generationNo}`;
}

/** 解析 jobId；不匹配返回 null（Worker 归属核对时用于拒绝异构 job） */
export function parseIntakeAnalysisJobId(
  jobId: string,
): { readonly intakeId: number; readonly generationNo: number } | null {
  const match = JOB_ID_PATTERN.exec(jobId);
  if (!match) {
    return null;
  }
  const intakeId = Number(match[1]);
  const generationNo = Number(match[2]);
  if (!Number.isSafeInteger(intakeId) || intakeId <= 0) {
    return null;
  }
  return { intakeId, generationNo };
}
