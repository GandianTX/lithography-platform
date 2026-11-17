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
}
