// src/adapters/api/graphql/admin-document-database/dto/admin-document-database.dto.ts
// 管理员文档数据库（PR3 只读聚合）GraphQL 输出对象
// 不返回任何归属类账号 ID；昵称/公司名为服务端富集展示字段

import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  AiConversationStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';
import {
  EngineerResolutionStatus,
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import type {
  AdminAiReportDetailView,
  AdminRepairRequestListItemView,
  AdminRepairRequestResponseView,
  AdminRepairRequestRevisionDetailView,
  AdminRepairRequestRevisionSnapshotView,
  AdminRepairRequestRevisionView,
  AdminRepairRequestSummaryView,
} from '@src/modules/lithography/admin-document-database.types';
import { paginatedTypeFactory } from '@src/adapters/api/graphql/pagination.type-factory';
import {
  RepairIntakeSourceDTO,
  RepairMaintenanceFaultPanelDTO,
  RepairMaintenanceRecordDTO,
  RepairMaintenanceStepDTO,
  toRepairIntakeSourceDTO,
  toRepairMaintenanceFaultPanelDTO,
  toRepairMaintenanceRecordDTO,
  toRepairMaintenanceStepDTO,
} from '@src/adapters/api/graphql/repair-request/dto/repair-maintenance.dto';

// ---------- 维修申请 ----------

@ObjectType({ description: '管理员维修申请列表项' })
export class AdminRepairRequestListItemDTO {
  @Field(() => Int, { description: '维修申请 ID' })
  id!: number;

  @Field(() => String, { description: '申请编号' })
  requestNo!: string;

  @Field(() => String, { description: '客户当前昵称（缺失时回落「未知用户」）' })
  customerNickname!: string;

  @Field(() => String, { nullable: true, description: '客户所属公司名称（未填写为空）' })
  companyName?: string | null;

  @Field(() => Int, { description: '设备型号 ID' })
  equipmentModelId!: number;

  @Field(() => String, { description: '设备型号代码' })
  equipmentModelCode!: string;

  @Field(() => String, { description: '设备型号名称' })
  equipmentModelName!: string;

  @Field(() => String, { description: '故障码' })
  errorCode!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Boolean, { description: '是否已被接单' })
  isAccepted!: boolean;

  @Field(() => Date, { nullable: true, description: '接单时间（未接单为空）' })
  acceptedAt?: Date | null;

  @Field(() => String, { nullable: true, description: '接单工程师当前昵称（未接单为空）' })
  acceptedByEngineerNickname?: string | null;

  @Field(() => EngineerResolutionStatus, {
    nullable: true,
    description: '最新回复处理状态（尚无回复为空）',
  })
  latestResolutionStatus?: EngineerResolutionStatus | null;

  // ---- 工单真实进度（列表与详情复用；旧行可为空）----

  @Field(() => String, {
    nullable: true,
    description: '结单状态（OPEN / CLOSED）；字段缺失为 null，展示层按不可确认处理',
  })
  closureStatus?: string | null;

  @Field(() => Date, { nullable: true, description: '结单时间；未结单为空' })
  closedAt?: Date | null;

  @Field(() => RepairRequestHandlingResult, {
    nullable: true,
    description: '处理结果；尚未处理为空',
  })
  handlingResult?: RepairRequestHandlingResult | null;

  @Field(() => RepairRequestHandlingStatus, {
    nullable: true,
    description: '实际处理状态；尚未处理为空',
  })
  handlingStatus?: RepairRequestHandlingStatus | null;
}

@ObjectType({ description: '管理员工单内已保存原件的安全字段（不含存储引用）' })
export class AdminRepairProcessEntryFileDTO {
  @Field(() => String, { description: '原件 ID' })
  fileId!: string;

  @Field(() => String, { description: '原始文件名' })
  originalFilename!: string;

  @Field(() => String, { description: 'MIME 类型' })
  mimeType!: string;

  @Field(() => Int, { description: '字节数' })
  byteSize!: number;

  @Field(() => String, { description: 'SHA-256 校验值' })
  checksumSha256!: string;
}

@ObjectType({ description: '管理员工单内部维修过程（只读）' })
export class AdminRepairProcessEntryDTO {
  @Field(() => ID, { description: '过程记录 ID' })
  id!: string;

  @Field(() => String, { description: '过程记录业务 UUID' })
  entryUuid!: string;

  @Field(() => Int, { description: '所属维修申请 ID' })
  requestId!: number;

  @Field(() => String, { description: '操作内容' })
  operationText!: string;

  @Field(() => String, { nullable: true, description: '测试结果' })
  testResult?: string | null;

