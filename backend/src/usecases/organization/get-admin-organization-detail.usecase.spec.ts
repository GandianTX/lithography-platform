// src/usecases/organization/get-admin-organization-detail.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_MANAGEMENT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import { GetAdminOrganizationDetailUsecase } from './get-admin-organization-detail.usecase';

describe('GetAdminOrganizationDetailUsecase（一级公司档案详情）', () => {
  const view: AdminOrganizationView = {
    id: 7,
    organizationCode: 'ADMIN_ORG_0000',
    name: '光刻设备（上海）有限公司',
    shortName: '光刻设备',
    contactName: '张三',
    contactPhone: '021-12345678',
    contactEmail: 'ops@example.com',
    address: '上海市',
    remark: null,
    isServiceProvider: true,
    isManagedCompany: true,
    kind: 'CLIENT',
    status: 'DISABLED',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  let organizationQueryService: { findAdminOrganizationView: jest.Mock };
  let usecase: GetAdminOrganizationDetailUsecase;

  const levelOneSession: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  beforeEach(() => {
    organizationQueryService = {
      findAdminOrganizationView: jest.fn().mockResolvedValue(view),
    };
    usecase = new GetAdminOrganizationDetailUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('一级管理员可读取停用公司的完整详情', async () => {
    await expect(usecase.execute({ session: levelOneSession, organizationId: 7 })).resolves.toEqual(
      view,
    );
    expect(organizationQueryService.findAdminOrganizationView).toHaveBeenCalledWith({
      organizationId: 7,
    });
  });

  it('目标不存在时返回 TARGET_NOT_FOUND', async () => {
    organizationQueryService.findAdminOrganizationView.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: 404 }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.TARGET_NOT_FOUND });
  });

  it('二级管理员即使目标是自己公司也拒绝', async () => {
    await expect(
      usecase.execute({
        session: {
          accountId: 31,
          roles: [IdentityTypeEnum.SUPER_ADMIN],
          activeRole: IdentityTypeEnum.SUPER_ADMIN,
          adminLevel: 2,
          adminOrganizationId: 7,
        },
        organizationId: 7,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(organizationQueryService.findAdminOrganizationView).not.toHaveBeenCalled();
  });

  it('公司 ID 非正整数时在查询前拒绝', async () => {
    await expect(
      usecase.execute({ session: levelOneSession, organizationId: Number.NaN }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

    expect(organizationQueryService.findAdminOrganizationView).not.toHaveBeenCalled();
  });
});
