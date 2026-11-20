// src/adapters/api/graphql/repair-request/dto/repair-request-read.dto.ts
// 维修申请公共读模型 GraphQL 输出对象（负责人 20260901 裁定契约）
// 处理状态使用共享类型层正式枚举（裁定 4）；回复返回工程师安全昵称（裁定 3）

import {
  EngineerResolutionStatus,
  RepairRequestAcceptanceViewStatus,
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';
import { paginatedTypeFactory } from '@src/adapters/api/graphql/pagination.type-factory';
import { EquipmentModelDTO } from '../../equipment-model/dto/equipment-model.dto';
import {
  RepairIntakeSourceDTO,
  RepairMaintenanceFaultPanelDTO,
  RepairMaintenanceRecordDTO,
  RepairMaintenanceStepDTO,
} from './repair-maintenance.dto';
import { RepairProcessEntryDTO } from './repair-process-entry.dto';

/**
 * 维修申请列表项输出对象（客户列表基础结构）
 * 工程师列表项在其上扩展展示字段（RepairRequestEngineerListItemDTO）；
 * 不返回归属类账号 ID
 */
@ObjectType({ description: '维修申请列表项' })
export class RepairRequestListItemDTO {
  @Field(() => Int, { description: '维修申请 ID' })
  id!: number;

  @Field(() => String, { description: '申请编号' })
  requestNo!: string;

  @Field(() => EquipmentModelDTO, { description: '设备型号' })
  equipmentModel!: EquipmentModelDTO;

  @Field(() => String, { description: '设备错误码' })
  errorCode!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Boolean, { description: '是否已接单' })
  isAccepted!: boolean;

  @Field(() => Date, { nullable: true, description: '接单时间（未接单为空）' })
  acceptedAt?: Date | null;

  @Field(() => EngineerResolutionStatus, {
    nullable: true,
    description: '最新回复处理状态；尚无回复为空',
  })
  latestResolutionStatus?: EngineerResolutionStatus | null;
}

/**
 * 首析自助重试资格输出对象（服务端判定，前端不再自行组合 FAILED + generation）。
 * reason 为稳定原因码，不含内部异常信息、堆栈、队列或任务标识。
 */
@ObjectType({ description: '首析自助重试资格' })
export class IntakeAnalysisRetryEligibilityDTO {
  @Field(() => Boolean, { description: '当前会话能否对本工单发起重新分析' })
  eligible!: boolean;

  @Field(() => String, {
    description:
      '稳定原因码（OWNER_RETRY_AVAILABLE / ANALYSIS_IN_PROGRESS / RETRY_ALREADY_USED / ANALYSIS_SUCCEEDED / FAILURE_NOT_CONFIRMED / LEDGER_INTENT_MISSING / OWNERSHIP_CONFLICT / NOT_CONVERTED / NO_INTAKE / INTAKE_DELETED / STATUS_UNKNOWN）',
  })
  reason!: string;
}

/** 客户可见首析状态与正文（仅 myRepairRequests / myRepairRequest 客户入口装配） */
@ObjectType({ description: '客户可见首析状态与正文' })
export class IntakeAnalysisCustomerViewDTO {
  @Field(() => String, { description: '首析状态（WAITING / RUNNING / SUCCEEDED / FAILED）' })
  status!: string;

  @Field(() => Int, { description: '首析代次（0=初次；1=唯一重试）' })
  generation!: number;

  @Field(() => String, { nullable: true, description: '首析正文；仅成功态返回真实模型输出' })
  outputText?: string | null;

  @Field(() => Date, { nullable: true, description: '首析完成时间；未完成为空' })
  finishedAt?: Date | null;

  @Field(() => String, {
    description:
      '服务端判定的展示状态：QUEUED（已登记投递意图，等待执行）/ RUNNING / COMPLETED / FAILED_RETRYABLE / FAILED_NOT_RETRYABLE / UNAVAILABLE（缺少可信记录或状态矛盾）',
  })
  displayState!: string;

  @Field(() => IntakeAnalysisRetryEligibilityDTO, {
    description: '自助重试资格；仅第 0 代明确模型失败且记录可信时 eligible 为 true',
  })
  retryEligibility!: IntakeAnalysisRetryEligibilityDTO;
}

/** 客户报修原件安全字段（不暴露存储引用与校验和；下载走共用授权 REST） */
@ObjectType({ description: '客户报修原件安全字段' })
export class RepairRequestOriginalFileDTO {
  @Field(() => String, { description: '原件编号' })
  fileId!: string;

  @Field(() => String, { description: '原始文件名' })
  originalFilename!: string;

