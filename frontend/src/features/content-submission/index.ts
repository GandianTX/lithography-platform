// src/features/content-submission/index.ts

// barrel 只导出切片外实际消费的公开 API：投稿契约类型与真实数据访问函数
// （GraphQL 九操作 + REST 单附件上传/移除/下载）。
// 本阶段不包含页面 / 导航 / 钩子 / mock；页面装配所需的 UI 与 hooks 在后续阶段
// 仍按「narrowest owner」原则新增到本 barrel。
export type {
  ContentSubmissionAttachmentDownloadResult,
  ContentSubmissionAttachmentMeta,
  ContentSubmissionAttachmentRemoveResult,
  ContentSubmissionAttachmentUploadResult,
  ContentSubmissionDecisionResult,
  ContentSubmissionDraftSaveResult,
  ContentSubmissionEditablePatch,
  ContentSubmissionFaultCaseDetail,
  ContentSubmissionKind,
  ContentSubmissionLatestReview,
  ContentSubmissionListFilter,
  ContentSubmissionListItem,
  ContentSubmissionListPage,
  ContentSubmissionListPagination,
  ContentSubmissionMaterialDetail,
  ContentSubmissionMineDetail,
  ContentSubmissionMineDetailResult,
  ContentSubmissionPublishedDocument,
  ContentSubmissionReviewDecision,
  ContentSubmissionReviewDecisionInput,
  ContentSubmissionReviewDetail,
  ContentSubmissionReviewDetailResult,
  ContentSubmissionReviewHistoryItem,
  ContentSubmissionRevision,
  ContentSubmissionRevisionResult,
  ContentSubmissionStatus,
  ContentSubmissionSubmitResult,
  ContentSubmissionUploadedAttachment,
  ContentSubmissionWriteFailureReason,
  CreateContentSubmissionDraftInput,
  SubmitContentSubmissionInput,
} from './infrastructure/content-submission.types';
export {
  createContentSubmissionDraft,
  fetchContentSubmissionRevision,
  fetchMyContentSubmission,
  fetchMyContentSubmissions,
  fetchReviewContentSubmission,
  fetchReviewContentSubmissions,
  reviewContentSubmissionDecision,
  submitContentSubmission,
  updateContentSubmissionDraft,
} from './infrastructure/content-submission-adapter';
export {
  downloadContentSubmissionAttachment,
  removeContentSubmissionAttachment,
  uploadContentSubmissionAttachment,
} from './infrastructure/content-submission-attachment-adapter';