  @Field(() => Date, { nullable: true, description: '发生时间' })
  occurredAt?: Date | null;

  @Field(() => String, { description: '时间来源（SERVER / MANUAL）' })
  timeSource!: string;

  @Field(() => String, { nullable: true, description: '已绑定原件 ID' })
  fileId?: string | null;

  @Field(() => AdminRepairProcessEntryFileDTO, {
    nullable: true,
    description: '已保存绑定的原件安全字段（未绑定为空）',
  })
  file?: AdminRepairProcessEntryFileDTO | null;

  @Field(() => Int, { description: '过程当前版本号（用于管理修订）' })
  versionNo!: number;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

@ObjectType({ description: '管理员工单客户回复（只读）' })
export class AdminRepairResponseDTO {
  @Field(() => Int, { description: '回复 ID' })
  id!: number;

  @Field(() => String, { description: '回复正文' })
  responseText!: string;

  @Field(() => EngineerResolutionStatus, { description: '回复处理状态' })
  resolutionStatus!: EngineerResolutionStatus;

  @Field(() => String, { description: '回复工程师当前昵称' })
  engineerNickname!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

@ObjectType({ description: '管理员工单修订历史项' })
export class AdminRepairRevisionDTO {
  @Field(() => Int, { description: '修订后版本号' })
  revisionNo!: number;

  @Field(() => Int, { description: '修订前版本号' })
  previousVersion!: number;

  @Field(() => String, { description: '修订原因' })
  reason!: string;

  @Field(() => String, { description: '修订人当前昵称' })
  actorNickname!: string;

  @Field(() => Date, { description: '修订时间' })
  createdAt!: Date;

  @Field(() => Boolean, {
    description: '是否保存了可用于维修维度对比的前后快照（旧快照为 false）',
  })
  hasComparableSnapshot!: boolean;

  @Field(() => Int, { description: '快照结构版本' })
  schemaVersion!: number;
}

@ObjectType({ description: '修订快照中的排查步骤' })
export class AdminRevisionStepDTO {
  @Field(() => String)
  id!: string;

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

@ObjectType({ description: '修订快照中的故障面板' })
export class AdminRevisionPanelDTO {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  panelType!: string;

  @Field(() => String, { nullable: true })
  stepId!: string | null;

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

@ObjectType({ description: '管理修订快照（只读，不含存储引用）' })
export class AdminRevisionSnapshotDTO {
  @Field(() => Int)
  schemaVersion!: number;

  @Field(() => String)
  contentMd!: string;

  @Field(() => String, { nullable: true })
  handlingResult!: string | null;

  @Field(() => String, { nullable: true })
  handlingStatus!: string | null;

  @Field(() => String, { nullable: true })
  closureReason!: string | null;

  @Field(() => String, { nullable: true })
  maintenanceDate!: string | null;

  @Field(() => String, { nullable: true })
  maintenanceEngineerName!: string | null;

  @Field(() => String, { nullable: true })
  resetResult!: string | null;

  @Field(() => String, { nullable: true })
  supplementaryNote!: string | null;

  @Field(() => Int)
  maintenanceVersionNo!: number;

  @Field(() => String, { nullable: true })
  maintenanceAttachmentFileId!: string | null;

  @Field(() => [AdminRevisionStepDTO])
  steps!: AdminRevisionStepDTO[];

  @Field(() => [AdminRevisionPanelDTO])
  panels!: AdminRevisionPanelDTO[];
}

@ObjectType({ description: '管理员修订详情（查看版本 / 对比上一版）' })
export class AdminRepairRequestRevisionDetailDTO {
  @Field(() => Int)
  requestId!: number;

  @Field(() => Int)
  revisionNo!: number;

  @Field(() => Int)
  previousVersion!: number;

  @Field(() => String)
  reason!: string;

  @Field(() => String)
  actorNickname!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Boolean, { description: '前后快照是否都可解析；false 时只可查看不可比' })
  comparable!: boolean;

  @Field(() => Boolean, { description: '前后快照是否包含 v2 维修区块' })
  hasMaintenanceData!: boolean;

  @Field(() => String, {
    nullable: true,
    description: '不可比时的明确原因；可比时为空',
  })
  incomparableReason!: string | null;

  @Field(() => AdminRevisionSnapshotDTO, { nullable: true })
  before!: AdminRevisionSnapshotDTO | null;

  @Field(() => AdminRevisionSnapshotDTO, { nullable: true })
  after!: AdminRevisionSnapshotDTO | null;
}

@ObjectType({ description: '管理员工单只读详情（已提交事实）' })
export class AdminRepairRequestSummaryDTO extends AdminRepairRequestListItemDTO {
  @Field(() => String, { description: '故障描述' })
  faultDescription!: string;

