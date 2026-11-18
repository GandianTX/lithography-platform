// src/adapters/api/graphql/repair-request/dto/update-repair-process-entry.input.ts

import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { RepairProcessEntryFileInput } from './create-repair-process-entry.input';

/**
 * 编辑内部维修过程输入。
 * `expectedVersion` 为乐观并发控制版本号。
 * 仅当当前过程尚无原件时可补传一份暂存原件；已有原件不允许替换或移除。
 * `file` 合同：
 * - 省略 `file`：保持原有件绑定不变（无原件时仍无原件）；
 * - 显式 `file: null`：不是移除/清空，按输入错误拒绝；
 * - 已有原件时传新 `file`：拒绝（不支持替换/移除）。
 */
@InputType({ description: '编辑内部维修过程输入参数' })
export class UpdateRepairProcessEntryInput {
  @Field(() => Int, { description: '工单 ID' })
  @IsInt({ message: '工单 ID 必须是整数' })
  @Min(1, { message: '工单 ID 必须大于 0' })
  requestId!: number;

  @Field(() => String, { description: '过程 ID' })
  @IsString({ message: '过程 ID 必须是字符串' })
  entryId!: string;

  @Field(() => Int, { description: '期望的当前版本号' })
  @IsInt({ message: '版本号必须是整数' })
  @Min(1, { message: '版本号必须大于 0' })
  expectedVersion!: number;

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
    description:
      '省略表示保持原有件绑定；显式 null 表示非法移除，按输入错误拒绝；已有原件时传新文件拒绝（不支持替换/移除）。与过程更新同一事务绑定',
  })
  @IsOptional()
  file?: RepairProcessEntryFileInput | null;
}
