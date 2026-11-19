// src/adapters/api/graphql/repair-request/dto/interrupt-repair-request.input.ts

import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** 维修中断输入：原因必填，不结单 */
@InputType({ description: '维修中断记录输入参数' })
export class InterruptRepairRequestInput {
  @Field(() => Int, { description: '工单 ID' })
  @IsInt({ message: '工单 ID 必须是整数' })
  @Min(1, { message: '工单 ID 必须大于 0' })
  requestId!: number;

  @Field(() => String, { description: '中断原因（必填）' })
  @IsString({ message: '中断原因必须是字符串' })
  @MinLength(1, { message: '中断原因不能为空' })
  @MaxLength(2000, { message: '中断原因不能超过 2000 个字符' })
  reason!: string;
}
