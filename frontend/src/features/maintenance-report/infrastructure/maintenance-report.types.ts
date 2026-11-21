// src/features/maintenance-report/infrastructure/maintenance-report.types.ts
// 维修报告（任务 06）GraphQL 读模型类型：与后端 DTO 字段一一对应。

export type MaintenanceReportSourceType = 'HISTORICAL_CASE' | 'WORK_ORDER_SUMMARY';

export type MaintenanceReportStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PENDING_REVIEW'
  | 'RETURNED'
  | 'APPROVED';

export type ReportHandlingResult =
  | 'FIXED'
  | 'PART_PURCHASED'
  | 'PROVIDE_PLAN_SELF_EXECUTE'
  | 'INTERRUPTED'
  | 'UNREPAIRABLE';

export type ReportResetResult = 'NORMAL' | 'SAME_FAULT' | 'NEW_FAULT';

export type ReportStepResult = 'RESOLVED' | 'UNRESOLVED' | 'NEW_FAULT';

export type ReportFaultBranchKind = 'INITIAL' | 'RESET_NEW_FAULT' | 'STEP_NEW_FAULT';

export type MaintenanceReportFaultRecord = {
  id: string;
  branchKind: ReportFaultBranchKind;
  stepCode: string | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

export type MaintenanceReportStepRecord = {
  id: number;
  stepNo: number;
  stepCode: string;
  partName: string | null;
  actionText: string;
  resultCode: ReportStepResult | null;
  errorCode: string | null;
  resultText: string | null;
};

export type MaintenanceReportAttachmentRecord = {
  id: number;
  /** 关联暂存原件编号；历史行为 null，可用于授权下载 */
  fileId: string | null;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sortOrder: number;
};

/** 任务 11 上传暂存成功返回的标识与元数据（挂接只传标识，元数据以服务端事实为准） */
export type StagedMaintenanceReportFile = {
  fileId: string;
  uploadContextId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

export type MaintenanceReportUploadFailureReason =
  | 'invalid-input'
  | 'file-too-large'
  | 'file-type-not-allowed'
  | 'insufficient-permission'
  | 'upload-failed';

export type MaintenanceReportUploadResult =
  | { ok: true; file: StagedMaintenanceReportFile }
  | { ok: false; reason: MaintenanceReportUploadFailureReason; message: string };

export type MaintenanceReportAttachmentMutationResult =
  | { ok: true }
  | { ok: false; message: string };

/** R062-03 报告附件授权下载结果（受保护通道，不返回永久直链） */
export type MaintenanceReportAttachmentDownloadResult =
  | { ok: true; blob: Blob; filename: string }
  | {
      ok: false;
      reason: 'download-failed' | 'insufficient-permission' | 'not-found' | 'not-available';
      message: string;
    };

export type MaintenanceReportRecord = {
  id: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  status: MaintenanceReportStatus;
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  engineerName: string;
  handlingResult: ReportHandlingResult | null;
  closureReason: string | null;
  resetResult: ReportResetResult | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
  currentVersionNo: number;
  updatedAt: string;
  /** 任务 05 真实会话评价：USED / NOT_USED */
  aiUsage: MaintenanceReportAiUsage | null;
  aiSourceType: string | null;
  aiSourceId: string | null;
  aiSourceVersion: string | null;
  aiScore: number | null;
  aiCorrectness: MaintenanceReportAiCorrectness | null;
  aiHelpfulness: number | null;
  aiNote: string | null;
};

/** AI 使用标记（与后端 MaintenanceAiUsage 同值） */
export type MaintenanceReportAiUsage = 'USED' | 'NOT_USED';

/** AI 回答正确性（与后端 MaintenanceAiCorrectness 同值） */
export type MaintenanceReportAiCorrectness = 'CORRECT' | 'PARTIAL' | 'INCORRECT';

/**
 * 工单总结 AI 评价候选会话（任务 05 真实读侧）。
 * 只有「本人工单 + 同一公司 + 所选版本内已有有效回复」的会话才会出现；
 * 不含会话正文；`contentVersion` 为评价绑定的不可变版本。
 */
export type WorkOrderSummaryAiConversation = {
  conversationId: number;
  contentVersion: number;
  lastMessageSeq: number;
  effectiveReplyCount: number;
  createdAt: string;
  completedAt: string | null;
};

export type MaintenanceReportDetail = {
  report: MaintenanceReportRecord;
  steps: MaintenanceReportStepRecord[];
  faults: MaintenanceReportFaultRecord[];
  attachments: MaintenanceReportAttachmentRecord[];
  /**
   * 机型冻结语义：当前冻结版本快照中的机型显示名；旧快照缺键为 null。
   */
  frozenEquipmentModelName: string | null;
  canEdit: boolean;
};

export type MaintenanceReportSubmitResult = {
  reportId: number;
  versionId: number;
  versionNo: number;
  status: MaintenanceReportStatus;
  submissionRequestId: string;
  referenceDocumentId: number | null;
};

export type MaintenanceReportDraftResult = {
  reportId: number;
  status: MaintenanceReportStatus;
  currentVersionNo: number;
  updatedAt: string;
};

export type MaintenanceReportExportFormat = 'DOCX' | 'PDF';

export type MaintenanceReportExportResult = {
  format: MaintenanceReportExportFormat;
  fileName: string;
  mimeType: string;
  byteSize: number;
  contentBase64: string;
};

export type MaintenanceReportSummary = {
  id: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string | null;
  status: MaintenanceReportStatus;
  currentVersionNo: number;
  maintenanceDate: string | null;
  updatedAt: string;
};

export type MaintenanceReportPage = {
  items: MaintenanceReportSummary[];
  total?: number | null;
  page: number;
  pageSize: number;
};

export type WorkOrderSummaryCandidate = {
  repairRequestId: number;
  requestNo: string;
  equipmentModelCode: string | null;
  equipmentModelName: string | null;
  closedAt: string | null;
  handlingResult: ReportHandlingResult | null;
  /** 客户原始报修故障现象（2026-11-21 列表对齐 Demo 增列；无 intake 为 null） */
  intakeFaultDescription: string | null;
  reportId: number | null;
  reportStatus: MaintenanceReportStatus | null;
  reportUpdatedAt: string | null;
};

export type WorkOrderSummaryCandidatePage = {
  items: WorkOrderSummaryCandidate[];
  total?: number | null;
  page: number;
  pageSize: number;
};

/** 来源工单只读核对预览：与 sourceConfirmation 指纹同一份服务端事实（展示=校验） */
export type WorkOrderSummarySourcePreview = {
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

export type MyWorkOrderSummaryEntry = {
  repairRequestId: number;
  requestNo: string;
  equipmentModelId: number | null;
  equipmentModelCode: string | null;
  equipmentModelName: string | null;
  closedAt: string | null;
  /** 2026-11-20 需求调整：来源工单在草稿保存后是否已被管理员修订 */
  sourceChangedSinceDraft: boolean;
  sourceConfirmation: string;
  /** 2026-11-21 需求调整：与 sourceConfirmation 同源的服务端只读预览事实 */
  sourcePreview: WorkOrderSummarySourcePreview;
  report: MaintenanceReportDetail | null;
};

export type MaintenanceReportDraftInput = {
  title?: string | null;
  customerFactoryName?: string | null;
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  maintenanceDate?: string | null;
  handlingResult?: ReportHandlingResult | null;
  closureReason?: string | null;
  resetResult?: ReportResetResult | null;
  actualCause?: string | null;
  repairActions?: string | null;
  verificationResult?: string | null;
  supplementaryNote?: string | null;
  steps?: Array<{
    stepCode: string | null;
    partName: string | null;
    actionText: string;
    resultCode: ReportStepResult | null;
    errorCode: string | null;
    resultText: string | null;
  }>;
  faults?: Array<{
    branchKind: ReportFaultBranchKind;
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
  /** AI 评价组：undefined 表示沿用落库值；整个字段组可独立提交 */
  aiUsage?: MaintenanceReportAiUsage | null;
  aiSourceType?: string | null;
  aiSourceId?: string | null;
  aiSourceVersion?: string | null;
  aiScore?: number | null;
  aiCorrectness?: MaintenanceReportAiCorrectness | null;
  aiHelpfulness?: number | null;
  aiNote?: string | null;
};

export type EquipmentModelOption = {
  id: number;
  modelCode: string;
  modelName: string;
};
