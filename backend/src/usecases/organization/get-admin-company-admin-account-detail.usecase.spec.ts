// src/usecases/organization/get-admin-company-admin-account-detail.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { ORGANIZATION_MANAGEMENT_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import { GetAdminCompanyAdminAccountDetailUsecase } from './get-admin-company-admin-account-detail.usecase';

describe('GetAdminCompanyAdminAccountDetailUsecase（一级按需账号详情）', () => {
  const organization: AdminOrganizationView = {
    id: 7,
    organizationCode: 'ADMIN_ORG_0007',
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
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  const levelOneSession: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  const boundCandidate = {
    accountId: 9001,
    loginName: 'admin_org_0007',
    nickname: '公司管理员',
    adminLevel: 2,
    accountStatus: AccountStatus.ACTIVE,
    userState: 'ACTIVE',
    roleConverged: true,
    role: IdentityTypeEnum.SUPER_ADMIN,
    customerOrganizationId: null,
  };

  let organizationQueryService: { findAdminOrganizationView: jest.Mock };
  let membershipQueryService: { listMembershipsByOrganization: jest.Mock };
  let adminUserQueryService: {
    findAdminBindingCandidateFacts: jest.Mock;
    findAccountOpeningStatus: jest.Mock;
  };
  let usecase: GetAdminCompanyAdminAccountDetailUsecase;

  beforeEach(() => {
    organizationQueryService = {
      findAdminOrganizationView: jest.fn().mockResolvedValue(organization),
    };
    membershipQueryService = {
      listMembershipsByOrganization: jest
        .fn()
        .mockResolvedValue([{ accountId: 9001, memberRole: 'SUPER_ADMIN', status: 'ACTIVE' }]),
    };
    adminUserQueryService = {
      findAdminBindingCandidateFacts: jest
        .fn()
        .mockResolvedValue(new Map([[9001, boundCandidate]])),
      findAccountOpeningStatus: jest.fn().mockResolvedValue({
        accountStatus: AccountStatus.ACTIVE,
        mustChangePassword: true,
      }),
    };

    usecase = new GetAdminCompanyAdminAccountDetailUsecase(
      organizationQueryService as unknown as OrganizationQueryService,
      membershipQueryService as unknown as OrganizationMembershipQueryService,
      adminUserQueryService as unknown as AdminUserQueryService,
    );
  });

  it('唯一合法绑定时返回完整登录名、昵称与待首次改密状态', async () => {
    await expect(usecase.execute({ session: levelOneSession, organizationId: 7 })).resolves.toEqual(
      {
        organizationId: 7,
        organizationCode: 'ADMIN_ORG_0007',
        companyName: '光刻设备（上海）有限公司',
        isManagedCompany: true,
        companyStatus: 'ACTIVE',
        status: 'BOUND',
        reason: null,
        accountId: 9001,
        loginName: 'admin_org_0007',
        nickname: '公司管理员',
        mustChangePassword: true,
        accountDisabled: false,
        candidateCount: 1,
      },
    );
    expect(adminUserQueryService.findAccountOpeningStatus).toHaveBeenCalledWith({
      accountId: 9001,
    });
  });

  it('已首次改密时仍返回详情，但开通状态为 false', async () => {
    adminUserQueryService.findAccountOpeningStatus.mockResolvedValue({
      accountStatus: AccountStatus.ACTIVE,
      mustChangePassword: false,
    });

    const view = await usecase.execute({ session: levelOneSession, organizationId: 7 });

    expect(view.loginName).toBe('admin_org_0007');
    expect(view.mustChangePassword).toBe(false);
  });

  it('多个候选时不返回任何具体账号，只给冲突状态与候选数量', async () => {
    membershipQueryService.listMembershipsByOrganization.mockResolvedValue([
      { accountId: 9001, memberRole: 'SUPER_ADMIN', status: 'ACTIVE' },
      { accountId: 9002, memberRole: 'SUPER_ADMIN', status: 'ACTIVE' },
    ]);
    adminUserQueryService.findAdminBindingCandidateFacts.mockResolvedValue(
      new Map([
        [9001, boundCandidate],
        [
          9002,
          {
            ...boundCandidate,
            accountId: 9002,
            loginName: 'admin_org_0007_b',
            nickname: '管理员B',
          },
        ],
      ]),
    );

    await expect(usecase.execute({ session: levelOneSession, organizationId: 7 })).resolves.toEqual(
      {
        organizationId: 7,
        organizationCode: 'ADMIN_ORG_0007',
        companyName: '光刻设备（上海）有限公司',
        isManagedCompany: true,
        companyStatus: 'ACTIVE',
        status: 'CONFLICT',
        reason: 'MULTIPLE_BINDINGS',
        accountId: null,
        loginName: null,
        nickname: null,
        mustChangePassword: null,
        accountDisabled: false,
        candidateCount: 2,
      },
    );
    expect(adminUserQueryService.findAccountOpeningStatus).not.toHaveBeenCalled();
  });

  it('公司停用时不返回账号身份与开通状态', async () => {
    organizationQueryService.findAdminOrganizationView.mockResolvedValue({
      ...organization,
      status: 'DISABLED',
    });

    const view = await usecase.execute({ session: levelOneSession, organizationId: 7 });

    expect(view.status).toBe('COMPANY_DISABLED');
    expect(view.accountId).toBeNull();
    expect(view.loginName).toBeNull();
    expect(view.mustChangePassword).toBeNull();
    expect(adminUserQueryService.findAccountOpeningStatus).not.toHaveBeenCalled();
  });

  it('非受管公司返回 UNCONFIGURED 安全态，不读取成员与候选', async () => {
    organizationQueryService.findAdminOrganizationView.mockResolvedValue({
      ...organization,
      isManagedCompany: false,
    });

    const view = await usecase.execute({ session: levelOneSession, organizationId: 7 });

    expect(view).toMatchObject({
      status: 'UNCONFIGURED',
      isManagedCompany: false,
      accountId: null,
      loginName: null,
      mustChangePassword: null,
    });
    expect(membershipQueryService.listMembershipsByOrganization).not.toHaveBeenCalled();
    expect(adminUserQueryService.findAdminBindingCandidateFacts).not.toHaveBeenCalled();
  });

  it('账号行缺失时开通状态按 null 返回，不伪造已改密或待改密', async () => {
    adminUserQueryService.findAccountOpeningStatus.mockResolvedValue(null);

    const view = await usecase.execute({ session: levelOneSession, organizationId: 7 });

    expect(view.loginName).toBe('admin_org_0007');
    expect(view.mustChangePassword).toBeNull();
  });

  it('目标公司不存在时返回 TARGET_NOT_FOUND', async () => {
    organizationQueryService.findAdminOrganizationView.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: 404 }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.TARGET_NOT_FOUND });
  });

  it('二级管理员拒绝且不发起任何读取', async () => {
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
});
