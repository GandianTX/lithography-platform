// src/usecases/registration/get-admin-engineer-registration-detail.usecase.spec.ts
import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import {
  ADMIN_USER_ERROR,
  ENGINEER_REGISTRATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AdminUserView } from '@src/modules/account/account.types';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetAdminEngineerRegistrationDetailUsecase } from './get-admin-engineer-registration-detail.usecase';

describe('GetAdminEngineerRegistrationDetailUsecase（管理员申请详情）', () => {
  const ADMIN_ACCOUNT_ID = 1;
  const APPLICANT_ACCOUNT_ID = 11;
  const ORGANIZATION_ID = 5;
  const PEER_ORGANIZATION_ID = 6;
  const APPLICATION_ID = 61;
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

  let session: UsecaseSession;
  let engineerRegistrationQueryService: { findById: jest.Mock };
  let adminUserQueryService: { findAdminUserViewById: jest.Mock };
  let organizationContext: { resolveForAccount: jest.Mock };
  let organizationQueryService: { findOrganizationNameById: jest.Mock };
  let usecase: GetAdminEngineerRegistrationDetailUsecase;

  const snapshot = (organizationId: number): EngineerRegistrationApplicationSnapshot => ({
    id: APPLICATION_ID,
    accountId: APPLICANT_ACCOUNT_ID,
    organizationId,
    status: EngineerRegistrationApplicationStatus.PENDING,
    applicationNote: '希望加入组织',
    submittedAt: CREATED_AT,
    reviewedByAccountId: null,
    reviewedAt: null,
    reviewComment: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const applicantView = (): AdminUserView => ({
    id: APPLICANT_ACCOUNT_ID,
    loginName: 'pending-engineer',
    loginEmail: 'pending@example.com',
    nickname: '待审工程师',
    companyName: null,
    phone: '13800000001',
    contactEmail: null,
    role: IdentityTypeEnum.ENGINEER,
    status: AccountStatus.PENDING,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const levelOneSession = (): UsecaseSession => ({
    accountId: ADMIN_ACCOUNT_ID,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: ORGANIZATION_ID,
  });

  beforeEach(() => {
    session = levelOneSession();
    engineerRegistrationQueryService = {
      findById: jest.fn().mockResolvedValue(snapshot(ORGANIZATION_ID)),
    };
    adminUserQueryService = {
      findAdminUserViewById: jest.fn().mockResolvedValue(applicantView()),
    };
    organizationContext = {
      resolveForAccount: jest.fn().mockResolvedValue({
        membershipId: 9,
        organizationId: ORGANIZATION_ID,
        organizationCode: 'CLIENT_DEFAULT',
        organizationName: '测试组织',
        organizationKind: 'CLIENT',
        memberRole: IdentityTypeEnum.SUPER_ADMIN,
      }),
    };
    organizationQueryService = {
      findOrganizationNameById: jest.fn().mockResolvedValue('测试组织'),
    };
    usecase = new GetAdminEngineerRegistrationDetailUsecase(
      engineerRegistrationQueryService as unknown as EngineerRegistrationQueryService,
      adminUserQueryService as unknown as AdminUserQueryService,
      organizationContext as unknown as TrustedOrganizationContextQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('等级缺失时失败关闭，且不读取申请', async () => {
    session = { ...levelOneSession(), adminLevel: null };

    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS },
    );
    expect(engineerRegistrationQueryService.findById).not.toHaveBeenCalled();
  });

  it('二级管理员可信成员事实不符时失败关闭', async () => {
    session = {
      ...levelOneSession(),
      adminLevel: 2,
    };
    organizationContext.resolveForAccount.mockResolvedValue({
      membershipId: 9,
      organizationId: ORGANIZATION_ID,
      organizationCode: 'CLIENT_DEFAULT',
      organizationName: '测试组织',
      organizationKind: 'CLIENT',
      memberRole: IdentityTypeEnum.ENGINEER,
    });

    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS },
    );
    expect(engineerRegistrationQueryService.findById).not.toHaveBeenCalled();
  });

  it('二级管理员跨公司申请与不存在申请统一按 NOT_FOUND 处理', async () => {
    session = {
      ...levelOneSession(),
      adminLevel: 2,
    };

    engineerRegistrationQueryService.findById.mockResolvedValue(snapshot(PEER_ORGANIZATION_ID));
    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND },
    );

    engineerRegistrationQueryService.findById.mockResolvedValue(null);
    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND },
    );
  });

  it('一级管理员可读取任意公司申请', async () => {
    engineerRegistrationQueryService.findById.mockResolvedValue(snapshot(PEER_ORGANIZATION_ID));

    const result = await usecase.execute({ session, applicationId: APPLICATION_ID });

    expect(result.application.organizationId).toBe(PEER_ORGANIZATION_ID);
  });

  it('返回申请、申请人公开资料（AdminUserView）与目标公司名', async () => {
    const result = await usecase.execute({ session, applicationId: APPLICATION_ID });

    expect(result.application.id).toBe(APPLICATION_ID);
    expect(result.applicant.id).toBe(APPLICANT_ACCOUNT_ID);
    expect(result.applicant.nickname).toBe('待审工程师');
    expect(result.applicant.role).toBe(IdentityTypeEnum.ENGINEER);
    expect(result.organizationName).toBe('测试组织');
    expect(adminUserQueryService.findAdminUserViewById).toHaveBeenCalledWith({
      accountId: APPLICANT_ACCOUNT_ID,
    });
  });

  it('申请人账号资料缺失时读取失败关闭', async () => {
    adminUserQueryService.findAdminUserViewById.mockResolvedValue(null);

    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: ADMIN_USER_ERROR.READ_FAILED },
    );
  });
});
