// src/usecases/maintenance-report/maintenance-report-command.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { MaintenanceReportExportFormat } from '@app-types/models/maintenance-report.types';
import type {
  MaintenanceReportDetailView,
  MaintenanceReportDraftWriteData,
  MaintenanceReportSyncStatusDisplay,
} from '@src/modules/lithography/maintenance-report.types';
import type { MaintenanceReportStagedAttachmentInput } from './maintenance-report-attachment-binding.helpers';

export type MaintenanceReportAlarmInput = {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription?: string | null;
  phaseCode: string;
  resetResult: string;
};

export type MaintenanceReportStepInput = {
  /** 步骤稳定编码；新步骤由前端生成，缺省时服务端按次序回落 */
  stepCode?: string | null;
  /** 步骤阶段：V6.5 §8.3 未要求逐步骤填写，缺省时继承初始故障阶段 */
  phaseCode?: string | null;
  partName?: string | null;
  actionText: string;
  resultCode?: string | null;
  errorCode?: string | null;
  resultText?: string | null;
  newAlarmCode?: string | null;
  isValidNewBranch?: boolean;
};

/**
 * 报告故障分支输入（与前端编辑器面板字段一一对应）。
 * `stepNo` 仅 STEP_NEW_FAULT 使用，指向本次输入数组中的步骤顺序号。
 */
export type MaintenanceReportFaultInput = {
  branchKind: string;
  stepNo?: number | null;
  phaseCode?: string | null;
  mainError?: string | null;
  unitError?: string | null;
  source?: string | null;
  errorType?: string | null;
  gpibStatus?: string | null;
  faultStatus?: string | null;
  description: string;
  action?: string | null;
};

export type MaintenanceReportDraftInput = {
  title?: string | null;
  customerFactoryName?: string | null;
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  maintenanceDate?: string | null;
  handlingResult?: string | null;
  closureReason?: string | null;
  resetResult?: string | null;
  actualCause?: string | null;
  repairActions?: string | null;
  verificationResult?: string | null;
  supplementaryNote?: string | null;
  alarms?: MaintenanceReportAlarmInput[];
  steps?: MaintenanceReportStepInput[];
  faults?: MaintenanceReportFaultInput[];
  aiUsage?: string;
  aiSourceType?: string | null;
  aiSourceId?: string | null;
  aiSourceVersion?: string | null;
  aiScore?: number | null;
  aiCorrectness?: string | null;
  aiHelpfulness?: number | null;
  aiNote?: string | null;
};

export type CreateMaintenanceReportCommand = {
  session: UsecaseSession;
  sourceType: string;
  repairRequestId?: number | null;
  draft: MaintenanceReportDraftInput;
  /**
   * R050-01 / R045-02 首次保存同事务绑定的暂存原件（可选）。
   * 服务端核验任务 11 暂存事实后原子绑定并登记附件行（含 file_id），
   * 失败与草稿创建一起回滚。
   */
  attachment?: MaintenanceReportStagedAttachmentInput | null;
};

export type UpdateMaintenanceReportDraftCommand = {
  session: UsecaseSession;
  reportId: number;
  draft: MaintenanceReportDraftInput;
  /**
   * R050-02/R062-01 续填草稿同事务绑定/更换暂存原件（可选）：
   * 与内容更新同一事务；已有有效原件且 file_id 不同时先退役旧关联再绑定新原件，
   * 任一步失败与内容一起回滚，不丢失原有有效关联。
   */
  attachment?: MaintenanceReportStagedAttachmentInput | null;
};

export type SubmitMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
};

/**
 * R051-01 正式提交命令：草稿提交与首次未保存表单直接提交共用。
 *
 * - submissionRequestId：系统生成、同次提交重试复用；服务端按
 *   (操作者, 公司, 提交标识) 定位既有结果并比对规范化内容摘要；
 * - reportId 缺省时走直接提交路径（同事务创建报告根并冻结）；
 * - expectedVersionNo 仅在有 reportId 时校验，合法幂等重试不因旧版本被拒。
 */
export type SubmitMaintenanceReportFormalCommand = {
  session: UsecaseSession;
  sourceType: string;
  repairRequestId?: number | null;
  reportId?: number | null;
  expectedVersionNo?: number | null;
  submissionRequestId: string;
  sourceConfirmation?: string | null;
  draft: MaintenanceReportDraftInput;
  /**
   * R051-01 直接提交时附带的本轮暂存原件（可选；fileId 计入提交内容摘要）。
   * 同事务绑定并随冻结版本关联；幂等重试须携带同一 fileId 命中原摘要。
   */
  attachment?: MaintenanceReportStagedAttachmentInput | null;
};

export type MaintenanceReportFormalSubmitResult = {
  reportId: number;
  versionId: number;
  versionNo: number;
  status: 'SUBMITTED';
  submissionRequestId: string;
  /** 冻结版本对应的正式资料（reference_document）ID */
  referenceDocumentId: number | null;
};

export type ReviewMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
  comment?: string | null;
};

export type ApproveMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
  comment?: string | null;
  publishedAttachmentIds?: number[];
};

export type MaintenanceReportDraftWriteResult = {
  reportId: number;
  draft: MaintenanceReportDraftWriteData;
};

