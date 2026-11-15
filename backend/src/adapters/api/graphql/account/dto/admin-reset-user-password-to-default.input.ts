// src/adapters/api/graphql/account/dto/admin-reset-user-password-to-default.input.ts

import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, Min } from 'class-validator';

/**
 * 管理员把普通用户密码重置为系统默认密码的输入（任务 08.4）。
 *
 * 刻意**只有** `accountId`：默认密码只来自服务端运行期配置
 * （`ADMIN_DEFAULT_RESET_PASSWORD`），协议层不提供、也不接受任何密码字段，
 * 从结构上禁止把客户端自报的任意密码写入目标账号。
 */
@InputType({ description: '管理员重置用户密码为默认密码输入' })
export class AdminResetUserPasswordToDefaultInput {
  @Field(() => Int, { description: '目标账号 ID' })
  @IsInt({ message: '账号 ID 必须是整数' })
  @Min(1, { message: '账号 ID 必须是正整数' })
  accountId!: number;
}
