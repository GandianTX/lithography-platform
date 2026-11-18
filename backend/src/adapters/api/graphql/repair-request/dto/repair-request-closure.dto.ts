// src/adapters/api/graphql/repair-request/dto/repair-request-closure.dto.ts

import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/** 结单结果 */
@ObjectType({ description: '工单结单结果' })
export class RepairRequestClosureDTO {
  @Field(() => Int, { description: '工单 ID' })
  requestId!: number;

  @Field(() => String, { description: '结单状态（CLOSED）' })
  closureStatus!: string;

  @Field(() => Date, { description: '结单时间' })
  closedAt!: Date;

  @Field(() => String, { nullable: true, description: '结单原因' })
  closureReason?: string | null;

  @Field(() => RepairRequestHandlingResult, { description: '处理结果' })
  handlingResult!: RepairRequestHandlingResult;

  @Field(() => RepairRequestHandlingStatus, { description: '实际处理状态' })
  handlingStatus!: RepairRequestHandlingStatus;

  @Field(() => Date, { nullable: true, description: '处理终结时间（中断时为空）' })
  handlingEndedAt?: Date | null;
}
