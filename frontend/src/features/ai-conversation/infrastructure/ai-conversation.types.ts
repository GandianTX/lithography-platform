// src/features/ai-conversation/infrastructure/ai-conversation.types.ts

/** 会话状态（与后端 AiConversationStatus 正式枚举一致） */
export type AiConversationStatus = 'ACTIVE' | 'COMPLETED';

/** 分析状态（与后端 AiMessageAnalysisStatus 正式枚举一致） */
export type AiMessageAnalysisStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export type AiMessageRole = 'SYSTEM' | 'USER' | 'ASSISTANT' | 'TOOL';

export type AiConversationListItem = {
  id: number;
  requestId: number | null;
  requestNo: string;
  status: AiConversationStatus;
  contentVersion: number;
  messageCount: number;
  /** 真实轮次：用户发起过的轮次（按 turn_no 去重，含失败轮） */
  turnCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type AiConversationMessage = {
  messageId: number;
  messageSeq: number;
  turnNo: number | null;
  role: AiMessageRole;
  questionUuid: string | null;
  text: string;
  contentVersion: number;
  createdAt: string;
};

export type AiConversationTurn = {
  questionUuid: string;
  turnNo: number | null;
  question: AiConversationMessage | null;
  answer: AiConversationMessage | null;
  analysisStatus: AiMessageAnalysisStatus | null;
  failureReason: string | null;
  analysisContentVersion: number | null;
  completedAt: string | null;
};

export type AiConversationDetail = {
  id: number;
  requestId: number | null;
  requestNo: string;
  status: AiConversationStatus;
  contentVersion: number;
  createdAt: string;
  completedAt: string | null;
  messages: AiConversationMessage[];
  turns: AiConversationTurn[];
};

export type AiConversationListPage = {
  items: AiConversationListItem[];
  total: number | null;
  page: number;
  pageSize: number;
};

export type CreateAiConversationResult = {
  id: number;
  requestId: number | null;
  requestNo: string;
  status: AiConversationStatus;
  contentVersion: number;
  createdAt: string;
};

export type SubmitAiQuestionResult = {
  conversationId: number;
  questionUuid: string;
  status: AiMessageAnalysisStatus;
  turnNo: number;
  messageSeq: number;
  contentVersion: number;
  replayed: boolean;
  dispatchStatus: AiConversationDispatchStatus;
};

/** 派发结果（与后端 AiConversationDispatchStatus 正式枚举一致） */
export type AiConversationDispatchStatus = 'QUEUED' | 'DEFERRED' | 'FAILED';

/** 部件展示态（与模型 API 约定一致：NORMAL/HIGHLIGHT/WARNING/HIDDEN） */
export type AiPartDisplay = 'NORMAL' | 'HIGHLIGHT' | 'WARNING' | 'HIDDEN';

/** 短时图形部件项（服务端已按约定校验并规范化） */
export type AiVisualizationPart = {
  partId: string;
  display: AiPartDisplay;
};

/** 短时图形信封：仅内存渲染，不进持久存储 */
export type AiVisualization = {
  sceneId: string;
  stage: number | null;
  parts: AiVisualizationPart[];
};

export type AiQuestionStatus = {
  conversationId: number;
  questionUuid: string;
  status: AiMessageAnalysisStatus;
  failureReason: string | null;
  contentVersion: number;
  turnNo: number | null;
  questionText: string;
  answer: AiConversationMessage | null;
  /** 短时图形（过期/缺失为 null，正文照常） */
  visualization: AiVisualization | null;
};

/** 导出格式（PDF 为正式页面入口；RAW_JSON 属受控技术操作，普通页面不提供） */
export type AiConversationExportFormat = 'PDF' | 'RAW_JSON';

/** 导出结果（文件字节 + 固定范围声明） */
export type AiConversationExportResult = {
  format: string;
  filename: string;
  mimeType: string;
  contentVersion: number;
  lastMessageSeq: number;
  byteSize: number;
  contentBase64: string;
};
