// src/usecases/repair-request/search-repair-service-organizations.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { INPUT_NORMALIZE_ERROR, PAGINATION_ERROR, PERMISSION_ERROR } from '@core/common/errors';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { SearchRepairServiceOrganizationsUsecase } from './search-repair-service-organizations.usecase';

/**
 * 报修服务候选检索单测：准入口径（客户 + 可信公司归属）与输入边界。
 * 资格口径（`ACTIVE + is_service_provider`）在查询服务与 E2E 中验证。
 */
describe('SearchRepairServiceOrganizationsUsecase（报修服务公司候选）', () => {
  const page = {
    items: [{ id: 3, name: '维修公司', shortName: '维修' }],
    total: 1,
    page: 1,
    pageSize: 20,
  };

  let session: UsecaseSession;
  let organizationQueryService: { searchServiceProviderOptions: jest.Mock };
  let usecase: SearchRepairServiceOrganizationsUsecase;

  beforeEach(() => {
    session = {
      accountId: 21,
      roles: [IdentityTypeEnum.CUSTOMER],
      activeRole: IdentityTypeEnum.CUSTOMER,
      customerOrganizationId: 8,
    };
    organizationQueryService = {
      searchServiceProviderOptions: jest.fn().mockResolvedValue(page),
    };
    usecase = new SearchRepairServiceOrganizationsUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('有可信公司归属的客户可检索，关键字与分页透传', async () => {
    const result = await usecase.execute({
      session,
      keyword: '  维修  ',
      pagination: { mode: 'OFFSET', page: 2, pageSize: 10 },
    });

    expect(result).toEqual(page);
    expect(organizationQueryService.searchServiceProviderOptions).toHaveBeenCalledWith({
      keyword: '维修',
      pagination: { page: 2, pageSize: 10 },
    });
  });

  it('空白关键字视为未填', async () => {
    await usecase.execute({
      session,
      keyword: '   ',
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    expect(organizationQueryService.searchServiceProviderOptions).toHaveBeenCalledWith({
      keyword: undefined,
      pagination: { page: 1, pageSize: 10 },
    });
  });

  it('页码下限归一，页大小上限截断为 50', async () => {
    await usecase.execute({
      session,
      pagination: { mode: 'OFFSET', page: 0, pageSize: 500 },
    });

    expect(organizationQueryService.searchServiceProviderOptions).toHaveBeenCalledWith({
      keyword: undefined,
      pagination: { page: 1, pageSize: 50 },
    });
  });

  it('缺少客户角色（含管理员）时拒绝且不触达查询服务', async () => {
    await expect(
      usecase.execute({
        session: {
          accountId: 1,
          roles: [IdentityTypeEnum.SUPER_ADMIN],
          activeRole: IdentityTypeEnum.SUPER_ADMIN,
        },
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    await expect(
      usecase.execute({
        session: { accountId: 2, roles: [], activeRole: undefined },
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(organizationQueryService.searchServiceProviderOptions).not.toHaveBeenCalled();
  });

  it('客户缺少可信公司归属时拒绝且不触达查询服务', async () => {
    for (const customerOrganizationId of [null, undefined, 0, -1, 1.5]) {
      await expect(
        usecase.execute({
          session: { ...session, customerOrganizationId },
          pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    }

    expect(organizationQueryService.searchServiceProviderOptions).not.toHaveBeenCalled();
  });

  it('仅接受 OFFSET 分页，CURSOR 在查询前拒绝', async () => {
    await expect(
      usecase.execute({ session, pagination: { mode: 'CURSOR', limit: 20 } }),
    ).rejects.toMatchObject({ code: PAGINATION_ERROR.INVALID_PAGE_SIZE });

    expect(organizationQueryService.searchServiceProviderOptions).not.toHaveBeenCalled();
  });

  it('关键字超过 100 字符或非字符串时拒绝，不静默截断', async () => {
    await expect(
      usecase.execute({
        session,
        keyword: 'a'.repeat(101),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    await expect(
      usecase.execute({
        session,
        keyword: 123 as unknown as string,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    expect(organizationQueryService.searchServiceProviderOptions).not.toHaveBeenCalled();
  });
});
