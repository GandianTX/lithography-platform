// src/adapters/api/graphql/registration/dto/admin-engineer-registration-item.dto.ts

import { AdminUserDTO, toAdminUserDTO } from '@src/adapters/api/graphql/account/dto/admin-user.dto';
import type { AdminEngineerRegistrationItem } from '@src/usecases/registration/admin-engineer-registration.types';
import { Field, ObjectType } from '@nestjs/graphql';
import {
  EngineerRegistrationApplicationDTO,
  toEngineerRegistrationApplicationDTO,
} from './engineer-registration-application.dto';

/**
 * 组织审核条目 DTO：申请事实 + 申请人公开资料。
 *
 * 有意复用 account 域 `AdminUserDTO`（仓库已有 `third-party-auth` 跨域复用先例），
 * 避免出现第二套“管理员眼中的账号资料”形状；若 account 域该 DTO 演进，本条目随之同步。
 */
@ObjectType({ description: '组织审核条目（申请 + 申请人）' })
export class AdminEngineerRegistrationItemDTO {
  @Field(() => EngineerRegistrationApplicationDTO, { description: '申请记录' })
  application!: EngineerRegistrationApplicationDTO;

  @Field(() => AdminUserDTO, { description: '申请人账号公开资料' })
  applicant!: AdminUserDTO;
}

/** 组织审核条目 View → DTO 薄映射 */
export function toAdminEngineerRegistrationItemDTO(
  item: AdminEngineerRegistrationItem,
): AdminEngineerRegistrationItemDTO {
  return {
    application: toEngineerRegistrationApplicationDTO(item.application),
    applicant: toAdminUserDTO(item.applicant),
  };
}
