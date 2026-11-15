// src/adapters/api/graphql/account/dto/my-account-settings.dto.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';
import type { MyAccountSettingsView } from '@src/modules/account/account.types';

/**
 * 当前用户账号设置 DTO（P1，只读）。
 *
 * 由 `MyAccountSettingsView`（modules/account 稳定公开读视图）薄映射而来，只做字段直通，
 * 不含任何业务判断。服务 `myAccountSettings` 受保护 Query。
 *
 * 刻意**不含 `accountId` 字段**：负责人明确要求「不暴露目标 accountId」，客户端已从登录结果
 * 获知自己的 accountId；View 上没有该字段，本 DTO 也无从声明。
 *
 * - `contactEmail` 是联系邮箱（`base_user_info.email`），与登录凭据邮箱 `loginEmail` 严格区分，
 *   不得互相代替；
 * - `role` 是三源收敛后的单值只读角色，`status` 是账号真实只读状态；二者均为只读展示字段，
 *   本功能不提供任何角色/状态写入入口；
 * - 严禁出现：密码或哈希、`metaDigest`、完整 `accessGroup`、Access/Refresh Token、`identityHint`、
 *   `userState` 或任何内部诊断字段。
 */
@ObjectType({ description: '当前用户账号设置（只读）' })
export class MyAccountSettingsDTO {
  @Field(() => String, { description: '登录名', nullable: true })
  loginName!: string | null;

  @Field(() => String, { description: '登录邮箱（登录凭据）', nullable: true })
  loginEmail!: string | null;

  @Field(() => String, { description: '昵称' })
  nickname!: string;

  @Field(() => String, { description: '真实姓名', nullable: true })
  realName!: string | null;

  @Field(() => String, { description: '公司名称', nullable: true })
  companyName!: string | null;

  @Field(() => String, { description: '可信公司名称', nullable: true })
  trustedCompanyName!: string | null;

  @Field(() => String, { description: '电话', nullable: true })
  phone!: string | null;

  @Field(() => String, { description: '联系邮箱（非登录凭据）', nullable: true })
  contactEmail!: string | null;

  @Field(() => IdentityTypeEnum, { description: '当前角色（只读）' })
  role!: IdentityTypeEnum;

  @Field(() => AccountStatus, { description: '账号状态（只读）' })
  status!: AccountStatus;

  @Field(() => Int, { description: '管理员等级（只读）', nullable: true })
  adminLevel!: number | null;

  @Field(() => Date, { description: '最近变更时间（账号侧与资料侧较新值）' })
  updatedAt!: Date;
}

/**
 * View → DTO 薄映射（字段直通，供 Resolver 复用；不做任何业务判断）。
 */
export function toMyAccountSettingsDTO(view: MyAccountSettingsView): MyAccountSettingsDTO {
  return {
    loginName: view.loginName,
    loginEmail: view.loginEmail,
    nickname: view.nickname,
    realName: view.realName,
    companyName: view.companyName,
    trustedCompanyName: view.trustedCompanyName,
    phone: view.phone,
    contactEmail: view.contactEmail,
    role: view.role,
    status: view.status,
    adminLevel: view.adminLevel,
    updatedAt: view.updatedAt,
  };
}
