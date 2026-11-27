// src/features/my-records/infrastructure/my-records.types.ts

/**
 * 「我的资料记录」前端契约（与 backend/src/adapters/api/graphql/maintenance-report/dto 对齐）。
 *
 * 只包含后端 DTO 已剥离安全字段后的展示字段：不出现账号 ID、组织 ID、存储引用
 * 与冻结快照 JSON。报告状态为受控字符串，前端不硬编码「正式」单一状态，而是用
 * `isDraftRecordStatus` 判定未完成（草稿/退回）。
 */

export type MyRecordSourceType = 'HISTORICAL_CASE' | 'WORK_ORDER_SUMMARY';

/** 记录状态：任务 06 合入后会新增 SUBMITTED，前端按「非草稿即正式」兼容未知状态 */
export type MyRecordStatus = 'DRAFT' | 'RETURNED' | 'PENDING_REVIEW' | 'APPROVED' | 'SUBMITTED';

export type MyRecordRecordKind = 'ALL' | 'DRAFT' | 'FORMAL';

export type MyRecordListFilter = {
  sourceType?: MyRecordSourceType;
  recordKind?: MyRecordRecordKind;
  /** 标题关键词：服务端在归属谓词内全量搜索（后端不支持时不得只筛当前页） */
  titleKeyword?: string;
};

export type MyRecordSummary = {
  id: number;
  sourceType: MyRecordSourceType;
  repairRequestId: number | null;
  title: string | null;
  status: MyRecordStatus;
  currentVersionNo: number;
  maintenanceDate: string | null;
  updatedAt: string;
  publishedDocumentId: number | null;
  /** 同步状态展示（任务 09 未接入前恒为 NOT_CONNECTED；不从保存成功推断已同步） */
  syncStatus: MyRecordSyncStatusView;
};

export type MyRecordListPage = {
  items: MyRecordSummary[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 同步状态展示值（任务 07 预留，与后端 maintenance-report.types 对齐；
 * 判定口径见 backend/docs/api/task07-task09-sync-status-handoff.md §4）：
 * 展示状态而非同步表枚举透传；NOT_CONNECTED/UNKNOWN 由任务 07 侧判定。
 */
export type MyRecordSyncStatus =
  | 'NOT_CONNECTED'
  | 'UNKNOWN'
  | 'NOT_APPLICABLE'
  | 'NO_TASK'
  | 'PENDING'
  | 'UPLOADING'
  | 'FAILED'
  | 'SYNCED'
  | 'CONFLICT'
  /** 后端任务 09 提案值：原记录账号授权失效（任务 07 枚举冻结前可能不出现） */
  | 'AUTHORIZATION_INVALID';

/** 附着到记录上的同步状态展示；与「草稿／已入库」独立，网页版当前默认隐藏同步列 */
export type MyRecordSyncStatusView = {
  status: MyRecordSyncStatus;
  /** 仅限面向用户的安全提示；不含快照、回执正文、内部错误或文件路径 */
  message: string | null;
  /** 仅当前版本存在未解决冲突时由任务 09 提供；处理路由本轮不接入 */
  conflictId: string | null;
  /** 仅据此决定是否提供处理入口；任务 09 打开/确认处理时仍须重新核权 */
  canResolveConflict: boolean;
};

export type MyRecordAlarm = {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: string;
  resetResult: string;
};

export type MyRecordStep = {
  stepNo: number;
  stepCode: string;
  phaseCode: string;
  partName: string | null;
  actionText: string;
  resultText: string | null;
  newAlarmCode: string | null;
  isValidNewBranch: boolean;
};

export type MyRecordAttachment = {
  id: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  description: string | null;
  sortOrder: number;
  status: 'CURRENT' | 'RETIRED';
};

export type MyRecordVersion = {
  id: number;
  versionNo: number;
  changeKind: string;
  changeReason: string | null;
  schemaVersion: number;
  submittedAt: string;
};

export type MyRecordVersionAttachment = {
  versionId: number;
  attachmentId: number;
  sortOrder: number;
  descriptionSnapshot: string | null;
  publishFlag: boolean;
};

export type MyRecordReview = {
  id: number;
  versionId: number;
  decision: 'APPROVE' | 'RETURN';
  comment: string | null;
  reviewedAt: string;
};

export type MyRecordReport = {
  id: number;
  sourceType: MyRecordSourceType;
  repairRequestId: number | null;
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  maintenanceEngineerName: string;
  status: MyRecordStatus;
  currentVersionNo: number;
  lastSubmittedAt: string | null;
  lastReviewedAt: string | null;
  aiUsage: string;
  aiScore: number | null;
  aiCorrectness: string | null;
  aiHelpfulness: number | null;
  aiNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MyRecordDetail = {
  report: MyRecordReport;
  alarms: MyRecordAlarm[];
  steps: MyRecordStep[];
  currentAttachments: MyRecordAttachment[];
  latestReturnComment: string | null;
  currentVersion: MyRecordVersion | null;
  currentVersionAttachments: MyRecordVersionAttachment[];
  currentReview: MyRecordReview | null;
  reviewHistory: MyRecordReview[];
  canEdit: boolean;
  equipmentModelName: string | null;
  publishedDocumentId: number | null;
  /** 同步状态展示（任务 07 预留；详情复用列表同一批量接口） */
  syncStatus: MyRecordSyncStatusView;
};

/**
 * 详情读取的领域失败结果（与历史维修记录详情同口径）：
 * 他人 / 跨公司 / 不存在统一 not-found；transport/auth 失败仍抛 GraphQLIngressError。
 */
export type MyRecordDetailResult =
  | { ok: true; detail: MyRecordDetail }
  | { ok: false; reason: 'not-found'; message: string };

/** 未完成（可续填）状态：仅 DRAFT / RETURNED；其余（含任务 06 的 SUBMITTED）视为正式 */
export function isDraftRecordStatus(status: MyRecordStatus | string): boolean {
  return status === 'DRAFT' || status === 'RETURNED';
}

/** 记录类型展示键：由页面翻译，feature 内不硬编码中英文文案 */
export function resolveRecordKindKey(status: MyRecordStatus | string): 'draft' | 'formal' {
  return isDraftRecordStatus(status) ? 'draft' : 'formal';
}
