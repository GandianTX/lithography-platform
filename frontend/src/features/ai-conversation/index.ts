// src/features/ai-conversation/index.ts

// 任务 05 公开出口：工作区 hook、UI 组件与只读类型。
// 页面不得直接 import infrastructure/*（adapter 只在 application 层被使用）。
export { useAiConversationConsole } from './application/use-ai-conversation-console';
export { useAiDiagnosisWorkspace } from './application/use-ai-diagnosis-workspace';
export {
  parseAiVisualization,
  pickAiHighlightedParts,
  resolveAiPartDisplays,
} from './domain/ai-visualization';
export {
  AI_PART_GEOMETRIES,
  AI_PART_IDS,
  AI_STAGE_DEFINITIONS,
  buildStageBaselineDisplays,
  findAiPartGeometry,
  findAiStageDefinition,
} from './domain/litho-geometry';
export type {
  AiConversationDetail,
  AiConversationDispatchStatus,
  AiConversationListItem,
  AiConversationListPage,
  AiConversationMessage,
  AiConversationStatus,
  AiConversationTurn,
  AiMessageAnalysisStatus,
  AiPartDisplay,
  AiQuestionStatus,
  AiVisualization,
  AiVisualizationPart,
  CreateAiConversationResult,
  SubmitAiQuestionResult,
} from './infrastructure/ai-conversation.types';
export { AiConversationPanel, type AiWorkOrderOption } from './ui/ai-conversation-panel';
export { AiHistoryDrawer } from './ui/ai-history-drawer';
export { AiPartLegend } from './ui/ai-part-legend';
export { LithoWorkflowCanvas } from './ui/litho-workflow-canvas';
