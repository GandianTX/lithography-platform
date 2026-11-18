// src/adapters/api/graphql/organization/dto/admin-level-two-credential-result.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import type { LevelTwoCredentialResult } from '@src/usecases/organization/company-admin-binding.types';

/**
 * 补发 / 二级专用重置的成功结果（S3）。
 *
 * `temporaryPassword` 只在本次成功响应返回一次，服务端不持久化明文；
 * 客户端不得缓存或落库，审计与日志也不包含该值。
 */
@ObjectType({ description: '二级管理员临时凭据结果（口令仅本次返回）' })
export class AdminLevelTwoCredentialResultDTO {
  @Field(() => Int, { description: '公司主键' })
  organizationId!: number;

  @Field(() => Int, { description: '目标管理员账号主键' })
  adminAccountId!: number;

  @Field(() => String, { description: '目标账号登录名' })
  loginName!: string;

  @Field(() => String, { nullable: true, description: '目标账号昵称' })
  nickname?: string | null;

  @Field(() => Boolean, { description: '是否必须先改密（恒为 true）' })
  mustChangePassword!: boolean;

  @Field(() => String, { description: '本次新生成的随机临时密码；仅本次响应返回一次' })
  temporaryPassword!: string;
}

export function toAdminLevelTwoCredentialResultDTO(
  result: LevelTwoCredentialResult,
): AdminLevelTwoCredentialResultDTO {
  return {
    organizationId: result.organizationId,
    adminAccountId: result.adminAccountId,
    loginName: result.loginName,
    nickname: result.nickname,
    mustChangePassword: result.mustChangePassword,
    temporaryPassword: result.temporaryPassword,
  };
}
