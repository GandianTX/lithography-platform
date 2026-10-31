// src/adapters/api/graphql/registration/dto/registration-organization.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import type { OrganizationRegistrationOption } from '@src/modules/lithography/organization.types';

/**
 * 注册可选组织（公开只读，只含主键与展示名称）。
 *
 * 只供注册页选择；客户端提交的 organizationId 仍由注册/重提事务复核有效性，
 * 本 DTO 不暴露组织类别、成员、内部资料等任何组织内部信息。
 */
@ObjectType({ description: '注册可选组织（有效组织的公开最小信息）' })
export class RegistrationOrganizationDTO {
  @Field(() => Int, { description: '组织主键' })
  id!: number;

  @Field(() => String, { description: '组织名称' })
  name!: string;
}

/** View → DTO 薄映射（字段直通，不做业务判断） */
export function toRegistrationOrganizationDTO(
  view: OrganizationRegistrationOption,
): RegistrationOrganizationDTO {
  return { id: view.id, name: view.name };
}
