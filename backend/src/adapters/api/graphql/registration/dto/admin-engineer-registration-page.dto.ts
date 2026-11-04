// src/adapters/api/graphql/registration/dto/admin-engineer-registration-page.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import { AdminEngineerRegistrationItemDTO } from './admin-engineer-registration-item.dto';

/** 组织审核队列分页 DTO：只含当前可信组织的申请，`total` 为该组织筛选后的总数 */
@ObjectType({ description: '组织审核队列分页' })
export class AdminEngineerRegistrationPageDTO {
  @Field(() => [AdminEngineerRegistrationItemDTO], { description: '当前页审核条目' })
  items!: AdminEngineerRegistrationItemDTO[];

  @Field(() => Int, { description: '总记录数' })
  total!: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  page!: number;

  @Field(() => Int, { description: '每页数量' })
  pageSize!: number;
}
