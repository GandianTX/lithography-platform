// src/adapters/api/graphql/reference-document/dto/reference-document-write.dto.ts
// 历史维修记录写侧输入与结果（任务 07 R053/R058–R061 + A-PR0 §S6 案例更正）
// 仅做结构校验（拦脏数据）：空白语义、长度语义、型号/账号/公司存在性由 usecase 判定；
// createdByAccountId 归属更正为显式输入（一级管理员核实动作），其余写路径不取自客户端。
//
// 任务 07 确认需求收口：CreateReferenceDocumentInput / UpdateReferenceDocumentInput
// 已随旧普通新增与通用编辑写入口一并移除——本期普通资料新增与资料审核取消，
// 服务端同步关闭，历史资料照常授权读取。
//
// expected_version 口径（R053/R058–R061）：令牌是 reference_document.current_revision_no，
// 该列默认 0 表示「尚无管理修订」（正文仍是原始冻结报告/原始正文）。因此
// expected_version 的协议级下界是 0，只有负数被拒绝；账号 ID/组织 ID 等
// 其它数值输入仍是 @Min(1)，不随本口径放宽。

import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** 标题长度上限 */
const TITLE_MAX_LENGTH = 255;
/** 文档说明长度上限 */
const DESCRIPTION_MAX_LENGTH = 2000;
/** 文本内容长度上限（与生效正文口径一致） */
const CONTENT_TEXT_MAX_LENGTH = 200_000;
/** 管理操作原因长度上限（usecase assertManagementReason 为单一校验真源） */
const REASON_MAX_LENGTH = 500;
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
 * 管理修订输入参数（任务 07 R058）：expected_version 过期拒绝（CONFLICT）；
 * 补丁为全量值语义，仅标题/说明/正文可修订，FAULT_CASE 正文走案例更正接口。
 */
@InputType({ description: '管理修订正式资料输入参数（仅一级管理员）' })
export class ReviseReferenceDocumentInput {
  @Field(() => Int, { description: '期望生效版本号（expected_version）' })
  @IsInt({ message: 'expected_version 必须是整数' })
  @Min(0, { message: 'expected_version 不能为负数' })
  expectedVersion!: number;

  @Field(() => String, { description: '修订原因（必填）' })
  @IsString({ message: '修订原因必须是字符串' })
  @MaxLength(REASON_MAX_LENGTH, { message: `修订原因不能超过 ${REASON_MAX_LENGTH} 个字符` })
  reason!: string;

  @Field(() => String, { nullable: true, description: '文档标题（不传保持原值）' })
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(TITLE_MAX_LENGTH, { message: `标题不能超过 ${TITLE_MAX_LENGTH} 个字符` })
  title?: string;

  @Field(() => String, { nullable: true, description: '文档说明（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '文档说明必须是字符串' })
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `文档说明不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符`,
  })
  description?: string | null;

