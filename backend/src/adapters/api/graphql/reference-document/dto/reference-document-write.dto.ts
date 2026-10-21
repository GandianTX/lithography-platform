// src/adapters/api/graphql/reference-document/dto/reference-document-write.dto.ts
// AI 参考资料写侧输入与结果（0907.docx 任务二）
// 仅做结构校验（拦脏数据）：空白语义、长度语义、型号存在性由 usecase 判定；
// createdByAccountId 不在输入中（仅取自会话）

import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** 标题长度上限（单一口径在 CreateReferenceDocumentUsecase；本层为装配层防御） */
const TITLE_MAX_LENGTH = 255;
/** 文档类型长度上限 */
const DOCUMENT_TYPE_MAX_LENGTH = 100;
/** 文档说明长度上限 */
const DESCRIPTION_MAX_LENGTH = 2000;
/** 文本内容长度上限（与 usecase 口径一致） */
const CONTENT_TEXT_MAX_LENGTH = 200_000;
/** 案例更正字段长度上限（A-PR0 §2.3，与明细表列长一致；usecase 为单一校验真源） */
const CASE_MODEL_TEXT_MAX_LENGTH = 100;
const CASE_ERROR_CODE_MAX_LENGTH = 100;
const CASE_PHENOMENON_MAX_LENGTH = 2000;
const CASE_CONDITION_MAX_LENGTH = 2000;
const CASE_REPRODUCTION_MAX_LENGTH = 10_000;
const CASE_DIAGNOSIS_MAX_LENGTH = 10_000;
const CASE_ACTION_TAKEN_MAX_LENGTH = 10_000;
const CASE_RESOLUTION_MAX_LENGTH = 2000;

/**
 * 创建参考资料输入参数
 */
@InputType({ description: '创建参考资料输入参数' })
export class CreateReferenceDocumentInput {
  @Field(() => String, { description: '文档标题' })
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(TITLE_MAX_LENGTH, { message: `标题不能超过 ${TITLE_MAX_LENGTH} 个字符` })
  title!: string;

  @Field(() => String, { description: '文档类型' })
  @IsString({ message: '文档类型必须是字符串' })
  @MaxLength(DOCUMENT_TYPE_MAX_LENGTH, {
    message: `文档类型不能超过 ${DOCUMENT_TYPE_MAX_LENGTH} 个字符`,
  })
  documentType!: string;

  @Field(() => Int, { nullable: true, description: '适用设备型号 ID；为空表示通用资料' })
  @IsOptional()
  @IsInt({ message: '设备型号 ID 必须是整数' })
  @Min(1, { message: '设备型号 ID 必须大于 0' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '文档说明' })
  @IsOptional()
  @IsString({ message: '文档说明必须是字符串' })
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `文档说明不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符`,
  })
  description?: string | null;

  @Field(() => String, { description: '文本内容（本周仅支持文本内容来源）' })
  @IsString({ message: '文本内容必须是字符串' })
  @MaxLength(CONTENT_TEXT_MAX_LENGTH, {
    message: `文本内容不能超过 ${CONTENT_TEXT_MAX_LENGTH} 个字符`,
  })
  contentText!: string;
}

/**
 * 编辑参考资料输入参数（部分提交语义：未提供的字段保持原值；
 * equipmentModelId/description 显式传 null 表示清空；contentText 不允许清空）
 */
@InputType({ description: '编辑参考资料输入参数' })
export class UpdateReferenceDocumentInput {
  @Field(() => String, { nullable: true, description: '文档标题（不传保持原值）' })
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(TITLE_MAX_LENGTH, { message: `标题不能超过 ${TITLE_MAX_LENGTH} 个字符` })
  title?: string | null;

  @Field(() => String, { nullable: true, description: '文档类型（不传保持原值）' })
  @IsOptional()
  @IsString({ message: '文档类型必须是字符串' })
  @MaxLength(DOCUMENT_TYPE_MAX_LENGTH, {
    message: `文档类型不能超过 ${DOCUMENT_TYPE_MAX_LENGTH} 个字符`,
  })
  documentType?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '适用设备型号 ID（不传保持原值；显式传 null 清空为通用资料）',
  })
  @IsOptional()
  @IsInt({ message: '设备型号 ID 必须是整数' })
  @Min(1, { message: '设备型号 ID 必须大于 0' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '文档说明（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '文档说明必须是字符串' })
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `文档说明不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符`,
  })
  description?: string | null;

  @Field(() => String, { nullable: true, description: '文本内容（不传保持原值；不允许清空）' })
  @IsOptional()
  @IsString({ message: '文本内容必须是字符串' })
  @MaxLength(CONTENT_TEXT_MAX_LENGTH, {
    message: `文本内容不能超过 ${CONTENT_TEXT_MAX_LENGTH} 个字符`,
  })
  contentText?: string | null;
}

/**
 * 资料写操作结果输出对象（创建/编辑/软删除共用）
 */
