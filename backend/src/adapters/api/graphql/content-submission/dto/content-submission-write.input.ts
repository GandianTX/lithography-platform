// src/adapters/api/graphql/content-submission/dto/content-submission-write.input.ts
// 投稿域写侧输入（A-PR0 §4.1：createContentSubmissionDraft / updateContentSubmissionDraft /
// submitContentSubmission / reviewContentSubmissionDecision）
// 仅做结构校验（拦脏数据）：空白语义、值域、必填完备性、跨类别字段拒收由 usecase 判定；
// 提交人 / 组织 / 审核状态一律不在输入中（仅取自会话与服务端事实）

import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';

/** 字段长度上限（A-PR0 §2.3，与明细表列长一致；usecase 为单一校验真源，本层为装配防御） */
const TITLE_MAX_LENGTH = 255;
const DOCUMENT_TYPE_MAX_LENGTH = 100;
const MODEL_TEXT_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 2000;
const CONTENT_TEXT_MAX_LENGTH = 200_000;
const ERROR_CODE_MAX_LENGTH = 100;
const PHENOMENON_MAX_LENGTH = 2000;
const CONDITION_MAX_LENGTH = 2000;
const REPRODUCTION_MAX_LENGTH = 10_000;
const DIAGNOSIS_MAX_LENGTH = 10_000;
const ACTION_TAKEN_MAX_LENGTH = 10_000;
const RESOLUTION_MAX_LENGTH = 2000;
/** 处理状态 / 投稿类别 / 审核决定为受控字符串，长度防御即可 */
const ENUM_VALUE_MAX_LENGTH = 32;
/** 审核意见长度上限（A-PR0 §2.3「审核」行：退回理由必填；通过的意见可选） */
const REVIEW_COMMENT_MAX_LENGTH = 2000;

/**
 * 草稿可编辑字段补丁（与 usecase ContentSubmissionEditablePatch 逐字段对齐）：
 * - 字段缺省（不传）：保持原值（创建时视为未提供）；
 * - 显式传 null：清空（草稿期全部字段可空；必填完备性在送审时校验）；
 * - 不属于目标类别的字段出现非空值即被 usecase 拒绝（null/缺省视为未提供）；
 * - extension 为 v1 扩展位：schema_version=1 未定义任何补充键，传任何键即被拒绝。
 */