  @Field(() => String, { nullable: true, description: '文本内容（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '文本内容必须是字符串' })
  @MaxLength(CONTENT_TEXT_MAX_LENGTH, {
    message: `文本内容不能超过 ${CONTENT_TEXT_MAX_LENGTH} 个字符`,
  })
  contentText?: string | null;
}

// ---- 任务 07 结构化管理修订输入（报告来源正式资料；仅一级管理员） ----
// 结构校验只拦脏数据（长度/嵌套形状）；枚举、分支启用条件、稳定关联、
// 日期格式与必填语义由 usecase normalizeStructuredRevisionContent 严格裁决。

/** 结构化故障面板长度上限（与前端编辑器 model.ts / usecase 校验同口径） */
const STRUCTURED_PANEL_TEXT_MAX_LENGTH = 300;
const STRUCTURED_STEP_TEXT_MAX_LENGTH = 300;
const STRUCTURED_ACTION_MAX_LENGTH = 20_000;
const STRUCTURED_RESULT_TEXT_MAX_LENGTHS = {
  actualCause: 2000,
  repairActions: 10_000,
  verificationResult: 2000,
  supplementaryNote: 10_000,
  closureReason: 10_000,
} as const;
const STRUCTURED_ENGINEER_NAME_MAX_LENGTH = 200;
/** 客户厂家文本上限（与任务 06 报告字段规则同口径） */
const STRUCTURED_CUSTOMER_FACTORY_MAX_LENGTH = 200;
const STRUCTURED_DATE_MAX_LENGTH = 10;

@InputType({ description: '结构化管理修订故障面板输入' })
export class ReferenceDocumentStructuredFaultInput {
  @Field(() => String, { description: '分支类型：INITIAL/RESET_NEW_FAULT/STEP_NEW_FAULT' })
  @IsString({ message: '分支类型必须是字符串' })
  @MaxLength(64, { message: '分支类型长度非法' })
  branchKind!: string;

  @Field(() => String, { nullable: true, description: '步骤新故障关联的步骤编码' })
  @IsOptional()
  @IsString({ message: '步骤编码必须是字符串' })
  @MaxLength(200, { message: '步骤编码不能超过 200 个字符' })
  stepCode?: string | null;

  @Field(() => String, { nullable: true, description: '流程阶段编码' })
  @IsOptional()
  @IsString({ message: '流程阶段必须是字符串' })
  @MaxLength(16, { message: '流程阶段编码长度非法' })
  phaseCode?: string | null;

  @Field(() => String, { nullable: true, description: 'Main Error' })
  @IsOptional()
  @IsString({ message: 'Main Error 必须是字符串' })
  @MaxLength(STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
    message: `Main Error 不能超过 ${STRUCTURED_PANEL_TEXT_MAX_LENGTH} 个字符`,
  })
  mainError?: string | null;

  @Field(() => String, { nullable: true, description: 'Unit Error' })
  @IsOptional()
  @IsString({ message: 'Unit Error 必须是字符串' })
  @MaxLength(STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
    message: `Unit Error 不能超过 ${STRUCTURED_PANEL_TEXT_MAX_LENGTH} 个字符`,
  })
  unitError?: string | null;

  @Field(() => String, { nullable: true, description: 'Source' })
  @IsOptional()
  @IsString({ message: 'Source 必须是字符串' })
  @MaxLength(STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
    message: `Source 不能超过 ${STRUCTURED_PANEL_TEXT_MAX_LENGTH} 个字符`,
  })
  source?: string | null;

  @Field(() => String, { nullable: true, description: 'Error Type' })
  @IsOptional()
  @IsString({ message: 'Error Type 必须是字符串' })
  @MaxLength(STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
    message: `Error Type 不能超过 ${STRUCTURED_PANEL_TEXT_MAX_LENGTH} 个字符`,
  })
  errorType?: string | null;

  @Field(() => String, { nullable: true, description: 'GPIB Status' })
  @IsOptional()
  @IsString({ message: 'GPIB Status 必须是字符串' })
  @MaxLength(STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
    message: `GPIB Status 不能超过 ${STRUCTURED_PANEL_TEXT_MAX_LENGTH} 个字符`,
  })
  gpibStatus?: string | null;

  @Field(() => String, { nullable: true, description: 'Status' })
  @IsOptional()
  @IsString({ message: 'Status 必须是字符串' })
  @MaxLength(STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
    message: `Status 不能超过 ${STRUCTURED_PANEL_TEXT_MAX_LENGTH} 个字符`,
  })
  faultStatus?: string | null;

  @Field(() => String, { description: 'Description（必填）' })
  @IsString({ message: '故障描述必须是字符串' })
  @MaxLength(STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
    message: `故障描述不能超过 ${STRUCTURED_PANEL_TEXT_MAX_LENGTH} 个字符`,
  })
  description!: string;

  @Field(() => String, { nullable: true, description: 'Action' })
  @IsOptional()
  @IsString({ message: 'Action 必须是字符串' })
  @MaxLength(STRUCTURED_ACTION_MAX_LENGTH, {
    message: `Action 不能超过 ${STRUCTURED_ACTION_MAX_LENGTH} 个字符`,
  })
  action?: string | null;
}

@InputType({ description: '结构化管理修订排查步骤输入' })
export class ReferenceDocumentStructuredStepInput {
  @Field(() => String, { description: '步骤稳定编码（调序不变）' })
  @IsString({ message: '步骤编码必须是字符串' })
  @MaxLength(200, { message: '步骤编码不能超过 200 个字符' })
  stepCode!: string;

