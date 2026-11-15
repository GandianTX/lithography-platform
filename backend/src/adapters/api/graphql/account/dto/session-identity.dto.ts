// src/adapters/api/graphql/account/dto/session-identity.dto.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * 当前会话身份与限制状态。
 *
 * 供受限页展示「为什么被限制」以及前端路由策略使用；不含 `accessGroup`、`metaDigest`
 * 等授权原值，也不接收任何目标账号参数（账号来自已认证 Session）。
 */
@ObjectType({ description: '当前会话身份与限制状态' })
export class SessionIdentityDTO {
  @Field(() => Int, { description: '当前账户 ID' })
  accountId!: number;

  @Field(() => IdentityTypeEnum, { nullable: true, description: '当前使用角色' })
  role!: IdentityTypeEnum | null;

  @Field(() => Int, { nullable: true, description: '管理员等级（非管理员为空）' })
  adminLevel!: number | null;

  @Field(() => Int, { nullable: true, description: '客户公司归属（无归属为空）' })
  customerOrganizationId!: number | null;

  @Field(() => Int, { nullable: true, description: '唯一有效工程师成员组织（无或多组织为空）' })
  engineerOrganizationId!: number | null;

  @Field(() => Int, { nullable: true, description: '唯一有效管理员成员组织（无或多组织为空）' })
  adminOrganizationId!: number | null;

  @Field(() => Int, {
    nullable: true,
    description: '最新工程师申请的目标公司（仅展示，不授予组织业务权限）',
  })
  registrationOrganizationId!: number | null;

  @Field(() => SessionRestriction, { description: '当前会话限制状态' })
  restriction!: SessionRestriction;
}
