// src/usecases/common/ports/ai-workflow-admission.contract.ts
// 跨域端口契约：ai 对话（05）等工作流域需要「创建并受理 AI 工作流」能力。
//
// 依赖无关（不得 import 任何域实现）：实现方为 ai-workflow 域的
// `AiWorkflowAdmissionAdapter`（委托 `CreateAndAdmitAiWorkflowUsecase`），
// 由 adapter 层模块装配进消费域模块图（与 TRANSACTION_RUNNER 同模式）。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

export const AI_WORKFLOW_ADMISSION_PORT = Symbol('AI_WORKFLOW_ADMISSION_PORT');

/** 受理结果状态（与 ai-workflow 域 `CreateAndAdmitAiWorkflowResult` 的状态集一致） */
export type AiWorkflowAdmissionStatus =
  'QUEUED' | 'ADMISSION_WAITING' | 'EXISTING_ACTIVE' | 'STALE_QUEUED' | 'CONFLICT';

export interface AiWorkflowAdmissionRequest {
  readonly workflowType: string;
  readonly workflowDedupKey?: string | null;
  readonly inputPayload: Record<string, unknown>;
  readonly bizType: string;
  readonly bizKey: string;
  readonly bizSubKey?: string | null;
  readonly source: string;
  readonly actorAccountId?: number | null;
  readonly actorActiveRole?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
}

export interface AiWorkflowAdmissionResult {
  readonly status: AiWorkflowAdmissionStatus;
  readonly workflowId: string | null;
  readonly traceId: string | null;
  readonly jobId: string | null;
}

/**
 * 受理事务内的准备结果（任务05 Q01／B2）。
 *
 * - `PREPARED`：本次调用在调用方事务内创建了「已受理、待投递」的事实；
 * - `EXISTING_ACTIVE`：该去重键已有未终态执行（并发受理或上一执行尚未收尾），
 *   调用方不得把它当成新一次执行成功。
 */
export interface AiWorkflowAdmissionPrepareResult {
  readonly status: 'PREPARED' | 'EXISTING_ACTIVE';
  readonly workflowId: string;
}

export interface AiWorkflowAdmissionPort {
  /** 旧路径：创建并立即尝试投递，供既有消费者使用 */
  execute(request: AiWorkflowAdmissionRequest): Promise<AiWorkflowAdmissionResult>;

  /**
   * 在调用方数据库事务内创建待准入事实（落 `ADMISSION_WAITING` + `nextEnqueueAt`），
   * 不做任何 Redis／网络入队；事务提交后由 `admitExisting` 投递。
   */
  prepareInTransaction(
    request: AiWorkflowAdmissionRequest,
    transactionContext: PersistenceTransactionContext,
  ): Promise<AiWorkflowAdmissionPrepareResult>;

  /** 投递已存在的待准入上下文（事务外）；失败时数据库事实仍在，由正式调度恢复 */
  admitExisting(input: { readonly workflowId: string }): Promise<AiWorkflowAdmissionResult>;
}
