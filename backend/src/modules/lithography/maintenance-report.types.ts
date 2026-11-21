// src/modules/lithography/maintenance-report.types.ts
// 维修报告域写模型与读模型（模块层内部契约，不含 GraphQL 装饰器）。

import {
  MaintenanceAiCorrectness,
  MaintenanceAiUsage,
  MaintenanceAlarmResetResult,
  MaintenanceAttachmentStatus,
  MaintenanceAttachmentStorageBackend,
  MaintenancePhaseCode,
  MaintenanceReportChangeKind,
  MaintenanceReportFaultBranchKind,
  MaintenanceReportResetResult,
  MaintenanceReportReviewDecision,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
  MaintenanceReportStepResult,
} from '@app-types/models/maintenance-report.types';

export type MaintenanceReportAlarmWriteData = {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: MaintenancePhaseCode;
  resetResult: MaintenanceAlarmResetResult;
};

export type MaintenanceReportStepWriteData = {
  stepNo: number;
  stepCode: string;
  phaseCode: MaintenancePhaseCode;
  partName: string | null;
  actionText: string;
  resultCode: MaintenanceReportStepResult | null;
  errorCode: string | null;
  resultText: string | null;
  newAlarmCode: string | null;
  isValidNewBranch: boolean;
};

/**
 * 报告故障分支写入事实：与前端编辑器面板一一对应。
 * `stepCode` 仅 STEP_NEW_FAULT 使用，且必须指向同一报告内的步骤稳定编码。
 */
