// src/usecases/ai-conversation/ai-conversation-dispatch.types.ts

import { AiConversationDispatchStatus } from '@app-types/models/ai-conversation.types';

export { AiConversationDispatchStatus };

/** 工作流类型常量在共享类型层（ai-conversation 与 ai-worker 两域共用） */
export { AI_CONVERSATION_REPLY_WORKFLOW_TYPE } from '@app-types/models/ai-conversation.types';

export interface AiConversationDispatchResult {
  readonly status: AiConversationDispatchStatus;
  readonly workflowId: string | null;
  readonly jobId: string | null;
}
