// src/adapters/api/graphql/maintenance-report/dto/maintenance-report.dto.ts
// 维修报告（任务 06）GraphQL 输出契约：只输出安全读模型字段，不暴露组织/作者账号。

import {
  MaintenancePhaseCode,
  MaintenanceReportExportFormat,
  MaintenanceReportFaultBranchKind,
  MaintenanceReportResetResult,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
  MaintenanceReportStepResult,
} from '@app-types/models/maintenance-report.types';
import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';
import type {
  MaintenanceReportAttachmentSnapshot,
  MaintenanceReportDetailView,
  MaintenanceReportFaultSnapshot,
  MaintenanceReportSnapshot,
  MaintenanceReportStepSnapshot,
  MaintenanceReportSummaryView,
  MaintenanceReportVersionSnapshot,
  WorkOrderSummaryAiConversationView,
  WorkOrderSummaryCandidateView,
  WorkOrderSummarySourcePreviewView,
} from '@src/modules/lithography/maintenance-report.types';

@ObjectType({ description: '报告故障分支' })
export class MaintenanceReportFaultDTO {
  @Field(() => String, { description: '故障行 ID' })
  id!: string;

  @Field(() => MaintenanceReportFaultBranchKind, {
    description: 'INITIAL / RESET_NEW_FAULT / STEP_NEW_FAULT',
  })
  branchKind!: MaintenanceReportFaultBranchKind;

  @Field(() => String, { nullable: true, description: '步骤新故障所关联的步骤稳定编码' })
  stepCode!: string | null;

  @Field(() => MaintenancePhaseCode, { nullable: true, description: '流程阶段 PHASE_01—PHASE_10' })
  phaseCode!: MaintenancePhaseCode | null;

  @Field(() => String, { nullable: true })
  mainError!: string | null;

  @Field(() => String, { nullable: true })
  unitError!: string | null;

  @Field(() => String, { nullable: true })
  source!: string | null;

  @Field(() => String, { nullable: true })
  errorType!: string | null;

  @Field(() => String, { nullable: true })
  gpibStatus!: string | null;

  @Field(() => String, { nullable: true })
  faultStatus!: string | null;

  @Field(() => String, { description: '故障描述（必填）' })
  description!: string;

  @Field(() => String, { nullable: true })
  action!: string | null;
}

@ObjectType({ description: '报告排查步骤' })
export class MaintenanceReportStepDTO {
  @Field(() => Int)
  id!: number;

  @Field(() => Int, { description: '报告内顺序号' })
  stepNo!: number;

  @Field(() => String, { description: '步骤稳定编码（调序不变）' })
  stepCode!: string;

  @Field(() => MaintenancePhaseCode)
  phaseCode!: MaintenancePhaseCode;

  @Field(() => String, { nullable: true })
  partName!: string | null;

  @Field(() => String)
  actionText!: string;

  @Field(() => MaintenanceReportStepResult, { nullable: true })
  resultCode!: MaintenanceReportStepResult | null;

  @Field(() => String, { nullable: true })
  errorCode!: string | null;

  @Field(() => String, { nullable: true })
  resultText!: string | null;
}

@ObjectType({ description: '报告当前有效附件安全元数据（file_id 可用于授权下载；不返回存储引用）' })
export class MaintenanceReportAttachmentDTO {
  @Field(() => Int)
  id!: number;

  @Field(() => String, {
    nullable: true,
    description: '关联暂存原件编号；历史行为 NULL，可用于 R062-03 授权下载',
  })
  fileId!: string | null;

  @Field(() => String)
  originalFilename!: string;

  @Field(() => String)
  mimeType!: string;

  @Field(() => Int)
  byteSize!: number;

  @Field(() => Int)
  sortOrder!: number;
}

@ObjectType({ description: '报告基本信息与工作态状态' })
export class MaintenanceReportDTO {
  @Field(() => Int)
  id!: number;

  @Field(() => MaintenanceReportSourceType)
  sourceType!: MaintenanceReportSourceType;

