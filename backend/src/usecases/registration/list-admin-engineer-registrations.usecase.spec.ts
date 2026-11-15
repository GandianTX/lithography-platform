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
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { ListAdminEngineerRegistrationsUsecase } from './list-admin-engineer-registrations.usecase';

describe('ListAdminEngineerRegistrationsUsecase（管理员审核队列）', () => {
  const ADMIN_ACCOUNT_ID = 1;
  const ORGANIZATION_ID = 5;
  const PEER_ORGANIZATION_ID = 6;
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

  let session: UsecaseSession;
  let engineerRegistrationQueryService: { listForAdminQueue: jest.Mock };
  let adminUserQueryService: { findAdminUserViewById: jest.Mock };
  let organizationContext: { resolveForAccount: jest.Mock };
  let organizationQueryService: { findOrganizationNamesByIds: jest.Mock };
  let usecase: ListAdminEngineerRegistrationsUsecase;

  const snapshot = (
    id: number,
    accountId: number,
    organizationId = ORGANIZATION_ID,
  ): EngineerRegistrationApplicationSnapshot => ({
    id,
    accountId,
    organizationId,
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

  const organizationFact = (memberRole: string, organizationId = ORGANIZATION_ID) => ({
    membershipId: 9,
    organizationId,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '测试组织',
    organizationKind: 'CLIENT',
    memberRole,
  });

  const levelOneSession = (): UsecaseSession => ({
    accountId: ADMIN_ACCOUNT_ID,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: ORGANIZATION_ID,
  });

  const levelTwoSession = (): UsecaseSession => ({
    accountId: ADMIN_ACCOUNT_ID,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 2,
    adminOrganizationId: ORGANIZATION_ID,
  });

  beforeEach(() => {
    session = levelOneSession();
    engineerRegistrationQueryService = {
      listForAdminQueue: jest.fn().mockResolvedValue({
        items: [snapshot(1, 11), snapshot(2, 12, PEER_ORGANIZATION_ID)],
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
    organizationQueryService = {
      findOrganizationNamesByIds: jest.fn().mockResolvedValue(
        new Map([
          [ORGANIZATION_ID, '甲公司'],
          [PEER_ORGANIZATION_ID, '乙公司'],
        ]),
      ),
    };
    usecase = new ListAdminEngineerRegistrationsUsecase(
      engineerRegistrationQueryService as unknown as EngineerRegistrationQueryService,
      adminUserQueryService as unknown as AdminUserQueryService,
      organizationContext as unknown as TrustedOrganizationContextQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  const command = () => ({
    session,
    pagination: { mode: 'OFFSET', page: 1, pageSize: 10 } as const,
  });

  it('等级缺失或非法时失败关闭，且不触发任何读取', async () => {
    session = { ...levelOneSession(), adminLevel: null };

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(engineerRegistrationQueryService.listForAdminQueue).not.toHaveBeenCalled();
  });

  it('二级管理员缺少可信公司时失败关闭', async () => {
    session = { ...levelTwoSession(), adminOrganizationId: null };

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(engineerRegistrationQueryService.listForAdminQueue).not.toHaveBeenCalled();
  });

  it('二级管理员可信成员事实不符时失败关闭', async () => {
    session = levelTwoSession();
    organizationContext.resolveForAccount.mockResolvedValue(
      organizationFact(IdentityTypeEnum.ENGINEER),
    );

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(engineerRegistrationQueryService.listForAdminQueue).not.toHaveBeenCalled();
  });

  it('二级管理员可信成员公司变化时失败关闭', async () => {
    session = levelTwoSession();
    organizationContext.resolveForAccount.mockResolvedValue(
      organizationFact(IdentityTypeEnum.SUPER_ADMIN, PEER_ORGANIZATION_ID),
    );

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('CURSOR 分页明确拒绝', async () => {
    await expect(
      usecase.execute({ session, pagination: { mode: 'CURSOR', limit: 10 } }),
    ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS });
  });

  it('一级管理员不限定公司（全范围），按上限收敛页大小并批量补充公司名', async () => {
    const result = await usecase.execute({
      session,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 500 },
    });

    expect(engineerRegistrationQueryService.listForAdminQueue).toHaveBeenCalledWith({
      status: undefined,
      pagination: { page: 1, pageSize: 100 },
    });
    expect(organizationContext.resolveForAccount).not.toHaveBeenCalled();
    expect(organizationQueryService.findOrganizationNamesByIds).toHaveBeenCalledWith([
      ORGANIZATION_ID,
      PEER_ORGANIZATION_ID,
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].applicant.id).toBe(11);
    expect(result.items[0].organizationName).toBe('甲公司');
    expect(result.items[1].organizationName).toBe('乙公司');
    expect(result.total).toBe(2);
  });

  it('二级管理员先按可信公司限域，再筛选与分页', async () => {
    session = levelTwoSession();
    engineerRegistrationQueryService.listForAdminQueue.mockResolvedValue({
      items: [snapshot(1, 11)],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    await usecase.execute({
      session,
      status: EngineerRegistrationApplicationStatus.PENDING,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    expect(engineerRegistrationQueryService.listForAdminQueue).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      status: EngineerRegistrationApplicationStatus.PENDING,
      pagination: { page: 1, pageSize: 10 },
    });
  });

  it('公司行缺失时公司名兜底为 null，不阻断整页', async () => {
    organizationQueryService.findOrganizationNamesByIds.mockResolvedValue(new Map());

    const result = await usecase.execute(command());

    expect(result.items.every((item) => item.organizationName === null)).toBe(true);
  });

  it('申请人账号资料缺失时整页失败关闭，不返回部分列表', async () => {
    adminUserQueryService.findAdminUserViewById.mockResolvedValueOnce(null);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ADMIN_USER_ERROR.READ_FAILED,
    });
  });
});
