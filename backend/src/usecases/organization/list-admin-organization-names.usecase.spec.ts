// src/usecases/organization/list-admin-organization-names.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  INPUT_NORMALIZE_ERROR,
  PAGINATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { ListAdminOrganizationNamesUsecase } from './list-admin-organization-names.usecase';

/**
 * 管理员公司名称名单单测：等级/可信公司裁决与输入边界。
 * 名单「只含 ACTIVE、不按受管过滤」的口径在查询服务与 E2E 中验证。
 */
describe('ListAdminOrganizationNamesUsecase（管理员公司名称名单）', () => {
  const page = {
    items: [
      { id: 1, name: '公司A' },
      { id: 2, name: '公司B' },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
  };

  let organizationQueryService: { searchOrganizationNameOptions: jest.Mock };
  let usecase: ListAdminOrganizationNamesUsecase;

  const levelOneSession: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  beforeEach(() => {
    organizationQueryService = {
      searchOrganizationNameOptions: jest.fn().mockResolvedValue(page),
    };
    usecase = new ListAdminOrganizationNamesUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('一级管理员可查看，关键字去空白后透传', async () => {
    const result = await usecase.execute({
      session: levelOneSession,
      keyword: '  公司  ',
      pagination: { mode: 'OFFSET', page: 2, pageSize: 10 },
    });

    expect(result).toEqual(page);
    expect(organizationQueryService.searchOrganizationNameOptions).toHaveBeenCalledWith({
      keyword: '公司',
      pagination: { page: 2, pageSize: 10 },
    });
  });

  it('二级管理员带可信公司时可跨公司查看', async () => {
    await usecase.execute({
      session: {
        accountId: 31,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.SUPER_ADMIN,
        adminLevel: 2,
        adminOrganizationId: 27,
      },
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    expect(organizationQueryService.searchOrganizationNameOptions).toHaveBeenCalledWith({
      keyword: undefined,
      pagination: { page: 1, pageSize: 10 },
    });
  });

  it('非管理员、等级缺失/非法、二级缺少可信公司时拒绝且不触达查询服务', async () => {
    const rejectedSessions: UsecaseSession[] = [
      { accountId: 1, roles: [IdentityTypeEnum.CUSTOMER], activeRole: IdentityTypeEnum.CUSTOMER },
      {
        accountId: 2,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.CUSTOMER,
      },
      { ...levelOneSession, adminLevel: null },
      { ...levelOneSession, adminLevel: 3 },
      { ...levelOneSession, adminLevel: 2, adminOrganizationId: null },
      { ...levelOneSession, adminLevel: 2, adminOrganizationId: 0 },
    ];

    for (const session of rejectedSessions) {
      await expect(
        usecase.execute({ session, pagination: { mode: 'OFFSET', page: 1, pageSize: 10 } }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    }

    expect(organizationQueryService.searchOrganizationNameOptions).not.toHaveBeenCalled();
  });

  it('页码下限归一，页大小上限截断为 50', async () => {
    await usecase.execute({
      session: levelOneSession,
      pagination: { mode: 'OFFSET', page: 0, pageSize: 500 },
    });

    expect(organizationQueryService.searchOrganizationNameOptions).toHaveBeenCalledWith({
      keyword: undefined,
      pagination: { page: 1, pageSize: 50 },
    });
  });

  it('仅接受 OFFSET 分页，CURSOR 在查询前拒绝', async () => {
    await expect(
      usecase.execute({ session: levelOneSession, pagination: { mode: 'CURSOR', limit: 20 } }),
    ).rejects.toMatchObject({ code: PAGINATION_ERROR.INVALID_PAGE_SIZE });

    expect(organizationQueryService.searchOrganizationNameOptions).not.toHaveBeenCalled();
  });

  it('关键字超过 100 字符或非字符串时拒绝，不静默截断', async () => {
    await expect(
      usecase.execute({
        session: levelOneSession,
        keyword: 'a'.repeat(101),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    await expect(
      usecase.execute({
        session: levelOneSession,
        keyword: 123 as unknown as string,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    expect(organizationQueryService.searchOrganizationNameOptions).not.toHaveBeenCalled();
  });
});
