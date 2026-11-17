// src/adapters/api/graphql/organization/dto/admin-reissue-level-two-credential.input.ts

import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, Min } from 'class-validator';

/**
 * 一级管理员补发二级管理员临时密码输入（S3）。
 *
 * 目标只按公司定位：服务端在事务内复核该公司唯一合法绑定，且目标必须
 * 仍处于「待首次改密」。不提供账号入参，避免客户端指定任意账号。
 */
@InputType({ description: '补发二级管理员临时密码输入' })
export class AdminReissueLevelTwoCredentialInput {
  @Field(() => Int, { description: '目标公司主键（按公司定位唯一绑定管理员）' })
  @IsInt({ message: '公司 ID 必须是整数' })
  @Min(1, { message: '公司 ID 必须大于等于 1' })
  organizationId!: number;
}
