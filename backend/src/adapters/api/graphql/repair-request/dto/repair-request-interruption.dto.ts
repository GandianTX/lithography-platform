// src/adapters/api/graphql/repair-request/dto/repair-request-interruption.dto.ts

import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/** 维修中断结果：不结单，closureStatus / closedAt 为空 */
@ObjectType({ description: '工单维修中断记录结果' })
export class RepairRequestInterruptionDTO {
  @Field(() => Int, { description: '工单 ID' })
  requestId!: number;

  @Field(() => String, { nullable: true, description: '结单状态（中断时为空）' })
  closureStatus?: string | null;

  @Field(() => Date, { nullable: true, description: '结单时间（中断时为空）' })
  closedAt?: Date | null;

  @Field(() => String, { nullable: true, description: '中断原因' })
  closureReason?: string | null;

  @Field(() => RepairRequestHandlingResult, { description: '处理结果' })
  handlingResult!: RepairRequestHandlingResult;

  @Field(() => RepairRequestHandlingStatus, { description: '实际处理状态' })
  handlingStatus!: RepairRequestHandlingStatus;

  @Field(() => Date, { nullable: true, description: '处理终结时间（中断时为空）' })
  handlingEndedAt?: Date | null;
}