@InputType({ description: '投稿草稿可编辑字段补丁（未提供保持原值；传 null 清空）' })
export class ContentSubmissionEditablePatchInput {
  @Field(() => String, { nullable: true, description: '标题（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(TITLE_MAX_LENGTH, { message: `标题不能超过 ${TITLE_MAX_LENGTH} 个字符` })
  title?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '资料类型（仅普通资料；FAULT_CASE 由 usecase 拒绝）',
  })
  @IsOptional()
  @IsString({ message: '资料类型必须是字符串' })
  @MaxLength(DOCUMENT_TYPE_MAX_LENGTH, {
    message: `资料类型不能超过 ${DOCUMENT_TYPE_MAX_LENGTH} 个字符`,
  })
  documentType?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '适用设备型号 ID（不传保持原值；传 null 清空；与机型文字互斥）',
  })
  @IsOptional()
  @IsInt({ message: '设备型号 ID 必须是整数' })
  @Min(1, { message: '设备型号 ID 必须大于 0' })
  equipmentModelId?: number | null;

  @Field(() => String, {
    nullable: true,
    description: '机型文字（不传保持原值；传 null 清空；与机型 ID 互斥）',
  })
  @IsOptional()
  @IsString({ message: '机型文字必须是字符串' })
  @MaxLength(MODEL_TEXT_MAX_LENGTH, {
    message: `机型文字不能超过 ${MODEL_TEXT_MAX_LENGTH} 个字符`,
  })
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '说明（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '说明必须是字符串' })
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `说明不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符`,
  })
  description?: string | null;

  @Field(() => String, { nullable: true, description: '正文（仅普通资料；不传保持原值）' })
  @IsOptional()
  @IsString({ message: '正文必须是字符串' })
  @MaxLength(CONTENT_TEXT_MAX_LENGTH, {
    message: `正文不能超过 ${CONTENT_TEXT_MAX_LENGTH} 个字符`,
  })
  contentText?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '设备错误码（仅故障案例；保留大小写与内部符号；传 null 清空）',
  })
  @IsOptional()
  @IsString({ message: '错误码必须是字符串' })
  @MaxLength(ERROR_CODE_MAX_LENGTH, {
    message: `错误码不能超过 ${ERROR_CODE_MAX_LENGTH} 个字符`,
  })
  errorCode?: string | null;

  @Field(() => String, { nullable: true, description: '故障现象（仅故障案例；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '故障现象必须是字符串' })
  @MaxLength(PHENOMENON_MAX_LENGTH, {
    message: `故障现象不能超过 ${PHENOMENON_MAX_LENGTH} 个字符`,
  })
  phenomenon?: string | null;

  @Field(() => String, { nullable: true, description: '触发条件（仅故障案例；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '触发条件必须是字符串' })
  @MaxLength(CONDITION_MAX_LENGTH, {
    message: `触发条件不能超过 ${CONDITION_MAX_LENGTH} 个字符`,
  })
  conditionText?: string | null;

  @Field(() => String, { nullable: true, description: '复现步骤（仅故障案例；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '复现步骤必须是字符串' })
  @MaxLength(REPRODUCTION_MAX_LENGTH, {
    message: `复现步骤不能超过 ${REPRODUCTION_MAX_LENGTH} 个字符`,
  })
  reproductionSteps?: string | null;

  @Field(() => String, { nullable: true, description: '排查过程（仅故障案例；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '排查过程必须是字符串' })
  @MaxLength(DIAGNOSIS_MAX_LENGTH, {
    message: `排查过程不能超过 ${DIAGNOSIS_MAX_LENGTH} 个字符`,
  })
  diagnosis?: string | null;

  @Field(() => String, { nullable: true, description: '处理措施（仅故障案例；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '处理措施必须是字符串' })
  @MaxLength(ACTION_TAKEN_MAX_LENGTH, {
    message: `处理措施不能超过 ${ACTION_TAKEN_MAX_LENGTH} 个字符`,
  })
  actionTaken?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '处理状态（仅故障案例）：UNRESOLVED/IN_PROGRESS/RESOLVED',
  })
  @IsOptional()
  @IsString({ message: '处理状态必须是字符串' })
  @MaxLength(ENUM_VALUE_MAX_LENGTH, { message: '处理状态不能超过 32 个字符' })
  handlingStatus?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '处理结果（仅故障案例；已解决时送审必填；传 null 清空）',
  })
  @IsOptional()
  @IsString({ message: '处理结果必须是字符串' })
  @MaxLength(RESOLUTION_MAX_LENGTH, {
    message: `处理结果不能超过 ${RESOLUTION_MAX_LENGTH} 个字符`,
  })
  resolution?: string | null;

  @Field(() => GraphQLJSON, {
    nullable: true,
    description: '扩展字段 v1 位（schema_version=1 未定义任何键，传任何键即被拒绝）',
  })
  @IsOptional()
  extension?: Record<string, unknown> | null;
}

/** 新建草稿输入：kind 决定类别，fields 为匹配类别的可编辑字段（草稿期全部可空） */
@InputType({ description: '新建投稿草稿输入（创建人/组织由服务端从会话确定）' })
export class CreateContentSubmissionDraftInput {
  @Field(() => String, { description: '投稿类别：MATERIAL（普通资料）/ FAULT_CASE（故障案例）' })
  @IsString({ message: '投稿类别必须是字符串' })
  @MaxLength(ENUM_VALUE_MAX_LENGTH, { message: '投稿类别不能超过 32 个字符' })
  kind!: string;

  @Field(() => ContentSubmissionEditablePatchInput, {
    description: '匹配类别的可编辑字段（保存草稿只要求一个非空文字业务字段）',
  })
  @ValidateNested()
  @Type(() => ContentSubmissionEditablePatchInput)
  fields!: ContentSubmissionEditablePatchInput;
}

@InputType({ description: '修改投稿草稿输入（仅本人 DRAFT/RETURNED；类别不可改）' })
export class UpdateContentSubmissionDraftInput {
  @Field(() => ContentSubmissionEditablePatchInput, {
    description: '可编辑字段补丁（未提供保持原值；传 null 清空；空补丁被拒绝）',
  })
  @ValidateNested()
  @Type(() => ContentSubmissionEditablePatchInput)
  patch!: ContentSubmissionEditablePatchInput;
}

/**
 * 送审 / 重提输入：从本人已保存稿冻结出新版本。
 * 不接受客户端自报状态、所有者、版本号（由服务端在同一事务内冻结）。
 */
@InputType({ description: '提交审核输入（从已保存稿冻结新版本）' })
export class SubmitContentSubmissionInput {
  @Field(() => Boolean, {
    description: '入库告知确认（未确认为 true 时拒绝送审；服务端固定告知版本）',
  })
  @IsBoolean({ message: '入库告知确认必须是布尔值' })
  libraryNoticeConfirmed!: boolean;
}

/**
 * 审核决定输入（A-PR0 §4.1 reviewContentSubmissionDecision）：
 * revisionId 必须属于该投稿且等于当前待审版本（行锁内核对，不符拒绝）。
 * RETURN 不产生正式资料；APPROVE 时 publishAttachment 为当次获准原件发布决定
 * （缺省 false=不发布附件；仅文件版本选择 false 会被 usecase 拒绝）。
 */
@InputType({ description: '投稿审核决定输入（退回 / 通过）' })
export class ReviewContentSubmissionDecisionInput {
  @Field(() => Int, { description: '投稿 ID' })
  @IsInt({ message: '投稿 ID 必须是整数' })
  @Min(1, { message: '投稿 ID 必须大于 0' })
  submissionId!: number;

  @Field(() => Int, { description: '目标版本 ID（必须等于当前待审版本）' })
  @IsInt({ message: '版本 ID 必须是整数' })
  @Min(1, { message: '版本 ID 必须大于 0' })
  revisionId!: number;

  @Field(() => String, { description: '审核决定：RETURN（退回）/ APPROVE（通过）' })
  @IsString({ message: '审核决定必须是字符串' })
  @IsIn(['RETURN', 'APPROVE'], { message: '审核决定取值非法' })
  decision!: string;

  @Field(() => String, {
    nullable: true,
    description: '审核意见：退回时必填；通过时可选',
  })
  @IsOptional()
  @IsString({ message: '审核意见必须是字符串' })
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH, {
    message: `审核意见不能超过 ${REVIEW_COMMENT_MAX_LENGTH} 个字符`,
  })
  comment?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      '附件发布决定（仅 APPROVE 生效；缺省 false=不发布附件；无文件版本只能为 false，仅文件版本必须为 true）',
  })
  @IsOptional()
  @IsBoolean({ message: '附件发布决定必须是布尔值' })
  publishAttachment?: boolean | null;
}
