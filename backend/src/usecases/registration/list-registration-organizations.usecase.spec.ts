// src/usecases/registration/list-registration-organizations.usecase.spec.ts
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { ListRegistrationOrganizationsUsecase } from './list-registration-organizations.usecase';

describe('ListRegistrationOrganizationsUsecase（兼容入口：全部 ACTIVE 组织数组）', () => {
  let organizationQueryService: { listActiveRegistrationOptions: jest.Mock };
  let usecase: ListRegistrationOrganizationsUsecase;

  beforeEach(() => {
    organizationQueryService = {
      listActiveRegistrationOptions: jest.fn().mockResolvedValue([{ id: 1, name: '公司A' }]),
    };
    usecase = new ListRegistrationOrganizationsUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('无参调用并原样返回 ACTIVE 组织数组（保持主线既有响应形状）', async () => {
    const result = await usecase.execute();

    expect(result).toEqual([{ id: 1, name: '公司A' }]);
    expect(organizationQueryService.listActiveRegistrationOptions).toHaveBeenCalledWith();
  });

  it('查询服务失败时原样上抛', async () => {
    const failure = new Error('db unavailable');
    organizationQueryService.listActiveRegistrationOptions.mockRejectedValue(failure);

    await expect(usecase.execute()).rejects.toBe(failure);
  });
});
