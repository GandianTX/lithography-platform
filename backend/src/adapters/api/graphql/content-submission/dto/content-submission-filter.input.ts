// src/adapters/api/graphql/content-submission/dto/content-submission-filter.input.ts
// 投稿列表筛选入参（本人列表与审核队列共用；标题模糊 + 类别等值 + 状态等值，均可选）

import { Field, InputType } from '@nestjs/graphql';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 标题搜索词长度上限（与资料标题字段上限一致，防超长入参直达查询层） */
const TITLE_FILTER_MAX_LENGTH = 255;
/** 类别 / 状态等值筛选取值长度上限（值为受控字符串，长度防御即可） */
const ENUM_FILTER_MAX_LENGTH = 32;

@InputType({ description: '投稿列表筛选条件（本人列表与审核队列共用）' })
export class ContentSubmissionFilterInput {
  @Field(() => String, { nullable: true, description: '标题模糊搜索' })
  @IsOptional()
  @IsString({ message: '标题搜索词必须是字符串' })
  @MaxLength(TITLE_FILTER_MAX_LENGTH, {
    message: `标题搜索词不能超过 ${TITLE_FILTER_MAX_LENGTH} 个字符`,
  })
  title?: string;

  @Field(() => String, {
    nullable: true,
    description: '投稿类别等值筛选：MATERIAL（普通资料）/ FAULT_CASE（故障案例）',
  })
  @IsOptional()
  @IsString({ message: '投稿类别必须是字符串' })
  @MaxLength(ENUM_FILTER_MAX_LENGTH, { message: '投稿类别不能超过 32 个字符' })
  submissionKind?: string;

  @Field(() => String, {
    nullable: true,
    description:
      '状态等值筛选：DRAFT/PENDING_REVIEW/RETURNED/PUBLISHED；本人列表缺省为全部状态，审核队列缺省为 PENDING_REVIEW（值域由 usecase 校验）',
  })
  @IsOptional()
  @IsString({ message: '状态必须是字符串' })
  @MaxLength(ENUM_FILTER_MAX_LENGTH, { message: '状态不能超过 32 个字符' })
  status?: string;
}