  @Field(() => String, { nullable: true, description: '流程阶段编码' })
  @IsOptional()
  @IsString({ message: '流程阶段必须是字符串' })
  @MaxLength(16, { message: '流程阶段编码长度非法' })
  phaseCode?: string | null;

  @Field(() => String, { nullable: true, description: '故障部件代码' })
  @IsOptional()
  @IsString({ message: '故障部件代码必须是字符串' })
  @MaxLength(STRUCTURED_STEP_TEXT_MAX_LENGTH, {
    message: `故障部件代码不能超过 ${STRUCTURED_STEP_TEXT_MAX_LENGTH} 个字符`,
  })
  errorCode?: string | null;

  @Field(() => String, { nullable: true, description: '部件名称' })
  @IsOptional()
  @IsString({ message: '部件名称必须是字符串' })
  @MaxLength(STRUCTURED_STEP_TEXT_MAX_LENGTH, {
    message: `部件名称不能超过 ${STRUCTURED_STEP_TEXT_MAX_LENGTH} 个字符`,
  })
  partName?: string | null;

  @Field(() => String, { description: '操作方式（必填）' })
  @IsString({ message: '操作方式必须是字符串' })
  @MaxLength(STRUCTURED_STEP_TEXT_MAX_LENGTH, {
    message: `操作方式不能超过 ${STRUCTURED_STEP_TEXT_MAX_LENGTH} 个字符`,
  })
  actionText!: string;

  @Field(() => String, { description: '步骤结果：RESOLVED/UNRESOLVED/NEW_FAULT' })
  @IsString({ message: '步骤结果必须是字符串' })
  @MaxLength(32, { message: '步骤结果长度非法' })
  resultCode!: string;
}

@InputType({ description: '结构化管理修订内容输入（全量值语义）' })
export class ReferenceDocumentStructuredContentInput {
  @Field(() => Int, { description: '结构化内容 schema 版本' })
  @IsInt({ message: 'schema 版本必须是整数' })
  schemaVersion!: number;

  @Field(() => String, { description: '维修日期（YYYY-MM-DD）' })
  @IsString({ message: '维修日期必须是字符串' })
  @MaxLength(STRUCTURED_DATE_MAX_LENGTH, { message: '维修日期长度非法' })
  maintenanceDate!: string;

  @Field(() => String, { description: '维修工程师' })
  @IsString({ message: '维修工程师必须是字符串' })
  @MaxLength(STRUCTURED_ENGINEER_NAME_MAX_LENGTH, {
    message: `维修工程师不能超过 ${STRUCTURED_ENGINEER_NAME_MAX_LENGTH} 个字符`,
  })
  maintenanceEngineerName!: string;

  @Field(() => String, { description: '客户厂家文本（必填，不超过 200 字）' })
  @IsString({ message: '客户厂家必须是字符串' })
  @MaxLength(STRUCTURED_CUSTOMER_FACTORY_MAX_LENGTH, {
    message: `客户厂家不能超过 ${STRUCTURED_CUSTOMER_FACTORY_MAX_LENGTH} 个字符`,
  })
  customerFactoryName!: string;

  @Field(() => String, { description: '复位情况：NORMAL/SAME_FAULT/NEW_FAULT' })
  @IsString({ message: '复位情况必须是字符串' })
  @MaxLength(32, { message: '复位情况长度非法' })
  resetResult!: string;

  @Field(() => [ReferenceDocumentStructuredFaultInput], { description: '故障面板' })
  @IsArray({ message: '故障面板必须是数组' })
  @ValidateNested({ each: true, message: '故障面板存在非法项' })
  @Type(() => ReferenceDocumentStructuredFaultInput)
  faults!: ReferenceDocumentStructuredFaultInput[];

  @Field(() => [ReferenceDocumentStructuredStepInput], { description: '排查步骤' })
  @IsArray({ message: '排查步骤必须是数组' })
  @ValidateNested({ each: true, message: '排查步骤存在非法项' })
  @Type(() => ReferenceDocumentStructuredStepInput)
  steps!: ReferenceDocumentStructuredStepInput[];

