// src/adapters/api/graphql/admin-document-database/dto/append-repair-request-revision.input.ts

import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  RepairMaintenanceFaultPanelInput,
  RepairMaintenanceStepInput,
} from '@src/adapters/api/graphql/repair-request/dto/save-repair-request-maintenance.input';

/** 单条内部维修过程的文本修订；只允许订正操作与测试事实，不转绑原件 */
@InputType({ description: '维修过程文本修订输入' })
export class RepairProcessEntryRevisionInput {
  @Field(() => ID, { description: '过程记录 ID' })
  @IsString({ message: '过程 ID 必须是字符串' })
  entryId!: string;

  @Field(() => Int, { description: '过程当前版本号' })
  @IsInt({ message: '过程版本号必须是整数' })
  @Min(1, { message: '过程版本号必须大于 0' })
  expectedVersion!: number;

  @Field(() => String, { description: '订正后的操作内容' })
  @IsString({ message: '操作内容必须是字符串' })
  operationText!: string;

  @Field(() => String, { nullable: true, description: '订正后的测试事实' })
  @IsOptional()
  @IsString({ message: '测试事实必须是字符串' })
  testResult?: string | null;
}

/**
 * 管理员维修记录修订输入。
 *
 * 只开放维修字段、步骤与面板；不开放附件绑定、服务厂家、接单人、
 * 流程状态、原报修与 AI 原文（这些字段不在 input 类型中，whitelist 会拒绝）。
 */
@InputType({ description: '管理员维修记录修订输入（字段白名单）' })
export class MaintenanceRevisionInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  maintenanceDate?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  engineerName?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  resetResult?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  supplementaryNote?: string | null;

  @Field(() => [RepairMaintenanceStepInput], { defaultValue: [] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RepairMaintenanceStepInput)
  steps!: RepairMaintenanceStepInput[];

  @Field(() => [RepairMaintenanceFaultPanelInput], { defaultValue: [] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RepairMaintenanceFaultPanelInput)
  panels!: RepairMaintenanceFaultPanelInput[];
}

/**
 * 管理员工单修订输入。
 *
 * - `expectedVersion` 为工单当前修订版本号，必须与服务端一致；
 * - `reason` 必填，保存到修订历史；
 * - 可修订字段白名单：正文、处理结果、结单原因、已存在过程文本；
 *   客户端传入其他字段会被 whitelist 拒绝。
 */
@InputType({ description: '管理员工单修订输入参数' })
export class AppendRepairRequestRevisionInput {
  @Field(() => Int, { description: '维修申请 ID' })
  @IsInt({ message: '维修申请 ID 必须是整数' })
  @Min(1, { message: '维修申请 ID 必须大于 0' })
  requestId!: number;

  @Field(() => Int, { description: '工单当前修订版本号（乐观并发）' })
  @IsInt({ message: '工单版本号必须是整数' })
  @Min(0, { message: '工单版本号不能小于 0' })
  expectedVersion!: number;

  @Field(() => String, { description: '修订原因（必填，最多 1000 字符）' })
  @IsString({ message: '修订原因必须是字符串' })
  @MaxLength(1000, { message: '修订原因不能超过 1000 个字符' })
  reason!: string;

  @Field(() => String, { nullable: true, description: '订正后的申请正文（Markdown）' })
  @IsOptional()
  @IsString({ message: '申请正文必须是字符串' })
  contentMd?: string | null;

  @Field(() => RepairRequestHandlingResult, { nullable: true, description: '订正后的处理结果' })
  @IsOptional()
  @IsEnum(RepairRequestHandlingResult, { message: '处理结果无效' })
  handlingResult?: RepairRequestHandlingResult | null;

  @Field(() => String, { nullable: true, description: '订正后的结单原因' })
  @IsOptional()
  @IsString({ message: '结单原因必须是字符串' })
  closureReason?: string | null;

  @Field(() => [RepairProcessEntryRevisionInput], {
    nullable: true,
    description: '过程文本修订列表（只允许已有过程）',
  })
  @IsOptional()
  @IsArray({ message: '过程修订列表必须是数组' })
  @ValidateNested({ each: true })
  @Type(() => RepairProcessEntryRevisionInput)
  processEntries?: RepairProcessEntryRevisionInput[] | null;

  @Field(() => Int, {
    nullable: true,
    description: '工单当前维修版本号；修订维修记录时必填',
  })
  @IsOptional()
  @IsInt({ message: '维修版本号必须是整数' })
  @Min(0, { message: '维修版本号不能小于 0' })
  expectedMaintenanceVersion?: number | null;

  @Field(() => MaintenanceRevisionInput, {
    nullable: true,
    description: '结构化维修记录修订（故障面板/步骤/维修字段）',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceRevisionInput)
  maintenance?: MaintenanceRevisionInput | null;
}
