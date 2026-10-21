// src/features/content-submission/infrastructure/content-submission.types.ts

/**
 * 内容投稿的前端契约类型（与后端 A-PR0 §4.1 GraphQL 读/写 DTO 逐字段对齐）。
 *
 * 契约依据：backend/src/adapters/api/graphql/content-submission/dto/。
 * 日期字段后端为 Date 标量，GraphQL JSON 序列化后是 ISO 字符串；
 * 不出现存储引用、服务器路径与审核人账号 ID（后端 DTO 已在边界剥离）；
 * 审核链路独有 submittedByAccountId（供管理员联系投稿人，本人链路不返回）。
 */

/** 投稿类别（受控字符串）：MATERIAL（普通资料）/ FAULT_CASE（故障案例） */
export type ContentSubmissionKind = 'MATERIAL' | 'FAULT_CASE';

/** 投稿状态（受控字符串）：未送审 / 待审核 / 已退回 / 已发布 */
export type ContentSubmissionStatus = 'DRAFT' | 'PENDING_REVIEW' | 'RETURNED' | 'PUBLISHED';

/** 审核决定 */
export type ContentSubmissionReviewDecision = 'RETURN' | 'APPROVE';

/** 附件安全元数据（无存储引用与服务器路径；下载时传回 id） */
export type ContentSubmissionAttachmentMeta = {
  id: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
};

/** 最近审核事实（未审核为空） */
export type ContentSubmissionLatestReview = {
  decision: ContentSubmissionReviewDecision;
  /** 退回必填、通过可选 */
  comment: string | null;
  /** 附件发布决定（退回恒为 false） */
  publishAttachment: boolean;
  reviewedAt: string;
};

/** 已发布正式资料关联（available=false 表示正式资料已下架，保留 ID 但不可用） */
export type ContentSubmissionPublishedDocument = {
  documentId: number;
  available: boolean;
};

/** 普通资料明细稳定视图（草稿字段可空；机型文字与机型 ID 互斥） */
export type ContentSubmissionMaterialDetail = {
  title: string | null;
  /** 资料类型（不可为 FAULT_CASE） */
  documentType: string | null;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  description: string | null;
  contentText: string | null;
};

/** 故障案例明细稳定视图（草稿字段可空；机型文字与机型 ID 互斥） */
export type ContentSubmissionFaultCaseDetail = {
  title: string | null;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  /** 设备错误码（保留大小写与内部符号） */
  errorCode: string | null;
  phenomenon: string | null;
  conditionText: string | null;
  reproductionSteps: string | null;
  diagnosis: string | null;
  actionTaken: string | null;
  /** 处理状态：UNRESOLVED / IN_PROGRESS / RESOLVED（受控字符串） */
  handlingStatus: string | null;
  /** 处理结果（已解决时送审必填） */
  resolution: string | null;
};

/** 投稿列表项（本人列表与审核队列共用；草稿标题可为空） */
export type ContentSubmissionListItem = {
  id: number;
  title: string | null;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  /** 当前版本号（未送审为 0） */
  currentRevisionNo: number;
  lastSubmittedAt: string | null;
  updatedAt: string;
  createdAt: string;
};

/** 本人投稿详情（按类别恰好一类明细非空） */
export type ContentSubmissionMineDetail = {
  id: number;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  currentRevisionNo: number;
  lastSubmittedAt: string | null;
  publishedAt: string | null;
  material: ContentSubmissionMaterialDetail | null;
  faultCase: ContentSubmissionFaultCaseDetail | null;
  currentAttachment: ContentSubmissionAttachmentMeta | null;
  latestReview: ContentSubmissionLatestReview | null;
  publishedDocument: ContentSubmissionPublishedDocument | null;
  createdAt: string;
  updatedAt: string;
};

/** 冻结版本（完整内容快照 + 附件安全元数据 + 版本审核记录至多一条） */
export type ContentSubmissionRevision = {
  revisionId: number;
  submissionId: number;
  submissionKind: ContentSubmissionKind;
  /** 版本号（从 1 开始单调递增） */
  revisionNo: number;
  /** 明细 schema 版本（当前为 1） */
  schemaVersion: number;
  titleSnapshot: string;
  /** 业务字段完整快照（不含存储引用与服务器路径；字段随类别而定） */
  payloadSnapshot: Record<string, unknown>;
  attachment: ContentSubmissionAttachmentMeta | null;
  noticeVersion: string;
  confirmedAt: string;
  submittedAt: string;
  review: ContentSubmissionLatestReview | null;
};