  @Field(() => String, { description: '申请正文（Markdown，当前生效版本）' })
  contentMd!: string;

  @Field(() => String, { nullable: true, description: '结单原因' })
  closureReason?: string | null;

  @Field(() => Int, { description: '当前修订版本号' })
  currentRevisionNo!: number;

  @Field(() => [AdminRepairProcessEntryDTO], { description: '内部维修过程（已提交）' })
  processEntries!: AdminRepairProcessEntryDTO[];

  @Field(() => [AdminRepairResponseDTO], { description: '客户可见回复时间线' })
  responses!: AdminRepairResponseDTO[];

  @Field(() => [AdminRepairRevisionDTO], { description: '修订历史（新版本在前）' })
  revisions!: AdminRepairRevisionDTO[];

  // ---- 结构化维修记录（管理员编辑器与版本卡片使用）----

  @Field(() => Int, { description: '当前维修版本号（管理员修订时回传）' })
  maintenanceVersionNo!: number;

  @Field(() => RepairMaintenanceRecordDTO, { nullable: true, description: '结构化维修记录' })
  maintenance?: RepairMaintenanceRecordDTO | null;

  @Field(() => [RepairMaintenanceStepDTO], { description: '排查步骤' })
  maintenanceSteps!: RepairMaintenanceStepDTO[];

  @Field(() => [RepairMaintenanceFaultPanelDTO], { description: '故障面板' })
  maintenanceFaultPanels!: RepairMaintenanceFaultPanelDTO[];

  @Field(() => RepairIntakeSourceDTO, {
    nullable: true,
    description: '客户原始报修与首次 AI 分析（只读）',
  })
  intake?: RepairIntakeSourceDTO | null;
}

@ObjectType({ description: '管理员工单修订结果' })
export class AdminRepairRevisionResultDTO extends AdminRepairRevisionDTO {
  @Field(() => Int, { description: '维修申请 ID' })
  requestId!: number;

  @Field(() => Int, { description: '修订后的当前版本号' })
  currentRevisionNo!: number;
}

@ObjectType({ description: '管理员维修申请分页结果' })
export class AdminRepairRequestPaginatedDTO extends paginatedTypeFactory(
  AdminRepairRequestListItemDTO,
) {}

// ---------- AI 会话 ----------

@ObjectType({ description: '管理员 AI 会话列表项' })
export class AdminAiConversationListItemDTO {
  @Field(() => Int, { description: 'AI 会话 ID' })
  id!: number;

  @Field(() => Int, { nullable: true, description: '关联维修申请 ID（转换前可为空）' })
  requestId?: number | null;

  @Field(() => String, { description: '关联申请编号' })
  requestNo!: string;

  @Field(() => String, { description: '发起会话的工程师当前昵称（缺失时回落「工程师」）' })
  engineerNickname!: string;

  @Field(() => AiConversationStatus, { description: '会话状态' })
  status!: AiConversationStatus;

  @Field(() => String, { nullable: true, description: 'AI 反馈（未填写为空）' })
  aiFeedback?: string | null;

  @Field(() => Int, { description: '会话内容版本（导出按此固定消息范围与截止点）' })
  contentVersion!: number;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { nullable: true, description: '完成时间（未完成为空）' })
  completedAt?: Date | null;

  @Field(() => Int, { description: '消息数量（真实聚合统计）' })
  messageCount!: number;

  @Field(() => Int, { description: '报告数量（真实聚合统计）' })
  reportCount!: number;
}

@ObjectType({ description: '管理员 AI 会话分页结果' })
export class AdminAiConversationPaginatedDTO extends paginatedTypeFactory(
  AdminAiConversationListItemDTO,
) {}

// ---------- AI 消息 ----------

@ObjectType({ description: '管理员 AI 消息列表项' })
export class AdminAiMessageListItemDTO {
  @Field(() => Int, { description: '消息 ID' })
  id!: number;

  @Field(() => Int, { description: '所属会话 ID' })
  conversationId!: number;

  @Field(() => Int, { description: '会话内消息序号（稳定顺序键）' })
  messageSeq!: number;

  @Field(() => Int, { nullable: true, description: '轮次号（1-100；无轮次语义的消息为空）' })
  turnNo?: number | null;

  @Field(() => AiMessageRole, { description: '消息角色' })
  role!: AiMessageRole;

  @Field(() => String, { description: '消息正文' })
  contentText!: string;

  @Field(() => Int, { description: '消息内容版本（与同轮分析、会话版本一致）' })
  contentVersion!: number;