  @Field(() => Int, { nullable: true, description: '工单总结关联工单 ID；独立报告为空' })
  repairRequestId!: number | null;

  @Field(() => MaintenanceReportStatus)
  status!: MaintenanceReportStatus;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String, { nullable: true })
  customerFactoryName!: string | null;

  @Field(() => Int, { nullable: true })
  equipmentModelId!: number | null;

  @Field(() => String, { nullable: true })
  equipmentModelText!: string | null;

  @Field(() => String, { nullable: true, description: '维修日期 YYYY-MM-DD；未填写为空' })
  maintenanceDate!: string | null;

  @Field(() => String, { description: '维修工程师姓名快照' })
  engineerName!: string;

  @Field(() => RepairRequestHandlingResult, { nullable: true })
  handlingResult!: RepairRequestHandlingResult | null;

  @Field(() => String, { nullable: true })
  closureReason!: string | null;

  @Field(() => MaintenanceReportResetResult, { nullable: true })
  resetResult!: MaintenanceReportResetResult | null;

  @Field(() => String, { nullable: true })
  actualCause!: string | null;

  @Field(() => String, { nullable: true })
  repairActions!: string | null;

  @Field(() => String, { nullable: true })
  verificationResult!: string | null;

  @Field(() => String, { nullable: true })
  supplementaryNote!: string | null;

  @Field(() => Int, { description: '最近冻结版本号；草稿为 0' })
  currentVersionNo!: number;

  @Field(() => Date)
  updatedAt!: Date;

  // —— AI 辅助排查评价（任务 05 真实会话）——

  @Field(() => String, { nullable: true, description: 'USED / NOT_USED' })
  aiUsage!: string | null;

  @Field(() => String, { nullable: true, description: '评价来源类型：AI_CONVERSATION' })
  aiSourceType!: string | null;

  @Field(() => String, { nullable: true, description: '评价来源会话标识' })
  aiSourceId!: string | null;

  @Field(() => String, { nullable: true, description: '评价绑定的不可变内容版本' })
  aiSourceVersion!: string | null;

  @Field(() => Int, { nullable: true, description: '综合评分 1-5' })
  aiScore!: number | null;

  @Field(() => String, { nullable: true, description: '正确性 CORRECT / PARTIAL / INCORRECT' })
  aiCorrectness!: string | null;

  @Field(() => Int, { nullable: true, description: '帮助度 1-4（历史值可能为 5）' })
  aiHelpfulness!: number | null;

  @Field(() => String, { nullable: true, description: '评价说明' })
  aiNote!: string | null;
}

@ObjectType({ description: '工单总结 AI 评价候选会话（只含有效回复的版本范围，不含正文）' })
export class WorkOrderSummaryAiConversationDTO {
  @Field(() => Int)
  conversationId!: number;

  @Field(() => Int, { description: '不可变内容版本（评价绑定此版本）' })
  contentVersion!: number;

  @Field(() => Int, { description: '该版本内的最后消息序号（消息截止点）' })
  lastMessageSeq!: number;

  @Field(() => Int, { description: '该版本内的有效回复数' })
  effectiveReplyCount!: number;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date, { nullable: true })
  completedAt!: Date | null;
}

@ObjectType({ description: '报告详情（工作态内容 + 可编辑性）' })
export class MaintenanceReportDetailDTO {
  @Field(() => MaintenanceReportDTO)
  report!: MaintenanceReportDTO;

  @Field(() => [MaintenanceReportStepDTO])
  steps!: MaintenanceReportStepDTO[];

  @Field(() => [MaintenanceReportFaultDTO])
  faults!: MaintenanceReportFaultDTO[];

  @Field(() => [MaintenanceReportAttachmentDTO])
  attachments!: MaintenanceReportAttachmentDTO[];