  @Field(() => String, { description: 'MIME 类型' })
  mimeType!: string;

  @Field(() => Int, { description: '字节数' })
  byteSize!: number;
}

/** 维修厂家展示字段（仅名称与主键，不含联系信息） */
@ObjectType({ description: '维修厂家展示字段' })
export class RepairRequestServiceOrganizationDTO {
  @Field(() => Int, { description: '组织主键' })
  id!: number;

  @Field(() => String, { description: '组织全称' })
  name!: string;
}

/**
 * 工程师回复输出对象（随详情返回，时间正序）
 * engineerNickname 为后端实时关联的安全昵称，缺失回落「工程师」；
 * 不返回工程师账号 ID（裁定 3）
 */
@ObjectType({ description: '工程师回复（按时间正序）' })
export class EngineerResponseDTO {
  @Field(() => Int, { description: '回复 ID' })
  id!: number;

  @Field(() => String, { description: '回复工程师当前昵称（缺失时回落「工程师」）' })
  engineerNickname!: string;

  @Field(() => EngineerResolutionStatus, { description: '处理状态' })
  resolutionStatus!: EngineerResolutionStatus;

  @Field(() => String, { description: '面向客户的处理回复' })
  responseText!: string;

  @Field(() => Date, { description: '回复时间' })
  createdAt!: Date;
}

/**
 * 维修申请详情输出对象（客户与工程师入口共用结构，读权限由后端按身份判定）
 */
@ObjectType({ description: '维修申请详情（含回复时间线）' })
export class RepairRequestDetailDTO {
  @Field(() => Int, { description: '维修申请 ID' })
  id!: number;

  @Field(() => String, { description: '申请编号' })
  requestNo!: string;

  @Field(() => EquipmentModelDTO, { description: '设备型号' })
  equipmentModel!: EquipmentModelDTO;

  @Field(() => String, { description: '设备错误码' })
  errorCode!: string;

  @Field(() => String, { description: '故障描述' })
  faultDescription!: string;

  @Field(() => String, { description: '维修申请 Markdown 内容' })
  contentMd!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Boolean, { description: '是否已接单' })
  isAccepted!: boolean;

  @Field(() => Date, { nullable: true, description: '接单时间（未接单为空）' })
  acceptedAt?: Date | null;

  @Field(() => EngineerResolutionStatus, {
    nullable: true,
    description: '最新回复处理状态；尚无回复为空',
  })
  latestResolutionStatus?: EngineerResolutionStatus | null;

  @Field(() => [EngineerResponseDTO], { description: '工程师回复（时间正序）' })
  responses!: EngineerResponseDTO[];

  // ---- 结单事实（客户与工程师入口共用；旧行可为空）----

  @Field(() => String, {
    nullable: true,
    description: '结单状态（OPEN / CLOSED）；字段缺失为 null，展示层按不可确认处理',
  })
  closureStatus?: string | null;

  @Field(() => Date, { nullable: true, description: '结单时间；未结单为空' })
  closedAt?: Date | null;

  @Field(() => String, { nullable: true, description: '结单原因' })
  closureReason?: string | null;

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

  // ---- 内部过程（仅接单工程师本人可见；客户入口为空数组）----

  @Field(() => [RepairProcessEntryDTO], {
    description: '内部维修过程（仅接单工程师本人可见；客户入口为空数组）',
  })
  processEntries!: RepairProcessEntryDTO[];

  // ---- 结构化内部维修记录（任务 04；仅接单工程师本人可见，客户入口为空）----

  @Field(() => RepairMaintenanceRecordDTO, {
    nullable: true,
    description: '结构化维修记录（仅接单工程师本人可见；客户入口为空）',
  })
  maintenance?: RepairMaintenanceRecordDTO | null;

  @Field(() => [RepairMaintenanceStepDTO], {
    description: '排查步骤（仅接单工程师本人可见；客户入口为空数组）',
  })
  maintenanceSteps!: RepairMaintenanceStepDTO[];

  @Field(() => [RepairMaintenanceFaultPanelDTO], {
    description: '故障面板（仅接单工程师本人可见；客户入口为空数组）',
  })
  maintenanceFaultPanels!: RepairMaintenanceFaultPanelDTO[];

  @Field(() => RepairIntakeSourceDTO, {
    nullable: true,
    description: '客户原始报修与首次 AI 分析（仅工程师入口；客户入口为空）',
  })
  intake?: RepairIntakeSourceDTO | null;

  // ---- 客户入口装配字段（工程师入口为 null；首析状态与工单进度分开展示）----

  @Field(() => IntakeAnalysisCustomerViewDTO, {
    nullable: true,
    description: '客户可见首析状态与正文；仅客户入口装配，无原稿关联的旧单为空',
  })
  intakeAnalysis?: IntakeAnalysisCustomerViewDTO | null;

  @Field(() => RepairRequestOriginalFileDTO, {
    nullable: true,
    description: '客户报修原件安全字段；仅客户入口装配，未绑定或无效原件为空',
  })
  originalFile?: RepairRequestOriginalFileDTO | null;

  @Field(() => RepairRequestServiceOrganizationDTO, {
    nullable: true,
    description: '维修厂家；仅客户入口装配，旧行无服务公司为空',
  })
  serviceOrganization?: RepairRequestServiceOrganizationDTO | null;

  @Field(() => Boolean, {
    description: '当前会话能否保存结构化维修记录（接单本人且工单未结束）',
  })
  canEditMaintenance!: boolean;

  // ---- 工程师入口富集字段（客户入口为空；accept Mutation 成功输出复用工程师入口）----

  @Field(() => String, {
    nullable: true,
    description: '客户当前昵称（缺失回落「客户」）；客户入口为空',
  })
  customerNickname?: string | null;

  @Field(() => String, { nullable: true, description: '客户公司名称；客户入口为空' })
  customerCompanyName?: string | null;

  @Field(() => RepairRequestAcceptanceViewStatus, {
    nullable: true,
    description:
      '接单状态视角（AVAILABLE / MINE / TAKEN_BY_OTHER）；客户入口为空；AVAILABLE 仅表示未接单事实，不代表当前会话可接单',
  })
  acceptanceViewStatus?: RepairRequestAcceptanceViewStatus | null;

  @Field(() => String, {
    nullable: true,
    description: '接单工程师当前昵称（缺失回落「工程师」）；未接单或客户入口为空',
  })
  acceptedEngineerNickname?: string | null;
}

