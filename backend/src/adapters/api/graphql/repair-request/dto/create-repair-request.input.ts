// src/adapters/api/graphql/repair-request/dto/create-repair-request.input.ts

import { Field, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** 故障描述长度上限（单一口径在 CreateRepairRequestUsecase；本层为装配层防御，拦截异常长输入直达业务层） */
const FAULT_DESCRIPTION_MAX_LENGTH = 5000;

/** 手填机型长度上限（与 equipment_model.model_code 列长一致；编码与名称同源） */
const MANUAL_MODEL_TEXT_MAX_LENGTH = 50;

/** 稳定提交标识长度（36 位 UUID） */
const RECORD_UUID_LENGTH = 36;

/**
 * 客户报修原件绑定输入（原件须先经任务 11 上传并通过校验）。
 *
 * `uploadContextId` 与上传时返回的一致；绑定在提交事务内完成，
 * 这里只传引用，不接受组织、用途、绑定状态等可由服务端推出的事实。
 */
@InputType({ description: '客户报修原件绑定输入' })
export class CreateRepairRequestAttachmentInput {
  @Field(() => String, { description: '原件编号（上传后返回）' })
  @IsString({ message: '原件编号必须是字符串' })
  fileId!: string;

  @Field(() => String, { description: '上传上下文（上传后返回）' })
  @IsString({ message: '上传上下文必须是字符串' })
  uploadContextId!: string;
}

/**
 * 创建维修申请输入参数（任务 03「提交即出单」）
 *
 * 仅做结构校验（拦脏数据）：
 * - 空白语义、长度语义、机型二选一、提交标识格式由 usecase 判定；
 * - customerAccountId / 客户公司 / 工单号 / contentMd / 分析状态由服务端生成或从可信身份取得，
 *   不在输入中，客户端不可指定；
 * - `recordUuid` 为稳定提交标识：双击、并发与成功响应丢失后的重发必须复用同一值。
 */
@InputType({ description: '创建维修申请输入参数' })
export class CreateRepairRequestInput {
  @Field(() => String, {
    description: '稳定提交标识（36 位 UUID）：同一份报修内容重发时必须复用',
  })
  @IsString({ message: '提交标识必须是字符串' })
  @Length(RECORD_UUID_LENGTH, RECORD_UUID_LENGTH, { message: '提交标识必须是 36 位 UUID' })
  recordUuid!: string;

  @Field(() => Int, { description: '选定维修厂家（组织主键）' })
  @IsInt({ message: '维修厂家 ID 必须是整数' })
  @Min(1, { message: '维修厂家 ID 必须大于 0' })
  serviceOrganizationId!: number;

  @Field(() => Int, {
    nullable: true,
    description: '已有设备型号 ID；与 equipmentModelText 二选一',
  })
  @IsOptional()
  @IsInt({ message: '设备型号 ID 必须是整数' })
  @Min(1, { message: '设备型号 ID 必须大于 0' })
  equipmentModelId?: number | null;

  @Field(() => String, {
    nullable: true,
    description: '手填新机型；与 equipmentModelId 二选一，按编码查重后登记',
  })
  @IsOptional()
  @IsString({ message: '手填机型必须是字符串' })
  @MaxLength(MANUAL_MODEL_TEXT_MAX_LENGTH, {
    message: `手填机型不能超过 ${MANUAL_MODEL_TEXT_MAX_LENGTH} 个字符`,
  })
  equipmentModelText?: string | null;

  @Field(() => String, { description: '设备错误码' })
  @IsString({ message: '错误码必须是字符串' })
  @MaxLength(100, { message: '错误码不能超过 100 个字符' })
  errorCode!: string;

  @Field(() => String, { description: '故障描述' })
  @IsString({ message: '故障描述必须是字符串' })
  @MaxLength(FAULT_DESCRIPTION_MAX_LENGTH, {
    message: `故障描述不能超过 ${FAULT_DESCRIPTION_MAX_LENGTH} 个字符`,
  })
  faultDescription!: string;

  @Field(() => CreateRepairRequestAttachmentInput, {
    nullable: true,
    description: '可选：客户私有报修原件（须先上传为暂存态）',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRepairRequestAttachmentInput)
  attachment?: CreateRepairRequestAttachmentInput | null;
}