  /**
   * 机型冻结语义（加法式扩展）：当前冻结版本快照中的机型显示名。
   * 冻结视图展示此值，不随机型库改名变化；旧快照缺键为 null（前端回落
   * 实时解析，如实回退）。
   */
  @Field(() => String, {
    nullable: true,
    description: '当前冻结版本快照中的机型显示名称（旧快照可能缺失）',
  })
  frozenEquipmentModelName?: string | null;

  @Field(() => Boolean, { description: '当前是否可编辑（DRAFT/RETURNED）' })
  canEdit!: boolean;
}

@ObjectType({ description: '草稿保存结果' })
export class MaintenanceReportDraftResultDTO {
  @Field(() => Int)
  reportId!: number;

  @Field(() => MaintenanceReportStatus)
  status!: MaintenanceReportStatus;

  @Field(() => Int)
  currentVersionNo!: number;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType({ description: '报告附件集合变更结果（返回变更后的当前附件 ID 集合）' })
export class MaintenanceReportAttachmentResultDTO {
  @Field(() => Int)
  reportId!: number;

  @Field(() => [Int])
  attachmentIds!: number[];

  @Field(() => Int, { description: '当前附件集合总字节数' })
  currentBytes!: number;
}

@ObjectType({ description: 'R051-01 正式提交结果（冻结报告 + 正式资料）' })
export class MaintenanceReportSubmitResultDTO {
  @Field(() => Int)
  reportId!: number;

  @Field(() => Int)
  versionId!: number;

  @Field(() => Int)
  versionNo!: number;

  @Field(() => MaintenanceReportStatus)
  status!: MaintenanceReportStatus;

  @Field(() => String)
  submissionRequestId!: string;

  @Field(() => Int, { nullable: true, description: '冻结版本对应的正式资料 ID' })
  referenceDocumentId!: number | null;
}

@ObjectType({ description: '本人报告列表项' })
export class MaintenanceReportSummaryDTO {
  @Field(() => Int)
  id!: number;

  @Field(() => MaintenanceReportSourceType)
  sourceType!: MaintenanceReportSourceType;

  @Field(() => Int, { nullable: true })
  repairRequestId!: number | null;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => MaintenanceReportStatus)
  status!: MaintenanceReportStatus;

  @Field(() => Int)
  currentVersionNo!: number;

  @Field(() => String, { nullable: true })
  maintenanceDate!: string | null;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType({ description: '本人报告分页' })
export class MaintenanceReportPageDTO {
  @Field(() => [MaintenanceReportSummaryDTO])
  items!: MaintenanceReportSummaryDTO[];

  @Field(() => Int, { nullable: true })
  total?: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  pageSize!: number;
}

@ObjectType({ description: '工单维修总结待填写候选' })
export class WorkOrderSummaryCandidateDTO {
  @Field(() => Int)
  repairRequestId!: number;

  @Field(() => String)
  requestNo!: string;

  @Field(() => String, { nullable: true })
  equipmentModelCode!: string | null;

  @Field(() => String, { nullable: true })
  equipmentModelName!: string | null;

  @Field(() => Date, { nullable: true })
  closedAt!: Date | null;

  @Field(() => RepairRequestHandlingResult, { nullable: true })
  handlingResult!: RepairRequestHandlingResult | null;

  @Field(() => String, {
    nullable: true,
    description: '客户原始报修故障现象（无 intake 报修为空）',
  })
  intakeFaultDescription!: string | null;

  @Field(() => Int, { nullable: true, description: '已存在的草稿 ID；未保存过为空' })
  reportId!: number | null;

  @Field(() => MaintenanceReportStatus, { nullable: true })
  reportStatus!: MaintenanceReportStatus | null;

  @Field(() => Date, { nullable: true })
  reportUpdatedAt!: Date | null;
}

@ObjectType({ description: '工单维修总结待填写分页' })
export class WorkOrderSummaryCandidatePageDTO {
  @Field(() => [WorkOrderSummaryCandidateDTO])
  items!: WorkOrderSummaryCandidateDTO[];

