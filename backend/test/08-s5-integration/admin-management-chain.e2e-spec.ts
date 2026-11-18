// test/08-s5-integration/admin-management-chain.e2e-spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import {
  EngineerRegistrationApplicationStatus,
  EngineerRegistrationReviewAction,
  RegistrationOutcomeStatus,
} from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { OrganizationMembershipEntity } from '../../src/modules/lithography/entities/organization-membership.entity';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * S5 · 管理端组合链路（真实 GraphQL + MySQL）。
 *
 * 链路 A：一级管理员新增有效受管公司 → Web 工程师注册进入待审 → 待审受限会话直调业务接口被拒 →
 * 一级管理员批准 / 拒绝 → 查库复核申请终态、成员关系与真实业务资格。
 *
 * 造数纪律：业务写入只走 GraphQL 入口；数据库仅用于只读核验与受控清理。
 * 本人结果页属任务 02，未进入同一可验快照时以 `myEngineerRegistrationStatus` 真实 API 证据替代，
 * 页面联调缺口登记在 `docs/plan/task08/开工准备记录.md` §9。
 */

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type AdminOrganizationPayload = {
  id: number;
  organizationCode: string;
  name: string;
  kind: string;
  status: string;
  isManagedCompany: boolean;
  provisionedAdmin?: {
    accountId: number;
    loginName: string;
    nickname: string;
    mustChangePassword: boolean;
  } | null;
};

type ApplicationPayload = {
  id: number;
  accountId: number;
  organizationId: number;
  status: EngineerRegistrationApplicationStatus;
  applicationNote: string | null;
  reviewedByAccountId: number | null;
  reviewedAt: string | null;
  reviewComment: string | null;
};

type AdminItemPayload = {
  application: ApplicationPayload;
  organizationName: string | null;
  applicant: {
    id: number;
    loginName: string | null;
    loginEmail: string | null;
    nickname: string;
    role: IdentityTypeEnum;
    status: AccountStatus;
  };
};

type RegisterPayload = {
  success: boolean;
  message: string;
  accountId?: number | null;
  registrationStatus: RegistrationOutcomeStatus;
  applicationId?: number | null;
};

type LoginPayload = {
  login?: {
    accessToken?: string;
    accountId?: number;
    restriction?: string;
  };
};

type StatusPayload = {
  accountId: number;
  latest: ApplicationPayload | null;
  applications: { items: ApplicationPayload[]; total: number; page: number; pageSize: number };
};

const APPLICATION_FIELDS = `
  id accountId organizationId status applicationNote
  reviewedByAccountId reviewedAt reviewComment
`;

const REGISTER_MUTATION = `
  mutation RegisterWeb($input: RegisterWebInput!) {
    register: registerWeb(input: $input) {
      success
      message
      accountId
      registrationStatus
      applicationId
    }
  }
`;

const ADMIN_CREATE_ORGANIZATION_MUTATION = `
  mutation AdminCreateOrganization($input: AdminCreateOrganizationInput!) {
    adminCreateOrganization(input: $input) {
      id organizationCode name kind status isManagedCompany
      provisionedAdmin { accountId loginName nickname mustChangePassword }
    }
  }
`;

const ADMIN_UPDATE_ORGANIZATION_MUTATION = `
  mutation AdminUpdateOrganization($input: AdminUpdateOrganizationInput!) {
    adminUpdateOrganization(input: $input) {
      id organizationCode name kind status isManagedCompany
    }
  }
`;

const REVIEW_MUTATION = `
  mutation Review($input: ReviewEngineerRegistrationInput!) {
    reviewEngineerRegistration(input: $input) {
      application { ${APPLICATION_FIELDS} }
      organizationName
      applicant { id loginName loginEmail nickname role status }
    }
  }
`;

const MY_STATUS_MUTATION = `
  mutation MyStatus($input: EngineerRegistrationCredentialInput!, $pagination: PaginationArgs!) {
    myEngineerRegistrationStatus(input: $input, pagination: $pagination) {
      accountId
      latest { ${APPLICATION_FIELDS} }
      applications {
        items { ${APPLICATION_FIELDS} }
        total
        page
        pageSize
      }
    }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) { accessToken accountId restriction }
  }
`;

const USER_INFO_QUERY = `
  query UserInfo($accountId: Int!) {
    userInfo(accountId: $accountId) { id accountId nickname userState }
  }
`;

