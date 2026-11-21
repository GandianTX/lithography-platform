// src/adapters/api/graphql/maintenance-report/dto/maintenance-report.input.ts
// 维修报告（任务 06）GraphQL 输入契约：只做结构/长度校验，业务规则仍在 usecase。

import {
  MaintenancePhaseCode,
  MaintenanceReportExportFormat,
  MaintenanceReportFaultBranchKind,
  MaintenanceReportResetResult,
  MaintenanceReportSourceType,
  MaintenanceReportStepResult,
} from '@app-types/models/maintenance-report.types';
import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

@InputType({ description: '报告故障分支输入' })
export class MaintenanceReportFaultInputDTO {
  @Field(() => MaintenanceReportFaultBranchKind)
  @IsEnum(MaintenanceReportFaultBranchKind)
  branchKind!: MaintenanceReportFaultBranchKind;

  @Field(() => Int, { nullable: true, description: '仅 STEP_NEW_FAULT：本次提交中的步骤顺序号' })
  @IsOptional()
  @IsInt()
  @Min(1)
  stepNo?: number | null;

  @Field(() => MaintenancePhaseCode, { nullable: true })
  @IsOptional()
  @IsEnum(MaintenancePhaseCode)
  phaseCode?: MaintenancePhaseCode | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  mainError?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  unitError?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  source?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  errorType?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  gpibStatus?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  faultStatus?: string | null;

  @Field(() => String, { description: '故障描述（必填）' })
  @IsString()
  @MaxLength(10000)
  description!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  action?: string | null;
}