@ObjectType({ description: '参考资料写操作结果' })
export class ReferenceDocumentMutationResultDTO {
  @Field(() => Int, { description: '参考资料 ID' })
  id!: number;
}

/**
 * 案例专属更正输入参数（A-PR0 §S6 / §4.1 `updateReferenceDocumentCase`）
 * 部分提交语义：未提供的字段保持原值；可读正文为派生字段不在输入中；
 * 类型/归属组织/来源与原附件不可通过本接口修改
 */
@InputType({ description: '更正正式案例资料输入参数（仅案例资料；未提供字段保持原值）' })
export class UpdateReferenceDocumentCaseInput {
  @Field(() => String, { nullable: true, description: '文档标题（不传保持原值）' })
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(TITLE_MAX_LENGTH, { message: `标题不能超过 ${TITLE_MAX_LENGTH} 个字符` })
  title?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '适用设备型号 ID（不传保持原值；显式传 null 清空；与机型文字互斥）',
  })
  @IsOptional()
  @IsInt({ message: '设备型号 ID 必须是整数' })
  @Min(1, { message: '设备型号 ID 必须大于 0' })
  equipmentModelId?: number | null;

  @Field(() => String, {
    nullable: true,
    description: '机型文字（不传保持原值；显式传 null 清空；与机型 ID 互斥）',
  })
  @IsOptional()
  @IsString({ message: '机型文字必须是字符串' })
  @MaxLength(CASE_MODEL_TEXT_MAX_LENGTH, {
    message: `机型文字不能超过 ${CASE_MODEL_TEXT_MAX_LENGTH} 个字符`,
  })
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '文档说明（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '文档说明必须是字符串' })
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `文档说明不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符`,
  })
  description?: string | null;

  @Field(() => String, { nullable: true, description: '设备错误码（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '错误码必须是字符串' })
  @MaxLength(CASE_ERROR_CODE_MAX_LENGTH, {
    message: `错误码不能超过 ${CASE_ERROR_CODE_MAX_LENGTH} 个字符`,
  })
  errorCode?: string | null;

  @Field(() => String, { nullable: true, description: '故障现象（必填字段，不可清空）' })
  @IsOptional()
  @IsString({ message: '故障现象必须是字符串' })
  @MaxLength(CASE_PHENOMENON_MAX_LENGTH, {
    message: `故障现象不能超过 ${CASE_PHENOMENON_MAX_LENGTH} 个字符`,
  })
  phenomenon?: string | null;

  @Field(() => String, { nullable: true, description: '触发条件（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '触发条件必须是字符串' })
  @MaxLength(CASE_CONDITION_MAX_LENGTH, {
    message: `触发条件不能超过 ${CASE_CONDITION_MAX_LENGTH} 个字符`,
  })
  conditionText?: string | null;

  @Field(() => String, { nullable: true, description: '复现步骤（必填字段，不可清空）' })
  @IsOptional()
  @IsString({ message: '复现步骤必须是字符串' })
  @MaxLength(CASE_REPRODUCTION_MAX_LENGTH, {
    message: `复现步骤不能超过 ${CASE_REPRODUCTION_MAX_LENGTH} 个字符`,
  })
  reproductionSteps?: string | null;

  @Field(() => String, { nullable: true, description: '排查过程（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '排查过程必须是字符串' })
  @MaxLength(CASE_DIAGNOSIS_MAX_LENGTH, {
    message: `排查过程不能超过 ${CASE_DIAGNOSIS_MAX_LENGTH} 个字符`,
  })
  diagnosis?: string | null;

  @Field(() => String, { nullable: true, description: '处理措施（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '处理措施必须是字符串' })
  @MaxLength(CASE_ACTION_TAKEN_MAX_LENGTH, {
    message: `处理措施不能超过 ${CASE_ACTION_TAKEN_MAX_LENGTH} 个字符`,
  })
  actionTaken?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '处理状态：UNRESOLVED/IN_PROGRESS/RESOLVED（必填字段，不可清空）',
  })
  @IsOptional()
  @IsString({ message: '处理状态必须是字符串' })
  handlingStatus?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '处理结果（不传保持原值；传 null 清空；已解决时必须非空）',
  })
  @IsOptional()
  @IsString({ message: '处理结果必须是字符串' })
  @MaxLength(CASE_RESOLUTION_MAX_LENGTH, {
    message: `处理结果不能超过 ${CASE_RESOLUTION_MAX_LENGTH} 个字符`,
  })
  resolution?: string | null;
}

/**
 * 案例更正结果输出对象（A-PR0 §4.1：返回正式资料 ID/更新时间）
 */
@ObjectType({ description: '案例更正结果（正式资料 ID 与更新时间）' })
export class ReferenceDocumentCaseMutationResultDTO {
  @Field(() => Int, { description: '正式资料 ID' })
  id!: number;

  @Field(() => Date, { description: '资料最近更新时间' })
  updatedAt!: Date;
}
