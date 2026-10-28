// src/usecases/content-submission/content-submission.types.ts

import type { Readable } from 'node:stream';

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PaginationParams } from '@core/pagination/pagination.types';
import type {
  ContentSubmissionListPage,
  ContentSubmissionMineDetailView,
  ContentSubmissionReviewDetailView,
  ContentSubmissionRevisionView,
  ContentSubmissionStatus,
  ContentSubmissionStatusSnapshot,
} from '@src/modules/lithography/content-submission.types';

/**
 * 草稿可编辑字段补丁（创建输入与更新补丁共用同一结构，A-PR0 §4.1）：
 * - undefined：保持原值（创建时视为未提供）；
 * - null 或空白字符串：清空（创建时视为未提供）；
 * - 非空值：经 usecase 规范化与校验后写入；
 * - 不属于目标类别的字段出现非空值即拒绝（null/undefined 视为未提供，
 *   静默忽略非空值会掩盖调用方错发字段）；
 * - extension 为 v1 扩展位：schema_version=1 的补充字段集为空集，
 *   任何键都拒绝（A-PR0 §2.3 补充口径 5）。
 */
export type ContentSubmissionEditablePatch = {
  title?: string | null;
  documentType?: string | null;
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  description?: string | null;
  contentText?: string | null;
  errorCode?: string | null;
  phenomenon?: string | null;
  conditionText?: string | null;
  reproductionSteps?: string | null;
  diagnosis?: string | null;
  actionTaken?: string | null;
  handlingStatus?: string | null;
  resolution?: string | null;
  extension?: Record<string, unknown> | null;
};

/**
 * 创建草稿命令：`kind` + 匹配类型的字段（A-PR0 §4.1）。
 * 创建人 / 组织由服务端从可信来源确定，不接受客户端传入。
 */
export type CreateContentSubmissionDraftCommand = {
  session: UsecaseSession;
  /** MATERIAL / FAULT_CASE（字符串入口，usecase 校验值域） */
  kind: string;
  /** 匹配 kind 类型的可编辑字段（草稿期全部可空） */
  fields: ContentSubmissionEditablePatch;
};

/**
 * 更新草稿命令（A-PR0 §4.1）：仅本人 DRAFT/RETURNED 可改；类别不变；
 * 返回真实保存状态。
 */
export type UpdateContentSubmissionDraftCommand = {
  session: UsecaseSession;
  submissionId: number;
  patch: ContentSubmissionEditablePatch;
};

/** 本人投稿列表命令：标题关键字 / 类别 / 状态筛选（无他人记录） */
export type ListMyContentSubmissionsCommand = {
  session: UsecaseSession;
  pagination: PaginationParams;
  filter?: {
    title?: string;
    submissionKind?: string;
    status?: string;
  };
};

/** 本人投稿详情命令 */
export type GetMyContentSubmissionCommand = {
  session: UsecaseSession;
  submissionId: number;
};

/** 草稿 mutation 结果：ID、类别、状态、更新时间（真实落库状态回读） */
export type ContentSubmissionDraftMutationResult = ContentSubmissionStatusSnapshot;

/**
 * 附件上传文件载荷（协议层已完成 latin1 还原与展示清洗）。
 * buffer 为服务端接收的实际字节，大小上限判定不信任任何客户端声明值。
 */
export type ContentSubmissionAttachmentUploadFile = {
  buffer: Buffer;
  originalFilename: string;
};

/**
 * 上传/替换单附件命令（A-PR0 §4.2 `POST /api/content-submissions/:id/attachment`）：
 * 本人 DRAFT/RETURNED；存储引用由 usecase 编排生成，客户端不参与
 * （不接收 storageReference / 服务器路径）。
 */
export type UploadContentSubmissionAttachmentCommand = {
  session: UsecaseSession;
  submissionId: number;
  file: ContentSubmissionAttachmentUploadFile;
};

/**
 * 移除单附件命令（A-PR0 §4.2 `DELETE /api/content-submissions/:id/attachment`）：
 * 本人 DRAFT/RETURNED；只退役数据库记录，历史冻结引用保留（幂等）。
 */
export type RemoveContentSubmissionAttachmentCommand = {
  session: UsecaseSession;
  submissionId: number;
};

/**
 * 下载指定原件命令（A-PR0 §4.2）：本人或本组织授权审核员；
 * 必须校验附件属于该投稿（不只下载「当前文件」）。
 */
