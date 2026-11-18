// src/adapters/api/graphql/repair-request/dto/close-repair-request.input.ts

import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import { Field, InputType, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

/** 结单输入：处理结果必填，原因在中断/无法修复时必填 */
@InputType({ description: '工单结单输入参数' })
export class CloseRepairRequestInput {
  @Field(() => Int, { description: '工单 ID' })
  @IsInt({ message: '工单 ID 必须是整数' })
  @Min(1, { message: '工单 ID 必须大于 0' })
  requestId!: number;

  @Field(() => RepairRequestHandlingResult, { description: '处理结果' })
  @IsEnum(RepairRequestHandlingResult, { message: '处理结果无效' })
  handlingResult!: RepairRequestHandlingResult;

  @Field(() => String, { nullable: true, description: '结单原因（中断/无法修复时必填）' })
  @IsOptional()
  @IsString({ message: '结单原因必须是字符串' })
  closureReason?: string | null;
}
