// src/usecases/organization/list-admin-organizations.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  INPUT_NORMALIZE_ERROR,
  PAGINATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { ListAdminOrganizationsUsecase } from './list-admin-organizations.usecase';

describe('ListAdminOrganizationsUsecase（一级公司档案列表）', () => {
  const page = {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  };

  let organizationQueryService: { searchAdminOrganizations: jest.Mock };
  let usecase: ListAdminOrganizationsUsecase;

  const levelOneSession: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  beforeEach(() => {
    organizationQueryService = {
      searchAdminOrganizations: jest.fn().mockResolvedValue(page),
    };
    usecase = new ListAdminOrganizationsUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('一级管理员可查看，关键字去空白、筛选与分页归一后透传', async () => {
    const result = await usecase.execute({
      session: levelOneSession,
      keyword: '  光刻  ',
      status: 'DISABLED',
      isManagedCompany: true,
      isServiceProvider: false,
      pagination: { mode: 'OFFSET', page: 2, pageSize: 10 },
    });

    expect(result).toEqual(page);
    expect(organizationQueryService.searchAdminOrganizations).toHaveBeenCalledWith({
      keyword: '光刻',
      status: 'DISABLED',
      isManagedCompany: true,
      isServiceProvider: false,
      pagination: { page: 2, pageSize: 10 },
    });
  });

  it('缺省筛选参数归一为不过滤', async () => {
    await usecase.execute({
      session: levelOneSession,
      keyword: '   ',
      status: null,
      isManagedCompany: null,
      isServiceProvider: null,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
    });

    expect(organizationQueryService.searchAdminOrganizations).toHaveBeenCalledWith({
      keyword: undefined,
      status: undefined,
      isManagedCompany: undefined,
      isServiceProvider: undefined,
      pagination: { page: 1, pageSize: 20 },
    });
  });

  it('二级与非管理员、等级缺失/非法、二级缺少可信公司一律拒绝且不触达查询服务', async () => {
    const rejectedSessions: UsecaseSession[] = [
      { accountId: 1, roles: [IdentityTypeEnum.CUSTOMER], activeRole: IdentityTypeEnum.CUSTOMER },
      {
        accountId: 2,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.CUSTOMER,
      },
      { ...levelOneSession, adminLevel: null },
      { ...levelOneSession, adminLevel: 3 },
      { ...levelOneSession, adminLevel: 2, adminOrganizationId: 27 },
      { ...levelOneSession, adminLevel: 2, adminOrganizationId: null },
    ];

    for (const session of rejectedSessions) {
      await expect(
        usecase.execute({ session, pagination: { mode: 'OFFSET', page: 1, pageSize: 10 } }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    }

    expect(organizationQueryService.searchAdminOrganizations).not.toHaveBeenCalled();
  });

  it('页码下限归一，页大小上限截断为 50', async () => {
    await usecase.execute({
      session: levelOneSession,
      pagination: { mode: 'OFFSET', page: 0, pageSize: 500 },
    });

    expect(organizationQueryService.searchAdminOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { page: 1, pageSize: 50 } }),
    );
  });

  it('仅接受 OFFSET 分页，CURSOR 在查询前拒绝', async () => {
    await expect(
      usecase.execute({ session: levelOneSession, pagination: { mode: 'CURSOR', limit: 20 } }),
    ).rejects.toMatchObject({ code: PAGINATION_ERROR.INVALID_PAGE_SIZE });

    expect(organizationQueryService.searchAdminOrganizations).not.toHaveBeenCalled();
  });

  it('非法状态或非布尔筛选值拒绝，不触达查询服务', async () => {
    await expect(
      usecase.execute({
        session: levelOneSession,
        status: 'PENDING',
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });

    await expect(
      usecase.execute({
        session: levelOneSession,
        isServiceProvider: 'yes' as unknown as boolean,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    expect(organizationQueryService.searchAdminOrganizations).not.toHaveBeenCalled();
  });
});