const DEFAULT_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 20 } as const;

/** 工程师注册口令：满足后端密码策略（仅测试夹具使用） */
const ENGINEER_PASSWORD = 'E2eS5Engineer@2026';

describe('S5 管理端组合链路：新增公司 → Web 注册 → 待审受限 → 审核 → 真实资格 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const RUN_TAG = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  const COMPANY_NAME = `E2E-S5-组合链路公司-${RUN_TAG}`;
  const COMPANY_PHONE = '021-58880000';
  const ENGINEER_A = {
    loginName: `e2es5a${RUN_TAG}`,
    loginEmail: `e2e.s5.a.${RUN_TAG}@example.com`,
  };
  const ENGINEER_B = {
    loginName: `e2es5b${RUN_TAG}`,
    loginEmail: `e2e.s5.b.${RUN_TAG}@example.com`,
  };
  // 停用公司反例专用申请人：与既有正向/拒绝用例完全独立的账号与申请
  const ENGINEER_C = {
    loginName: `e2es5c${RUN_TAG}`,
    loginEmail: `e2e.s5.c.${RUN_TAG}@example.com`,
  };
  const DISABLED_COMPANY_NAME = `E2E-S5-停用公司-${RUN_TAG}`;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();

  let adminToken = '';
  let adminAccountId = 0;
  let companyId = 0;
  let engineerAAccountId = 0;
  let engineerAApplicationId = 0;
  let engineerBAccountId = 0;
  let engineerBApplicationId = 0;

  const accountRepo = () => dataSource.getRepository(AccountEntity);
  const userInfoRepo = () => dataSource.getRepository(UserInfoEntity);
  const membershipRepo = () => dataSource.getRepository(OrganizationMembershipEntity);

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin'],
      ownership,
    });

    // 一级管理员：等级由请求期查库的 admin_level 决定（不写 JWT 字段）
    const admin = await accountRepo().findOneOrFail({
      where: { loginName: testAccountsConfig.admin.loginName },
    });
    await accountRepo().update(admin.id, { adminLevel: 1 });

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    adminAccountId = await getAccountIdByLoginName(dataSource, testAccountsConfig.admin.loginName);
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;

        await runGuardedSpecCleanup({
          dataSource,
          owned: ownership,
          helper: 'admin-management-chain.e2e-spec afterAll 收尾',
        });

        // 清理后再按台账与本轮前缀核验零残留：任一存在都使规格失败
        const countOf = async (sql: string, params: unknown[]): Promise<number> => {
          const rows = await dataSource.query(sql, params);
          return Number(rows[0]?.total ?? 0);
        };
        const residue: Array<[string, number]> = [];
        const accountIds = ownership.accountIds;
        const organizationIds = ownership.organizationIds;
        const membershipIds = ownership.membershipIds;
        const applicationIds = ownership.engineerRegistrationApplicationIds;

        if (accountIds.length > 0) {
          const placeholders = accountIds.map(() => '?').join(', ');
          residue.push([
            'account',
            await countOf(
              `SELECT COUNT(*) AS total FROM base_user_account WHERE id IN (${placeholders})`,
              accountIds,
            ),
          ]);
          residue.push([
            'userInfo',
            await countOf(
              `SELECT COUNT(*) AS total FROM base_user_info WHERE account_id IN (${placeholders})`,
              accountIds,
            ),
          ]);
        }
        if (organizationIds.length > 0) {
          residue.push([
            'organization',
            await countOf(
              `SELECT COUNT(*) AS total FROM organization WHERE id IN (${organizationIds
                .map(() => '?')
                .join(', ')})`,
              organizationIds,
            ),
          ]);
        }
        if (membershipIds.length > 0) {
          residue.push([
            'membership',
            await countOf(
              `SELECT COUNT(*) AS total FROM organization_membership WHERE id IN (${membershipIds
                .map(() => '?')
                .join(', ')})`,
              membershipIds,
            ),
          ]);
        }
        if (applicationIds.length > 0) {
          residue.push([
            'application',
            await countOf(
              `SELECT COUNT(*) AS total FROM engineer_registration_application WHERE id IN (${applicationIds
                .map(() => '?')
                .join(', ')})`,
              applicationIds,
            ),
          ]);
        }

        // 前缀反查：即使某次写入未拿到响应 ID，也不得留下本轮命名的数据
        residue.push([
          'organizationByPrefix',
          await countOf('SELECT COUNT(*) AS total FROM organization WHERE name = ?', [
            COMPANY_NAME,
          ]),
        ]);
        residue.push([
          'accountByEmailPrefix',
          await countOf(
            'SELECT COUNT(*) AS total FROM base_user_account WHERE login_email LIKE ?',
            [`e2e.s5.%${RUN_TAG}@example.com`],
          ),
        ]);

        expect(residue.filter(([, count]) => count !== 0)).toEqual([]);
      },
      finalize: null,
      closeApp: app ? async () => await app.close() : null,
    });
  });

  const gql = async <T>(params: {
    query: string;
    variables?: unknown;
    token?: string;
  }): Promise<GqlBody<T>> => {
    const response = await postGql({
      app,
      query: params.query,
      variables: params.variables,
      token: params.token,
    }).expect((res) => {
      expect([200, 400]).toContain(res.status);
    });
    return response.body as GqlBody<T>;
  };

  const errorCodeOf = (body: GqlBody<unknown>): string | undefined =>
    body.errors?.[0]?.extensions?.code;

  const engineerRegisterInput = (
    engineer: { loginName: string; loginEmail: string },
    organizationId: number = companyId,
  ) => ({
    loginName: engineer.loginName,
    loginEmail: engineer.loginEmail,
    loginPassword: ENGINEER_PASSWORD,
    nickname: engineer.loginName,
    // Web 工程师注册必填姓名与电话（V44）
    realName: 'E2E S5 工程师',
    phone: '13800000000',
    type: RegisterTypeEnum.ENGINEER,
    organizationId,
    applicationNote: 'S5 组合链路申请',
  });

  /** 注册成功后立即登记账号与申请事实（不依赖可能失败的回读） */
  const recordEngineerAccount = (
    accountId: number,
    engineer: { loginName: string; loginEmail: string },
  ): void => {
    recordOwnedResource(ownership, 'account', accountId, {
      loginName: engineer.loginName,
      loginEmail: engineer.loginEmail,
      status: AccountStatus.PENDING,
      identityHint: IdentityTypeEnum.ENGINEER,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      nickname: engineer.loginName,
      userInfoEmail: engineer.loginEmail,
      userState: UserState.PENDING,
      // Web 工程师注册不写可信公司归属（V44）
      customerOrganizationId: null,
    });
  };

  const verifyEngineerAccount = async (accountId: number): Promise<void> => {
    const expected = ownership.facts.account.get(accountId);
    if (expected === undefined) {
      throw new Error(`回读核验失败：账号 ${accountId} 未登记预期事实`);
    }

    const account = await accountRepo().findOneOrFail({ where: { id: accountId } });
    const userInfo = await userInfoRepo().findOneOrFail({ where: { accountId } });
    const accessGroup = Array.isArray(userInfo.accessGroup)
      ? userInfo.accessGroup
      : (JSON.parse(userInfo.accessGroup) as string[]);
    const mismatches: string[] = [];

    if ((account.loginName ?? null) !== expected.loginName) mismatches.push('loginName');
    if (account.loginEmail !== expected.loginEmail) mismatches.push('loginEmail');
    if (String(account.status) !== String(expected.status)) mismatches.push('status');
    if ((account.identityHint ?? null) !== expected.identityHint) mismatches.push('identityHint');
    if (JSON.stringify(accessGroup) !== JSON.stringify(expected.accessGroup)) {
      mismatches.push('accessGroup');
    }
    if (userInfo.nickname !== expected.nickname) mismatches.push('nickname');
    if ((userInfo.email ?? null) !== expected.userInfoEmail) mismatches.push('userInfoEmail');
    if (String(userInfo.userState) !== String(expected.userState)) mismatches.push('userState');
    if ((userInfo.customerOrganizationId ?? null) !== (expected.customerOrganizationId ?? null)) {
      mismatches.push('customerOrganizationId');
    }
    if (mismatches.length > 0) {
      throw new Error(
        `回读核验失败：账号 ${accountId} 与登记事实不一致（${mismatches.join(', ')}）`,
      );
    }
  };

  /**
   * 新增公司同事务开通的二级管理员：按真实回读登记账号与资料事实。
   * 成员关系由清理器按已登记账号自动扩图，组织删除前必须先清掉。
   */
  const recordProvisionedAdmin = async (organization: AdminOrganizationPayload): Promise<void> => {
    const admin = organization.provisionedAdmin;
    if (!admin) {
      throw new Error(`新增公司 ${organization.id} 未返回已开通管理员`);
    }
    const account = await accountRepo().findOneOrFail({ where: { id: admin.accountId } });
    const userInfo = await userInfoRepo().findOneOrFail({ where: { accountId: admin.accountId } });
    const accessGroup = Array.isArray(userInfo.accessGroup)
      ? userInfo.accessGroup
      : (JSON.parse(userInfo.accessGroup) as string[]);
    recordOwnedResource(ownership, 'account', admin.accountId, {
      loginName: account.loginName,
      loginEmail: account.loginEmail,
      status: account.status,
      identityHint: account.identityHint,
      accessGroup,
      nickname: userInfo.nickname,
      userInfoEmail: userInfo.email,
      userState: userInfo.userState,
      customerOrganizationId: userInfo.customerOrganizationId,
    });
  };

  const recordApplication = (
    applicationId: number,
    accountId: number,
    organizationId: number = companyId,
  ): void => {
    recordOwnedResource(ownership, 'engineerRegistrationApplication', applicationId, {
      accountId,
      organizationId,
      applicationNote: 'S5 组合链路申请',
    });
  };

  const registerEngineer = async (
    engineer: {
      loginName: string;
      loginEmail: string;
    },
    organizationId: number = companyId,
  ): Promise<{
    accountId: number;
    applicationId: number;
    body: GqlBody<{ register?: RegisterPayload }>;
  }> => {
    const body = await gql<{ register?: RegisterPayload }>({
      query: REGISTER_MUTATION,
      variables: { input: engineerRegisterInput(engineer, organizationId) },
    });
    const payload = body.data?.register;
    const accountId = payload?.accountId;
    const applicationId = payload?.applicationId;

    if (typeof accountId !== 'number' || typeof applicationId !== 'number') {
      throw new Error(`工程师注册未返回账号/申请主键：${JSON.stringify(body)}`);
    }

    recordApplication(applicationId, accountId, organizationId);
    recordEngineerAccount(accountId, engineer);
    await verifyEngineerAccount(accountId);

    return { accountId, applicationId, body };
  };

  const performLogin = async (
    loginName: string,
    loginPassword: string,
    allowRestrictedSession = false,
  ): Promise<GqlBody<LoginPayload>> =>
    await gql<LoginPayload>({
      query: LOGIN_MUTATION,
      variables: {
        input: {
          loginName,
          loginPassword,
          allowRestrictedSession,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
        },
      },
    });

  const myStatus = async (
    accountIdentifier: string,
    password: string,
  ): Promise<GqlBody<{ myEngineerRegistrationStatus?: StatusPayload }>> =>
    await gql<{ myEngineerRegistrationStatus?: StatusPayload }>({
      query: MY_STATUS_MUTATION,
      variables: {
        input: { accountIdentifier, password },
        pagination: DEFAULT_PAGINATION,
      },
    });

  const review = async (params: {
    applicationId: number;
    action: EngineerRegistrationReviewAction;
    reviewComment?: string;
  }): Promise<GqlBody<{ reviewEngineerRegistration?: AdminItemPayload }>> =>
    await gql<{ reviewEngineerRegistration?: AdminItemPayload }>({
      query: REVIEW_MUTATION,
      variables: {
        input: {
          applicationId: params.applicationId,
          action: params.action,
          reviewComment: params.reviewComment ?? null,
        },
      },
      token: adminToken,
    });

  it('一级管理员新增有效受管公司：ACTIVE + 受管 + CLIENT', async () => {
    const body = await gql<{ adminCreateOrganization?: AdminOrganizationPayload }>({
      query: ADMIN_CREATE_ORGANIZATION_MUTATION,
      variables: {
        input: { name: COMPANY_NAME, contactPhone: COMPANY_PHONE },
      },
      token: adminToken,
    });

    expect(body.errors).toBeUndefined();
    const organization = body.data?.adminCreateOrganization;
    expect(organization).toBeDefined();
    expect(organization?.name).toBe(COMPANY_NAME);
    expect(organization?.status).toBe('ACTIVE');
    expect(organization?.kind).toBe('CLIENT');
    expect(organization?.isManagedCompany).toBe(true);
    expect((organization?.organizationCode ?? '').length).toBeGreaterThan(0);

    companyId = organization?.id as number;
    recordOwnedResource(ownership, 'organization', companyId, {
      organizationCode: organization?.organizationCode as string,
      name: organization?.name as string,
      kind: organization?.kind as string,
      status: organization?.status as string,
      isManagedCompany: organization?.isManagedCompany,
    });
    await recordProvisionedAdmin(organization as AdminOrganizationPayload);
  });

  it('工程师 Web 注册进入待审：PENDING/PENDING、无成员关系，受限会话直调业务接口被拒', async () => {
    const recorded = await registerEngineer(ENGINEER_A);
    engineerAAccountId = recorded.accountId;
    engineerAApplicationId = recorded.applicationId;

    expect(recorded.body.errors).toBeUndefined();
    expect(recorded.body.data?.register?.success).toBe(true);
    expect(recorded.body.data?.register?.registrationStatus).toBe(
      RegistrationOutcomeStatus.PENDING_REVIEW,
    );

    const account = await accountRepo().findOneOrFail({ where: { id: engineerAAccountId } });
    expect(account.status).toBe(AccountStatus.PENDING);
    expect(account.identityHint).toBe(IdentityTypeEnum.ENGINEER);
    const userInfo = await userInfoRepo().findOneOrFail({
      where: { accountId: engineerAAccountId },
    });
    expect(userInfo.userState).toBe(UserState.PENDING);
    expect(await membershipRepo().count({ where: { accountId: engineerAAccountId } })).toBe(0);

    // 未显式允许受限会话：待审账号拿不到令牌
    const blockedLogin = await performLogin(ENGINEER_A.loginName, ENGINEER_PASSWORD);
    expect(blockedLogin.data?.login?.accessToken).toBeFalsy();
    expect(errorCodeOf(blockedLogin)).toBe('FORBIDDEN');

    // 显式允许后仅签发受限会话，业务 Query 仍被统一拒绝
    const restrictedLogin = await performLogin(ENGINEER_A.loginName, ENGINEER_PASSWORD, true);
    expect(restrictedLogin.errors).toBeUndefined();
    expect(restrictedLogin.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_PENDING);
    const restrictedToken = restrictedLogin.data?.login?.accessToken;
    expect(typeof restrictedToken).toBe('string');

    const businessProbe = await gql<{ userInfo?: unknown }>({
      query: USER_INFO_QUERY,
      variables: { accountId: engineerAAccountId },
      token: restrictedToken,
    });
    expect(businessProbe.data?.userInfo).toBeFalsy();
    expect(errorCodeOf(businessProbe)).toBe('FORBIDDEN');

    // 本人结果证据（替代任务 02 页面）：凭据可查、最新申请待审
    const status = await myStatus(ENGINEER_A.loginName, ENGINEER_PASSWORD);
    expect(status.errors).toBeUndefined();
    expect(status.data?.myEngineerRegistrationStatus?.accountId).toBe(engineerAAccountId);
    expect(status.data?.myEngineerRegistrationStatus?.latest?.status).toBe(
      EngineerRegistrationApplicationStatus.PENDING,
    );
  });

  it('一级管理员批准：账号/资料/成员/申请同事务生效，业务资格恢复', async () => {
    const approved = await review({
      applicationId: engineerAApplicationId,
      action: EngineerRegistrationReviewAction.APPROVE,
      reviewComment: 'S5 组合链路通过',
    });

    expect(approved.errors).toBeUndefined();
    expect(approved.data?.reviewEngineerRegistration?.application.status).toBe(
      EngineerRegistrationApplicationStatus.APPROVED,
    );
    expect(approved.data?.reviewEngineerRegistration?.application.reviewedByAccountId).toBe(
      adminAccountId,
    );

    const account = await accountRepo().findOneOrFail({ where: { id: engineerAAccountId } });
    expect(account.status).toBe(AccountStatus.ACTIVE);
    const userInfo = await userInfoRepo().findOneOrFail({
      where: { accountId: engineerAAccountId },
    });
    expect(userInfo.userState).toBe(UserState.ACTIVE);

    const membership = await membershipRepo().findOneOrFail({
      where: { organizationId: companyId, accountId: engineerAAccountId },
    });
    expect(membership.memberRole).toBe(IdentityTypeEnum.ENGINEER);
    expect(membership.status).toBe('ACTIVE');
    recordOwnedResource(ownership, 'membership', membership.id, {
      organizationId: companyId,
      accountId: engineerAAccountId,
      memberRole: IdentityTypeEnum.ENGINEER,
      status: membership.status,
    });

    // 审核是合法状态变更：同步台账预期，避免收尾预检误判为归属漂移
    updateOwnedExpectation(ownership, 'account', engineerAAccountId, {
      status: AccountStatus.ACTIVE,
      userState: UserState.ACTIVE,
    });

    const recoveredLogin = await performLogin(ENGINEER_A.loginName, ENGINEER_PASSWORD);
    expect(recoveredLogin.errors).toBeUndefined();
    expect(recoveredLogin.data?.login?.restriction).toBe(SessionRestriction.NONE);
    const token = recoveredLogin.data?.login?.accessToken as string;

    const businessProbe = await gql<{ userInfo?: { accountId?: number } }>({
      query: USER_INFO_QUERY,
      variables: { accountId: engineerAAccountId },
      token,
    });
    expect(businessProbe.errors).toBeUndefined();
    expect(businessProbe.data?.userInfo?.accountId).toBe(engineerAAccountId);
  });

  it('一级管理员拒绝：申请 REJECTED、账号保持 PENDING、无成员关系、业务仍受限', async () => {
    const recorded = await registerEngineer(ENGINEER_B);
    engineerBAccountId = recorded.accountId;
    engineerBApplicationId = recorded.applicationId;
    expect(recorded.body.errors).toBeUndefined();

    const rejected = await review({
      applicationId: engineerBApplicationId,
      action: EngineerRegistrationReviewAction.REJECT,
      reviewComment: 'S5 组合链路拒绝',
    });

    expect(rejected.errors).toBeUndefined();
    expect(rejected.data?.reviewEngineerRegistration?.application.status).toBe(
      EngineerRegistrationApplicationStatus.REJECTED,
    );

    const account = await accountRepo().findOneOrFail({ where: { id: engineerBAccountId } });
    expect(account.status).toBe(AccountStatus.PENDING);
    expect(await membershipRepo().count({ where: { accountId: engineerBAccountId } })).toBe(0);

    const status = await myStatus(ENGINEER_B.loginName, ENGINEER_PASSWORD);
    expect(status.errors).toBeUndefined();
    expect(status.data?.myEngineerRegistrationStatus?.latest?.status).toBe(
      EngineerRegistrationApplicationStatus.REJECTED,
    );

    const restrictedLogin = await performLogin(ENGINEER_B.loginName, ENGINEER_PASSWORD, true);
    expect(restrictedLogin.errors).toBeUndefined();
    expect(restrictedLogin.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_REJECTED);

    const businessProbe = await gql<{ userInfo?: unknown }>({
      query: USER_INFO_QUERY,
      variables: { accountId: engineerBAccountId },
      token: restrictedLogin.data?.login?.accessToken,
    });
    expect(businessProbe.data?.userInfo).toBeFalsy();
    expect(errorCodeOf(businessProbe)).toBe('FORBIDDEN');
  });

  it('提交后、批准前公司被停用：批准返回 CONFLICT，申请与账号保持待审、无成员关系', async () => {
    // 独立造数：本轮专用公司 + 申请人，与正向/拒绝用例互不影响
    const createdCompany = await gql<{ adminCreateOrganization?: AdminOrganizationPayload }>({
      query: ADMIN_CREATE_ORGANIZATION_MUTATION,
      variables: {
        input: { name: DISABLED_COMPANY_NAME, contactPhone: COMPANY_PHONE },
      },
      token: adminToken,
    });
    expect(createdCompany.errors).toBeUndefined();
    const organization = createdCompany.data?.adminCreateOrganization;
    expect(organization?.status).toBe('ACTIVE');
    const disabledCompanyId = organization?.id as number;
    expect(typeof disabledCompanyId).toBe('number');
    recordOwnedResource(ownership, 'organization', disabledCompanyId, {
      organizationCode: organization?.organizationCode as string,
      name: organization?.name as string,
      kind: organization?.kind as string,
      status: organization?.status as string,
      isManagedCompany: organization?.isManagedCompany,
    });
    await recordProvisionedAdmin(organization as AdminOrganizationPayload);

    const recorded = await registerEngineer(ENGINEER_C, disabledCompanyId);
    expect(recorded.body.errors).toBeUndefined();
    expect(recorded.body.data?.register?.registrationStatus).toBe(
      RegistrationOutcomeStatus.PENDING_REVIEW,
    );
    const engineerCAccountId = recorded.accountId;
    const engineerCApplicationId = recorded.applicationId;

    const pendingAccount = await accountRepo().findOneOrFail({ where: { id: engineerCAccountId } });
    expect(pendingAccount.status).toBe(AccountStatus.PENDING);
    const pendingUserInfo = await userInfoRepo().findOneOrFail({
      where: { accountId: engineerCAccountId },
    });
    expect(pendingUserInfo.userState).toBe(UserState.PENDING);
    expect(await membershipRepo().count({ where: { accountId: engineerCAccountId } })).toBe(0);

    const applicationFacts = async (): Promise<
      Array<{
        status: string;
        reviewedByAccountId: number | null;
        reviewedAt: Date | null;
        reviewComment: string | null;
      }>
    > =>
      await dataSource.query(
        `SELECT status,
                reviewed_by_account_id AS reviewedByAccountId,
                reviewed_at AS reviewedAt,
                review_comment AS reviewComment
           FROM engineer_registration_application
          WHERE id = ?`,
        [engineerCApplicationId],
      );

    const beforeReview = await applicationFacts();
    expect(beforeReview).toHaveLength(1);
    expect(beforeReview[0]?.status).toBe(EngineerRegistrationApplicationStatus.PENDING);
    expect(beforeReview[0]?.reviewedByAccountId).toBeNull();
    expect(beforeReview[0]?.reviewedAt).toBeNull();
    expect(beforeReview[0]?.reviewComment).toBeNull();

    // 提交后、批准前停用本轮公司，并回读 DISABLED
    const disabledCompany = await gql<{ adminUpdateOrganization?: AdminOrganizationPayload }>({
      query: ADMIN_UPDATE_ORGANIZATION_MUTATION,
      variables: { input: { organizationId: disabledCompanyId, status: 'DISABLED' } },
      token: adminToken,
    });
    expect(disabledCompany.errors).toBeUndefined();
    expect(disabledCompany.data?.adminUpdateOrganization?.status).toBe('DISABLED');

    const organizationRows = await dataSource.query(
      'SELECT status FROM organization WHERE id = ?',
      [disabledCompanyId],
    );
    expect(organizationRows).toHaveLength(1);
    expect(organizationRows[0]?.status).toBe('DISABLED');
    updateOwnedExpectation(ownership, 'organization', disabledCompanyId, { status: 'DISABLED' });

    // 批准应被拒绝：只有 CONFLICT 与业务文案，无成功数据
    const blockedApproval = await review({
      applicationId: engineerCApplicationId,
      action: EngineerRegistrationReviewAction.APPROVE,
      reviewComment: '停用公司不应通过',
    });

    expect(blockedApproval.data?.reviewEngineerRegistration).toBeUndefined();
    expect(errorCodeOf(blockedApproval)).toBe('CONFLICT');
    expect(blockedApproval.errors?.[0]?.message).toBe(
      '申请所属公司已停用或不可用，无法批准。申请仍为待审。',
    );

    // 四类库内事实不变：申请终态字段、账号、资料、成员关系
    expect(await applicationFacts()).toEqual(beforeReview);
    const stillPendingAccount = await accountRepo().findOneOrFail({
      where: { id: engineerCAccountId },
    });
    expect(stillPendingAccount.status).toBe(AccountStatus.PENDING);
    const stillPendingUserInfo = await userInfoRepo().findOneOrFail({
      where: { accountId: engineerCAccountId },
    });
    expect(stillPendingUserInfo.userState).toBe(UserState.PENDING);
    expect(await membershipRepo().count({ where: { accountId: engineerCAccountId } })).toBe(0);

    // 本人受限会话仍是待审，直调业务仍被拒绝
    const restrictedLogin = await performLogin(ENGINEER_C.loginName, ENGINEER_PASSWORD, true);
    expect(restrictedLogin.errors).toBeUndefined();
    expect(restrictedLogin.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_PENDING);
    const businessProbe = await gql<{ userInfo?: unknown }>({
      query: USER_INFO_QUERY,
      variables: { accountId: engineerCAccountId },
      token: restrictedLogin.data?.login?.accessToken,
    });
    expect(businessProbe.data?.userInfo).toBeFalsy();
    expect(errorCodeOf(businessProbe)).toBe('FORBIDDEN');
  });
});
