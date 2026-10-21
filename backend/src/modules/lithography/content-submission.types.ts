// src/modules/lithography/content-submission.types.ts

/**
 * 内容投稿领域稳定视图与写入类型（A-PR0 计划 §2.2/§2.3；不暴露 ORM Entity）。
 *
 * 状态与类别用受控字符串常量声明（与实体 CHECK 约束值域一致），
 * 不把未知未来类别写死成代码枚举——扩展走显式修改本文件。
 */

/** 投稿类别值域：MATERIAL=普通资料；FAULT_CASE=故障案例 */
export const CONTENT_SUBMISSION_KINDS = ['MATERIAL', 'FAULT_CASE'] as const;
export type ContentSubmissionKind = (typeof CONTENT_SUBMISSION_KINDS)[number];

/** 投稿状态值域（A-PR0 §2.2 状态机） */
export const CONTENT_SUBMISSION_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'RETURNED',
  'PUBLISHED',
] as const;
export type ContentSubmissionStatus = (typeof CONTENT_SUBMISSION_STATUSES)[number];

/**
 * 可编辑状态（A-PR0 §2.2）：草稿与退回稿可改；PENDING_REVIEW 只读、PUBLISHED 不可改稿。
 * 更新用例在事务内持投稿行锁后按本值域裁决。
 */
export const CONTENT_SUBMISSION_EDITABLE_STATUSES: ReadonlyArray<ContentSubmissionStatus> = [
  'DRAFT',
  'RETURNED',
];

/** 案例处理状态值域（A-PR0 §2.3） */
export const CONTENT_SUBMISSION_HANDLING_STATUSES = [
  'UNRESOLVED',
  'IN_PROGRESS',
  'RESOLVED',
] as const;
export type ContentSubmissionHandlingStatus = (typeof CONTENT_SUBMISSION_HANDLING_STATUSES)[number];

/** 普通资料明细稳定视图（草稿字段可空） */
export type MaterialSubmissionDetailView = {
  title: string | null;
  documentType: string | null;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  description: string | null;
  contentText: string | null;
};

/** 故障案例明细稳定视图（草稿字段可空） */
export type FaultCaseSubmissionDetailView = {
  title: string | null;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  errorCode: string | null;
  phenomenon: string | null;
  conditionText: string | null;
  reproductionSteps: string | null;
  diagnosis: string | null;
  actionTaken: string | null;
  handlingStatus: string | null;
  resolution: string | null;
};

/**
 * 私有附件安全元数据：不返回 storageBackend/storageReference 与服务器路径
 * （authorization 先于文件 I/O、客户端不得获知存储引用是 §4.2 的固定口径）。
 */
export type ContentSubmissionAttachmentMetaView = {
  id: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  uploadedAt: Date;
};

/** 最近审核稳定视图（S5 审核链路起有数据；未审核/尚未实现阶段为 null） */
export type ContentSubmissionLatestReviewView = {
  decision: string;
  comment: string | null;
  publishAttachment: boolean;
  reviewedAt: Date;
};

/**
 * 已发布正式资料关联（S5 发布链路起有数据）。
 * available = 正式资料未被软删；已下架资料保留 ID 但标记不可用（A-PR0 §4.3）。
 */
export type ContentSubmissionPublishedDocumentView = {
  documentId: number;
  available: boolean;
};

/**
 * 本人投稿详情稳定视图（A-PR0 §4.1 `myContentSubmission`）：
 * 当前稿（按 kind 恰好一类明细非 null）、当前状态、最近审核、版本入口
 * （currentRevisionNo + lastSubmittedAt）与已发布正式资料关联。
 * 不含 storageReference / 审核人账号 ID / 内部扩展 JSON。
 */
