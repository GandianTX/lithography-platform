// src/usecases/registration/check-registration-organization-name.usecase.spec.ts
import { INPUT_NORMALIZE_ERROR } from '@core/common/errors';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { CheckRegistrationOrganizationNameUsecase } from './check-registration-organization-name.usecase';

describe('CheckRegistrationOrganizationNameUsecase（手填公司名精确同名提示）', () => {
  let organizationQueryService: { existsEligibleRegistrationOptionByName: jest.Mock };
  let usecase: CheckRegistrationOrganizationNameUsecase;

  beforeEach(() => {
    organizationQueryService = {
      existsEligibleRegistrationOptionByName: jest.fn().mockResolvedValue(true),
    };
    usecase = new CheckRegistrationOrganizationNameUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('去首尾空白、合并连续空白并统一小写后精确查询', async () => {
    await expect(usecase.execute({ name: '  Litho   Tech  ' })).resolves.toBe(true);

    expect(organizationQueryService.existsEligibleRegistrationOptionByName).toHaveBeenCalledWith({
      normalizedName: 'litho tech',
    });
  });

  it('空白名称直接返回未命中且不查询', async () => {
    await expect(usecase.execute({ name: '   ' })).resolves.toBe(false);

    expect(organizationQueryService.existsEligibleRegistrationOptionByName).not.toHaveBeenCalled();
  });

  it('200 字名称仍在注册边界内并照常查询', async () => {
    await expect(usecase.execute({ name: 'a'.repeat(200) })).resolves.toBe(true);

    expect(organizationQueryService.existsEligibleRegistrationOptionByName).toHaveBeenCalledWith({
      normalizedName: 'a'.repeat(200),
    });
  });

  it('超过注册列上限的名称直接返回未命中且不查询', async () => {
    await expect(usecase.execute({ name: 'a'.repeat(201) })).resolves.toBe(false);

    expect(organizationQueryService.existsEligibleRegistrationOptionByName).not.toHaveBeenCalled();
  });

  it('非字符串名称按输入问题拒绝，不查询', async () => {
    await expect(usecase.execute({ name: 123 })).rejects.toMatchObject({
      code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
    });

    expect(organizationQueryService.existsEligibleRegistrationOptionByName).not.toHaveBeenCalled();
  });
});
