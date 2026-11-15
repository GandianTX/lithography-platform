// src/adapters/api/graphql/registration/dto/registration-organization-page.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import type { OrganizationRegistrationOptionPage } from '@src/modules/lithography/organization.types';
import {
  RegistrationOrganizationDTO,
  toRegistrationOrganizationDTO,
} from './registration-organization.dto';

/** 注册公司候选分页（公开只读，按名称、主键稳定排序） */
@ObjectType({ description: '注册可选公司分页' })
export class RegistrationOrganizationPageDTO {
  @Field(() => [RegistrationOrganizationDTO], { description: '当前页公司' })
  items!: RegistrationOrganizationDTO[];

  @Field(() => Int, { description: '匹配总数' })
  total!: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  page!: number;

  @Field(() => Int, { description: '每页数量' })
  pageSize!: number;
}

/** View → DTO 薄映射 */
export function toRegistrationOrganizationPageDTO(
  page: OrganizationRegistrationOptionPage,
): RegistrationOrganizationPageDTO {
  return {
    items: page.items.map((item) => toRegistrationOrganizationDTO(item)),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
