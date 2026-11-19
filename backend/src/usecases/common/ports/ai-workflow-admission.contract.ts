// src/usecases/common/ports/ai-workflow-admission.contract.ts
// 跨域端口契约：ai 对话（05）等工作流域需要「创建并受理 AI 工作流」能力。
//
// 依赖无关（不得 import 任何域实现）：实现方为 ai-workflow 域的
// `AiWorkflowAdmissionAdapter`（委托 `CreateAndAdmitAiWorkflowUsecase`），
// 由 adapter 层模块装配进消费域模块图（与 TRANSACTION_RUNNER 同模式）。

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

export interface AiWorkflowAdmissionPort {
  execute(request: AiWorkflowAdmissionRequest): Promise<AiWorkflowAdmissionResult>;
}