  @Field(() => AiMessageAnalysisStatus, {
    nullable: true,
    description: '所属轮次的分析状态（无分析记录时为空）',
  })
  analysisStatus?: AiMessageAnalysisStatus | null;

  @Field(() => String, {
    nullable: true,
    description: '所属轮次的失败原因（仅失败轮次）',
  })
  failureReason?: string | null;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

@ObjectType({ description: '管理员 AI 消息分页结果' })
export class AdminAiMessagePaginatedDTO extends paginatedTypeFactory(AdminAiMessageListItemDTO) {}

// ---------- AI 报告 ----------

@ObjectType({ description: '管理员 AI 报告列表项（不含正文大字段）' })
export class AdminAiReportListItemDTO {
  @Field(() => Int, { description: 'AI 报告 ID' })
  id!: number;

  @Field(() => Int, { description: '报告记录自身携带的维修申请 ID（审计字段）' })
  requestId!: number;

  @Field(() => String, { description: '权威申请编号（以会话归属申请为准）' })
  requestNo!: string;

  @Field(() => Boolean, {
    description:
      '报告记录的申请与会话归属申请是否不一致（数据审计标记：正常数据为 false；以会话归属为权威）',
  })
  requestMismatch!: boolean;

  @Field(() => Int, { description: '关联 AI 会话 ID' })
  conversationId!: number;

  @Field(() => String, { description: '生成报告的工程师当前昵称（缺失时回落「工程师」）' })
  engineerNickname!: string;

  @Field(() => String, { description: '报告标题' })
  reportTitle!: string;

  @Field(() => String, { description: '报告类型' })
  reportType!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

@ObjectType({ description: '管理员 AI 报告只读详情（含正文）' })
export class AdminAiReportDetailDTO extends AdminAiReportListItemDTO {
  @Field(() => String, { description: '报告正文（Markdown）' })
  contentMd!: string;
}

@ObjectType({ description: '管理员 AI 报告分页结果' })
export class AdminAiReportPaginatedDTO extends paginatedTypeFactory(AdminAiReportListItemDTO) {}

// ---------- 统计 ----------

@ObjectType({ description: '管理员文档数据库统计（口径与各标签默认列表过滤一致）' })
export class AdminDocumentDatabaseStatsDTO {
  @Field(() => Int, { description: '维修申请总数（不含软删除）' })
  repairRequestTotal!: number;

  @Field(() => Int, { description: 'AI 会话总数' })
  aiConversationTotal!: number;

  @Field(() => Int, { description: 'AI 报告总数' })
  aiReportTotal!: number;