/**
 * 工程师列表项输出对象：在基础列表项上补充客户/接单工程师安全展示资料
 * 与当前会话视角状态；不返回归属类账号 ID
 */
@ObjectType({ description: '工程师维修申请列表项' })
export class RepairRequestEngineerListItemDTO extends RepairRequestListItemDTO {
  @Field(() => String, {
    description: '客户当前昵称（缺失回落「客户」）',
  })
  customerNickname!: string;

  @Field(() => String, { nullable: true, description: '客户公司名称' })
  customerCompanyName?: string | null;

  @Field(() => RepairRequestAcceptanceViewStatus, {
    description:
      '接单状态视角（AVAILABLE / MINE / TAKEN_BY_OTHER）；AVAILABLE 仅表示未接单事实，不代表当前会话可接单',
  })
  acceptanceViewStatus!: RepairRequestAcceptanceViewStatus;

  @Field(() => String, {
    nullable: true,
    description: '接单工程师当前昵称（缺失回落「工程师」）；未接单为空',
  })
  acceptedEngineerNickname?: string | null;

  // ---- 工单真实进度（列表展示用；与详情结单事实同源）----

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

/**
 * 工程师列表分页输出（OFFSET：items/total/page/pageSize）
 */
@ObjectType({ description: '工程师维修申请分页结果' })
export class RepairRequestEngineerPaginatedDTO extends paginatedTypeFactory(
  RepairRequestEngineerListItemDTO,
) {}

/**
 * 客户维修申请列表项：基础列表项 + 首析状态事实（仅客户列表装配；旧单为空）
 */
@ObjectType({ description: '客户维修申请列表项' })
export class RepairRequestCustomerListItemDTO extends RepairRequestListItemDTO {
  @Field(() => String, {
    nullable: true,
    description: '首析状态（WAITING/RUNNING/SUCCEEDED/FAILED）；无原稿关联的旧单为空',
  })
  analysisStatus?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '首析代次（0=初次；1=唯一重试）；无原稿关联的旧单为空',
  })
  analysisGeneration?: number | null;
}

/**
 * 维修申请列表分页输出（OFFSET：items/total/page/pageSize）
 */
@ObjectType({ description: '维修申请分页结果' })
export class RepairRequestPaginatedDTO extends paginatedTypeFactory(RepairRequestListItemDTO) {}

/**
 * 客户维修申请列表分页输出（OFFSET；含首析状态事实）
 */
@ObjectType({ description: '客户维修申请分页结果' })
export class RepairRequestCustomerPaginatedDTO extends paginatedTypeFactory(
  RepairRequestCustomerListItemDTO,
) {}