@InputType({ description: '报告排查步骤输入' })
export class MaintenanceReportStepInputDTO {
  @Field(() => String, {
    nullable: true,
    description: '步骤稳定编码；新步骤由前端生成，缺省时服务端按次序回落',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  stepCode?: string | null;

  @Field(() => MaintenancePhaseCode, { nullable: true })
  @IsOptional()
  @IsEnum(MaintenancePhaseCode)
  phaseCode?: MaintenancePhaseCode | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  partName?: string | null;

  @Field(() => String)
  @IsString()
  @MaxLength(10000)
  actionText!: string;

  @Field(() => MaintenanceReportStepResult, { nullable: true })
  @IsOptional()
  @IsEnum(MaintenanceReportStepResult)
  resultCode?: MaintenanceReportStepResult | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  errorCode?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resultText?: string | null;
}

@InputType({ description: '报告草稿内容（补丁语义：未提供字段保持落库值）' })
export class MaintenanceReportDraftInputDTO {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @Field(() => String, { nullable: true, description: '客户厂家' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customerFactoryName?: string | null;

  @Field(() => Int, { nullable: true, description: '已有型号库 ID；与手填文字互斥' })
  @IsOptional()
  @IsInt()
  @Min(1)
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '手填型号文字；独立报告草稿不登记型号库' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '维修日期 YYYY-MM-DD；不默认今天' })
  @IsOptional()
  @IsString()
  maintenanceDate?: string | null;

  @Field(() => RepairRequestHandlingResult, { nullable: true })
  @IsOptional()
  @IsEnum(RepairRequestHandlingResult)
  handlingResult?: RepairRequestHandlingResult | null;

  @Field(() => String, { nullable: true, description: '中断/无法修复原因（必填）' })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  closureReason?: string | null;

  @Field(() => MaintenanceReportResetResult, { nullable: true })
  @IsOptional()
  @IsEnum(MaintenanceReportResetResult)
  resetResult?: MaintenanceReportResetResult | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  actualCause?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  repairActions?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  verificationResult?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  supplementaryNote?: string | null;

  // 不带 GraphQL 默认值：工单总结只读守卫按「字段 !== undefined」判定客户端
  // 是否重复填写内容；带 `= []` 默认值会把合法的 draft:{} 变成含空数组的
  // 输入并被拒绝（2026-11-21 实库验收缺陷修复）。未提供时由 usecase 归一化
  // 补空数组，客户端显式空数组仍会被只读守卫拒绝。
  @Field(() => [MaintenanceReportStepInputDTO], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaintenanceReportStepInputDTO)
  steps?: MaintenanceReportStepInputDTO[];

  @Field(() => [MaintenanceReportFaultInputDTO], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaintenanceReportFaultInputDTO)
  faults?: MaintenanceReportFaultInputDTO[];

  // —— AI 辅助排查评价（任务 06 适配任务 05 真实会话读侧）——
  // 只接受业务取值；「未提供」表示沿用落库值，`NOT_USED` 表示明确不适用。

  @Field(() => String, {
    nullable: true,
    description: 'AI 使用标记：USED / NOT_USED（未提供沿用落库值）',
  })
  @IsOptional()
  @IsIn(['USED', 'NOT_USED'])
  aiUsage?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '评价来源类型：AI_CONVERSATION（工单辅助排查会话）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  aiSourceType?: string | null;

  @Field(() => String, { nullable: true, description: '评价来源会话标识（稳定 ID）' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  aiSourceId?: string | null;

  @Field(() => String, { nullable: true, description: '评价绑定的不可变内容版本' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  aiSourceVersion?: string | null;

  @Field(() => Int, { nullable: true, description: '综合评分 1-5（不预选）' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  aiScore?: number | null;

  @Field(() => String, {
    nullable: true,
    description: '正确性：CORRECT / PARTIAL / INCORRECT（不预选）',
  })
  @IsOptional()
  @IsIn(['CORRECT', 'PARTIAL', 'INCORRECT'])
  aiCorrectness?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '帮助度 1-4（历史值 5 仅在未改写时原样保留）',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  aiHelpfulness?: number | null;

  @Field(() => String, { nullable: true, description: '评价说明（可选，≤2000 字）' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  aiNote?: string | null;
}

@InputType({ description: 'R062-01 首次保存/直接提交同事务绑定的任务 11 暂存原件' })
export class MaintenanceReportStagedAttachmentInputDTO {
  @Field(() => String, { description: '上传返回的暂存原件编号（char(36)）' })
  @IsString()
  @MinLength(1)
  @MaxLength(36)
  fileId!: string;

  @Field(() => String, { description: '上传返回的服务端上传上下文（char(36)）' })
  @IsString()
  @MinLength(1)
  @MaxLength(36)
  uploadContextId!: string;

  @Field(() => String, { nullable: true, description: '附件说明（可选，≤500 字）' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

@InputType({ description: '新建维修报告草稿' })
export class CreateMaintenanceReportDraftInput {
  @Field(() => MaintenanceReportSourceType)
  @IsEnum(MaintenanceReportSourceType)
  sourceType!: MaintenanceReportSourceType;

  @Field(() => Int, {
    nullable: true,
    description: '工单总结必填；独立历史报告不得携带（不支持客户端自报作者/公司）',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  repairRequestId?: number | null;

  @Field(() => MaintenanceReportDraftInputDTO)
  @ValidateNested()
  @Type(() => MaintenanceReportDraftInputDTO)
  draft!: MaintenanceReportDraftInputDTO;

  @Field(() => MaintenanceReportStagedAttachmentInputDTO, {
    nullable: true,
    description: 'R050-01/R045-02 首次保存同事务绑定的暂存原件（可选）',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceReportStagedAttachmentInputDTO)
  attachment?: MaintenanceReportStagedAttachmentInputDTO | null;
}

@InputType({ description: '更新本人维修报告草稿' })
export class UpdateMaintenanceReportDraftInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  reportId!: number;

  @Field(() => MaintenanceReportDraftInputDTO)
  @ValidateNested()
  @Type(() => MaintenanceReportDraftInputDTO)
  draft!: MaintenanceReportDraftInputDTO;

  @Field(() => MaintenanceReportStagedAttachmentInputDTO, {
    nullable: true,
    description: 'R050-02/R062-01 续填同事务绑定/更换暂存原件（可选）；单份报告最多 1 份有效原件',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceReportStagedAttachmentInputDTO)
  attachment?: MaintenanceReportStagedAttachmentInputDTO | null;
}

@InputType({ description: 'R051-01 正式提交（草稿提交与未保存表单直接提交共用）' })
export class SubmitMaintenanceReportInput {
  @Field(() => MaintenanceReportSourceType)
  @IsEnum(MaintenanceReportSourceType)
  sourceType!: MaintenanceReportSourceType;

  @Field(() => Int, {
    nullable: true,
    description: '工单总结必填；独立历史报告不得携带（不支持客户端自报作者/公司）',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  repairRequestId?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: '已有草稿提交时提供；缺省走直接提交（同事务创建报告根并冻结）',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  reportId?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: '已有草稿首次提交时的展示版本号；合法幂等重试不因旧版本被拒',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersionNo?: number | null;

  @Field(() => String, {
    description: '提交标识：系统生成并在同次提交重试时复用，不是新增填写项',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  submissionRequestId!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(64)
  @MaxLength(64)
  sourceConfirmation?: string | null;

  @Field(() => MaintenanceReportDraftInputDTO)
  @ValidateNested()
  @Type(() => MaintenanceReportDraftInputDTO)
  draft!: MaintenanceReportDraftInputDTO;

  @Field(() => MaintenanceReportStagedAttachmentInputDTO, {
    nullable: true,
    description: 'R051-01 直接提交附带的本轮暂存原件（可选；fileId 计入提交内容摘要）',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceReportStagedAttachmentInputDTO)
  attachment?: MaintenanceReportStagedAttachmentInputDTO | null;
}

@InputType({ description: '本人报告列表分页' })
export class MaintenanceReportPaginationInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  pageSize?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  withTotal?: boolean;
}

@InputType({ description: '本人报告列表筛选' })
export class MyMaintenanceReportFilterInput {
  @Field(() => MaintenanceReportSourceType, { nullable: true })
  @IsOptional()
  @IsEnum(MaintenanceReportSourceType)
  sourceType?: MaintenanceReportSourceType;
}

@InputType({ description: '导出工程师本人完整的当前表单（未保存草稿可导出；只读）' })
export class MaintenanceReportExportCurrentFormInput {
  @Field(() => MaintenanceReportSourceType)
  @IsEnum(MaintenanceReportSourceType)
  sourceType!: MaintenanceReportSourceType;

  @Field(() => Int, { nullable: true, description: '工单总结必填；独立历史报告不得携带' })
  @IsOptional()
  @IsInt()
  @Min(1)
  repairRequestId?: number | null;

  @Field(() => MaintenanceReportDraftInputDTO)
  @ValidateNested()
  @Type(() => MaintenanceReportDraftInputDTO)
  draft!: MaintenanceReportDraftInputDTO;
}

@InputType({ description: '导出已保存报告冻结版本（权限由服务端裁决）' })
export class MaintenanceReportExportSavedVersionInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  reportId!: number;

  @Field(() => Int, { nullable: true, description: '缺省取当前冻结版本' })
  @IsOptional()
  @IsInt()
  @Min(1)
  versionNo?: number | null;
}

@InputType({ description: 'R051 维修报告导出（预览/导出不写库；两目标互斥）' })
export class MaintenanceReportExportInput {
  @Field(() => MaintenanceReportExportFormat)
  @IsEnum(MaintenanceReportExportFormat)
  format!: MaintenanceReportExportFormat;

  @Field(() => MaintenanceReportExportCurrentFormInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceReportExportCurrentFormInput)
  currentForm?: MaintenanceReportExportCurrentFormInput | null;

  @Field(() => MaintenanceReportExportSavedVersionInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceReportExportSavedVersionInput)
  savedVersion?: MaintenanceReportExportSavedVersionInput | null;
}

@InputType({ description: '挂接任务 11 暂存原件到本人可编辑报告（服务端核验并绑定）' })
export class AddMaintenanceReportAttachmentInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  reportId!: number;

  @Field(() => String, { description: '上传暂存返回的稳定原件编号 file_id' })
  @IsString()
  @MaxLength(64)
  fileId!: string;

  @Field(() => String, { description: '上传暂存返回的 uploadContextId' })
  @IsString()
  @MaxLength(64)
  uploadContextId!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '缺省取第一个空闲槽位（R062-01：单份报告最多 1 份）',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  sortOrder?: number | null;
}

@InputType({ description: '移除（退役）本人报告的当前附件' })
export class RemoveMaintenanceReportAttachmentInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  reportId!: number;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  attachmentId!: number;
}
