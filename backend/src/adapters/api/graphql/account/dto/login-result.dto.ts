// src/adapters/api/graphql/account/dto/login-result.dto.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';
import { UserInfoDTO } from './user-info.dto';

/**
 * 登录成功结果，失败由 Graphql 直接抛错
 */
@ObjectType({ description: '登录结果' })
export class LoginResult {
  @Field(() => String, { description: '访问令牌' })
  accessToken!: string;

  @Field(() => String, { description: '刷新令牌' })
  refreshToken!: string;

  @Field(() => Int, { description: '用户 ID' })
  accountId!: number;

  @Field(() => IdentityTypeEnum, { description: '用户默认角色' })
  role!: IdentityTypeEnum;

  @Field(() => UserInfoDTO, { nullable: true, description: '用户信息' })
  userInfo?: UserInfoDTO | null;

  @Field(() => SessionRestriction, { description: '当前会话限制状态' })
  restriction!: SessionRestriction;

  @Field(() => Int, { nullable: true, description: '管理员等级（非管理员为空）' })
  adminLevel?: number | null;

  @Field(() => Int, { nullable: true, description: '客户公司归属（无归属为空）' })
  customerOrganizationId?: number | null;
}