export type ContentSubmissionMineDetailView = {
  id: number;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  currentRevisionNo: number;
  lastSubmittedAt: Date | null;
  publishedAt: Date | null;
  material: MaterialSubmissionDetailView | null;
  faultCase: FaultCaseSubmissionDetailView | null;
  currentAttachment: ContentSubmissionAttachmentMetaView | null;
  latestReview: ContentSubmissionLatestReviewView | null;
  publishedDocument: ContentSubmissionPublishedDocumentView | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 本人投稿列表项稳定视图（无他人记录；草稿标题可为 null） */
export type ContentSubmissionListItemView = {
  id: number;
  title: string | null;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  currentRevisionNo: number;
  lastSubmittedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

/** 本人投稿列表分页结果 */
export type ContentSubmissionListPage = {
  items: ContentSubmissionListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/** 本人投稿列表筛选（标题关键字跨两类明细模糊匹配） */
export type ContentSubmissionListFilter = {
  title?: string;
  submissionKind?: ContentSubmissionKind;
  status?: ContentSubmissionStatus;
};

/** 本人投稿列表分页参数（usecase 已钳制上限） */
export type ContentSubmissionListPagination = {
  page: number;
  pageSize: number;
  withTotal: boolean;
};

/**
 * 主表状态敏感动作的最小锁定事实（pessimistic_write 行锁读取结果）。
 * 只承载裁决所需事实；权限与可编辑性判断归 usecase。
 * currentRevisionNo 供送审计算下一版本号（锁内读取，保证版本号单调）。
 */
export type ContentSubmissionLockSnapshot = {
  id: number;
  submissionKind: ContentSubmissionKind;
  ownerOrganizationId: number;
  submittedByAccountId: number;
  status: ContentSubmissionStatus;
  currentRevisionNo: number;
};

/**
 * 写动作后的最小状态快照（write-then-read 同一事务回读的真实落库状态），
 * mutation 契约「返回真实保存状态」的载体：不回显请求入参里的状态值。
 */
export type ContentSubmissionStatusSnapshot = {
  id: number;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  updatedAt: Date;
};

/** 普通资料明细写入数据（创建与全量覆盖更新共用；null = 该列为空） */
export type MaterialSubmissionDetailWriteData = {
  title: string | null;
  documentType: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  description: string | null;
  contentText: string | null;
};

/** 故障案例明细写入数据（创建与全量覆盖更新共用；null = 该列为空） */
export type FaultCaseSubmissionDetailWriteData = {
  title: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  errorCode: string | null;
  phenomenon: string | null;
  conditionText: string | null;
  reproductionSteps: string | null;
  diagnosis: string | null;
  actionTaken: string | null;
  handlingStatus: ContentSubmissionHandlingStatus | null;
  resolution: string | null;
};

/**
 * 创建草稿写入数据（usecase 完成全部业务判定后传入）。
 * ownerOrganizationId 来自可信组织上下文解析、submittedByAccountId 仅取自可信 Session，
 * 均不得由客户端传入；两类明细恰好一个非 null（与 submissionKind 对应）。
 */
export type ContentSubmissionInsertData = {
  submissionKind: ContentSubmissionKind;
  ownerOrganizationId: number;
  submittedByAccountId: number;
  material: MaterialSubmissionDetailWriteData | null;
  faultCase: FaultCaseSubmissionDetailWriteData | null;
};

/**
 * 附件登记写入数据（usecase 完成授权/状态/文件策略判定后传入）。
 * 存储引用由 usecase 编排的存储合约生成（服务端随机、无路径语义），
 * 客户端不参与命名与引用传递。
 */
export type ContentSubmissionAttachmentInsertData = {
  submissionId: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  storageBackend: string;
  storageReference: string;
  uploadedByAccountId: number;
};

/** 附件登记结果（安全元数据：附件 ID、原名、MIME、实际大小） */
export type ContentSubmissionAttachmentUploadSnapshot = {
  attachmentId: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
};

/** 投稿访问裁决事实（下载链路：本人/组织归属判定所需最小事实） */
export type ContentSubmissionAccessFacts = {
  submittedByAccountId: number;
  ownerOrganizationId: number;
};

/**
 * 下载目标附件引用（含内部存储引用，仅 usecase 中转，不进任何 DTO/视图）；
 * 不按状态过滤——历史 RETIRED 原件经授权同样可下载（A-PR0 §4.2）。
 */
export type ContentSubmissionAttachmentDownloadRef = {
  id: number;
  originalFilename: string;
  mimeType: string;
  storageReference: string;
};

/**
 * 送审版本冻结写入数据（usecase 完成状态裁决与完整校验后传入）：
 * payloadSnapshot 为业务字段完整快照（不含存储引用与服务器路径），
 * attachmentId 为当次真实 CURRENT 附件 ID（无附件为 null）。
 */
export type ContentSubmissionRevisionInsertData = {
  submissionId: number;
  revisionNo: number;
  payloadSnapshot: Record<string, unknown>;
  schemaVersion: number;
  titleSnapshot: string;
  attachmentId: number | null;
  noticeVersion: string;
  confirmedByAccountId: number;
};

/**
 * 审核记录写入数据（usecase 完成角色/组织/状态/版本裁决后传入）。
 * comment 退回必填、通过可选；publishAttachment 为通过时附件发布决定
 * （退回由数据库 CHECK 强制为 false）。
 */
export type ContentSubmissionReviewInsertData = {
  submissionId: number;
  revisionId: number;
  decision: 'RETURN' | 'APPROVE';
  reviewedByAccountId: number;
  comment: string | null;
  publishAttachment: boolean;
};

/**
 * 冻结版本稳定视图（A-PR0 §4.1 `contentSubmissionRevision`）：
 * 本人或本组织管理员可读；含完整内容快照、附件安全元数据（无存储引用）
 * 与版本审核记录（版本 ID 唯一，至多一条）。
 */
export type ContentSubmissionRevisionView = {
  revisionId: number;
  submissionId: number;
  submissionKind: ContentSubmissionKind;
  revisionNo: number;
  schemaVersion: number;
  titleSnapshot: string;
  payloadSnapshot: Record<string, unknown>;
  attachment: ContentSubmissionAttachmentMetaView | null;
  noticeVersion: string;
  confirmedAt: Date;
  submittedAt: Date;
  review: ContentSubmissionLatestReviewView | null;
};

/** 历史审核条目（跨版本，审核详情历史区）：版本号 + 审核事实，不含审核人账号 ID */
export type ContentSubmissionReviewHistoryItemView = {
  revisionId: number;
  revisionNo: number;
  decision: string;
  comment: string | null;
  publishAttachment: boolean;
  reviewedAt: Date;
};

/**
 * 审核详情稳定视图（A-PR0 §4.1 `reviewContentSubmission`）：
 * 当前版本完整视图（无版本时为 null）+ 全部历史审核（新在前）+ 投稿基础事实。
 * 不含 storageReference / 服务器路径；公开性由调用方 usecase 先行裁决。
 */
export type ContentSubmissionReviewDetailView = {
  submissionId: number;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  currentRevisionNo: number;
  lastSubmittedAt: Date | null;
  submittedByAccountId: number;
  currentRevision: ContentSubmissionRevisionView | null;
  reviewHistory: ContentSubmissionReviewHistoryItemView[];
};

/**
 * 发布用附件引用（含内部存储引用，仅 usecase 中转，不进任何 DTO/视图）：
 * 审核通过时获准原件 = 冻结版本的 attachment_id 对应行。
 */
export type ContentSubmissionAttachmentPublishRef = {
  id: number;
  originalFilename: string;
  mimeType: string;
  storageReference: string;
};

/**
 * 发布用版本来源事实（审核通过事务外的文件复制准备）：
 * revision 行冻结不可变；事务内仍须行锁重核状态与目标版本归属
 * （A-PR0 S5.4：「文件准备后进入事务时仍须锁定并重新核对状态/版本」）。
 */
export type ContentSubmissionRevisionPublishSource = {
  revisionId: number;
  revisionNo: number;
  submissionKind: ContentSubmissionKind;
  titleSnapshot: string;
  payloadSnapshot: Record<string, unknown>;
  attachment: ContentSubmissionAttachmentPublishRef | null;
};
