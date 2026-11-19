// src/adapters/api/graphql/repair-request/dto/save-repair-request-maintenance.input.ts
// 结构化内部维修记录保存输入（任务 04）

import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType({ description: '维修原件绑定输入（原件须先经任务 11 上传并通过校验）' })
export class RepairMaintenanceAttachmentInput {
  @Field(() => String)
  @IsString()
  fileId!: string;

  @Field(() => String)
  @IsString()
  uploadContextId!: string;
}

@InputType({ description: '排查步骤输入' })
export class RepairMaintenanceStepInput {
  @Field(() => String, { nullable: true, description: '已有步骤 ID；新建为空' })
  @IsOptional()
  @IsString()
  id?: string | null;

  @Field(() => Int, { description: '最终顺序号，从 1 连续递增' })
  @IsInt()
  @Min(1)
  stepNo!: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  errorCode?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  partName?: string | null;

  @Field(() => String)
  @IsString()
  actionText!: string;

  @Field(() => String, { description: 'RESOLVED / UNRESOLVED / NEW_FAULT' })
  @IsString()
  resultCode!: string;
}

@InputType({ description: '故障面板输入' })
export class RepairMaintenanceFaultPanelInput {
  @Field(() => String, { nullable: true, description: '已有面板 ID；新建为空' })
  @IsOptional()
  @IsString()
  id?: string | null;

  @Field(() => String, { description: 'INITIAL / STEP_NEW_FAULT / RESET_NEW_FAULT' })
  @IsString()
  panelType!: string;

  @Field(() => Int, {
    nullable: true,
    description: '仅 STEP_NEW_FAULT 使用：所关联步骤在本次提交中的顺序号',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  stepNo?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  phaseCode?: string | null;

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

  @Field(() => String)
  @IsString()
  description!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  action?: string | null;
}

@InputType({ description: '保存工单结构化维修记录' })
export class SaveRepairRequestMaintenanceInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  requestId!: number;

  @Field(() => Int, { description: '当前 maintenance_version_no，用于乐观并发' })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

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

  @Field(() => RepairMaintenanceAttachmentInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => RepairMaintenanceAttachmentInput)
  attachment?: RepairMaintenanceAttachmentInput | null;

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
