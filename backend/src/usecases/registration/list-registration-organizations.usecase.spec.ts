// src/usecases/registration/list-registration-organizations.usecase.spec.ts
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { ListRegistrationOrganizationsUsecase } from './list-registration-organizations.usecase';

describe('ListRegistrationOrganizationsUsecase（公开组织选项）', () => {
  it('只透传有效组织选项，不额外读取账号或审核数据', async () => {
    const organizationQueryService = {
      listActiveRegistrationOptions: jest.fn().mockResolvedValue([
        { id: 1, name: '组织A' },
        { id: 2, name: '组织B' },
      ]),
    };
    const usecase = new ListRegistrationOrganizationsUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );

    const result = await usecase.execute();

    expect(result).toEqual([
      { id: 1, name: '组织A' },
      { id: 2, name: '组织B' },
    ]);
    expect(organizationQueryService.listActiveRegistrationOptions).toHaveBeenCalledTimes(1);
  });
});
