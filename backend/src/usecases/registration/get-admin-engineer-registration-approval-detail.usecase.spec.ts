// src/usecases/registration/get-admin-engineer-registration-approval-detail.usecase.spec.ts
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import {
  ADMIN_USER_ERROR,
  DomainError,
  ENGINEER_REGISTRATION_ERROR,
} from '@core/common/errors/domain-error';
import type { AdminApplicantDetailView } from '@src/modules/account/account.types';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { GetAdminEngineerRegistrationDetailUsecase } from './get-admin-engineer-registration-detail.usecase';
import { GetAdminEngineerRegistrationApprovalDetailUsecase } from './get-admin-engineer-registration-approval-detail.usecase';

describe('GetAdminEngineerRegistrationApprovalDetailUsecase（审批详情）', () => {
  const APPLICANT_ACCOUNT_ID = 11;
  const ORGANIZATION_ID = 5;
  const APPLICATION_ID = 61;
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

  let session: UsecaseSession;
  let detailReader: { resolveVisibleApplication: jest.Mock };
  let adminUserQueryService: { findAdminUserDetailViewById: jest.Mock };
  let organizationQueryService: { findOrganizationNameById: jest.Mock };
  let usecase: GetAdminEngineerRegistrationApprovalDetailUsecase;

  const snapshot = (): EngineerRegistrationApplicationSnapshot => ({
    id: APPLICATION_ID,
    accountId: APPLICANT_ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    status: EngineerRegistrationApplicationStatus.PENDING,
    applicationNote: '希望加入组织',
    submittedAt: CREATED_AT,
    reviewedByAccountId: null,
    reviewedAt: null,
    reviewComment: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const applicantDetailView = (): AdminApplicantDetailView => ({
    id: APPLICANT_ACCOUNT_ID,
    loginName: 'pending-engineer',
    nickname: '待审工程师',
    realName: '张三',
    phone: '13800000001',
    contactEmail: null,
  });

  beforeEach(() => {
    session = {
      accountId: 1,
      roles: [IdentityTypeEnum.SUPER_ADMIN],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
      adminLevel: 1,
      adminOrganizationId: ORGANIZATION_ID,
    };
    detailReader = {
      resolveVisibleApplication: jest.fn().mockResolvedValue(snapshot()),
    };
    adminUserQueryService = {
      findAdminUserDetailViewById: jest.fn().mockResolvedValue(applicantDetailView()),
    };
    organizationQueryService = {
      findOrganizationNameById: jest.fn().mockResolvedValue('测试组织'),
    };
    usecase = new GetAdminEngineerRegistrationApprovalDetailUsecase(
      detailReader as unknown as GetAdminEngineerRegistrationDetailUsecase,
      adminUserQueryService as unknown as AdminUserQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('复用既有可见性裁决后返回申请、真实姓名与目标公司名', async () => {
    const result = await usecase.execute({ session, applicationId: APPLICATION_ID });

    expect(detailReader.resolveVisibleApplication).toHaveBeenCalledWith({
      session,
      applicationId: APPLICATION_ID,
    });
    expect(adminUserQueryService.findAdminUserDetailViewById).toHaveBeenCalledWith({
      accountId: APPLICANT_ACCOUNT_ID,
    });
    expect(result.application.id).toBe(APPLICATION_ID);
    expect(result.applicant.realName).toBe('张三');
    expect(result.applicant.nickname).toBe('待审工程师');
    expect(result.organizationName).toBe('测试组织');
  });

  it('可见性裁决失败（不存在 / 跨公司）原样上抛，不读取申请人资料', async () => {
    detailReader.resolveVisibleApplication.mockRejectedValue(
      new DomainError(ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND, '注册申请不存在'),
    );

    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND },
    );
    expect(adminUserQueryService.findAdminUserDetailViewById).not.toHaveBeenCalled();
  });

  it('申请人账号资料缺失时按读取失败关闭', async () => {
    adminUserQueryService.findAdminUserDetailViewById.mockResolvedValue(null);

    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: ADMIN_USER_ERROR.READ_FAILED },
    );
  });

  it('申请人详情读取的未知错误包装为注册申请读取失败', async () => {
    adminUserQueryService.findAdminUserDetailViewById.mockRejectedValue(new Error('db down'));

    await expect(usecase.execute({ session, applicationId: APPLICATION_ID })).rejects.toMatchObject(
      { code: ENGINEER_REGISTRATION_ERROR.READ_FAILED },
    );
  });
});
