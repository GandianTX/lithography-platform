// test/13-admin-organization/company-provisioning-idempotency.e2e-spec.ts

import {
  AccountStatus,
  IdentityTypeEnum,
  LoginTypeEnum,
  AudienceTypeEnum,
} from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * S2 · 新增公司并开通二级管理员：提交标识幂等（真实 GraphQL + MySQL）。
 *
 * 覆盖计划 §4.10 六组：
 * 1. 同标识并发：一个首次创建、一个回放，公司与账号各恰 1 行、提交行恰 1 行；
 * 2. 首次成功响应丢失：同标识同输入重放返回相同引用且 `temporaryPassword=null`；
 * 3. 同标识改内容：`CONFLICT`（`SUBMISSION_CONFLICT`），库中零新增；
 * 4. 不同标识同名：两家公司、两个管理员、编号不同；
 * 5. 旧入口兼容：无标识连续两次都成功（不幂等）；带标识重放返回同一公司；
 * 6. 编辑与公开注册回归：既有编辑 mutation 与 `registerWeb` 各跑一次成功用例。
 *
 * 造数纪律：业务写入只走 GraphQL；数据库仅用于只读核验与受控清理。
 * 本规格不记录、不打印任何临时密码或哈希；断言只用「是否为 null」。
 */

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type ProvisionedAdmin = {
  accountId: number;
  loginName: string;
  nickname: string;
  mustChangePassword: boolean;
};

type ProvisioningOrganization = {
  id: number;
  organizationCode: string;
  name: string;
  status: string;
  isManagedCompany: boolean;
};

type ProvisionResult = {
  organization: ProvisioningOrganization;
  provisionedAdmin: ProvisionedAdmin;
  submission: { submissionId: number | null; replayed: boolean };
  temporaryPassword: string | null;
};

type LegacyCreateResult = {
  id: number;
  organizationCode: string;
  name: string;
  status: string;
  isManagedCompany: boolean;
  provisionedAdmin: ProvisionedAdmin | null;
};

type UpdateResult = {
  id: number;
  organizationCode: string;
  name: string;
  remark: string | null;
  status: string;
};

type RegisterResult = {
  success: boolean;
  message: string;
  accountId?: number | null;
  registrationStatus: string;
  applicationId?: number | null;
};

const PROVISION_MUTATION = `
  mutation AdminProvisionCompany($input: AdminCreateOrganizationInput!) {
    adminProvisionCompany(input: $input) {
      organization { id organizationCode name status isManagedCompany }
      provisionedAdmin { accountId loginName nickname mustChangePassword }
      submission { submissionId replayed }
      temporaryPassword
    }
  }
`;