/** 历史审核条目（跨版本，不含审核人账号 ID） */
export type ContentSubmissionReviewHistoryItem = {
  revisionId: number;
  revisionNo: number;
  decision: ContentSubmissionReviewDecision;
  comment: string | null;
  publishAttachment: boolean;
  reviewedAt: string;
};

/** 审核详情（当前版本完整视图 + 全部历史审核新在前 + 投稿基础事实） */
export type ContentSubmissionReviewDetail = {
  submissionId: number;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  currentRevisionNo: number;
  lastSubmittedAt: string | null;
  /** 投稿人账号 ID（仅审核链路返回，供管理员联系投稿人） */
  submittedByAccountId: number;
  /** 未送审为空 */
  currentRevision: ContentSubmissionRevision | null;
  reviewHistory: ContentSubmissionReviewHistoryItem[];
};

// ---- 输入 ----

/**
 * 草稿可编辑字段补丁（与后端 ContentSubmissionEditablePatchInput 对齐）。
 * - 字段缺省（undefined）：保持原值（创建时视为未提供）；
 * - 显式传 null：清空（草稿期全部字段可空，必填完备性在送审时校验）；
 * - 不属于目标类别的字段出现非空值会被后端拒绝（null / 缺省视为未提供）；
 * - 不含 extension v1 扩展位（schema_version=1 未定义任何键，传任何键即被拒绝）。
 */
export type ContentSubmissionEditablePatch = {
  title?: string | null;
  /** 资料类型（仅普通资料） */
  documentType?: string | null;
  /** 适用设备型号 ID（与机型文字互斥） */
  equipmentModelId?: number | null;
  /** 机型文字（与机型 ID 互斥） */
  equipmentModelText?: string | null;
  description?: string | null;
  /** 正文（仅普通资料） */
  contentText?: string | null;
  errorCode?: string | null;
  phenomenon?: string | null;
  conditionText?: string | null;
  reproductionSteps?: string | null;
  diagnosis?: string | null;
  actionTaken?: string | null;
  handlingStatus?: string | null;
  resolution?: string | null;
};

/** 新建草稿输入：kind 决定类别，fields 为匹配类别的可编辑字段（草稿期全部可空） */
export type CreateContentSubmissionDraftInput = {
  kind: ContentSubmissionKind;
  fields: ContentSubmissionEditablePatch;
};

/** 送审输入（入库告知确认；告知版本由服务端固定） */
export type SubmitContentSubmissionInput = {
  libraryNoticeConfirmed: boolean;
};

/** OFFSET 分页请求参数（真实 adapter 内部补齐 mode/withTotal，调用方不感知） */
export type ContentSubmissionListPagination = {
  page: number;
  pageSize: number;
};

/**
 * 列表筛选（本人列表与审核队列共用；均可选）。
 * titleKeyword 映射为契约字段 title；审核队列 status 缺省为 PENDING_REVIEW（后端强制）。
 */
export type ContentSubmissionListFilter = {
  titleKeyword?: string;
  submissionKind?: ContentSubmissionKind;
  status?: ContentSubmissionStatus;
};

/** OFFSET 分页结果（本人列表：更新时间倒序；审核队列：送审时间倒序） */
export type ContentSubmissionListPage = {
  items: ContentSubmissionListItem[];
  total: number;
  page: number;
  pageSize: number;
};

/** 审核决定输入（RETURN 必带意见；APPROVE 的 publishAttachment 仅对文件版本生效） */
export type ContentSubmissionReviewDecisionInput = {
  submissionId: number;
  /** 目标版本 ID（必须等于当前待审版本） */
  revisionId: number;
  decision: ContentSubmissionReviewDecision;
  comment?: string | null;
  publishAttachment?: boolean;
};

// ---- 结果（domain failure 显式结果；transport / auth 类失败上抛 GraphQLIngressError） ----

