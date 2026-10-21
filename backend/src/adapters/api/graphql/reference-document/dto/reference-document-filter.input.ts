// src/adapters/api/graphql/reference-document/dto/reference-document-filter.input.ts
// 参考资料列表筛选入参（标题模糊 + 文档类型等值 + 设备型号等值 + 案例处理状态等值，均可选）

import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** 标题搜索词长度上限（防超长入参直达查询层） */
const TITLE_FILTER_MAX_LENGTH = 255;

@InputType({ description: '参考资料列表筛选条件' })
export class ReferenceDocumentFilterInput {
  @Field(() => String, { nullable: true, description: '标题模糊搜索（区分通配符转义）' })
  @IsOptional()
  @IsString({ message: '标题搜索词必须是字符串' })
  @MaxLength(TITLE_FILTER_MAX_LENGTH, {
    message: `标题搜索词不能超过 ${TITLE_FILTER_MAX_LENGTH} 个字符`,
  })
  title?: string;

  @Field(() => String, { nullable: true, description: '文档类型等值筛选' })
  @IsOptional()
  @IsString({ message: '文档类型必须是字符串' })
  @MaxLength(100, { message: '文档类型不能超过 100 个字符' })
  documentType?: string;

  @Field(() => Int, { nullable: true, description: '设备型号 ID 等值筛选' })
  @IsOptional()
  @IsInt({ message: '设备型号 ID 必须是整数' })
  @Min(1, { message: '设备型号 ID 必须大于 0' })
  equipmentModelId?: number;

  @Field(() => String, {
    nullable: true,
    description: '案例处理状态等值筛选（UNRESOLVED/IN_PROGRESS/RESOLVED；仅命中案例资料）',
  })
  @IsOptional()
  @IsString({ message: '案例处理状态必须是字符串' })
  @MaxLength(32, { message: '案例处理状态不能超过 32 个字符' })
  caseHandlingStatus?: string;
}
