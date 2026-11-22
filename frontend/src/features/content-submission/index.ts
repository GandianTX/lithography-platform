// src/features/content-submission/index.ts

// barrel 只导出切片外实际消费的公开 API：投稿契约类型与真实数据访问函数
// （GraphQL 现役八操作 + REST 单附件上传/移除/下载）。
// 任务 07 收口：投稿审核决定写入口（reviewContentSubmissionDecision）已按确认需求
// 关闭，不再从本 barrel 导出；审核队列/详情读取保留为合法历史读取。
// 本阶段不包含页面 / 导航 / 钩子 / mock；页面装配所需的 UI 与 hooks 在后续阶段
// 仍按「narrowest owner」原则新增到本 barrel。
export type {
  ContentSubmissionAttachmentDownloadResult,
  ContentSubmissionAttachmentMeta,
  ContentSubmissionAttachmentRemoveResult,
  ContentSubmissionAttachmentUploadResult,
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
  submitContentSubmission,
  updateContentSubmissionDraft,
} from './infrastructure/content-submission-adapter';
export {
  downloadContentSubmissionAttachment,
  removeContentSubmissionAttachment,
  uploadContentSubmissionAttachment,
} from './infrastructure/content-submission-attachment-adapter';
