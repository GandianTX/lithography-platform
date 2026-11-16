// src/usecases/organization/check-admin-organization-name.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { INPUT_NORMALIZE_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { CheckAdminOrganizationNameUsecase } from './check-admin-organization-name.usecase';

describe('CheckAdminOrganizationNameUsecase（一级公司同名提示）', () => {
  let organizationQueryService: { existsAnyOrganizationByName: jest.Mock };
  let usecase: CheckAdminOrganizationNameUsecase;

  const levelOneSession: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  beforeEach(() => {
    organizationQueryService = {
      existsAnyOrganizationByName: jest.fn().mockResolvedValue(true),
    };
    usecase = new CheckAdminOrganizationNameUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('一级管理员：名称按共享口径归一后查询全部档案，新增不排除任何主键', async () => {
    await expect(
      usecase.execute({ session: levelOneSession, name: '  同名   公司 ' }),
    ).resolves.toBe(true);

    expect(organizationQueryService.existsAnyOrganizationByName).toHaveBeenCalledWith({
      normalizedName: '同名 公司',
      excludeOrganizationId: null,
    });
  });

  it('编辑按实际主键排除自身，空值视为不排除', async () => {
    await usecase.execute({ session: levelOneSession, name: '同名公司', excludeOrganizationId: 12 });
    await usecase.execute({ session: levelOneSession, name: '同名公司', excludeOrganizationId: null });

    expect(organizationQueryService.existsAnyOrganizationByName).toHaveBeenNthCalledWith(1, {
      normalizedName: '同名公司',
      excludeOrganizationId: 12,
    });
    expect(organizationQueryService.existsAnyOrganizationByName).toHaveBeenNthCalledWith(2, {
      normalizedName: '同名公司',
      excludeOrganizationId: null,
    });
  });

  it('非法排除主键拒绝，且不发起查询', async () => {
    await expect(
      usecase.execute({ session: levelOneSession, name: '同名公司', excludeOrganizationId: 0 }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    expect(organizationQueryService.existsAnyOrganizationByName).not.toHaveBeenCalled();
  });

  it('空白名称与超长名称直接未命中，不发起查询', async () => {
    await expect(usecase.execute({ session: levelOneSession, name: '   ' })).resolves.toBe(false);
    await expect(
      usecase.execute({ session: levelOneSession, name: 'a'.repeat(201) }),
    ).resolves.toBe(false);

    expect(organizationQueryService.existsAnyOrganizationByName).not.toHaveBeenCalled();
  });

  it('非字符串名称拒绝', async () => {
    await expect(
      usecase.execute({ session: levelOneSession, name: 123 }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });
  });

  it('二级管理员与普通客户拒绝，且不发起查询', async () => {
    const rejectedSessions: UsecaseSession[] = [
      { accountId: 1, roles: [IdentityTypeEnum.CUSTOMER], activeRole: IdentityTypeEnum.CUSTOMER },
      {
        accountId: 31,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.SUPER_ADMIN,
        adminLevel: 2,
        adminOrganizationId: 27,
      },
    ];

    for (const session of rejectedSessions) {
      await expect(usecase.execute({ session, name: '同名公司' })).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });
    }

    expect(organizationQueryService.existsAnyOrganizationByName).not.toHaveBeenCalled();
  });
});
