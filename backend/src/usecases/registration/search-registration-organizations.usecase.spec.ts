// src/usecases/registration/search-registration-organizations.usecase.spec.ts
import { PAGINATION_ERROR } from '@core/common/errors';
import { INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { SearchRegistrationOrganizationsUsecase } from './search-registration-organizations.usecase';

describe('SearchRegistrationOrganizationsUsecase（Web 公开公司候选检索）', () => {
  const page = {
    items: [
      { id: 1, name: '公司A' },
      { id: 2, name: '公司B' },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
  };

  let organizationQueryService: { searchEligibleRegistrationOptions: jest.Mock };
  let usecase: SearchRegistrationOrganizationsUsecase;

  beforeEach(() => {
    organizationQueryService = {
      searchEligibleRegistrationOptions: jest.fn().mockResolvedValue(page),
    };
    usecase = new SearchRegistrationOrganizationsUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('透传 OFFSET 分页并返回查询服务结果', async () => {
    const result = await usecase.execute({
      pagination: { mode: 'OFFSET', page: 2, pageSize: 10 },
    });

    expect(result).toEqual(page);
    expect(organizationQueryService.searchEligibleRegistrationOptions).toHaveBeenCalledWith({
      keyword: undefined,
      pagination: { page: 2, pageSize: 10 },
    });
  });

  it('关键字去首尾空白；空白视为未填', async () => {
    await usecase.execute({
      keyword: '  光刻  ',
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });
    expect(organizationQueryService.searchEligibleRegistrationOptions).toHaveBeenLastCalledWith({
      keyword: '光刻',
      pagination: { page: 1, pageSize: 10 },
    });

    await usecase.execute({
      keyword: '   ',
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });
    expect(organizationQueryService.searchEligibleRegistrationOptions).toHaveBeenLastCalledWith({
      keyword: undefined,
      pagination: { page: 1, pageSize: 10 },
    });
  });

  it('页码下限归一，页大小上限截断为 50', async () => {
    await usecase.execute({
      pagination: { mode: 'OFFSET', page: 0, pageSize: 500 },
    });

    expect(organizationQueryService.searchEligibleRegistrationOptions).toHaveBeenCalledWith({
      keyword: undefined,
      pagination: { page: 1, pageSize: 50 },
    });
  });

  it('仅接受 OFFSET 分页，CURSOR 在查询前拒绝', async () => {
    await expect(
      usecase.execute({ pagination: { mode: 'CURSOR', limit: 20 } }),
    ).rejects.toMatchObject({ code: PAGINATION_ERROR.INVALID_PAGE_SIZE });

    expect(organizationQueryService.searchEligibleRegistrationOptions).not.toHaveBeenCalled();
  });

  it('关键字超过 100 字符时拒绝，不静默截断', async () => {
    await expect(
      usecase.execute({
        keyword: 'a'.repeat(101),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    expect(organizationQueryService.searchEligibleRegistrationOptions).not.toHaveBeenCalled();
  });

  it('关键字非字符串时拒绝', async () => {
    await expect(
      usecase.execute({
        keyword: 123 as unknown as string,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    expect(organizationQueryService.searchEligibleRegistrationOptions).not.toHaveBeenCalled();
  });
});
