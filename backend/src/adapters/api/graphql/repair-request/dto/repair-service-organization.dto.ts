// src/adapters/api/graphql/repair-request/dto/repair-service-organization.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import type {
  OrganizationServiceProviderOption,
  OrganizationServiceProviderOptionPage,
} from '@src/modules/lithography/organization.types';

/**
 * 报修服务公司候选（客户提交报修时选择维修服务方的最小信息）。
 *
 * 只暴露选择所需的 `id` / `name` / `shortName`；不返回组织编码、联系信息、
 * 受管归类或任何内部资料。提交报修时由 03 在写入事务内复核。
 */
@ObjectType({ description: '报修服务公司候选（启用且具备维修服务资格）' })
export class RepairServiceOrganizationDTO {
  @Field(() => Int, { description: '公司主键' })
  id!: number;

  @Field(() => String, { description: '公司全称' })
  name!: string;

  @Field(() => String, { nullable: true, description: '公司简称' })
  shortName!: string | null;
}

/** 报修服务公司候选分页结果 */
@ObjectType({ description: '报修服务公司候选分页结果（按名称、主键升序）' })
export class RepairServiceOrganizationPageDTO {
  @Field(() => [RepairServiceOrganizationDTO], { description: '当前页候选' })
  items!: RepairServiceOrganizationDTO[];

  @Field(() => Int, { description: '符合条件的总数' })
  total!: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  page!: number;

  @Field(() => Int, { description: '页大小' })
  pageSize!: number;
}

/** View → DTO 薄映射（字段直通，不做业务判断） */
export function toRepairServiceOrganizationDTO(
  view: OrganizationServiceProviderOption,
): RepairServiceOrganizationDTO {
  return { id: view.id, name: view.name, shortName: view.shortName };
}

export function toRepairServiceOrganizationPageDTO(
  page: OrganizationServiceProviderOptionPage,
): RepairServiceOrganizationPageDTO {
  return {
    items: page.items.map((item) => toRepairServiceOrganizationDTO(item)),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
