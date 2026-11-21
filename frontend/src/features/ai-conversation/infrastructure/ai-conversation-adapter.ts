// src/features/ai-conversation/infrastructure/ai-conversation-adapter.ts

import { executeGraphQL } from '@/shared/graphql';

import type {
  AiConversationDetail,
  AiConversationExportFormat,
  AiConversationExportResult,
  AiConversationListPage,
  AiQuestionStatus,
  CreateAiConversationResult,
  SubmitAiQuestionResult,
} from './ai-conversation.types';

/**
 * 工程师侧 AI 对话数据访问层（任务 05 · S1）
 *
 * - 只消费 S1 已交付的 5 个 GraphQL operation，不猜测未实现字段；
 * - 公司归属、提问资格、可见性均由服务端裁决，前端不传组织/角色；
 * - transport 与业务拒绝由共享层归一为 GraphQLIngressError 上抛，
 *   由 application 层决定展示文案（不在 adapter 内吞错）。
 */

const CONVERSATION_FIELDS = `
  id
  requestId
  requestNo
  status
  contentVersion
  messageCount
  turnCount
  lastMessageAt
  createdAt
  completedAt
`;

const MESSAGE_FIELDS = `
  messageId
  messageSeq
  turnNo
  role
  questionUuid
  text
  contentVersion
  createdAt
`;

const MY_AI_CONVERSATIONS_QUERY = `
  query MyAiConversations($pagination: PaginationArgs!) {
    myAiConversations(pagination: $pagination) {
      items { ${CONVERSATION_FIELDS} }
      total
      page
      pageSize
    }
  }
`;

const MY_AI_CONVERSATION_QUERY = `
  query MyAiConversation($input: AiConversationIdInput!) {
    myAiConversation(input: $input) {
      id
      requestId
      requestNo
      status
      contentVersion
      createdAt
      completedAt
      messages { ${MESSAGE_FIELDS} }
      turns {
        questionUuid
        turnNo
        analysisStatus
        failureReason
        analysisContentVersion
        completedAt
        question { ${MESSAGE_FIELDS} }
        answer { ${MESSAGE_FIELDS} }
      }
    }
  }
`;

const CREATE_AI_CONVERSATION_MUTATION = `
  mutation CreateAiConversation($input: CreateAiConversationInput!) {
    createAiConversation(input: $input) {
      id
      requestId
      requestNo
      status
      contentVersion
      createdAt
    }
  }
`;

const SUBMIT_AI_QUESTION_MUTATION = `
  mutation SubmitAiQuestion($input: SubmitAiQuestionInput!) {
    submitAiQuestion(input: $input) {
      conversationId
      questionUuid
      status
      turnNo
      messageSeq
      contentVersion
      replayed
      dispatchStatus
    }
  }
`;

/** 重试失败轮次：沿用同一问题 UUID，不新增用户问题 */
const RETRY_AI_QUESTION_MUTATION = `
  mutation RetryAiQuestion($input: RetryAiQuestionInput!) {
    retryAiQuestion(input: $input) {
      conversationId
      questionUuid
      status
      turnNo
      messageSeq
      contentVersion
      replayed
      dispatchStatus
    }
  }
`;

const AI_QUESTION_STATUS_QUERY = `
  query AiQuestionStatus($input: AiQuestionStatusInput!) {
    aiQuestionStatus(input: $input) {
      conversationId
      questionUuid
      status
      failureReason
      contentVersion
      turnNo
      questionText
      answer { ${MESSAGE_FIELDS} }
      visualization
    }
  }
`;

const EXPORT_AI_CONVERSATION_MUTATION = `
  mutation ExportAiConversation($input: ExportAiConversationInput!) {
    exportAiConversation(input: $input) {
      format
      filename
      mimeType
      contentVersion
      lastMessageSeq
      byteSize
      contentBase64
    }
  }
`;

export async function listMyAiConversations(params: {
  page: number;
  pageSize: number;
}): Promise<AiConversationListPage> {
  const data = await executeGraphQL<
    { myAiConversations: AiConversationListPage },
    Record<string, unknown>
  >(MY_AI_CONVERSATIONS_QUERY, {
    pagination: {
      mode: 'OFFSET',
      page: params.page,
      pageSize: params.pageSize,
      withTotal: true,
    },
  });

  return data.myAiConversations;
}

export async function getMyAiConversation(conversationId: number): Promise<AiConversationDetail> {
  const data = await executeGraphQL<
    { myAiConversation: AiConversationDetail },
    Record<string, unknown>
  >(MY_AI_CONVERSATION_QUERY, { input: { conversationId } });

  return data.myAiConversation;
}

export async function createAiConversation(
  requestId: number | null,
): Promise<CreateAiConversationResult> {
  const data = await executeGraphQL<
    { createAiConversation: CreateAiConversationResult },
    Record<string, unknown>
  >(CREATE_AI_CONVERSATION_MUTATION, { input: requestId === null ? {} : { requestId } });

  return data.createAiConversation;
}

export async function submitAiQuestion(params: {
  conversationId: number;
  questionUuid: string;
  question: string;
  stage?: number | null;
}): Promise<SubmitAiQuestionResult> {
  const data = await executeGraphQL<
    { submitAiQuestion: SubmitAiQuestionResult },
    Record<string, unknown>
  >(SUBMIT_AI_QUESTION_MUTATION, {
    input: {
      conversationId: params.conversationId,
      questionUuid: params.questionUuid,
      question: params.question,
      stage: params.stage ?? null,
    },
  });

  return data.submitAiQuestion;
}

/** 重试失败轮次：沿用同一问题 UUID；服务端只允许「失败且无回答」的轮次重试 */
export async function retryAiQuestion(params: {
  conversationId: number;
  questionUuid: string;
  stage?: number | null;
}): Promise<SubmitAiQuestionResult> {
  const data = await executeGraphQL<
    { retryAiQuestion: SubmitAiQuestionResult },
    Record<string, unknown>
  >(RETRY_AI_QUESTION_MUTATION, {
    input: {
      conversationId: params.conversationId,
      questionUuid: params.questionUuid,
      stage: params.stage ?? null,
    },
  });

  return data.retryAiQuestion;
}

export async function getAiQuestionStatus(params: {
  conversationId: number;
  questionUuid: string;
}): Promise<AiQuestionStatus> {
  const data = await executeGraphQL<
    { aiQuestionStatus: AiQuestionStatus },
    Record<string, unknown>
  >(AI_QUESTION_STATUS_QUERY, { input: params });

  return data.aiQuestionStatus;
}

/**
 * 导出会话（任务 05 · S4.2 · R039-01）。
 *
 * 固定内容版本：服务端按 `contentVersion` 截取消息范围，导出期间新增消息不混入；
 * 受控原始 JSON 需要技术授权凭据（普通页面不提供该入口）。
 */
export async function exportAiConversation(params: {
  conversationId: number;
  contentVersion: number;
  format: AiConversationExportFormat;
  technicalAuthorization?: string;
}): Promise<AiConversationExportResult> {
  const data = await executeGraphQL<
    { exportAiConversation: AiConversationExportResult },
    Record<string, unknown>
  >(EXPORT_AI_CONVERSATION_MUTATION, {
    input: {
      conversationId: params.conversationId,
      contentVersion: params.contentVersion,
      format: params.format,
      technicalAuthorization: params.technicalAuthorization ?? null,
    },
  });

  return data.exportAiConversation;
}