  @Field(() => String, { nullable: true, description: '维修结果（五类稳定枚举）' })
  @IsOptional()
  @IsString({ message: '维修结果必须是字符串' })
  @MaxLength(64, { message: '维修结果长度非法' })
  handlingResult?: string | null;

  @Field(() => String, { nullable: true, description: '中断/无法修复原因' })
  @IsOptional()
  @IsString({ message: '中断/无法修复原因必须是字符串' })
  @MaxLength(STRUCTURED_RESULT_TEXT_MAX_LENGTHS.closureReason, {
    message: `中断/无法修复原因不能超过 ${STRUCTURED_RESULT_TEXT_MAX_LENGTHS.closureReason} 个字符`,
  })
  closureReason?: string | null;

  @Field(() => String, { nullable: true, description: '故障根因' })
  @IsOptional()
  @IsString({ message: '故障根因必须是字符串' })
  @MaxLength(STRUCTURED_RESULT_TEXT_MAX_LENGTHS.actualCause, {
    message: `故障根因不能超过 ${STRUCTURED_RESULT_TEXT_MAX_LENGTHS.actualCause} 个字符`,
  })
  actualCause?: string | null;

  @Field(() => String, { nullable: true, description: '维修动作说明' })
  @IsOptional()
  @IsString({ message: '维修动作说明必须是字符串' })
  @MaxLength(STRUCTURED_RESULT_TEXT_MAX_LENGTHS.repairActions, {
    message: `维修动作说明不能超过 ${STRUCTURED_RESULT_TEXT_MAX_LENGTHS.repairActions} 个字符`,
  })
  repairActions?: string | null;

  @Field(() => String, { nullable: true, description: '验证结果' })
  @IsOptional()
  @IsString({ message: '验证结果必须是字符串' })
  @MaxLength(STRUCTURED_RESULT_TEXT_MAX_LENGTHS.verificationResult, {
    message: `验证结果不能超过 ${STRUCTURED_RESULT_TEXT_MAX_LENGTHS.verificationResult} 个字符`,
  })
  verificationResult?: string | null;

  @Field(() => String, { nullable: true, description: '补充说明' })
  @IsOptional()
  @IsString({ message: '补充说明必须是字符串' })
  @MaxLength(STRUCTURED_RESULT_TEXT_MAX_LENGTHS.supplementaryNote, {
    message: `补充说明不能超过 ${STRUCTURED_RESULT_TEXT_MAX_LENGTHS.supplementaryNote} 个字符`,
  })
  supplementaryNote?: string | null;
}

/**
 * 结构化管理修订输入参数（任务 07，报告来源正式资料；仅一级管理员）：
 * 结构化内容为全量值语义（厂家文本可修订）；equipmentModelId 未提交＝保持原值，
 * 显式 null＝拒绝清空；改选目标按 ID 服务端校验存在且启用并从字典取名称。
 */
@InputType({ description: '结构化管理修订正式资料输入参数（仅一级管理员）' })
export class ReviseReferenceDocumentStructuredInput {
  @Field(() => Int, { description: '期望生效版本号（expected_version）' })
  @IsInt({ message: 'expected_version 必须是整数' })
  @Min(0, { message: 'expected_version 不能为负数' })
  expectedVersion!: number;

  @Field(() => String, { description: '管理修订原因（必填）' })
  @IsString({ message: '管理修订原因必须是字符串' })
  @MaxLength(REASON_MAX_LENGTH, { message: `管理修订原因不能超过 ${REASON_MAX_LENGTH} 个字符` })
  reason!: string;

  @Field(() => Int, {
    nullable: true,
    description: '机型改选目标 ID（不传＝保持原关联；显式 null＝拒绝清空）',
  })
  @IsOptional()
  @IsInt({ message: '机型 ID 必须是整数' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '文档标题（不传保持原值）' })
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(TITLE_MAX_LENGTH, { message: `标题不能超过 ${TITLE_MAX_LENGTH} 个字符` })
  title?: string;

