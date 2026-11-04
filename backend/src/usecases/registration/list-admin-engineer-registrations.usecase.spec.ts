// src/usecases/registration/list-admin-engineer-registrations.usecase.spec.ts
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
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { ListAdminEngineerRegistrationsUsecase } from './list-admin-engineer-registrations.usecase';

describe('ListAdminEngineerRegistrationsUsecase（本组织审核队列）', () => {
  const ADMIN_ACCOUNT_ID = 1;
  const ORGANIZATION_ID = 5;
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

  let session: UsecaseSession;
  let engineerRegistrationQueryService: { listByOrganization: jest.Mock };
  let adminUserQueryService: { findAdminUserViewById: jest.Mock };
  let organizationContext: { resolveForAccount: jest.Mock };
  let usecase: ListAdminEngineerRegistrationsUsecase;

  const snapshot = (id: number, accountId: number): EngineerRegistrationApplicationSnapshot => ({
    id,
    accountId,
    organizationId: ORGANIZATION_ID,
    status: EngineerRegistrationApplicationStatus.PENDING,
    applicationNote: null,
    submittedAt: CREATED_AT,
    reviewedByAccountId: null,
    reviewedAt: null,
    reviewComment: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const applicantView = (accountId: number): AdminUserView => ({
    id: accountId,
    loginName: `user-${accountId}`,
    loginEmail: null,
    nickname: '待审工程师',
    companyName: null,
    phone: null,
    contactEmail: null,
    role: IdentityTypeEnum.ENGINEER,
    status: AccountStatus.PENDING,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const organizationFact = (memberRole: string) => ({
    membershipId: 9,
    organizationId: ORGANIZATION_ID,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '测试组织',
    organizationKind: 'CLIENT',
    memberRole,
  });

  beforeEach(() => {
    session = {
      accountId: ADMIN_ACCOUNT_ID,
      roles: [IdentityTypeEnum.SUPER_ADMIN],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
    };
    engineerRegistrationQueryService = {
      listByOrganization: jest.fn().mockResolvedValue({
        items: [snapshot(1, 11), snapshot(2, 12)],
        total: 2,
        page: 1,
        pageSize: 10,
      }),
    };
    adminUserQueryService = {
      findAdminUserViewById: jest
        .fn()
        .mockImplementation(({ accountId }) => Promise.resolve(applicantView(accountId))),
    };
    organizationContext = {
      resolveForAccount: jest
        .fn()
        .mockResolvedValue(organizationFact(IdentityTypeEnum.SUPER_ADMIN)),
    };
    usecase = new ListAdminEngineerRegistrationsUsecase(
      engineerRegistrationQueryService as unknown as EngineerRegistrationQueryService,
      adminUserQueryService as unknown as AdminUserQueryService,
      organizationContext as unknown as TrustedOrganizationContextQueryService,
    );
  });

  const command = () => ({
    session,
    pagination: { mode: 'OFFSET', page: 1, pageSize: 10 } as const,
  });

  it('非本组织管理员被拒绝，且不触发任何读取', async () => {
    organizationContext.resolveForAccount.mockResolvedValue(
      organizationFact(IdentityTypeEnum.ENGINEER),
    );

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(engineerRegistrationQueryService.listByOrganization).not.toHaveBeenCalled();
  });

  it('CURSOR 分页明确拒绝', async () => {
    await expect(
      usecase.execute({ session, pagination: { mode: 'CURSOR', limit: 10 } }),
    ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS });
  });

  it('以可信组织限定队列，按上限收敛页大小并补充申请人视图', async () => {
    const result = await usecase.execute({
      session,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 500 },
    });

    expect(engineerRegistrationQueryService.listByOrganization).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      status: undefined,
      pagination: { page: 1, pageSize: 100 },
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0].applicant.id).toBe(11);
    expect(result.total).toBe(2);
  });

  it('状态筛选下推到查询', async () => {
    await usecase.execute({
      session,
      status: EngineerRegistrationApplicationStatus.REJECTED,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    expect(engineerRegistrationQueryService.listByOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ status: EngineerRegistrationApplicationStatus.REJECTED }),
    );
  });

  it('申请人账号资料缺失时整页失败关闭，不返回部分列表', async () => {
    adminUserQueryService.findAdminUserViewById.mockResolvedValueOnce(null);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ADMIN_USER_ERROR.READ_FAILED,
    });
  });
});
