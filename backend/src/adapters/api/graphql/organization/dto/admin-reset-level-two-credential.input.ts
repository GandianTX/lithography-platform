// src/adapters/api/graphql/organization/dto/admin-reset-level-two-credential.input.ts

import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import { ADMIN_CREDENTIAL_RESET_REASON_MAX_LENGTH } from '@src/usecases/organization/admin-organization.input.normalize';

/**
 * 一级管理员二级专用重置输入（S3）。
 *
 * 目标以 `organizationId + adminAccountId` 双重定位：服务端在事务内核验该账号
 * 就是该公司的唯一合法绑定（一级账号、非管理员、错误组织一律拒绝）。
 * `reason` 必填，写入审计便于追溯；不得包含口令或凭据信息。
 */
@InputType({ description: '二级管理员密码重置输入' })
export class AdminResetLevelTwoCredentialInput {
  @Field(() => Int, { description: '目标公司主键' })
  @IsInt({ message: '公司 ID 必须是整数' })
  @Min(1, { message: '公司 ID 必须大于等于 1' })
  organizationId!: number;

  @Field(() => Int, { description: '目标二级管理员账号主键' })
  @IsInt({ message: '管理员账号 ID 必须是整数' })
  @Min(1, { message: '管理员账号 ID 必须大于等于 1' })
  adminAccountId!: number;

  @Field(() => String, { description: '重置原因（必填，写入审计）' })
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '重置原因必须是字符串' })
  @MaxLength(ADMIN_CREDENTIAL_RESET_REASON_MAX_LENGTH, {
    message: `重置原因最多 ${ADMIN_CREDENTIAL_RESET_REASON_MAX_LENGTH} 个字符`,
  })
  reason!: string;
}
