// src/usecases/ai-workflow/ai-workflow-admission.adapter.ts
// 跨域端口适配器（ai-workflow 域）：把本域的「创建并受理 AI 工作流」用例
// 适配为 `AI_WORKFLOW_ADMISSION_PORT` 契约，供其他域（如 ai-conversation）
// 经端口注入使用，避免跨域静态导入。

import { Injectable } from '@nestjs/common';

import type {
  AiWorkflowAdmissionPort,
  AiWorkflowAdmissionRequest,
  AiWorkflowAdmissionResult,
} from '@src/usecases/common/ports/ai-workflow-admission.contract';
import type { AiWorkflowJsonPayload } from '@src/modules/ai-workflow-context/ai-workflow-context.types';

import { CreateAndAdmitAiWorkflowUsecase } from './create-and-admit-ai-workflow.usecase';
import type {
  CreateAndAdmitAiWorkflowInput,
  CreateAndAdmitAiWorkflowResult,
} from './ai-workflow-usecases.types';

@Injectable()
export class AiWorkflowAdmissionAdapter implements AiWorkflowAdmissionPort {
  constructor(private readonly createAndAdmit: CreateAndAdmitAiWorkflowUsecase) {}

  async execute(request: AiWorkflowAdmissionRequest): Promise<AiWorkflowAdmissionResult> {
    const result = await this.createAndAdmit.execute({
      workflowType: request.workflowType,
      workflowDedupKey: request.workflowDedupKey,
      inputPayload: request.inputPayload as AiWorkflowJsonPayload,
      bizType: request.bizType,
      bizKey: request.bizKey,
      bizSubKey: request.bizSubKey,
      source: toContextSource(request.source),
      actorAccountId: request.actorAccountId,
      actorActiveRole: request.actorActiveRole,
      provider: request.provider,
      model: request.model,
    });
    return toAdmissionResult(result);
  }
}

function toAdmissionResult(result: CreateAndAdmitAiWorkflowResult): AiWorkflowAdmissionResult {
  return {
    status: result.status,
    workflowId: result.context?.workflowId ?? null,
    traceId: result.context?.traceId ?? null,
    jobId: 'jobId' in result ? (result.jobId ?? null) : null,
  };
}

function toContextSource(source: string): CreateAndAdmitAiWorkflowInput['source'] {
  // source 是白名单枚举字符串；非法值由 createContext 校验失败关闭
  return source as CreateAndAdmitAiWorkflowInput['source'];
}