export type MaintenanceReportFaultWriteData = {
  branchKind: MaintenanceReportFaultBranchKind;
  stepCode: string | null;
  phaseCode: MaintenancePhaseCode | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

export type MaintenanceReportInsertData = {
  ownerOrganizationId: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  maintenanceEngineerAccountId: number;
  maintenanceEngineerNameSnapshot: string;
  phaseFlowVersion: number;
  createdByAccountId: number;
  updatedByAccountId: number;
  /**
   * R051-01：直接提交（无 report_id）路径在创建报告根时即写入提交标识与摘要，
   * 由 (created_by, owner_org, submission_request_id) 唯一键处理并发竞争；
   * 已有草稿路径由 markSubmitted 统一写入。缺省为 NULL（普通建稿）。
   */
  submissionRequestId?: string | null;
  submissionPayloadHash?: string | null;
};

export type MaintenanceReportDraftWriteData = {
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  handlingResult: string | null;
  closureReason: string | null;
  resetResult: MaintenanceReportResetResult | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
  aiUsage: MaintenanceAiUsage;
  aiSourceType: string | null;
  aiSourceId: string | null;
  aiSourceVersion: string | null;
  aiScore: number | null;
  aiCorrectness: MaintenanceAiCorrectness | null;
  aiHelpfulness: number | null;
  aiNote: string | null;
  alarms: MaintenanceReportAlarmWriteData[];
  steps: MaintenanceReportStepWriteData[];
  faults: MaintenanceReportFaultWriteData[];
  updatedByAccountId: number;
};

export type MaintenanceReportAttachmentInsertData = {
  reportId: number;
  /** 关联暂存原件ID（迁移 1775502700000 追加；历史行保持 NULL） */
  fileId: string | null;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string | null;
  storageBackend: MaintenanceAttachmentStorageBackend;
  storageReference: string;
  sortOrder: number;
  description: string | null;
  uploadedByAccountId: number;
};

export type MaintenanceReportVersionInsertData = {
  reportId: number;
  versionNo: number;
  changeKind: MaintenanceReportChangeKind;
  changeReason: string | null;
  payloadSnapshot: Record<string, unknown>;
  submittedByAccountId: number;
  submittedAt: Date;
};

export type MaintenanceReportVersionAttachmentWriteData = {
  attachmentId: number;
  sortOrder: number;
  descriptionSnapshot: string | null;
};

export type MaintenanceReportReviewInsertData = {
  reportId: number;
  versionId: number;
  decision: MaintenanceReportReviewDecision;
  comment: string | null;
  reviewedByAccountId: number;
  reviewedAt: Date;
};

export type MaintenanceReportSnapshot = {
  id: number;
  ownerOrganizationId: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  handlingResult: string | null;
  closureReason: string | null;
  resetResult: MaintenanceReportResetResult | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
  maintenanceEngineerAccountId: number;
  maintenanceEngineerNameSnapshot: string;
  phaseFlowVersion: number;
  status: MaintenanceReportStatus;
  currentVersionNo: number;
  /** R051-01 提交标识与规范化内容摘要（SHA-256）；未提交为 NULL */
  submissionRequestId: string | null;
  submissionPayloadHash: string | null;
  lastSubmittedAt: Date | null;
  lastReviewedAt: Date | null;
  aiUsage: MaintenanceAiUsage;
  aiSourceType: string | null;
  aiSourceId: string | null;
  aiSourceVersion: string | null;
  aiScore: number | null;
  aiCorrectness: MaintenanceAiCorrectness | null;
  aiHelpfulness: number | null;
  aiNote: string | null;
  createdByAccountId: number;
  updatedByAccountId: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MaintenanceReportAlarmSnapshot = {
  id: number;
  reportId: number;
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: MaintenancePhaseCode;
  resetResult: MaintenanceAlarmResetResult;
};

export type MaintenanceReportStepSnapshot = {
  id: number;
  reportId: number;
  stepNo: number;
  stepCode: string;
  phaseCode: MaintenancePhaseCode;
  partName: string | null;
  actionText: string;
  resultCode: MaintenanceReportStepResult | null;
  errorCode: string | null;
  resultText: string | null;
  newAlarmCode: string | null;
  isValidNewBranch: boolean;
};

export type MaintenanceReportFaultSnapshot = {
  id: string;
  reportId: number;
  faultUuid: string;
  branchKind: MaintenanceReportFaultBranchKind;
  stepCode: string | null;
  phaseCode: MaintenancePhaseCode | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

export type MaintenanceReportAttachmentSnapshot = {
  id: number;
  reportId: number;
  /** 关联暂存原件ID；R062-02 元数据口径允许返回，不暴露存储引用 */
  fileId: string | null;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string | null;
  storageBackend: MaintenanceAttachmentStorageBackend;
  storageReference: string;
  sortOrder: number;
  description: string | null;
  status: MaintenanceAttachmentStatus;
  uploadedByAccountId: number;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MaintenanceReportVersionAttachmentSnapshot = {
  versionId: number;
  attachmentId: number;
  reportId: number;
  sortOrder: number;
  descriptionSnapshot: string | null;
  publishFlag: boolean;
};

export type MaintenanceReportVersionSnapshot = {
  id: number;
  reportId: number;
  versionNo: number;
  changeKind: MaintenanceReportChangeKind;
  changeReason: string | null;
  schemaVersion: number;
  payloadSnapshot: Record<string, unknown>;
  submittedByAccountId: number;
  submittedAt: Date;
  createdAt: Date;
};

export type MaintenanceReportReviewSnapshot = {
  id: number;
  reportId: number;
  versionId: number;
  decision: MaintenanceReportReviewDecision;
  comment: string | null;
  reviewedByAccountId: number;
  reviewedAt: Date;
};

/** 工单写路径需要的最小事实（不泄露客户联系方式） */
export type RepairRequestWriteContext = {
  id: number;
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  acceptedEngineerAccountId: number | null;
  isAccepted: boolean;
  deprecated: boolean;
  ownerOrganizationId: number | null;
  closureStatus: string | null;
  closedAt: Date | null;
  handlingResult: string | null;
  handlingStatus: string | null;
  /** 结单原因（中断/无法修复时非空）；工单总结派生内容使用 */
  closureReason: string | null;
  /** 客户公司组织 ID；工单总结派生客户厂家展示名使用 */
  customerOrganizationId: number | null;
  /** 管理员修订版本号；工单总结版本变化检测使用 */
  currentRevisionNo: number;
};

/** 维修报告最小归属事实（只读授权用，不含任何内容字段） */
export type MaintenanceReportOwnershipFacts = {
  reportId: number;
  maintenanceEngineerAccountId: number;
  ownerOrganizationId: number;
};

/**
 * 详情读取范围限制：授权通过后仍作为查询谓词传给详情读取，
 * 避免只依赖调用方第一次检查。
 */
export type MaintenanceReportReadScope = {
  ownerOrganizationId: number;
  maintenanceEngineerAccountId?: number;
};

export type MaintenanceReportDraftDetailView = {
  report: MaintenanceReportSnapshot;
  alarms: MaintenanceReportAlarmSnapshot[];
  steps: MaintenanceReportStepSnapshot[];
  faults: MaintenanceReportFaultSnapshot[];
  attachments: MaintenanceReportAttachmentSnapshot[];
  latestReturnComment: string | null;
};

export type MaintenanceReportReviewDetailView = {
  report: MaintenanceReportSnapshot;
  version: MaintenanceReportVersionSnapshot;
  versionAttachments: MaintenanceReportVersionAttachmentSnapshot[];
  review: MaintenanceReportReviewSnapshot | null;
  /** 历史版本审核记录（按审核时间升序） */
  reviewHistory: MaintenanceReportReviewSnapshot[];
};

/** 完整报告详情（本人/审核共用装配；权限由 usecase 先行裁决） */
export type MaintenanceReportDetailView = {
  report: MaintenanceReportSnapshot;
  /** 工作态草稿内容（报警/故障分支/步骤/当前附件） */
  alarms: MaintenanceReportAlarmSnapshot[];
  steps: MaintenanceReportStepSnapshot[];
  faults: MaintenanceReportFaultSnapshot[];
  currentAttachments: MaintenanceReportAttachmentSnapshot[];
  latestReturnComment: string | null;
  /** 当前冻结版本；currentVersionNo=0 时为 null */
  currentVersion: MaintenanceReportVersionSnapshot | null;
  currentVersionAttachments: MaintenanceReportVersionAttachmentSnapshot[];
  currentReview: MaintenanceReportReviewSnapshot | null;
  reviewHistory: MaintenanceReportReviewSnapshot[];
  /** 是否处于可编辑状态（DRAFT/RETURNED） */
  canEdit: boolean;
};

export type MaintenanceReportSummaryView = {
  id: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string | null;
  status: MaintenanceReportStatus;
  currentVersionNo: number;
  maintenanceDate: string | null;
  maintenanceEngineerAccountId: number;
  updatedAt: Date;
};

/**
 * 工单维修总结待填写候选：本人已接单且已结单、尚未正式提交的工单。
 * 草稿仍在候选内（用于续填）；正式提交后移出列表。
 */
export type WorkOrderSummaryCandidateView = {
  repairRequestId: number;
  requestNo: string;
  equipmentModelCode: string | null;
  equipmentModelName: string | null;
  closedAt: Date | null;
  handlingResult: string | null;
  /** 客户原始报修故障现象（2026-11-21 列表对齐 Demo 增列；无 intake 为 null） */
  intakeFaultDescription: string | null;
  /** 已存在的草稿 ID；尚未保存过草稿为 null */
  reportId: number | null;
  reportStatus: MaintenanceReportStatus | null;
  reportUpdatedAt: Date | null;
};

/**
 * 来源工单只读核对预览（2026-11-21 需求调整）。
 *
 * 与 `sourceConfirmation` 指纹由同一份服务端事实生成：页面展示的就是被校验的
 * 工单内容与原件引用，预览与校验不再走两条读取路径。不含 provenance 修订号。
 */
export type WorkOrderSummarySourcePreviewView = {
  customerCompanyName: string | null;
  handlingResult: string | null;
  closureReason: string | null;
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  attachment: { fileId: string; originalFilename: string; byteSize: number } | null;
  intakeFaultDescription: string | null;
  intakeCustomerFile: { fileId: string; originalFilename: string; byteSize: number } | null;
  steps: Array<{
    stepNo: number;
    errorCode: string | null;
    partName: string | null;
    actionText: string;
    resultCode: string;
  }>;
  panels: Array<{
    panelType: string;
    stepNo: number | null;
    phaseCode: string | null;
    mainError: string | null;
    unitError: string | null;
    source: string | null;
    errorType: string | null;
    gpibStatus: string | null;
    faultStatus: string | null;
    description: string;
    action: string | null;
  }>;
};

/** 工单总结入口读取结果：工单资格事实（带出表头）+ 已有报告详情 */
export type WorkOrderSummaryEntryView = {
  repairRequestId: number;
  requestNo: string;
  equipmentModelId: number | null;
  equipmentModelCode: string | null;
  equipmentModelName: string | null;
  closedAt: Date | null;
  report: MaintenanceReportDetailView | null;
  /**
   * 2026-11-20 需求调整：来源工单在草稿保存后是否已被管理员修订
   * （可编辑草稿存在且服务端派生内容与库内草稿不一致）。
   * 页面据此提示重新核对并重新保存后再提交；已提交/无草稿恒为 false。
   */
  sourceChangedSinceDraft: boolean;
  sourceConfirmation: string;
  /** 2026-11-21 需求调整：与 sourceConfirmation 同源的服务端只读预览事实 */
  sourcePreview: WorkOrderSummarySourcePreviewView;
};

/**
 * 工单总结 AI 评价候选会话（任务 05 真实读侧）。
 *
 * 只包含「本人工单、同一公司、所选版本内有有效回复」的会话；
 * 不含会话正文，版本内固定截止点用于说明评价范围。
 */
export type WorkOrderSummaryAiConversationView = {
  conversationId: number;
  /** 不可变内容版本（评价绑定此版本） */
  contentVersion: number;
  /** 该版本内的最后消息序号（消息截止点） */
  lastMessageSeq: number;
  /** 该版本内的有效回复数（ASSISTANT 且已保存回答） */
  effectiveReplyCount: number;
  createdAt: Date;
  completedAt: Date | null;
};