  @Field(() => String, { nullable: true, description: '文档说明（不传保持原值；传 null 清空）' })
  @IsOptional()
  @IsString({ message: '文档说明必须是字符串' })
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `文档说明不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符`,
  })
  description?: string | null;

  @Field(() => ReferenceDocumentStructuredContentInput, {
    description: '结构化报告内容（全量值语义）',
  })
  @IsOptional()
  @ValidateNested({ message: '结构化报告内容非法' })
  @Type(() => ReferenceDocumentStructuredContentInput)
  structured?: ReferenceDocumentStructuredContentInput;
}

/**
 * 下架输入参数（任务 07 R059）：下架与管理删除分别确认，不复用同一入口。
 */
@InputType({ description: '下架正式资料输入参数（仅一级管理员）' })
export class OfflineReferenceDocumentInput {
  @Field(() => Int, { description: '期望生效版本号（expected_version）' })
  @IsInt({ message: 'expected_version 必须是整数' })
  @Min(0, { message: 'expected_version 不能为负数' })
  expectedVersion!: number;

  @Field(() => String, { description: '下架原因（必填）' })
  @IsString({ message: '下架原因必须是字符串' })
  @MaxLength(REASON_MAX_LENGTH, { message: `下架原因不能超过 ${REASON_MAX_LENGTH} 个字符` })
  reason!: string;
}

/**
 * 管理删除输入参数（任务 07 R060）：软删除 + 生效版本 + 历史 + 关键记录同事务。
 */
@InputType({ description: '管理删除正式资料输入参数（仅一级管理员）' })
export class AdminDeleteReferenceDocumentInput {
  @Field(() => Int, { description: '期望生效版本号（expected_version）' })
  @IsInt({ message: 'expected_version 必须是整数' })
  @Min(0, { message: 'expected_version 不能为负数' })
  expectedVersion!: number;

  @Field(() => String, { description: '删除原因（必填）' })
  @IsString({ message: '删除原因必须是字符串' })
  @MaxLength(REASON_MAX_LENGTH, { message: `删除原因不能超过 ${REASON_MAX_LENGTH} 个字符` })
  reason!: string;
}

/**
 * 归属更正输入参数（任务 07 R061-02）：仅提交需要更正的字段，未提交字段保留原值；
 * 更换上传者不自动采用其当前公司；上传者与公司均显式更正时才确认归属。
 */
@InputType({ description: '保存资料归属更正输入参数（仅一级管理员）' })
export class CorrectReferenceDocumentOwnershipInput {
  @Field(() => Int, { description: '期望生效版本号（expected_version）' })
  @IsInt({ message: 'expected_version 必须是整数' })
  @Min(0, { message: 'expected_version 不能为负数' })
  expectedVersion!: number;

  @Field(() => String, { description: '核实原因（必填）' })
  @IsString({ message: '核实原因必须是字符串' })
  @MaxLength(REASON_MAX_LENGTH, { message: `核实原因不能超过 ${REASON_MAX_LENGTH} 个字符` })
  verificationReason!: string;

  @Field(() => Int, { nullable: true, description: '更正后的上传者账号 ID（不传保留原值）' })
  @IsOptional()
  @IsInt({ message: '上传者账号 ID 必须是整数' })
  @Min(1, { message: '上传者账号 ID 必须大于 0' })
  createdByAccountId?: number;

  @Field(() => Int, { nullable: true, description: '更正后的上传时公司 ID（不传保留原值）' })
  @IsOptional()
  @IsInt({ message: '公司 ID 必须是整数' })
  @Min(1, { message: '公司 ID 必须大于 0' })
  ownerOrganizationId?: number;
}

/**
 * 资料写操作结果输出对象（原作者删除 R053）
 */
@ObjectType({ description: '历史维修记录写操作结果' })
export class ReferenceDocumentMutationResultDTO {
  @Field(() => Int, { description: '历史维修记录 ID' })
  id!: number;
}

/**
 * 管理操作结果输出对象（R058/R059/R060/R061-02）：资料 ID 与新生效版本号
 */
@ObjectType({ description: '历史维修记录管理操作结果（ID 与新生效版本号）' })
export class ReferenceDocumentManagedMutationResultDTO {
  @Field(() => Int, { description: '历史维修记录 ID' })
  id!: number;

  @Field(() => Int, { description: '本次生成的新生效版本号' })
  revisionNo!: number;
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
