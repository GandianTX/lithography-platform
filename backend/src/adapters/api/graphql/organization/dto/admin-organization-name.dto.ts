// src/adapters/api/graphql/organization/dto/admin-organization-name.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import type {
  OrganizationNameOption,
  OrganizationNameOptionPage,
} from '@src/modules/lithography/organization.types';

/**
 * 管理员公司名称名单条目（R015 最小字段视图）。
 *
 * 只有主键与全称；联系方式、成员、业务详情、受管与维修资格均不在此暴露。
 */
@ObjectType({ description: '管理员公司名称名单条目（最小字段）' })
export class AdminOrganizationNameDTO {
  @Field(() => Int, { description: '公司主键' })
  id!: number;

  @Field(() => String, { description: '公司全称' })
  name!: string;
}

/** 管理员公司名称名单分页结果 */
@ObjectType({ description: '管理员公司名称名单分页结果（按名称、主键升序）' })
export class AdminOrganizationNamePageDTO {
  @Field(() => [AdminOrganizationNameDTO], { description: '当前页公司' })
  items!: AdminOrganizationNameDTO[];

  @Field(() => Int, { description: '符合条件的总数' })
  total!: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  page!: number;

  @Field(() => Int, { description: '页大小' })
  pageSize!: number;
}

/** View → DTO 薄映射（字段直通，不做业务判断） */
export function toAdminOrganizationNameDTO(view: OrganizationNameOption): AdminOrganizationNameDTO {
  return { id: view.id, name: view.name };
}

export function toAdminOrganizationNamePageDTO(
  page: OrganizationNameOptionPage,
): AdminOrganizationNamePageDTO {
  return {
    items: page.items.map((item) => toAdminOrganizationNameDTO(item)),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
