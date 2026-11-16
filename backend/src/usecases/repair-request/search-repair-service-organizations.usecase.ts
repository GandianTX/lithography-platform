// src/usecases/repair-request/search-repair-service-organizations.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PAGINATION_ERROR, PERMISSION_ERROR } from '@core/common/errors';
import type { PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { OrganizationServiceProviderOptionPage } from '@src/modules/lithography/organization.types';
import { normalizeServiceOrganizationKeyword } from './repair-service-organization.search.input.normalize';

/** 单页上限：与查询服务一致，避免被用作批量导出 */
const SERVICE_ORGANIZATION_PAGE_SIZE_MAX = 50;

export type SearchRepairServiceOrganizationsCommand = {
  readonly session: UsecaseSession;
  readonly keyword?: string | null;
  readonly pagination: PaginationParams;
};

/**
 * 报修服务公司候选检索（任务 08 交付、任务 03 提交报修时再次复核）。
 *
 * 准入口径（负责人 2026-11-15 答复）：
 * 1. 仅客户身份可查询——角色集合必须含 `CUSTOMER`，且当前活动角色精确为 `CUSTOMER`；
 *    合法历史多角色（例如 `activeRole = SUPER_ADMIN` 且角色集合保留 `CUSTOMER`）在
 *    守卫层按集合放行，本入口按当前身份精确拒绝，拒绝先于任何公司查询；
 * 2. 客户必须已补齐可信公司归属（`base_user_info.customer_organization_id`，
 *    由请求期会话复核给出），缺归属一律拒绝，不按自报公司名猜测；
 * 3. 公司资格固定为「启用且具备维修服务资格」，与注册候选的
 *    `ACTIVE + is_managed_company` 口径相互独立，维修资格不参与注册判断。
 *
 * 只返回选择所需的 `id` / `name` / `shortName`；所选公司仍由 03 在提交事务内复核。
 */
@Injectable()
export class SearchRepairServiceOrganizationsUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(
    command: SearchRepairServiceOrganizationsCommand,
  ): Promise<OrganizationServiceProviderOptionPage> {
    this.assertRepairCustomerAccess(command.session);

    const { page, pageSize } = resolvePagination(command.pagination);
    return this.organizationQueryService.searchServiceProviderOptions({
      keyword: normalizeServiceOrganizationKeyword(command.keyword),
      pagination: { page, pageSize },
    });
  }

  /**
   * 报修候选准入：客户角色 + 当前活动角色为客户 + 已补齐可信公司归属，
   * 任一不满足即 `FORBIDDEN`，且全部先于公司查询。
   *
   * 不返回具体缺失项给客户端，避免暴露账号归属状态。
   */
  private assertRepairCustomerAccess(session: UsecaseSession): void {
    const isCustomer = session.roles.includes(IdentityTypeEnum.CUSTOMER);
    if (!isCustomer) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '仅客户账号可以查询维修服务公司',
      );
    }

    // 角色集合含 CUSTOMER 不等于当前以客户身份使用：活动管理员（或活动角色缺失）
    // 不得借历史客户角色读取候选。此处按精确活动角色失败关闭。
    if (session.activeRole !== IdentityTypeEnum.CUSTOMER) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '仅以客户身份使用时可查询维修服务公司',
      );
    }

    const organizationId = session.customerOrganizationId;
    if (
      typeof organizationId !== 'number' ||
      !Number.isInteger(organizationId) ||
      organizationId <= 0
    ) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '仅已关联公司归属的客户可以查询维修服务公司',
      );
    }
  }
}

/** 仅支持 OFFSET 分页；页码/页大小下限归一，页大小按上限截断 */
function resolvePagination(pagination: PaginationParams): { page: number; pageSize: number } {
  if (pagination.mode !== 'OFFSET') {
    throw new DomainError(PAGINATION_ERROR.INVALID_PAGE_SIZE, '维修服务公司检索仅支持 OFFSET 分页');
  }
  return {
    page: Math.max(pagination.page, 1),
    pageSize: Math.min(Math.max(pagination.pageSize, 1), SERVICE_ORGANIZATION_PAGE_SIZE_MAX),
  };
}