/**
 * 投稿写操作（草稿保存 / 送审 / 审核决定）业务拒绝原因：
 * - not-found：投稿不存在 / 他人投稿 / 跨组织（统一防探测口径）
 * - model-not-found：所选设备型号不存在（经 errorCode 细化）
 * - invalid-input：字段非法 / 草稿为空 / 送审完整性不足 / 未确认入库告知
 * - state-conflict：当前状态不允许该操作（PENDING_REVIEW 只读、PUBLISHED 不可改稿）
 * - forbidden：权限拒绝（角色 / 组织事实不满足）
 * - operation-failed：其余系统侧失败
 */
export type ContentSubmissionWriteFailureReason =
  | 'not-found'
  | 'model-not-found'
  | 'invalid-input'
  | 'state-conflict'
  | 'forbidden'
  | 'operation-failed';

/** 草稿保存结果（创建 / 修改共用；返回真实保存状态 write-then-read 回读） */
export type ContentSubmissionDraftSaveResult =
  | {
      ok: true;
      id: number;
      submissionKind: ContentSubmissionKind;
      status: ContentSubmissionStatus;
      updatedAt: string;
    }
  | { ok: false; reason: ContentSubmissionWriteFailureReason; message: string };

/** 送审结果（新版本 ID/版本号 + 真实落库状态） */
export type ContentSubmissionSubmitResult =
  | {
      ok: true;
      submissionId: number;
      revisionId: number;
      revisionNo: number;
      status: ContentSubmissionStatus;
    }
  | { ok: false; reason: ContentSubmissionWriteFailureReason; message: string };

/** 审核决定结果（退回不产生正式资料，documentId 恒为空） */
export type ContentSubmissionDecisionResult =
  | {
      ok: true;
      submissionId: number;
      status: ContentSubmissionStatus;
      documentId: number | null;
    }
  | { ok: false; reason: ContentSubmissionWriteFailureReason; message: string };

/** 本人投稿详情读取结果（不存在 / 他人投稿 / 跨组织统一 not-found 防探测） */
export type ContentSubmissionMineDetailResult =
  | { ok: true; detail: ContentSubmissionMineDetail }
  | { ok: false; reason: 'not-found'; message: string };

/** 冻结版本读取结果（非授权范围统一 not-found 防探测） */
export type ContentSubmissionRevisionResult =
  | { ok: true; revision: ContentSubmissionRevision }
  | { ok: false; reason: 'not-found'; message: string };

/** 审核详情读取结果（非本组织统一 not-found 防探测） */
export type ContentSubmissionReviewDetailResult =
  | { ok: true; detail: ContentSubmissionReviewDetail }
  | { ok: false; reason: 'not-found'; message: string };

// ---- REST 附件（单附件上传 / 移除 / 下载） ----

/** REST 上传响应的附件元数据（REST 边界不返回 uploadedAt；详情回读以 GraphQL 元数据为准） */
export type ContentSubmissionUploadedAttachment = {
  id: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
};

/**
 * 附件操作业务拒绝原因：
 * - not-found：投稿不存在 / 非本人（上传移除）或附件不可访问（下载）
 * - invalid-input：multipart 文件缺失或为空
 * - file-too-large：实际字节数超过配置上限
 * - file-type-not-allowed：扩展名不在白名单
 * - state-conflict：当前状态不允许变更附件（PENDING_REVIEW / PUBLISHED）
 * - forbidden：权限拒绝（含客户角色与非下载角色）
 * - file-not-available：存储对象缺失 / 引用不可用（仅下载）
 */
export type ContentSubmissionAttachmentUploadResult =
  | { ok: true; attachment: ContentSubmissionUploadedAttachment }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'invalid-input'
        | 'file-too-large'
        | 'file-type-not-allowed'
        | 'state-conflict'
        | 'forbidden'
        | 'upload-failed';
      message: string;
    };

/** 附件移除结果（无当前附件时后端幂等成功） */
export type ContentSubmissionAttachmentRemoveResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-found' | 'state-conflict' | 'forbidden' | 'remove-failed';
      message: string;
    };

/** 附件下载结果（成功返回 Blob 与文件名，交由调用方触发浏览器保存） */
export type ContentSubmissionAttachmentDownloadResult =
  | { ok: true; blob: Blob; filename: string }
  | {
      ok: false;
      reason: 'not-found' | 'file-not-available' | 'forbidden' | 'download-failed';
      message: string;
    };