const LEGACY_CREATE_MUTATION = `
  mutation AdminCreateOrganization($input: AdminCreateOrganizationInput!) {
    adminCreateOrganization(input: $input) {
      id organizationCode name status isManagedCompany
      provisionedAdmin { accountId loginName nickname mustChangePassword }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation AdminUpdateOrganization($input: AdminUpdateOrganizationInput!) {
    adminUpdateOrganization(input: $input) {
      id organizationCode name remark status
    }
  }
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

/** 工程师注册口令：满足后端密码策略（仅测试夹具使用） */
const REGISTER_PASSWORD = 'E2eS2Engineer@2026';
const ENGINEER_APPLICATION_NOTE = 'S2 幂等回归：公开注册成功';

describe('S2 新增公司并开通二级管理员·提交标识幂等 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const RUN_TAG = randomUUID().slice(0, 8);
  const ownership: OwnedResourceLedger = createOwnedResourceLedger();

  let adminToken = '';
  let adminAccountId = 0;

  const accountRepo = () => dataSource.getRepository(AccountEntity);
  const userInfoRepo = () => dataSource.getRepository(UserInfoEntity);

  const gql = async <T>(
    query: string,
    variables: unknown,
    options: { token?: string } = { token: adminToken },
  ): Promise<{ status: number; body: GqlBody<T> }> => {
    const response = await postGql({ app, token: options.token, query, variables });
    return { status: response.status, body: response.body as GqlBody<T> };
  };

  const personInput = (name: string, overrides: Record<string, unknown> = {}) => ({
    name,
    contactPhone: '021-58880000',
    contactEmail: 'contact@example.com',
    ...overrides,
  });

  const countOf = async (sql: string, params: unknown[]): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: number | string }>>(sql, params);
    return Number(rows[0]?.total ?? 0);
  };

  /** 登记公司事实（新增即受管、类别固定 CLIENT）。 */
  const trackOrganization = (organization: ProvisioningOrganization): void => {
    recordOwnedResource(ownership, 'organization', organization.id, {
      organizationCode: organization.organizationCode,
      name: organization.name,
      kind: 'CLIENT',
      status: organization.status,
      isManagedCompany: organization.isManagedCompany,
    });
  };

  /** 按真实回读登记同事务开通的二级管理员账号与资料事实。 */
  const trackProvisionedAdmin = async (admin: ProvisionedAdmin): Promise<void> => {
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

  /** 登记提交行归属证据：用途、公司、管理员账号与终态。 */
  const trackProvisioningRequest = (params: {
    submissionId: number;
    organizationId: number;
    adminAccountId: number;
  }): void => {
    recordOwnedResource(ownership, 'provisioningRequest', params.submissionId, {
      purpose: 'ADMIN_CREATE_ORGANIZATION',
      organizationId: params.organizationId,
      adminAccountId: params.adminAccountId,
      state: 'COMPLETED',
    });
  };

  const provisionCompany = (input: Record<string, unknown>) =>
    gql<{ adminProvisionCompany: ProvisionResult }>(PROVISION_MUTATION, { input });

  const createCompanyLegacy = (input: Record<string, unknown>) =>
    gql<{ adminCreateOrganization: LegacyCreateResult }>(LEGACY_CREATE_MUTATION, { input });

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    await seedTestAccounts({ dataSource, includeKeys: ['admin'], ownership });

    // 一级管理员：等级由请求期查库的 admin_level 决定（不写 JWT 字段）
    const admin = await accountRepo().findOneOrFail({
      where: { loginName: testAccountsConfig.admin.loginName },
    });
    await accountRepo().update(admin.id, { adminLevel: 1 });

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
      type: LoginTypeEnum.PASSWORD,
      audience: AudienceTypeEnum.DESKTOP,
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
          helper: 'company-provisioning-idempotency.e2e-spec afterAll 收尾',
        });

        const residue: Array<[string, number]> = [];
        const inClause = (values: number[]): string => values.map(() => '?').join(', ');

        const organizationIds = ownership.organizationIds;
        if (organizationIds.length > 0) {
          residue.push([
            'organization',
            await countOf(
              `SELECT COUNT(*) AS total FROM \`organization\` WHERE id IN (${inClause(organizationIds)})`,
              organizationIds,
            ),
          ]);
        }

        const accountIds = ownership.accountIds;
        if (accountIds.length > 0) {
          residue.push([
            'account',
            await countOf(
              `SELECT COUNT(*) AS total FROM base_user_account WHERE id IN (${inClause(accountIds)})`,
              accountIds,
            ),
          ]);
          residue.push([
            'userInfo',
            await countOf(
              `SELECT COUNT(*) AS total FROM base_user_info WHERE account_id IN (${inClause(accountIds)})`,
              accountIds,
            ),
          ]);
        }

        const submissionIds = ownership.provisioningRequestIds;
        if (submissionIds.length > 0) {
          residue.push([
            'provisioningRequest',
            await countOf(
              `SELECT COUNT(*) AS total FROM admin_organization_provisioning_request WHERE id IN (${inClause(submissionIds)})`,
              submissionIds,
            ),
          ]);
        }

        const leftovers = residue.filter(([, count]) => count !== 0);
        if (leftovers.length > 0) {
          throw new Error(
            `清理后仍存在残留：${leftovers.map(([name, count]) => `${name}=${count}`).join(', ')}`,
          );
        }
      },
    });
  });

  it('同标识并发：一个首次创建、一个回放，公司与账号各恰 1 行、提交行恰 1 行', async () => {
    const submissionKey = randomUUID();
    const name = `E2E-S2-并发-${RUN_TAG}`;
    const input = personInput(name);

    const [first, second] = await Promise.all([
      provisionCompany({ ...input, submissionKey }),
      provisionCompany({ ...input, submissionKey }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.errors).toBeUndefined();
    expect(second.body.errors).toBeUndefined();

    const a = first.body.data?.adminProvisionCompany;
    const b = second.body.data?.adminProvisionCompany;
    if (!a || !b) throw new Error('并发提交缺少返回结果');

    // 恰有一个是首次创建，另一个是回放。
    const replayedCount = [a, b].filter((item) => item.submission.replayed).length;
    expect(replayedCount).toBe(1);
    expect(a.organization.id).toBe(b.organization.id);
    expect(a.provisionedAdmin.accountId).toBe(b.provisionedAdmin.accountId);
    expect(a.submission.submissionId).toBe(b.submission.submissionId);

    // 一次性口令只在首次成功响应出现一次。
    const passwords = [a.temporaryPassword, b.temporaryPassword].filter(
      (item): item is string => item !== null,
    );
    expect(passwords).toHaveLength(1);
    // 用布尔断言而非 toMatch，避免断言失败时把临时密码明文写进失败信息。
    expect(passwords[0].startsWith('Aa1!')).toBe(true);

    // 库内事实：公司 1 行、管理员 1 行、提交行 1 行。
    expect(
      await countOf('SELECT COUNT(*) AS total FROM `organization` WHERE name = ?', [name]),
    ).toBe(1);
    expect(
      await countOf('SELECT COUNT(*) AS total FROM base_user_account WHERE login_name = ?', [
        a.provisionedAdmin.loginName,
      ]),
    ).toBe(1);
    expect(
      await countOf(
        'SELECT COUNT(*) AS total FROM admin_organization_provisioning_request WHERE purpose = ? AND actor_account_id = ? AND submission_key = ?',
        ['ADMIN_CREATE_ORGANIZATION', adminAccountId, submissionKey],
      ),
    ).toBe(1);

    const submissionId = a.submission.submissionId;
    if (submissionId === null) throw new Error('首次创建缺少提交行主键');
    trackOrganization(a.organization);
    await trackProvisionedAdmin(a.provisionedAdmin);
    trackProvisioningRequest({
      submissionId,
      organizationId: a.organization.id,
      adminAccountId: a.provisionedAdmin.accountId,
    });
  });

  it('首次成功响应丢失：同标识同输入重放返回相同引用且不再返回口令', async () => {
    const submissionKey = randomUUID();
    const name = `E2E-S2-重放-${RUN_TAG}`;
    const input = personInput(name);

    const first = await provisionCompany({ ...input, submissionKey });
    expect(first.status).toBe(200);
    const created = first.body.data?.adminProvisionCompany;
    if (!created) throw new Error('首次提交缺少返回结果');
    expect(created.submission.replayed).toBe(false);
    expect(created.temporaryPassword).not.toBeNull();

    const replay = await provisionCompany({ ...input, submissionKey });
    expect(replay.status).toBe(200);
    expect(replay.body.errors).toBeUndefined();
    const replayed = replay.body.data?.adminProvisionCompany;
    if (!replayed) throw new Error('重放缺少返回结果');

    expect(replayed.submission).toEqual({
      submissionId: created.submission.submissionId,
      replayed: true,
    });
    expect(replayed.organization.id).toBe(created.organization.id);
    expect(replayed.provisionedAdmin.accountId).toBe(created.provisionedAdmin.accountId);
    expect(replayed.provisionedAdmin.loginName).toBe(created.provisionedAdmin.loginName);
    expect(replayed.temporaryPassword).toBeNull();

    // 无第二家公司。
    expect(
      await countOf('SELECT COUNT(*) AS total FROM `organization` WHERE name = ?', [name]),
    ).toBe(1);

    const submissionId = created.submission.submissionId;
    if (submissionId === null) throw new Error('首次创建缺少提交行主键');
    trackOrganization(created.organization);
    await trackProvisionedAdmin(created.provisionedAdmin);
    trackProvisioningRequest({
      submissionId,
      organizationId: created.organization.id,
      adminAccountId: created.provisionedAdmin.accountId,
    });
  });

  it('同标识改内容：提交冲突且库中零新增', async () => {
    const submissionKey = randomUUID();
    const name = `E2E-S2-改内容-${RUN_TAG}`;
    const changedName = `${name}-改名`;

    const first = await provisionCompany({ ...personInput(name), submissionKey });
    expect(first.status).toBe(200);
    const created = first.body.data?.adminProvisionCompany;
    if (!created) throw new Error('首次提交缺少返回结果');

    const conflict = await provisionCompany({ ...personInput(changedName), submissionKey });
    const error = conflict.body.errors?.[0];
    expect(error).toBeDefined();
    expect(error?.extensions?.code).toBe('CONFLICT');

    expect(
      await countOf('SELECT COUNT(*) AS total FROM `organization` WHERE name = ?', [changedName]),
    ).toBe(0);
    expect(
      await countOf(
        'SELECT COUNT(*) AS total FROM admin_organization_provisioning_request WHERE purpose = ? AND actor_account_id = ? AND submission_key = ?',
        ['ADMIN_CREATE_ORGANIZATION', adminAccountId, submissionKey],
      ),
    ).toBe(1);

    const submissionId = created.submission.submissionId;
    if (submissionId === null) throw new Error('首次创建缺少提交行主键');
    trackOrganization(created.organization);
    await trackProvisionedAdmin(created.provisionedAdmin);
    trackProvisioningRequest({
      submissionId,
      organizationId: created.organization.id,
      adminAccountId: created.provisionedAdmin.accountId,
    });
  });

  it('不同标识同名：两家独立公司、两个管理员、编号不同', async () => {
    const name = `E2E-S2-同名-${RUN_TAG}`;
    const input = personInput(name);

    const first = await provisionCompany({ ...input, submissionKey: randomUUID() });
    const second = await provisionCompany({ ...input, submissionKey: randomUUID() });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const a = first.body.data?.adminProvisionCompany;
    const b = second.body.data?.adminProvisionCompany;
    if (!a || !b) throw new Error('同名两次新增缺少返回结果');

    expect(a.organization.id).not.toBe(b.organization.id);
    expect(a.organization.organizationCode).not.toBe(b.organization.organizationCode);
    expect(a.provisionedAdmin.accountId).not.toBe(b.provisionedAdmin.accountId);
    expect(a.submission.replayed).toBe(false);
    expect(b.submission.replayed).toBe(false);

    expect(
      await countOf('SELECT COUNT(*) AS total FROM `organization` WHERE name = ?', [name]),
    ).toBe(2);

    for (const result of [a, b]) {
      const submissionId = result.submission.submissionId;
      if (submissionId === null) throw new Error('新入口成功却缺少提交行主键');
      trackOrganization(result.organization);
      await trackProvisionedAdmin(result.provisionedAdmin);
      trackProvisioningRequest({
        submissionId,
        organizationId: result.organization.id,
        adminAccountId: result.provisionedAdmin.accountId,
      });
    }
  });

  it('旧入口兼容：无标识两次都成功（不幂等），带标识重放返回同一公司', async () => {
    const name = `E2E-S2-旧入口-${RUN_TAG}`;
    const legacyInput = personInput(name);

    const first = await createCompanyLegacy(legacyInput);
    const second = await createCompanyLegacy(legacyInput);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const a = first.body.data?.adminCreateOrganization;
    const b = second.body.data?.adminCreateOrganization;
    if (!a || !b || !a.provisionedAdmin || !b.provisionedAdmin) {
      throw new Error('旧入口缺少公司或管理员返回');
    }
    expect(a.id).not.toBe(b.id);
    expect(a.provisionedAdmin.accountId).not.toBe(b.provisionedAdmin.accountId);
    // 旧入口无标识：不写提交行。
    expect(
      await countOf(
        'SELECT COUNT(*) AS total FROM admin_organization_provisioning_request WHERE organization_id IN (?, ?)',
        [a.id, b.id],
      ),
    ).toBe(0);

    // 旧入口显式带标识：同标识重放返回同一公司。
    const submissionKey = randomUUID();
    const keyedName = `E2E-S2-旧入口标识-${RUN_TAG}`;
    const keyedFirst = await createCompanyLegacy({
      ...legacyInput,
      name: keyedName,
      submissionKey,
    });
    const keyedReplay = await createCompanyLegacy({
      ...legacyInput,
      name: keyedName,
      submissionKey,
    });
    const c = keyedFirst.body.data?.adminCreateOrganization;
    const d = keyedReplay.body.data?.adminCreateOrganization;
    if (!c || !d || !c.provisionedAdmin || !d.provisionedAdmin) {
      throw new Error('旧入口带标识缺少公司或管理员返回');
    }
    expect(c.id).toBe(d.id);
    expect(c.provisionedAdmin.accountId).toBe(d.provisionedAdmin.accountId);
    expect(
      await countOf('SELECT COUNT(*) AS total FROM `organization` WHERE name = ?', [keyedName]),
    ).toBe(1);

    const legacyCreated = [a, b, c].map((item) => {
      if (!item.provisionedAdmin) throw new Error('旧入口缺少管理员返回');
      return { organization: item, admin: item.provisionedAdmin };
    });
    for (const item of legacyCreated) {
      trackOrganization({
        id: item.organization.id,
        organizationCode: item.organization.organizationCode,
        name: item.organization.name,
        status: item.organization.status,
        isManagedCompany: item.organization.isManagedCompany,
      });
      await trackProvisionedAdmin(item.admin);
    }

    const submissionRows = await dataSource.query<Array<{ id: number; organization_id: number }>>(
      'SELECT id, organization_id FROM admin_organization_provisioning_request WHERE organization_id = ?',
      [c.id],
    );
    expect(submissionRows).toHaveLength(1);
    trackProvisioningRequest({
      submissionId: Number(submissionRows[0].id),
      organizationId: c.id,
      adminAccountId: c.provisionedAdmin.accountId,
    });
  });

  it('编辑回归：既有白名单编辑入口对新公司照常生效', async () => {
    const name = `E2E-S2-编辑-${RUN_TAG}`;
    const created = await provisionCompany({ ...personInput(name), submissionKey: randomUUID() });
    const result = created.body.data?.adminProvisionCompany;
    if (!result) throw new Error('编辑回归缺少新增结果');

    const updated = await gql<{ adminUpdateOrganization: UpdateResult }>(UPDATE_MUTATION, {
      input: { organizationId: result.organization.id, remark: `S2 编辑回归-${RUN_TAG}` },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.errors).toBeUndefined();
    const view = updated.body.data?.adminUpdateOrganization;
    expect(view?.id).toBe(result.organization.id);
    expect(view?.organizationCode).toBe(result.organization.organizationCode);
    expect(view?.remark).toBe(`S2 编辑回归-${RUN_TAG}`);

    const submissionId = result.submission.submissionId;
    if (submissionId === null) throw new Error('首次创建缺少提交行主键');
    trackOrganization(result.organization);
    await trackProvisionedAdmin(result.provisionedAdmin);
    trackProvisioningRequest({
      submissionId,
      organizationId: result.organization.id,
      adminAccountId: result.provisionedAdmin.accountId,
    });
  });

  it('公开注册回归：新公司仍可作为 Web 工程师注册候选', async () => {
    const name = `E2E-S2-注册-${RUN_TAG}`;
    const created = await provisionCompany({ ...personInput(name), submissionKey: randomUUID() });
    const result = created.body.data?.adminProvisionCompany;
    if (!result) throw new Error('注册回归缺少新增结果');

    const engineerLoginName = `e2es2eng${RUN_TAG}`;
    const engineerLoginEmail = `e2e.s2.eng.${RUN_TAG}@example.com`;

    const registered = await gql<{ register: RegisterResult }>(
      REGISTER_MUTATION,
      {
        input: {
          loginName: engineerLoginName,
          loginEmail: engineerLoginEmail,
          loginPassword: REGISTER_PASSWORD,
          nickname: engineerLoginName,
          realName: 'E2E S2 工程师',
          phone: '13800000000',
          type: RegisterTypeEnum.ENGINEER,
          organizationId: result.organization.id,
          applicationNote: ENGINEER_APPLICATION_NOTE,
        },
      },
      { token: undefined },
    );

    // 注册入口在两轮验收中分别走 200（成功）或 400（拒绝并返回业务错误），
    // 这里要求成功：新公司未停用、已受管，必须出现在 Web 注册候选中。
    expect(registered.body.errors).toBeUndefined();
    const payload = registered.body.data?.register;
    expect(payload?.success).toBe(true);
    if (payload?.accountId === null || payload?.accountId === undefined) {
      throw new Error('注册成功但缺少账号主键');
    }
    if (payload.applicationId === null || payload.applicationId === undefined) {
      throw new Error('注册成功但缺少申请主键');
    }

    recordOwnedResource(ownership, 'account', payload.accountId, {
      loginName: engineerLoginName,
      loginEmail: engineerLoginEmail,
      status: AccountStatus.PENDING,
      identityHint: IdentityTypeEnum.ENGINEER,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      nickname: engineerLoginName,
      userInfoEmail: engineerLoginEmail,
      userState: UserState.PENDING,
      customerOrganizationId: null,
    });
    recordOwnedResource(ownership, 'engineerRegistrationApplication', payload.applicationId, {
      accountId: payload.accountId,
      organizationId: result.organization.id,
      applicationNote: ENGINEER_APPLICATION_NOTE,
    });

    const submissionId = result.submission.submissionId;
    if (submissionId === null) throw new Error('首次创建缺少提交行主键');
    trackOrganization(result.organization);
    await trackProvisionedAdmin(result.provisionedAdmin);
    trackProvisioningRequest({
      submissionId,
      organizationId: result.organization.id,
      adminAccountId: result.provisionedAdmin.accountId,
    });
  });
});
