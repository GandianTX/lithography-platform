// src/usecases/registration/list-admin-engineer-registrations.usecase.ts

import {
  ADMIN_USER_ERROR,
  DomainError,
  ENGINEER_REGISTRATION_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import {
  applyDefaults,
  enforceMaxPageSize,
  isOffsetMode,
} from '@core/pagination/pagination.policy';
import { Injectable } from '@nestjs/common';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  AdminEngineerRegistrationItem,
  AdminEngineerRegistrationQueuePage,
  ListAdminEngineerRegistrationsCommand,
} from './admin-engineer-registration.types';
import { normalizeEngineerRegistrationStatusFilter } from './registration-input.normalize';
import { assertEngineerRegistrationReviewPermission } from './engineer-registration-review-permission';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐 */
const MAX_PAGE_SIZE = 100;
/** 审核队列默认页大小 */
const DEFAULT_PAGE_SIZE = 10;

/**
 * 管理员查看工程师注册申请队列。
 *
 * 执行顺序：
 * 1. 管理员作用域断言（请求期 `admin_level` + 可信公司），先于任何输入规范化和读取；
 * 2. 分页收敛（仅 OFFSET，页大小按上限钳制）与状态筛选白名单；
 * 3. **先限域再筛选/分页**：二级传入可信公司，一级不传公司（全范围）；
 *    用户输入不参与组织范围判定；
 * 4. 逐条补充申请人公开视图（`AdminUserView`，不含凭据）；
 * 5. 按页内公司 ID 去重后一次批量读取公司展示名，避免逐行查询。
 *
 * 只读：不开启事务、不写库、不加锁。申请人视图读取失败时整页失败关闭，
 * 不返回部分列表、不静默跳过异常账号。
 */
@Injectable()
export class ListAdminEngineerRegistrationsUsecase {
  constructor(
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationContext: TrustedOrganizationContextQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  async execute(
    command: ListAdminEngineerRegistrationsCommand,
  ): Promise<AdminEngineerRegistrationQueuePage> {
    const scope = await assertEngineerRegistrationReviewPermission({
      session: command.session,
      actionLabel: '查看',
      organizationContext: this.organizationContext,
    });

    const { page, pageSize } = this.resolveOffsetPagination(command.pagination);
    const status = normalizeEngineerRegistrationStatusFilter(command.status);

    try {
      const rawPage = await this.engineerRegistrationQueryService.listForAdminQueue({
        ...(scope.level === 2 ? { organizationId: scope.organizationId } : {}),
        status,
        pagination: { page, pageSize },
      });

      const organizationNames = await this.organizationQueryService.findOrganizationNamesByIds(
        rawPage.items.map((application) => application.organizationId),
      );

      const items: AdminEngineerRegistrationItem[] = [];
      for (const application of rawPage.items) {
        const applicant = await this.adminUserQueryService.findAdminUserViewById({
          accountId: application.accountId,
        });
        if (applicant === null) {
          throw new DomainError(
            ADMIN_USER_ERROR.READ_FAILED,
            '申请人账号资料读取失败，请稍后重试',
            undefined,
            { diagnostic: 'APPLICANT_VIEW_NOT_READABLE', accountId: application.accountId },
          );
        }
        items.push({
          application,
          applicant,
          organizationName: organizationNames.get(application.organizationId) ?? null,
        });
      }

      return { items, total: rawPage.total, page: rawPage.page, pageSize: rawPage.pageSize };
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.READ_FAILED,
        '注册申请队列读取失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  private resolveOffsetPagination(
    pagination: ListAdminEngineerRegistrationsCommand['pagination'],
  ): {
    page: number;
    pageSize: number;
  } {
    if (pagination.mode !== 'OFFSET') {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
        '工程师注册申请队列仅支持 OFFSET 分页',
      );
    }
    const resolved = enforceMaxPageSize(
      applyDefaults(pagination, { pageSize: DEFAULT_PAGE_SIZE }),
      MAX_PAGE_SIZE,
    );
    if (!isOffsetMode(resolved)) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
        '工程师注册申请队列仅支持 OFFSET 分页',
      );
    }
    return { page: resolved.page, pageSize: resolved.pageSize };
  }
}