  @Field(() => Int, { nullable: true })
  total?: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  pageSize!: number;
}

@ObjectType({ description: '来源工单原件引用（不暴露存储引用）' })
export class WorkOrderSummarySourceAttachmentDTO {
  @Field(() => String)
  fileId!: string;

  @Field(() => String)
  originalFilename!: string;

  @Field(() => Int)
  byteSize!: number;
}

@ObjectType({
  description: '来源工单只读核对预览：与 sourceConfirmation 指纹同一份服务端事实（展示=校验）',
})
export class WorkOrderSummarySourcePreviewDTO {
  @Field(() => String, { nullable: true })
  customerCompanyName!: string | null;

  @Field(() => String, { nullable: true })
  handlingResult!: string | null;

  @Field(() => String, { nullable: true })
  closureReason!: string | null;

  @Field(() => String, { nullable: true })
  maintenanceDate!: string | null;

  @Field(() => String, { nullable: true })
  engineerName!: string | null;

  @Field(() => String, { nullable: true })
  resetResult!: string | null;

  @Field(() => String, { nullable: true })
  supplementaryNote!: string | null;

  @Field(() => WorkOrderSummarySourceAttachmentDTO, { nullable: true })
  attachment!: WorkOrderSummarySourceAttachmentDTO | null;

  @Field(() => String, { nullable: true })
  intakeFaultDescription!: string | null;

  @Field(() => WorkOrderSummarySourceAttachmentDTO, { nullable: true })
  intakeCustomerFile!: WorkOrderSummarySourceAttachmentDTO | null;

  @Field(() => [WorkOrderSummarySourcePreviewStepDTO])
  steps!: WorkOrderSummarySourcePreviewStepDTO[];

  @Field(() => [WorkOrderSummarySourcePreviewPanelDTO])
  panels!: WorkOrderSummarySourcePreviewPanelDTO[];
}

@ObjectType({ description: '来源工单排查步骤（只读预览）' })
export class WorkOrderSummarySourcePreviewStepDTO {
  @Field(() => Int)
  stepNo!: number;

  @Field(() => String, { nullable: true })
  errorCode!: string | null;

  @Field(() => String, { nullable: true })
  partName!: string | null;

  @Field(() => String)
  actionText!: string;

  @Field(() => String)
  resultCode!: string;
}

@ObjectType({ description: '来源工单故障面板（只读预览）' })
export class WorkOrderSummarySourcePreviewPanelDTO {
  @Field(() => String)
  panelType!: string;

  @Field(() => Int, { nullable: true })
  stepNo!: number | null;

  @Field(() => String, { nullable: true })
  phaseCode!: string | null;

  @Field(() => String, { nullable: true })
  mainError!: string | null;

  @Field(() => String, { nullable: true })
  unitError!: string | null;

  @Field(() => String, { nullable: true })
  source!: string | null;

  @Field(() => String, { nullable: true })
  errorType!: string | null;

  @Field(() => String, { nullable: true })
  gpibStatus!: string | null;

  @Field(() => String, { nullable: true })
  faultStatus!: string | null;

  @Field(() => String)
  description!: string;

  @Field(() => String, { nullable: true })
  action!: string | null;
}

@ObjectType({ description: '工单总结入口（资格校验后返回表头事实与已有草稿或空）' })
export class MyWorkOrderSummaryDTO {
  @Field(() => Int)
  repairRequestId!: number;

  @Field(() => String)
  requestNo!: string;

  @Field(() => Int, { nullable: true, description: '工单设备型号 ID（带出表头，可改选/手填覆盖）' })
  equipmentModelId!: number | null;

  @Field(() => String, { nullable: true })
  equipmentModelCode!: string | null;

  @Field(() => String, { nullable: true })
  equipmentModelName!: string | null;

  @Field(() => Date, { nullable: true })
  closedAt!: Date | null;

  @Field(() => MaintenanceReportDetailDTO, { nullable: true })
  report!: MaintenanceReportDetailDTO | null;

