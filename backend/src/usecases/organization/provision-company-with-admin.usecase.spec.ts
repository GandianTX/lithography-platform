// src/usecases/organization/provision-company-with-admin.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import {
  DomainError,
  ORGANIZATION_MANAGEMENT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import {
  ADMIN_ORGANIZATION_PROVISIONING_PURPOSE,
  computeProvisioningInputFingerprint,
} from '@core/organization/policy/admin-organization-provisioning.policy';
import type { PinoLogger } from 'nestjs-pino';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import {
  AdminOrganizationProvisioningService,
  DuplicateProvisioningRequestError,
  type ProvisioningRequestFact,
} from '@src/modules/lithography/admin-organization-provisioning.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { ProvisionCompanyWithAdminCommand } from './company-provisioning.types';
import { ProvisionCompanyWithAdminUsecase } from './provision-company-with-admin.usecase';

/**
 * 一级管理员「新增公司并开通二级管理员」用例单测。
 *
 * 覆盖计划 §4.12 清单：正常开通、旧入口无标识、预读回放、并发重复键回放、
 * 改内容冲突、回放校验失败冲突、回放不返回口令、错误码映射。
 * 本 spec 不连库：全部协作者是 jest mock，事务上下文只用不透明占位对象。
 */

const TX = {} as PersistenceTransactionContext;

const SESSION: UsecaseSession = {
  accountId: 30,
  roles: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
  adminLevel: 1,
  adminOrganizationId: null,
};

/** 合法 v4 UUID（大小写无关），归一化后小写。 */
const SUBMISSION_KEY = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const NORMALIZED_SUBMISSION_KEY = SUBMISSION_KEY.toLowerCase();

const COMPANY_NAME = '光刻设备（上海）有限公司';
const CONTACT_PHONE = '021-12345678';

const ORGANIZATION_ID = 501;
const ORGANIZATION_CODE = 'ADMIN_ORG_0001';
const ADMIN_ACCOUNT_ID = 901;
const REQUEST_ID = 77;

const organizationView: AdminOrganizationView = {
  id: ORGANIZATION_ID,
  organizationCode: ORGANIZATION_CODE,
  name: COMPANY_NAME,
  shortName: null,
  contactName: null,
  contactPhone: CONTACT_PHONE,
  contactEmail: null,
  address: null,
  remark: null,
  isServiceProvider: false,
  isManagedCompany: true,
  kind: 'CLIENT',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/** 回放窄读的原始成员关系（不按公司状态过滤）。 */
const RAW_MEMBERSHIP_ID = 11;
const rawMembership = {
  membershipId: RAW_MEMBERSHIP_ID,
  accountId: ADMIN_ACCOUNT_ID,
  memberRole: String(IdentityTypeEnum.SUPER_ADMIN),
  status: 'ACTIVE',
};

const authoritySnapshot = {
  accountId: ADMIN_ACCOUNT_ID,
  accountStatus: AccountStatus.ACTIVE,
  identityHint: IdentityTypeEnum.SUPER_ADMIN as string | null,
  mustChangePassword: true,
  adminLevel: 2 as number | null,
  userInfo: {
    userState: UserState.ACTIVE,
    accessGroup: [IdentityTypeEnum.SUPER_ADMIN] as IdentityTypeEnum[] | null,
    metaDigest: [IdentityTypeEnum.SUPER_ADMIN] as IdentityTypeEnum[] | null,
    customerOrganizationId: ORGANIZATION_ID as number | null,
  },
};

const adminUserView = {
  accountId: ADMIN_ACCOUNT_ID,
  loginName: 'orgadmin_abcdef0123456789abcd',
  nickname: COMPANY_NAME,
  identityHint: IdentityTypeEnum.SUPER_ADMIN,
  role: IdentityTypeEnum.SUPER_ADMIN,
  status: AccountStatus.ACTIVE,
  adminLevel: 2,
  mustChangePassword: true,
};

/** 与「默认输入」对应的规范化指纹（normalize 后 contactPhone 去空白、其余缺省为 null/false）。 */
function expectedFingerprint(overrides: { name?: string; contactPhone?: string } = {}): string {
  return computeProvisioningInputFingerprint({
    name: overrides.name ?? COMPANY_NAME,
    shortName: null,
    contactName: null,
    contactPhone: overrides.contactPhone ?? CONTACT_PHONE,
    contactEmail: null,
    address: null,
    remark: null,
    status: 'ACTIVE',
    isServiceProvider: false,
  });
}

function completedFact(fingerprint: string): ProvisioningRequestFact {
  return {
    id: REQUEST_ID,
    inputFingerprint: fingerprint,
    state: 'COMPLETED',
    organizationId: ORGANIZATION_ID,
    adminAccountId: ADMIN_ACCOUNT_ID,
  };
}

function duplicateKeyError(): Error {
  return Object.assign(new Error("Duplicate entry 'x' for key 'uk_organization_code'"), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
  });
}