  @Field(() => Int, { description: '参考资料总数（不含软删除）' })
  referenceDocumentTotal!: number;
}

// ---------- View → DTO 薄映射（机型嵌套视图拍平为 DTO 字段；昵称/状态字段直传） ----------

export function toAdminRepairRequestListItemDTO(
  item: AdminRepairRequestListItemView,
): AdminRepairRequestListItemDTO {
  return {
    id: item.id,
    requestNo: item.requestNo,
    customerNickname: item.customerNickname,
    companyName: item.companyName,
    equipmentModelId: item.equipmentModel.id,
    equipmentModelCode: item.equipmentModel.modelCode,
    equipmentModelName: item.equipmentModel.modelName,
    errorCode: item.errorCode,
    createdAt: item.createdAt,
    isAccepted: item.isAccepted,
    acceptedAt: item.acceptedAt,
    acceptedByEngineerNickname: item.acceptedByEngineerNickname,
    latestResolutionStatus: item.latestResolutionStatus,
    closureStatus: item.closureStatus,
    closedAt: item.closedAt,
    handlingResult: item.handlingResult,
    handlingStatus: item.handlingStatus,
  };
}

export function toAdminRepairRequestSummaryDTO(
  summary: AdminRepairRequestSummaryView,
): AdminRepairRequestSummaryDTO {
  const base = toAdminRepairRequestListItemDTO(summary);
  return {
    ...base,
    faultDescription: summary.faultDescription,
    contentMd: summary.contentMd,
    closureStatus: summary.closureStatus,
    closedAt: summary.closedAt,
    closureReason: summary.closureReason,
    handlingResult: summary.handlingResult,
    handlingStatus: summary.handlingStatus,
    currentRevisionNo: summary.currentRevisionNo,
    processEntries: summary.processEntries.map(toAdminRepairProcessEntryDTO),
    responses: summary.responses.map(toAdminRepairResponseDTO),
    revisions: summary.revisions.map(toAdminRepairRevisionDTO),
    maintenanceVersionNo: summary.maintenanceVersionNo,
    maintenance: toRepairMaintenanceRecordDTO(summary.maintenance),
    maintenanceSteps: summary.maintenanceSteps.map(toRepairMaintenanceStepDTO),
    maintenanceFaultPanels: summary.maintenanceFaultPanels.map(toRepairMaintenanceFaultPanelDTO),
    intake: toRepairIntakeSourceDTO(summary.intake),
  };
}

function toAdminRepairProcessEntryDTO(entry: {
  id: string;
  entryUuid: string;
  requestId: number;
  operationText: string;
  testResult: string | null;
  occurredAt: Date | null;
  timeSource: string;
  fileId: string | null;
  versionNo: number;
  createdAt: Date;
  file: {
    fileId: string;
    originalFilename: string;
    mimeType: string;
    byteSize: number;
    checksumSha256: string;
  } | null;
}): AdminRepairProcessEntryDTO {
  return {
    id: entry.id,
    entryUuid: entry.entryUuid,
    requestId: entry.requestId,
    operationText: entry.operationText,
    testResult: entry.testResult,
    occurredAt: entry.occurredAt,
    timeSource: entry.timeSource,
    fileId: entry.fileId,
    file: entry.file
      ? {
          fileId: entry.file.fileId,
          originalFilename: entry.file.originalFilename,
          mimeType: entry.file.mimeType,
          byteSize: entry.file.byteSize,
          checksumSha256: entry.file.checksumSha256,
        }
      : null,
    versionNo: entry.versionNo,
    createdAt: entry.createdAt,
  };
}

function toAdminRepairResponseDTO(
  response: AdminRepairRequestResponseView,
): AdminRepairResponseDTO {
  return {
    id: response.id,
    responseText: response.responseText,
    resolutionStatus: response.resolutionStatus,
    engineerNickname: response.engineerNickname,
    createdAt: response.createdAt,
  };
}

function toAdminRepairRevisionDTO(
  revision: AdminRepairRequestRevisionView,
): AdminRepairRevisionDTO {
  return {
    revisionNo: revision.revisionNo,
    previousVersion: revision.previousVersion,
    reason: revision.reason,
    actorNickname: revision.actorNickname,
    createdAt: revision.createdAt,
    hasComparableSnapshot: revision.hasComparableSnapshot,
    schemaVersion: revision.schemaVersion,
  };
}

export function toAdminRepairRequestRevisionDetailDTO(
  detail: AdminRepairRequestRevisionDetailView,
): AdminRepairRequestRevisionDetailDTO {
  return {
    requestId: detail.requestId,
    revisionNo: detail.revisionNo,
    previousVersion: detail.previousVersion,
    reason: detail.reason,
    actorNickname: detail.actorNickname,
    createdAt: detail.createdAt,
    comparable: detail.comparable,
    hasMaintenanceData: detail.hasMaintenanceData,
    incomparableReason: detail.incomparableReason,
    before: detail.before === null ? null : toAdminRevisionSnapshotDTO(detail.before),
    after: detail.after === null ? null : toAdminRevisionSnapshotDTO(detail.after),
  };
}

function toAdminRevisionSnapshotDTO(
  snapshot: AdminRepairRequestRevisionSnapshotView,
): AdminRevisionSnapshotDTO {
  return {
    schemaVersion: snapshot.schemaVersion,
    contentMd: snapshot.contentMd,
    handlingResult: snapshot.handlingResult,
    handlingStatus: snapshot.handlingStatus,
    closureReason: snapshot.closureReason,
    maintenanceDate: snapshot.maintenanceDate,
    maintenanceEngineerName: snapshot.maintenanceEngineerName,
    resetResult: snapshot.resetResult,
    supplementaryNote: snapshot.supplementaryNote,
    maintenanceVersionNo: snapshot.maintenanceVersionNo,
    maintenanceAttachmentFileId: snapshot.maintenanceAttachmentFileId,
    steps: snapshot.steps.map((step) => ({ ...step })),
    panels: snapshot.panels.map((panel) => ({ ...panel })),
  };
}

export function toAdminAiReportDetailDTO(detail: AdminAiReportDetailView): AdminAiReportDetailDTO {
  return {
    id: detail.id,
    requestId: detail.requestId,
    requestNo: detail.requestNo,
    requestMismatch: detail.requestMismatch,
    conversationId: detail.conversationId,
    engineerNickname: detail.engineerNickname,
    reportTitle: detail.reportTitle,
    reportType: detail.reportType,
    createdAt: detail.createdAt,
    contentMd: detail.contentMd,
  };
}