export type MaintenanceReportPagination = {
  /** 分页模式：本人记录列表第一版仅支持 OFFSET（CURSOR 明确拒绝，不静默降级） */
  mode?: 'OFFSET' | 'CURSOR';
  page?: number;
  pageSize?: number;
  withTotal?: boolean;
};

export type GetMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
};

export type ListMyMaintenanceReportsCommand = {
  session: UsecaseSession;
  pagination?: MaintenanceReportPagination;
  /** 可选来源过滤（任务 06 兼容形态）：HISTORICAL_CASE / WORK_ORDER_SUMMARY */
  sourceType?: string;
  /** 任务 07 本人记录筛选：来源类型 + 未完成/已提交 + 标题关键词（服务端全量 LIKE） */
  filter?: {
    sourceType?: string;
    recordKind?: 'ALL' | 'DRAFT' | 'FORMAL';
    titleKeyword?: string;
  };
};

export type GetMyWorkOrderSummaryCommand = {
  session: UsecaseSession;
  repairRequestId: number;
};

export type ListMyWorkOrderSummaryCandidatesCommand = {
  session: UsecaseSession;
  pagination?: MaintenanceReportPagination;
};

/** 工单总结 AI 评价候选会话读取（任务 05 真实读侧，按工单过滤） */
export type ListWorkOrderSummaryAiConversationsCommand = {
  session: UsecaseSession;
  repairRequestId: number;
};

export type ListMaintenanceReportReviewQueueCommand = {
  session: UsecaseSession;
  pagination?: MaintenanceReportPagination;
};

/**
 * R051 导出命令：预览/导出不写库，只读。
 *
 * - currentForm：工程师本人完整的当前表单（含未保存草稿）；服务端按正式提交
 *   同一套完整性与工单前置校验内容，但不创建报告、不登记机型；
 * - savedVersion：当前用户有权读取的已保存报告冻结版本；版本号缺省取当前版本。
 */
export type ExportMaintenanceReportCurrentFormTarget = {
  sourceType: string;
  repairRequestId?: number | null;
  draft: MaintenanceReportDraftInput;
};

export type ExportMaintenanceReportSavedVersionTarget = {
  reportId: number;
  versionNo?: number | null;
};

export type ExportMaintenanceReportCommand = {
  session: UsecaseSession;
  format: string;
  currentForm?: ExportMaintenanceReportCurrentFormTarget | null;
  savedVersion?: ExportMaintenanceReportSavedVersionTarget | null;
};

export type MaintenanceReportExportResult = {
  format: MaintenanceReportExportFormat;
  fileName: string;
  mimeType: string;
  byteSize: number;
  contentBase64: string;
};

export type MaintenanceReportDraftMutationResult = {
  reportId: number;
  status: string;
  currentVersionNo: number;
  updatedAt: Date;
};

export type MaintenanceReportSubmitResult = {
  reportId: number;
  versionId: number;
  versionNo: number;
  status: string;
};

export type MaintenanceReportReviewResult = {
  reportId: number;
  reviewId: number;
  decision: string;
  status: string;
  reviewedAt: Date;
};

/**
 * R050/R045-02 附件挂接命令：只接收任务 11 上传暂存返回的真实标识。
 * 服务端在同一事务内锁定并核验暂存原件事实（上传者/公司/用途/上下文/VALID/TEMPORARY），
 * 核验通过后原子绑定到报告并按 stored_file 事实登记附件元数据；
 * 不接受客户端自报的文件名、MIME、大小、校验和或存储引用。
 */
export type AddMaintenanceReportAttachmentCommand = {
  session: UsecaseSession;
  reportId: number;
  /** 任务 11 上传暂存返回的稳定原件编号（stored_file.file_id） */
  fileId: string;
  /** 上传暂存返回的 uploadContextId；与暂存登记不一致即拒绝 */
  uploadContextId: string;
  description?: string | null;
  sortOrder?: number | null;
};

export type RemoveMaintenanceReportAttachmentCommand = {
  session: UsecaseSession;
  reportId: number;
  attachmentId: number;
};

export type ReorderMaintenanceReportAttachmentsCommand = {
  session: UsecaseSession;
  reportId: number;
  orderedAttachmentIds: number[];
};

/**
 * 本人记录详情结果（任务 07）：完整报告详情 + 机型展示名 + 已发布正式资料标识
 * + 同步状态展示（任务 07 预留，详情复用列表同一批量接口）。
 * 仅本人可见；他人/跨公司统一 NOT_FOUND。
 */
export type MyMaintenanceReportDetailResult = MaintenanceReportDetailView & {
  equipmentModelName: string | null;
  publishedDocumentId: number | null;
  syncStatus: MaintenanceReportSyncStatusDisplay;
};

export type MaintenanceReportAttachmentMutationResult = {
  reportId: number;
  attachmentIds: number[];
  currentBytes: number;
};

export type RecordRepairRequestHandlingCommand = {
  session: UsecaseSession;
  repairRequestId: number;
  handlingResult: string;
  /**
   * 中断/无法修复原因：这两类结果必填且去空白后非空；
   * 其他结果不得携带原因，避免静默丢弃调用方输入。
   */
  closureReason?: string | null;
};

export type RecordRepairRequestHandlingResult = {
  repairRequestId: number;
  handlingResult: string;
  handlingStatus: string;
  handlingRecordedAt: Date;
  handlingEndedAt: Date | null;
  closureReason: string | null;
};