export type DownloadContentSubmissionAttachmentCommand = {
  session: UsecaseSession;
  submissionId: number;
  attachmentId: number;
};

/** 上传/替换成功的安全元数据（附件 ID、原名、MIME、实际大小；无存储引用/路径） */
export type ContentSubmissionAttachmentUploadResult = {
  attachmentId: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
};

/**
 * 附件下载载荷：content 为存储契约 open() 的只读内容流，仅供 adapter 组装响应；
 * 本用例不感知服务器绝对路径与存储后端类型。
 */
export type ContentSubmissionAttachmentFilePayload = {
  attachmentId: number;
  originalFilename: string;
  mimeType: string;
  content: Readable;
};

export type ListMyContentSubmissionsResult = ContentSubmissionListPage;
export type GetMyContentSubmissionResult = ContentSubmissionMineDetailView;

/**
 * 入库告知版本（A-PR0 §2.3 补充口径 4）：服务端固定，不接受客户端传入；
 * 送审时随版本快照落库（notice_version），可追溯送审当次的告知内容版本。
 */
export const CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION = 'library-internal-v1';

/**
 * 送审/重提命令（A-PR0 §4.1 `submitContentSubmission`）：
 * 从本人已保存稿冻结出新版本；不接受客户端自报状态、所有者、版本号。
 * libraryNoticeConfirmed 为入库告知确认，未确认为 true 拒绝送审。
 */
export type SubmitContentSubmissionCommand = {
  session: UsecaseSession;
  submissionId: number;
  libraryNoticeConfirmed: boolean;
};

/**
 * 冻结版本读取命令（A-PR0 §4.1 `contentSubmissionRevision`）：
 * 本人或本组织管理员可读；版本由 submissionId + revisionNo 定位。
 */
export type GetContentSubmissionRevisionCommand = {
  session: UsecaseSession;
  submissionId: number;
  revisionNo: number;
};

/**
 * 退回命令（A-PR0 §4.1 `reviewContentSubmissionDecision` 的 RETURN 分支）：
 * revisionId 必须属于该投稿且等于当前待审版本（行锁内核对，不符拒绝）。
 */
export type ReturnContentSubmissionCommand = {
  session: UsecaseSession;
  submissionId: number;
  revisionId: number;
  comment?: string | null;
};

/**
 * 送审结果：新版本 ID/版本号 + 真实落库状态（PENDING_REVIEW）。
 * 状态与版本号均来自同一事务回读/冻结结果，不回显请求入参。
 */
export type ContentSubmissionSubmitResult = {
  submissionId: number;
  revisionId: number;
  revisionNo: number;
  status: ContentSubmissionStatus;
};

/**
 * 审核决定结果（退回/通过共用形状，A-PR0 §4.1「返回状态及可能的
 * documentId」）：退回不产生正式资料，documentId 恒为 null。
 */
export type ContentSubmissionReviewDecisionResult = {
  submissionId: number;
  status: ContentSubmissionStatus;
  documentId: number | null;
};

export type GetContentSubmissionRevisionResult = ContentSubmissionRevisionView;

/**
 * 审核队列命令（A-PR0 §4.1 `reviewContentSubmissions`）：
 * 仅本组织管理员；默认待审（status 缺省时按 PENDING_REVIEW），可选筛选。
 */
export type ListReviewQueueCommand = {
  session: UsecaseSession;
  pagination: PaginationParams;
  filter?: {
    title?: string;
    submissionKind?: string;
    status?: string;
  };
};

/** 审核详情命令（A-PR0 §4.1 `reviewContentSubmission`）：仅本组织管理员 */
export type GetReviewDetailCommand = {
  session: UsecaseSession;
  submissionId: number;
};

/**
 * 审核通过命令（A-PR0 §4.1 `reviewContentSubmissionDecision` 的 APPROVE 分支；S5）：
 * 仅当前待审 revisionId；publishAttachment 为当次获准原件发布决定
 * （无文件版本只能为 false）；comment 通过时可选。
 */
export type ApproveContentSubmissionCommand = {
  session: UsecaseSession;
  submissionId: number;
  revisionId: number;
  comment?: string | null;
  publishAttachment: boolean;
};

/** 审核队列结果（与本人列表同形状：items/total/page/pageSize） */
export type ListReviewQueueResult = ContentSubmissionListPage;
export type GetReviewDetailResult = ContentSubmissionReviewDetailView;
