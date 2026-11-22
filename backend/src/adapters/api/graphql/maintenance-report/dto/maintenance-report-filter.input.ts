// src/adapters/api/graphql/maintenance-report/dto/maintenance-report-filter.input.ts
// 本人记录列表筛选入参（来源类型 + 未完成/已提交），协议层只做结构校验。

import { Field, InputType } from '@nestjs/graphql';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const SOURCE_TYPES = ['HISTORICAL_CASE', 'WORK_ORDER_SUMMARY'] as const;
const RECORD_KINDS = ['ALL', 'DRAFT', 'FORMAL'] as const;

/** 标题关键词上限：与 usecase 归一化（maintenance-report-list-filter.ts）同口径 */
const TITLE_KEYWORD_MAX_LENGTH = 100;

@InputType({ description: '本人维修记录筛选条件' })
export class MaintenanceReportFilterInput {
  @Field(() => String, {
    nullable: true,
    description: '来源类型：HISTORICAL_CASE=独立历史报告；WORK_ORDER_SUMMARY=工单总结',
  })
  @IsOptional()
  @IsString({ message: '来源类型必须是字符串' })
  @IsIn(SOURCE_TYPES, { message: '来源类型无效' })
  sourceType?: (typeof SOURCE_TYPES)[number];

  @Field(() => String, {
    nullable: true,
    description: '记录状态：ALL=全部；DRAFT=未完成（草稿/退回）；FORMAL=已提交',
  })
  @IsOptional()
  @IsString({ message: '记录状态筛选必须是字符串' })
  @IsIn(RECORD_KINDS, { message: '记录状态筛选无效' })
  recordKind?: (typeof RECORD_KINDS)[number];

  @Field(() => String, {
    nullable: true,
    description: '标题关键词：在本人归属谓词范围内全量 LIKE 匹配（非客户端当页过滤）',
  })
  @IsOptional()
  @IsString({ message: '标题关键词必须是字符串' })
  @MaxLength(TITLE_KEYWORD_MAX_LENGTH, {
    message: `标题关键词不能超过 ${TITLE_KEYWORD_MAX_LENGTH} 个字符`,
  })
  titleKeyword?: string;
}
