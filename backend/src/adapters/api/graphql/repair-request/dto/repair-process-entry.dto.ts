// src/adapters/api/graphql/repair-request/dto/repair-process-entry.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';

/** 已保存绑定的原件安全展示字段（不暴露存储引用） */
@ObjectType({ description: '内部维修过程原件' })
export class RepairProcessEntryFileDTO {
  @Field(() => String, { description: '原件 ID' })
  fileId!: string;

  @Field(() => String, { description: '原始文件名' })
  originalFilename!: string;

  @Field(() => String, { description: 'MIME 类型' })
  mimeType!: string;

  @Field(() => Int, { description: '字节数' })
  byteSize!: number;

  @Field(() => String, { description: 'SHA-256 校验值' })
  checksumSha256!: string;
}

/**
 * 内部维修过程输出对象。
 * 仅接单工程师本人可见；客户入口不返回过程与原件。
 */
@ObjectType({ description: '内部维修过程' })
export class RepairProcessEntryDTO {
  @Field(() => String, { description: '过程 ID' })
  id!: string;

  @Field(() => String, { description: '稳定记录编号' })
  entryUuid!: string;

  @Field(() => Int, { description: '所属工单 ID' })
  requestId!: number;

  @Field(() => String, { description: '人工执行操作' })
  operationText!: string;

  @Field(() => String, { nullable: true, description: '实际测试事实' })
  testResult?: string | null;

  @Field(() => Date, { nullable: true, description: '业务现场事件时间' })
  occurredAt?: Date | null;

  @Field(() => String, { description: '时间来源（SERVER/MANUAL）' })
  timeSource!: string;

  @Field(() => String, { nullable: true, description: '已绑定原件 ID' })
  fileId?: string | null;

  @Field(() => RepairProcessEntryFileDTO, {
    nullable: true,
    description: '已保存绑定的原件信息；未绑定为空',
  })
  file?: RepairProcessEntryFileDTO | null;

  @Field(() => Int, { description: '过程修改版本号' })
  versionNo!: number;

  @Field(() => Date, { description: '记录时间' })
  createdAt!: Date;
}
