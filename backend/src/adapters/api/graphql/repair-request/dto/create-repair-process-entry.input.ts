// src/adapters/api/graphql/repair-request/dto/create-repair-process-entry.input.ts

import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/** 保存过程时携带的暂存原件（必须与过程写入同一事务） */
@InputType({ description: '待绑定原件' })
export class RepairProcessEntryFileInput {
  @Field(() => String, { description: '已上传原件 ID' })
  @IsString({ message: '原件 ID 必须是字符串' })
  fileId!: string;

  @Field(() => String, { description: '上传上下文 ID' })
  @IsString({ message: '上传上下文 ID 必须是字符串' })
  uploadContextId!: string;
}

/**
 * 创建内部维修过程输入。
 * 作者取自 Session；时间来源由服务端按是否传入 occurredAt 固定写入。
 */
@InputType({ description: '创建内部维修过程输入参数' })
export class CreateRepairProcessEntryInput {
  @Field(() => Int, { description: '工单 ID' })
  @IsInt({ message: '工单 ID 必须是整数' })
  @Min(1, { message: '工单 ID 必须大于 0' })
  requestId!: number;

  @Field(() => String, { description: '人工执行操作' })
  @IsString({ message: '执行操作必须是字符串' })
  operationText!: string;

  @Field(() => String, { nullable: true, description: '实际测试事实' })
  @IsOptional()
  @IsString({ message: '测试事实必须是字符串' })
  testResult?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '业务现场事件时间（ISO 字符串）；缺省使用服务端时间',
  })
  @IsOptional()
  @IsString({ message: '事件时间必须是字符串' })
  occurredAt?: string | null;

  @Field(() => RepairProcessEntryFileInput, {
    nullable: true,
    description: '可选暂存原件；与过程写入同一事务绑定',
  })
  @IsOptional()
  file?: RepairProcessEntryFileInput | null;
}