  @Field(() => Boolean, {
    description: '来源工单在草稿保存后是否已被修订（可编辑草稿存在且服务端派生内容不一致）',
  })
  sourceChangedSinceDraft!: boolean;

  @Field(() => String)
  sourceConfirmation!: string;

  @Field(() => WorkOrderSummarySourcePreviewDTO, {
    description: '与 sourceConfirmation 同源的服务端只读预览事实',
  })
  sourcePreview!: WorkOrderSummarySourcePreviewDTO;
}

@ObjectType({ description: 'R051 维修报告导出结果（内容以 base64 返回；导出不写库）' })
export class MaintenanceReportExportResultDTO {
  @Field(() => MaintenanceReportExportFormat)
  format!: MaintenanceReportExportFormat;

  @Field(() => String, { description: '建议的下载文件名（服务端清洗）' })
  fileName!: string;

  @Field(() => String, { description: 'MIME 类型：DOCX/PDF' })
  mimeType!: string;

  @Field(() => Int, { description: '文件字节数' })
  byteSize!: number;

  @Field(() => String, { description: '文档字节内容的 base64 编码' })
  contentBase64!: string;
}

/* ------------------------------ mapper ------------------------------ */

export function toMaintenanceReportDTO(snapshot: MaintenanceReportSnapshot): MaintenanceReportDTO {
  return {
    id: snapshot.id,
    sourceType: snapshot.sourceType,
    repairRequestId: snapshot.repairRequestId,
    status: snapshot.status,
    title: snapshot.title,
    customerFactoryName: snapshot.customerFactoryName,
    equipmentModelId: snapshot.equipmentModelId,
    equipmentModelText: snapshot.equipmentModelText,
    maintenanceDate: snapshot.maintenanceDate,
    engineerName: snapshot.maintenanceEngineerNameSnapshot,
    handlingResult: snapshot.handlingResult as RepairRequestHandlingResult | null,
    closureReason: snapshot.closureReason,
    resetResult: snapshot.resetResult,
    actualCause: snapshot.actualCause,
    repairActions: snapshot.repairActions,
    verificationResult: snapshot.verificationResult,
    supplementaryNote: snapshot.supplementaryNote,
    currentVersionNo: snapshot.currentVersionNo,
    updatedAt: snapshot.updatedAt,
    aiUsage: snapshot.aiUsage,
    aiSourceType: snapshot.aiSourceType,
    aiSourceId: snapshot.aiSourceId,
    aiSourceVersion: snapshot.aiSourceVersion,
    aiScore: snapshot.aiScore,
    aiCorrectness: snapshot.aiCorrectness,
    aiHelpfulness: snapshot.aiHelpfulness,
    aiNote: snapshot.aiNote,
  };
}

export function toWorkOrderSummaryAiConversationDTO(
  view: WorkOrderSummaryAiConversationView,
): WorkOrderSummaryAiConversationDTO {
  return {
    conversationId: view.conversationId,
    contentVersion: view.contentVersion,
    lastMessageSeq: view.lastMessageSeq,
    effectiveReplyCount: view.effectiveReplyCount,
    createdAt: view.createdAt,
    completedAt: view.completedAt,
  };
}

function toWorkOrderSummarySourceAttachmentDTO(
  view: { fileId: string; originalFilename: string; byteSize: number } | null,
): WorkOrderSummarySourceAttachmentDTO | null {
  return view === null
    ? null
    : {
        fileId: view.fileId,
        originalFilename: view.originalFilename,
        byteSize: view.byteSize,
      };
}

export function toWorkOrderSummarySourcePreviewDTO(
  view: WorkOrderSummarySourcePreviewView,
): WorkOrderSummarySourcePreviewDTO {
  return {
    customerCompanyName: view.customerCompanyName,
    handlingResult: view.handlingResult,
    closureReason: view.closureReason,
    maintenanceDate: view.maintenanceDate,
    engineerName: view.engineerName,
    resetResult: view.resetResult,
    supplementaryNote: view.supplementaryNote,
    attachment: toWorkOrderSummarySourceAttachmentDTO(view.attachment),
    intakeFaultDescription: view.intakeFaultDescription,
    intakeCustomerFile: toWorkOrderSummarySourceAttachmentDTO(view.intakeCustomerFile),
    steps: view.steps.map((step) => ({ ...step })),
    panels: view.panels.map((panel) => ({ ...panel })),
  };
}

export function toMaintenanceReportStepDTO(
  step: MaintenanceReportStepSnapshot,
): MaintenanceReportStepDTO {
  return {
    id: step.id,
    stepNo: step.stepNo,
    stepCode: step.stepCode,
    phaseCode: step.phaseCode,
    partName: step.partName,
    actionText: step.actionText,
    resultCode: step.resultCode,
    errorCode: step.errorCode,
    resultText: step.resultText,
  };
}

export function toMaintenanceReportFaultDTO(
  fault: MaintenanceReportFaultSnapshot,
): MaintenanceReportFaultDTO {
  return {
    id: fault.id,
    branchKind: fault.branchKind,
    stepCode: fault.stepCode,
    phaseCode: fault.phaseCode,
    mainError: fault.mainError,
    unitError: fault.unitError,
    source: fault.source,
    errorType: fault.errorType,
    gpibStatus: fault.gpibStatus,
    faultStatus: fault.faultStatus,
    description: fault.description,
    action: fault.action,
  };
}

export function toMaintenanceReportAttachmentDTO(
  attachment: MaintenanceReportAttachmentSnapshot,
): MaintenanceReportAttachmentDTO {
  return {
    id: attachment.id,
    fileId: attachment.fileId,
    originalFilename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    sortOrder: attachment.sortOrder,
  };
}

export function toMaintenanceReportDetailDTO(
  detail: MaintenanceReportDetailView,
): MaintenanceReportDetailDTO {
  return {
    report: toMaintenanceReportDTO(detail.report),
    steps: detail.steps.map(toMaintenanceReportStepDTO),
    faults: detail.faults.map(toMaintenanceReportFaultDTO),
    attachments: detail.currentAttachments.map(toMaintenanceReportAttachmentDTO),
    frozenEquipmentModelName: readFrozenEquipmentModelName(detail.currentVersion),
    canEdit: detail.canEdit,
  };
}

/**
 * 机型冻结语义：从当前冻结版本快照读取提交当时冻结的机型显示名；
 * 仅接受非空字符串，旧快照缺键/空值/类型异常一律返回 null（不伪造历史值）。
 */
function readFrozenEquipmentModelName(
  version: MaintenanceReportVersionSnapshot | null,
): string | null {
  if (version === null) return null;
  const value = version.payloadSnapshot['equipmentModelName'];
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}

export function toMaintenanceReportSummaryDTO(
  summary: MaintenanceReportSummaryView,
): MaintenanceReportSummaryDTO {
  return {
    id: summary.id,
    sourceType: summary.sourceType,
    repairRequestId: summary.repairRequestId,
    title: summary.title,
    status: summary.status,
    currentVersionNo: summary.currentVersionNo,
    maintenanceDate: summary.maintenanceDate,
    updatedAt: summary.updatedAt,
  };
}

export function toWorkOrderSummaryCandidateDTO(
  candidate: WorkOrderSummaryCandidateView,
): WorkOrderSummaryCandidateDTO {
  return {
    repairRequestId: candidate.repairRequestId,
    requestNo: candidate.requestNo,
    equipmentModelCode: candidate.equipmentModelCode,
    equipmentModelName: candidate.equipmentModelName,
    closedAt: candidate.closedAt,
    handlingResult: candidate.handlingResult as RepairRequestHandlingResult | null,
    intakeFaultDescription: candidate.intakeFaultDescription,
    reportId: candidate.reportId,
    reportStatus: candidate.reportStatus,
    reportUpdatedAt: candidate.reportUpdatedAt,
  };
}