type Mocks = {
  organizationService: { createManagedCompany: jest.Mock };
  organizationQueryService: { findAdminOrganizationView: jest.Mock };
  organizationMembershipService: { insertMembership: jest.Mock };
  organizationMembershipQueryService: { listMembershipsByOrganization: jest.Mock };
  accountService: {
    insertAccount: jest.Mock;
    updateAccountPasswordHash: jest.Mock;
    insertUserInfo: jest.Mock;
  };
  accountQueryService: { findSessionAuthoritySnapshot: jest.Mock };
  adminUserQueryService: { findAdminUserViewById: jest.Mock };
  provisioningService: { findByKey: jest.Mock; reserve: jest.Mock; complete: jest.Mock };
  logger: { setContext: jest.Mock; info: jest.Mock; error: jest.Mock };
  transactionRunner: { run: jest.Mock };
};

describe('ProvisionCompanyWithAdminUsecase（同事务开通 + 提交标识幂等）', () => {
  let mocks: Mocks;
  let usecase: ProvisionCompanyWithAdminUsecase;

  const command = (
    overrides: Partial<ProvisionCompanyWithAdminCommand> = {},
  ): ProvisionCompanyWithAdminCommand => ({
    session: SESSION,
    submissionKey: SUBMISSION_KEY,
    name: COMPANY_NAME,
    contactPhone: CONTACT_PHONE,
    ...overrides,
  });

  beforeEach(() => {
    mocks = {
      organizationService: {
        createManagedCompany: jest.fn().mockResolvedValue({
          id: ORGANIZATION_ID,
          organizationCode: ORGANIZATION_CODE,
        }),
      },
      organizationQueryService: {
        findAdminOrganizationView: jest.fn().mockResolvedValue(organizationView),
      },
      organizationMembershipService: {
        insertMembership: jest.fn().mockResolvedValue({ membershipId: RAW_MEMBERSHIP_ID }),
      },
      organizationMembershipQueryService: {
        listMembershipsByOrganization: jest.fn().mockResolvedValue([rawMembership]),
      },
      accountService: {
        insertAccount: jest.fn().mockResolvedValue({
          kind: 'CREATED',
          accountId: ADMIN_ACCOUNT_ID,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        updateAccountPasswordHash: jest.fn().mockResolvedValue(undefined),
        insertUserInfo: jest.fn().mockResolvedValue(undefined),
      },
      accountQueryService: {
        findSessionAuthoritySnapshot: jest.fn().mockResolvedValue(authoritySnapshot),
      },
      adminUserQueryService: {
        findAdminUserViewById: jest.fn().mockResolvedValue(adminUserView),
      },
      provisioningService: {
        findByKey: jest.fn().mockResolvedValue(null),
        reserve: jest.fn().mockResolvedValue(REQUEST_ID),
        complete: jest.fn().mockResolvedValue(undefined),
      },
      logger: { setContext: jest.fn(), info: jest.fn(), error: jest.fn() },
      transactionRunner: {
        run: jest.fn(async (callback: (ctx: PersistenceTransactionContext) => Promise<unknown>) =>
          callback(TX),
        ),
      },
    };

    usecase = new ProvisionCompanyWithAdminUsecase(
      mocks.organizationService as unknown as OrganizationService,
      mocks.organizationQueryService as unknown as OrganizationQueryService,
      mocks.organizationMembershipService as unknown as OrganizationMembershipService,
      mocks.organizationMembershipQueryService as unknown as OrganizationMembershipQueryService,
      mocks.accountService as unknown as AccountService,
      mocks.accountQueryService as unknown as AccountQueryService,
      mocks.adminUserQueryService as unknown as AdminUserQueryService,
      mocks.provisioningService as unknown as AdminOrganizationProvisioningService,
      new PasswordPolicyService(),
      mocks.logger as unknown as PinoLogger,
      mocks.transactionRunner,
    );
  });

  it('正常开通：先预留提交行，再在同一事务内写公司/账号/资料/成员并完成提交行', async () => {
    const result = await usecase.execute(command());

    expect(mocks.provisioningService.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.provisioningService.reserve).toHaveBeenCalledWith({
      purpose: ADMIN_ORGANIZATION_PROVISIONING_PURPOSE,
      submissionKey: NORMALIZED_SUBMISSION_KEY,
      actorAccountId: SESSION.accountId,
      inputFingerprint: expectedFingerprint(),
      transactionContext: TX,
    });

    // 事务顺序：预留提交行 → 公司 → 账号 → 密码哈希 → 资料 → 成员 → 完成。
    const reserveOrder = mocks.provisioningService.reserve.mock.invocationCallOrder[0];
    const companyOrder = mocks.organizationService.createManagedCompany.mock.invocationCallOrder[0];
    const accountOrder = mocks.accountService.insertAccount.mock.invocationCallOrder[0];
    const userInfoOrder = mocks.accountService.insertUserInfo.mock.invocationCallOrder[0];
    const membershipOrder =
      mocks.organizationMembershipService.insertMembership.mock.invocationCallOrder[0];
    const completeOrder = mocks.provisioningService.complete.mock.invocationCallOrder[0];
    expect(reserveOrder).toBeLessThan(companyOrder);
    expect(companyOrder).toBeLessThan(accountOrder);
    expect(accountOrder).toBeLessThan(userInfoOrder);
    expect(userInfoOrder).toBeLessThan(membershipOrder);
    expect(membershipOrder).toBeLessThan(completeOrder);

    // 账号安全口径：登录名由公司编号派生、登录邮箱留空、等级 2、首次登录强制改密。
    const accountArgs = mocks.accountService.insertAccount.mock.calls[0][0] as {
      accountData: Record<string, unknown>;
      transactionContext: PersistenceTransactionContext;
    };
    expect(accountArgs.transactionContext).toBe(TX);
    expect(accountArgs.accountData).toMatchObject({
      loginName: expect.stringMatching(/^orgadmin_[0-9a-f]{20}$/),
      loginEmail: null,
      status: AccountStatus.ACTIVE,
      identityHint: IdentityTypeEnum.SUPER_ADMIN,
      adminLevel: 2,
      mustChangePassword: true,
    });

    const userInfoArgs = mocks.accountService.insertUserInfo.mock.calls[0][0] as {
      userInfoData: Record<string, unknown>;
      transactionContext: PersistenceTransactionContext;
    };
    expect(userInfoArgs.transactionContext).toBe(TX);
    expect(userInfoArgs.userInfoData).toMatchObject({
      accountId: ADMIN_ACCOUNT_ID,
      nickname: COMPANY_NAME,
      customerOrganizationId: ORGANIZATION_ID,
      companyName: COMPANY_NAME,
      email: null,
      phone: CONTACT_PHONE,
      accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
      metaDigest: [IdentityTypeEnum.SUPER_ADMIN],
      userState: UserState.ACTIVE,
    });

    expect(mocks.organizationMembershipService.insertMembership).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        accountId: ADMIN_ACCOUNT_ID,
        memberRole: IdentityTypeEnum.SUPER_ADMIN,
      },
      TX,
    );
    expect(mocks.provisioningService.complete).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      organizationId: ORGANIZATION_ID,
      adminAccountId: ADMIN_ACCOUNT_ID,
      transactionContext: TX,
    });

    expect(result.organization).toBe(organizationView);
    expect(result.admin).toMatchObject({
      accountId: ADMIN_ACCOUNT_ID,
      nickname: COMPANY_NAME,
      mustChangePassword: true,
    });
    expect(result.submission).toEqual({ submissionId: REQUEST_ID, replayed: false });
    expect(result.temporaryPassword).toMatch(/^Aa1![\s\S]{16}$/);
    // 临时密码只出现在首次响应；写入的哈希不等于明文。
    const passwordArgs = mocks.accountService.updateAccountPasswordHash.mock.calls[0][0] as {
      passwordHash: string;
    };
    expect(passwordArgs.passwordHash).not.toBe(result.temporaryPassword);
    expect(mocks.logger.info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain(result.temporaryPassword);
  });

  it('旧入口无标识：不写提交行、不查提交行，返回 submissionId=null 且仍返回一次性口令', async () => {
    const result = await usecase.execute(command({ submissionKey: undefined }));

    expect(mocks.provisioningService.findByKey).not.toHaveBeenCalled();
    expect(mocks.provisioningService.reserve).not.toHaveBeenCalled();
    expect(mocks.provisioningService.complete).not.toHaveBeenCalled();
    expect(mocks.organizationService.createManagedCompany).toHaveBeenCalledTimes(1);
    expect(result.submission).toEqual({ submissionId: null, replayed: false });
    expect(result.temporaryPassword).toMatch(/^Aa1![\s\S]{16}$/);
  });

  it('预读回放：同标识同输入直接返回既有公司/账号，不进入事务、不返回口令', async () => {
    const fact = completedFact(expectedFingerprint());
    mocks.provisioningService.findByKey.mockResolvedValue(fact);

    const result = await usecase.execute(command());

    expect(mocks.transactionRunner.run).not.toHaveBeenCalled();
    expect(mocks.organizationService.createManagedCompany).not.toHaveBeenCalled();
    expect(mocks.provisioningService.reserve).not.toHaveBeenCalled();
    expect(result.submission).toEqual({ submissionId: REQUEST_ID, replayed: true });
    expect(result.organization).toBe(organizationView);
    expect(result.admin.accountId).toBe(ADMIN_ACCOUNT_ID);
    expect(result.admin.loginName).toBe(adminUserView.loginName);
    expect(result.temporaryPassword).toBeNull();
    // 回放响应整体不含任何口令形态。
    expect(JSON.stringify(result)).not.toContain('Aa1!');
  });

  it('回放返回账号当前改密状态：首次改密完成后不再宣称仍需改密', async () => {
    const fact = completedFact(expectedFingerprint());
    mocks.provisioningService.findByKey.mockResolvedValue(fact);
    mocks.accountQueryService.findSessionAuthoritySnapshot.mockResolvedValue({
      ...authoritySnapshot,
      mustChangePassword: false,
    });

    const result = await usecase.execute(command());

    expect(result.admin.mustChangePassword).toBe(false);
    expect(result.temporaryPassword).toBeNull();
  });

  it('并发重复键回放：竞争失败者回读已提交行，同指纹返回同一结果', async () => {
    const fact = completedFact(expectedFingerprint());
    mocks.provisioningService.findByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(fact);
    mocks.transactionRunner.run.mockRejectedValue(new DuplicateProvisioningRequestError());

    const result = await usecase.execute(command());

    expect(mocks.provisioningService.findByKey).toHaveBeenCalledTimes(2);
    expect(mocks.organizationService.createManagedCompany).not.toHaveBeenCalled();
    expect(result.submission).toEqual({ submissionId: REQUEST_ID, replayed: true });
    expect(result.temporaryPassword).toBeNull();
  });

  it('并发重复键但回读不到提交行：按提交冲突失败关闭', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(null);
    mocks.transactionRunner.run.mockRejectedValue(new DuplicateProvisioningRequestError());

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
    });
    expect(mocks.organizationService.createManagedCompany).not.toHaveBeenCalled();
  });

  it('同标识改内容：指纹不一致即提交冲突，零新增', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(
      completedFact(expectedFingerprint({ name: '另一家公司' })),
    );

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
    });
    expect(mocks.transactionRunner.run).not.toHaveBeenCalled();
    expect(mocks.organizationService.createManagedCompany).not.toHaveBeenCalled();
  });

  it('回放校验失败：角色三源不收敛时按提交冲突拒绝且不返回任何引用', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(completedFact(expectedFingerprint()));
    mocks.accountQueryService.findSessionAuthoritySnapshot.mockResolvedValue({
      ...authoritySnapshot,
      userInfo: {
        ...authoritySnapshot.userInfo,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
        metaDigest: [IdentityTypeEnum.CUSTOMER],
      },
    });

    const error = await usecase.execute(command()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT);
    expect((error as DomainError).details).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(String(ORGANIZATION_ID));
  });

  it('回放校验失败：公司已被删除时同样按提交冲突拒绝', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(completedFact(expectedFingerprint()));
    mocks.organizationQueryService.findAdminOrganizationView.mockResolvedValue(null);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
    });
  });

  it('回放校验失败：活动成员关系缺失时同样按提交冲突拒绝', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(completedFact(expectedFingerprint()));
    mocks.organizationMembershipQueryService.listMembershipsByOrganization.mockResolvedValue([]);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
    });
  });

  it('回放窄读不按公司状态过滤：公司已停用仍返回既有安全结果', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(completedFact(expectedFingerprint()));
    mocks.organizationQueryService.findAdminOrganizationView.mockResolvedValue({
      ...organizationView,
      status: 'DISABLED',
    });

    const result = await usecase.execute(command());

    expect(
      mocks.organizationMembershipQueryService.listMembershipsByOrganization,
    ).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
    expect(result.organization.status).toBe('DISABLED');
    expect(result.submission).toEqual({ submissionId: REQUEST_ID, replayed: true });
    expect(result.temporaryPassword).toBeNull();
  });

  it('回放校验失败：唯一成员边角色不是 SUPER_ADMIN 时拒绝', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(completedFact(expectedFingerprint()));
    mocks.organizationMembershipQueryService.listMembershipsByOrganization.mockResolvedValue([
      { ...rawMembership, memberRole: String(IdentityTypeEnum.ENGINEER) },
    ]);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
    });
  });

  it('回放校验失败：两条活动 SUPER_ADMIN 成员边（歧义）时拒绝', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(completedFact(expectedFingerprint()));
    mocks.organizationMembershipQueryService.listMembershipsByOrganization.mockResolvedValue([
      rawMembership,
      { ...rawMembership, membershipId: RAW_MEMBERSHIP_ID + 1, accountId: ADMIN_ACCOUNT_ID + 1 },
    ]);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
    });
  });

  it('回放校验失败：唯一活动 SUPER_ADMIN 边指向其他账号时拒绝', async () => {
    mocks.provisioningService.findByKey.mockResolvedValue(completedFact(expectedFingerprint()));
    mocks.organizationMembershipQueryService.listMembershipsByOrganization.mockResolvedValue([
      { ...rawMembership, accountId: ADMIN_ACCOUNT_ID + 1 },
    ]);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
    });
    expect(mocks.adminUserQueryService.findAdminUserViewById).not.toHaveBeenCalled();
  });

  it('新入口缺标识：null 直接 SUBMISSION_KEY_INVALID，任何数据库访问都不发生', async () => {
    await expect(usecase.execute(command({ submissionKey: null }))).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_KEY_INVALID,
    });
    expect(mocks.provisioningService.findByKey).not.toHaveBeenCalled();
    expect(mocks.transactionRunner.run).not.toHaveBeenCalled();
  });

  it('标识格式非法：非 UUID 字符串按 SUBMISSION_KEY_INVALID 拒绝', async () => {
    await expect(usecase.execute(command({ submissionKey: 'not-a-uuid' }))).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_KEY_INVALID,
    });
    expect(mocks.transactionRunner.run).not.toHaveBeenCalled();
  });

  it('非一级管理员：作用域断言先于输入规范化与数据库访问', async () => {
    await expect(
      usecase.execute(
        command({
          session: { ...SESSION, adminLevel: 2, adminOrganizationId: 88 },
          name: '',
        }),
      ),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(mocks.provisioningService.findByKey).not.toHaveBeenCalled();
  });

  it('错误码映射：账号凭据冲突 → ADMIN_BINDING_CONFLICT 且不完成提交行', async () => {
    mocks.accountService.insertAccount.mockResolvedValue({ kind: 'CREDENTIAL_CONFLICT' });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_CONFLICT,
    });
    expect(mocks.accountService.insertUserInfo).not.toHaveBeenCalled();
    expect(mocks.provisioningService.complete).not.toHaveBeenCalled();
  });

  it('错误码映射：公司编号唯一键冲突 → CODE_CONFLICT', async () => {
    mocks.organizationService.createManagedCompany.mockRejectedValue(duplicateKeyError());

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.CODE_CONFLICT,
    });
    expect(mocks.provisioningService.complete).not.toHaveBeenCalled();
  });

  it('错误码映射：其它协作者异常 → WRITE_FAILED，且日志不含输入口令或哈希', async () => {
    mocks.accountService.insertUserInfo.mockRejectedValue(new Error('connection lost'));

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
    });

    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mocks.logger.error.mock.calls);
    expect(logged).not.toContain('Aa1!');
    expect(logged).not.toContain('loginPassword');
    expect(logged).not.toContain(COMPANY_NAME);
    expect(mocks.provisioningService.complete).not.toHaveBeenCalled();
  });
});
