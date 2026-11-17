// test/13-admin-organization/level-two-credential.e2e-spec.ts

import { AudienceTypeEnum, LoginTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { getAccountIdByLoginName, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * S3 · 绑定查询 / 已绑定列表 / 补发与重置 / 会话失效（真实 GraphQL + MySQL）。
 *
 * 覆盖任务书 S3 五条：
 * 1. 一级按公司查询绑定：`BOUND` / `UNCONFIGURED` / `COMPANY_DISABLED` 与非受管安全状态，
 *    响应不含口令、哈希或完整凭据；
 * 2. 一级专用「已绑定二级管理员」窄查询：只列合法绑定，关键字与分页可用；
 * 3. 补发只在待首次改密时返回新随机临时密码，并同事务写哈希、置强制改密、递增代次、落审计；
 * 4. 补发后旧密码、旧 access token 与实际可用的 REST 业务入口均失效；首次临时登录只能走
 *    受限会话白名单（本人改密可用的同时，GraphQL / REST 业务入口被拒绝）；重置允许已改密目标；
 * 5. 二级管理员调用本组入口一律 `FORBIDDEN`。
 *
 * 造数纪律：业务写入只走 GraphQL；「无二级管理员的受管公司」无法由任何合法业务入口造出，
 * 因此这三条公司行以受控 SQL 直接插入（仅用于只读查询与写入口拒绝），并逐条登记归属台账。
 * 本规格不打印、不落盘任何临时密码或哈希；断言只用前缀 / 布尔 / 是否为空。
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

type BindingView = {
  organizationId: number;
  organizationCode: string;
  companyName: string;
  isManagedCompany: boolean;
  companyStatus: string;
  status: string;
  reason: string | null;
  boundAccountId: number | null;
  boundLoginNameMasked: string | null;
  candidateCount: number;
  accountDisabled: boolean;
};

type BoundAdminPage = {
  items: Array<{
    organizationId: number;
    organizationCode: string;
    companyName: string;
    companyStatus: string;
    accountId: number;
    loginName: string;
    nickname: string | null;
    accountDisabled: boolean;
  }>;
  total: number;
  page: number;
  pageSize: number;
};

type CredentialResult = {
  organizationId: number;
  adminAccountId: number;
  loginName: string;
  nickname: string | null;
  mustChangePassword: boolean;
  temporaryPassword: string;
};

type AuditRow = {
  event_id: string;
  actor_account_id: number;
  organization_id: number | null;
  operation: string;
  target_type: string;
  target_id: string;
  result: string;
  detail: string | null;
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

const BINDING_QUERY = `
  query AdminCompanyAdminBinding($organizationId: Int!) {
    adminCompanyAdminBinding(organizationId: $organizationId) {
      organizationId organizationCode companyName isManagedCompany companyStatus
      status reason boundAccountId boundLoginNameMasked candidateCount accountDisabled
    }
  }
`;

const BOUND_LIST_QUERY = `
  query AdminBoundLevelTwoAdmins($pagination: PaginationArgs!, $keyword: String) {
    adminBoundLevelTwoAdmins(pagination: $pagination, keyword: $keyword) {
      items {
        organizationId organizationCode companyName companyStatus
        accountId loginName nickname accountDisabled
      }
      total page pageSize
    }
  }
`;

const REISSUE_MUTATION = `
  mutation AdminReissueCompanyAdminCredential($input: AdminReissueLevelTwoCredentialInput!) {
    adminReissueCompanyAdminCredential(input: $input) {
      organizationId adminAccountId loginName nickname mustChangePassword temporaryPassword
    }
  }
`;

const RESET_MUTATION = `
  mutation AdminResetLevelTwoAdminCredential($input: AdminResetLevelTwoCredentialInput!) {
    adminResetLevelTwoAdminCredential(input: $input) {
      organizationId adminAccountId loginName nickname mustChangePassword temporaryPassword
    }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) { accessToken }
  }
`;

const CHANGE_PASSWORD_MUTATION = `
  mutation ChangeMyPassword($input: ChangeMyPasswordInput!) {
    changeMyPassword(input: $input) { isUpdated notice }
  }
`;

const NAME_LIST_PROBE = `
  query AdminOrganizationNameList($pagination: PaginationArgs!) {
    adminOrganizationNameList(pagination: $pagination) { total }
  }
`;

const UPDATE_ORGANIZATION_MUTATION = `
  mutation AdminUpdateOrganization($input: AdminUpdateOrganizationInput!) {
    adminUpdateOrganization(input: $input) { id status isManagedCompany }
  }
`;

const PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 50 } as const;
const RESET_REASON = 'S3 E2E 重置原因';
const FIRST_CHANGED_PASSWORD = 'E2eS3First#2026';
const SECOND_CHANGED_PASSWORD = 'E2eS3Second#2026';
const COMPANY_TOGGLE_PASSWORD = 'E2eS3Toggle#2026';

describe('S3 二级管理员绑定与凭据补发/重置 (e2e)', () => {
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
    token: string | undefined = adminToken,
  ): Promise<{ status: number; body: GqlBody<T> }> => {
    const response = await postGql({ app, token, query, variables });
    return { status: response.status, body: response.body as GqlBody<T> };
  };

  const personInput = (name: string) => ({
    name,
    contactPhone: '021-58880000',
    contactEmail: 'contact@example.com',
  });

  /** 登录（显式允许受限会话），成功返回 token，失败返回 null。 */
  const tryLogin = async (
    loginName: string,
    loginPassword: string,
  ): Promise<{ token: string | null; errors?: GqlError[] }> => {
    const response = await postGql({
      app,
      query: LOGIN_MUTATION,
      variables: {
        input: {
          loginName,
          loginPassword,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
          allowRestrictedSession: true,
        },
      },
    });
    const body = response.body as GqlBody<{ login?: { accessToken?: string } }>;
    if (body.errors !== undefined) {
      return { token: null, errors: body.errors };
    }
    const token = body.data?.login?.accessToken ?? null;
    if (token === null) throw new Error('登录响应缺少 accessToken');
    return { token };
  };

  const countOf = async (sql: string, params: unknown[]): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: number | string }>>(sql, params);
    return Number(rows[0]?.total ?? 0);
  };

  const readAccountCredentialFacts = async (
    accountId: number,
  ): Promise<{ mustChangePassword: boolean; credentialVersion: number }> => {
    const rows = await dataSource.query<
      Array<{ must_change_password: number; credential_version: number }>
    >('SELECT must_change_password, credential_version FROM base_user_account WHERE id = ?', [
      accountId,
    ]);
    if (rows.length !== 1) throw new Error('目标账号行缺失');
    return {
      mustChangePassword: Number(rows[0].must_change_password) === 1,
      credentialVersion: Number(rows[0].credential_version),
    };
  };

  const trackOrganization = (organization: ProvisioningOrganization): void => {
    recordOwnedResource(ownership, 'organization', organization.id, {
      organizationCode: organization.organizationCode,
      name: organization.name,
      kind: 'CLIENT',
      status: organization.status,
      isManagedCompany: organization.isManagedCompany,
    });
  };

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

  /** 只读回读同事务开通的成员关系，并按真实事实登记台账。 */
  const trackProvisionedMembership = async (
    organizationId: number,
    accountId: number,
  ): Promise<void> => {
    const rows = await dataSource.query<Array<{ id: number; member_role: string; status: string }>>(
      'SELECT id, member_role, status FROM organization_membership WHERE organization_id = ? AND account_id = ?',
      [organizationId, accountId],
    );
    for (const row of rows) {
      recordOwnedResource(ownership, 'membership', row.id, {
        organizationId,
        accountId,
        memberRole: row.member_role,
        status: row.status,
      });
    }
  };

  /** 回读本公司在案审计行并登记归属；审计行一经写入不可变。 */
  const trackManagementAuditEvents = async (organizationId: number): Promise<AuditRow[]> => {
    const rows = await dataSource.query<AuditRow[]>(
      'SELECT event_id, actor_account_id, organization_id, operation, target_type, target_id, result, detail FROM management_audit_event WHERE organization_id = ?',
      [organizationId],
    );
    for (const row of rows) {
      recordOwnedResource(ownership, 'managementAuditEvent', String(row.event_id), {
        actorAccountId: Number(row.actor_account_id),
        organizationId: row.organization_id === null ? null : Number(row.organization_id),
        operation: row.operation,
        targetType: row.target_type,
        targetId: row.target_id,
        result: row.result,
      });
    }
    return rows;
  };

  const provisionCompany = async (name: string) => {
    const response = await gql<{ adminProvisionCompany: ProvisionResult }>(PROVISION_MUTATION, {
      input: { ...personInput(name), submissionKey: randomUUID() },
    });
    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    const result = response.body.data?.adminProvisionCompany;
    if (!result || result.temporaryPassword === null) {
      throw new Error('开通公司缺少结果或一次性口令');
    }
    const submissionId = result.submission.submissionId;
    if (submissionId === null) throw new Error('开通公司缺少提交行主键');
    recordOwnedResource(ownership, 'provisioningRequest', submissionId, {
      purpose: 'ADMIN_CREATE_ORGANIZATION',
      organizationId: result.organization.id,
      adminAccountId: result.provisionedAdmin.accountId,
      state: 'COMPLETED',
    });
    trackOrganization(result.organization);
    await trackProvisionedAdmin(result.provisionedAdmin);
    await trackProvisionedMembership(result.organization.id, result.provisionedAdmin.accountId);
    return result;
  };

  /** 受控 SQL 夹具：无二级管理员的公司（无法由任何合法业务入口造出）。 */
  const insertCompanyFixture = async (params: {
    label: string;
    status: 'ACTIVE' | 'DISABLED';
    isManagedCompany: boolean;
  }): Promise<number> => {
    const organizationCode = `E2E_S3_${params.label}_${RUN_TAG}`.toUpperCase();
    const name = `E2E-S3-${params.label}-${RUN_TAG}`;
    await dataSource.query(
      'INSERT INTO organization (organization_code, name, kind, status, is_managed_company) VALUES (?, ?, ?, ?, ?)',
      [organizationCode, name, 'CLIENT', params.status, params.isManagedCompany ? 1 : 0],
    );
    const rows = await dataSource.query<Array<{ id: number }>>(
      'SELECT id FROM organization WHERE organization_code = ?',
      [organizationCode],
    );
    if (rows.length !== 1) throw new Error('夹具公司插入后未找到唯一行');
    const organizationId = Number(rows[0].id);
    recordOwnedResource(ownership, 'organization', organizationId, {
      organizationCode,
      name,
      kind: 'CLIENT',
      status: params.status,
      isManagedCompany: params.isManagedCompany,
    });
    return organizationId;
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    await seedTestAccounts({ dataSource, includeKeys: ['admin'], ownership });
    const admin = await accountRepo().findOneOrFail({
      where: { loginName: testAccountsConfig.admin.loginName },
    });
    await accountRepo().update(admin.id, { adminLevel: 1 });

    adminToken = await (async (): Promise<string> => {
      const attempt = await tryLogin(
        testAccountsConfig.admin.loginName,
        testAccountsConfig.admin.loginPassword,
      );
      if (attempt.token === null) throw new Error('一级管理员登录失败');
      return attempt.token;
    })();
    adminAccountId = await getAccountIdByLoginName(dataSource, testAccountsConfig.admin.loginName);
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;

        await runGuardedSpecCleanup({
          dataSource,
          owned: ownership,
          helper: 'level-two-credential.e2e-spec afterAll 收尾',
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

        const auditIds = ownership.managementAuditEventIds.map(String);
        if (auditIds.length > 0) {
          residue.push([
            'managementAuditEvent',
            await countOf(
              `SELECT COUNT(*) AS total FROM management_audit_event WHERE event_id IN (${auditIds
                .map(() => '?')
                .join(', ')})`,
              auditIds,
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

  it('一级按公司查询绑定与已绑定列表：只读、无凭据、状态清晰', async () => {
    const provisioned = await provisionCompany(`E2E-S3-查询-${RUN_TAG}`);
    const organizationId = provisioned.organization.id;
    const boundAdmin = provisioned.provisionedAdmin;

    const binding = await gql<{ adminCompanyAdminBinding: BindingView }>(BINDING_QUERY, {
      organizationId,
    });
    expect(binding.status).toBe(200);
    expect(binding.body.errors).toBeUndefined();
    const view = binding.body.data?.adminCompanyAdminBinding;
    if (!view) throw new Error('绑定查询缺少返回结果');

    expect(view).toMatchObject({
      organizationId,
      organizationCode: provisioned.organization.organizationCode,
      companyName: provisioned.organization.name,
      isManagedCompany: true,
      companyStatus: 'ACTIVE',
      status: 'BOUND',
      reason: null,
      boundAccountId: boundAdmin.accountId,
      candidateCount: 1,
      accountDisabled: false,
    });
    // 对外只允许脱敏登录名：不得出现完整登录名，也不得出现任何凭据字段。
    expect(view.boundLoginNameMasked).not.toBe(boundAdmin.loginName);
    expect(view.boundLoginNameMasked).toMatch(/^.\*\*\*.$/);
    expect(view.boundLoginNameMasked?.startsWith(boundAdmin.loginName[0])).toBe(true);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(boundAdmin.loginName);
    expect(serialized).not.toMatch(/password|hash|credential/i);
    expect(Object.keys(view).sort()).toEqual(
      [
        'accountDisabled',
        'boundAccountId',
        'boundLoginNameMasked',
        'candidateCount',
        'companyName',
        'companyStatus',
        'isManagedCompany',
        'organizationCode',
        'organizationId',
        'reason',
        'status',
      ].sort(),
    );

    const list = await gql<{ adminBoundLevelTwoAdmins: BoundAdminPage }>(BOUND_LIST_QUERY, {
      pagination: PAGINATION,
      keyword: RUN_TAG,
    });
    expect(list.body.errors).toBeUndefined();
    const page = list.body.data?.adminBoundLevelTwoAdmins;
    if (!page) throw new Error('已绑定列表缺少返回结果');
    const target = page.items.find((item) => item.accountId === boundAdmin.accountId);
    expect(target).toMatchObject({
      organizationId,
      companyName: provisioned.organization.name,
      loginName: boundAdmin.loginName,
      accountDisabled: false,
    });
    expect(page.items.every((item) => item.companyStatus === 'ACTIVE')).toBe(true);

    const miss = await gql<{ adminBoundLevelTwoAdmins: BoundAdminPage }>(BOUND_LIST_QUERY, {
      pagination: PAGINATION,
      keyword: `no-such-${RUN_TAG}`,
    });
    expect(miss.body.errors).toBeUndefined();
    expect(miss.body.data?.adminBoundLevelTwoAdmins.total).toBe(0);

    await trackManagementAuditEvents(organizationId);
  });

  it('补发→旧凭据失效→首次改密→重置→二级管理员拒绝', async () => {
    const provisioned = await provisionCompany(`E2E-S3-凭据-${RUN_TAG}`);
    const organizationId = provisioned.organization.id;
    const boundAdmin = provisioned.provisionedAdmin;
    const temp0 = provisioned.temporaryPassword as string;

    // 首次临时登录：只能拿到受限会话，但登录本身成功。
    const firstLogin = await tryLogin(boundAdmin.loginName, temp0);
    if (firstLogin.token === null) throw new Error('首次临时登录失败');
    const tempSessionToken = firstLogin.token;

    // 补发：写新哈希、置强制改密、递增代次、同事务审计。
    const before = await readAccountCredentialFacts(boundAdmin.accountId);
    expect(before.mustChangePassword).toBe(true);

    const reissued = await gql<{ adminReissueCompanyAdminCredential: CredentialResult }>(
      REISSUE_MUTATION,
      { input: { organizationId } },
    );
    expect(reissued.status).toBe(200);
    expect(reissued.body.errors).toBeUndefined();
    const reissueResult = reissued.body.data?.adminReissueCompanyAdminCredential;
    if (!reissueResult) throw new Error('补发缺少返回结果');
    expect(reissueResult.adminAccountId).toBe(boundAdmin.accountId);
    expect(reissueResult.mustChangePassword).toBe(true);
    expect(reissueResult.temporaryPassword.startsWith('Aa1!')).toBe(true);
    expect(reissueResult.temporaryPassword).not.toBe(temp0);
    const temp1 = reissueResult.temporaryPassword;

    const afterReissue = await readAccountCredentialFacts(boundAdmin.accountId);
    expect(afterReissue.mustChangePassword).toBe(true);
    expect(afterReissue.credentialVersion).toBe(before.credentialVersion + 1);

    const auditsAfterReissue = await trackManagementAuditEvents(organizationId);
    const reissueAudit = auditsAfterReissue.find(
      (row) => row.operation === 'REISSUE_LEVEL2_CREDENTIAL',
    );
    if (!reissueAudit) throw new Error('补发未写入审计行');
    expect(reissueAudit.target_id).toBe(String(boundAdmin.accountId));
    expect(reissueAudit.actor_account_id).toBe(adminAccountId);
    expect(reissueAudit.detail ?? '').not.toContain(temp1);
    const reissueDetail = JSON.parse(reissueAudit.detail ?? '{}') as Record<string, unknown>;
    expect(Object.keys(reissueDetail)).toEqual(['loginNameMasked']);
    expect(reissueDetail.loginNameMasked).not.toBe(boundAdmin.loginName);

    // 补发前的 access token 立即失效（凭据代次门禁）。
    const staleTokenProbe = await gql<{ adminOrganizationNameList: { total: number } }>(
      NAME_LIST_PROBE,
      { pagination: PAGINATION },
      tempSessionToken,
    );
    expect(staleTokenProbe.body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(staleTokenProbe.body.errors?.[0]?.extensions?.errorCode).toBe(
      'JWT_AUTHENTICATION_FAILED',
    );

    // 旧临时密码失效，新临时密码可登录。
    const oldPasswordLogin = await tryLogin(boundAdmin.loginName, temp0);
    expect(oldPasswordLogin.token).toBeNull();
    expect(oldPasswordLogin.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');

    const tempLogin = await tryLogin(boundAdmin.loginName, temp1);
    if (tempLogin.token === null) throw new Error('补发后的临时密码无法登录');
    const tempToken = tempLogin.token;

    // 临时登录白名单：GraphQL 业务入口与 REST 业务入口均被拒绝。
    const gqlBusinessProbe = await gql<{ adminOrganizationNameList: { total: number } }>(
      NAME_LIST_PROBE,
      { pagination: PAGINATION },
      tempToken,
    );
    expect(gqlBusinessProbe.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(gqlBusinessProbe.body.errors?.[0]?.extensions?.errorCode).toBe(
      'INSUFFICIENT_PERMISSIONS',
    );

    const restBusinessProbe = await request(app.getHttpServer())
      .get('/api/stored-files/1')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(restBusinessProbe.status).toBe(403);

    // 本人改密仍在白名单内。
    const changed = await gql<{ changeMyPassword: { isUpdated: boolean } }>(
      CHANGE_PASSWORD_MUTATION,
      { input: { currentPassword: temp1, newPassword: FIRST_CHANGED_PASSWORD } },
      tempToken,
    );
    expect(changed.body.errors).toBeUndefined();
    expect(changed.body.data?.changeMyPassword.isUpdated).toBe(true);

    // 改密后旧临时 token 同样失效。
    const afterChangeProbe = await gql<{ adminOrganizationNameList: { total: number } }>(
      NAME_LIST_PROBE,
      { pagination: PAGINATION },
      tempToken,
    );
    expect(afterChangeProbe.body.errors?.[0]?.extensions?.errorCode).toBe(
      'JWT_AUTHENTICATION_FAILED',
    );

    // 已完成首次改密：补发必须拒绝，重置方可重新开通。
    const reissueAfterChange = await gql<{ adminReissueCompanyAdminCredential: CredentialResult }>(
      REISSUE_MUTATION,
      { input: { organizationId } },
    );
    expect(reissueAfterChange.body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(reissueAfterChange.body.errors?.[0]?.extensions?.errorCode).toBe(
      'ORGANIZATION_MANAGEMENT_CREDENTIAL_REISSUE_NOT_ALLOWED',
    );

    // 重置：错目标拒绝；原因为空拒绝；正确目标成功。
    const wrongTargetReset = await gql<{ adminResetLevelTwoAdminCredential: CredentialResult }>(
      RESET_MUTATION,
      { input: { organizationId, adminAccountId, reason: RESET_REASON } },
    );
    expect(wrongTargetReset.body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(wrongTargetReset.body.errors?.[0]?.extensions?.errorCode).toBe(
      'ORGANIZATION_MANAGEMENT_ADMIN_BINDING_REQUIRED',
    );

    const blankReasonReset = await gql<{ adminResetLevelTwoAdminCredential: CredentialResult }>(
      RESET_MUTATION,
      { input: { organizationId, adminAccountId: boundAdmin.accountId, reason: '   ' } },
    );
    expect(blankReasonReset.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(blankReasonReset.body.errors?.[0]?.extensions?.errorCode).toBe(
      'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
    );

    const beforeReset = await readAccountCredentialFacts(boundAdmin.accountId);
    const reset = await gql<{ adminResetLevelTwoAdminCredential: CredentialResult }>(
      RESET_MUTATION,
      {
        input: {
          organizationId,
          adminAccountId: boundAdmin.accountId,
          reason: `  ${RESET_REASON}  `,
        },
      },
    );
    expect(reset.body.errors).toBeUndefined();
    const resetResult = reset.body.data?.adminResetLevelTwoAdminCredential;
    if (!resetResult) throw new Error('重置缺少返回结果');
    expect(resetResult.temporaryPassword.startsWith('Aa1!')).toBe(true);
    expect(resetResult.temporaryPassword).not.toBe(temp1);
    const temp2 = resetResult.temporaryPassword;

    const afterReset = await readAccountCredentialFacts(boundAdmin.accountId);
    expect(afterReset.mustChangePassword).toBe(true);
    expect(afterReset.credentialVersion).toBe(beforeReset.credentialVersion + 1);

    const auditsAfterReset = await trackManagementAuditEvents(organizationId);
    const resetAudit = auditsAfterReset.find((row) => row.operation === 'RESET_LEVEL2_CREDENTIAL');
    if (!resetAudit) throw new Error('重置未写入审计行');
    expect(resetAudit.target_id).toBe(String(boundAdmin.accountId));
    expect(resetAudit.detail ?? '').not.toContain(temp2);
    const resetDetail = JSON.parse(resetAudit.detail ?? '{}') as Record<string, unknown>;
    expect(resetDetail.reason).toBe(RESET_REASON);
    expect(resetDetail.loginNameMasked).not.toBe(boundAdmin.loginName);

    // 重置前密码与重置后密码：前者失效，后者可登录。
    const changedPasswordLogin = await tryLogin(boundAdmin.loginName, FIRST_CHANGED_PASSWORD);
    expect(changedPasswordLogin.token).toBeNull();

    const afterResetLogin = await tryLogin(boundAdmin.loginName, temp2);
    if (afterResetLogin.token === null) throw new Error('重置后的临时密码无法登录');
    const afterResetToken = afterResetLogin.token;

    const finalChange = await gql<{ changeMyPassword: { isUpdated: boolean } }>(
      CHANGE_PASSWORD_MUTATION,
      { input: { currentPassword: temp2, newPassword: SECOND_CHANGED_PASSWORD } },
      afterResetToken,
    );
    expect(finalChange.body.errors).toBeUndefined();

    // 已恢复普通会话的合法二级管理员：本组入口仍一律 FORBIDDEN（等级 2 无权）。
    const levelTwoLogin = await tryLogin(boundAdmin.loginName, SECOND_CHANGED_PASSWORD);
    if (levelTwoLogin.token === null) throw new Error('二级管理员改密后无法登录');
    const levelTwoToken = levelTwoLogin.token;

    const levelTwoBinding = await gql<{ adminCompanyAdminBinding: BindingView }>(
      BINDING_QUERY,
      { organizationId },
      levelTwoToken,
    );
    expect(levelTwoBinding.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(levelTwoBinding.body.errors?.[0]?.extensions?.errorCode).toBe(
      'INSUFFICIENT_PERMISSIONS',
    );

    const levelTwoList = await gql<{ adminBoundLevelTwoAdmins: BoundAdminPage }>(
      BOUND_LIST_QUERY,
      { pagination: PAGINATION, keyword: RUN_TAG },
      levelTwoToken,
    );
    expect(levelTwoList.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    const levelTwoReissue = await gql<{ adminReissueCompanyAdminCredential: CredentialResult }>(
      REISSUE_MUTATION,
      { input: { organizationId } },
      levelTwoToken,
    );
    expect(levelTwoReissue.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    const levelTwoReset = await gql<{ adminResetLevelTwoAdminCredential: CredentialResult }>(
      RESET_MUTATION,
      { input: { organizationId, adminAccountId: boundAdmin.accountId, reason: RESET_REASON } },
      levelTwoToken,
    );
    expect(levelTwoReset.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('公司停用与重新启用：旧会话在启用后仍不可复活', async () => {
    const provisioned = await provisionCompany(`E2E-S3-启停-${RUN_TAG}`);
    const organizationId = provisioned.organization.id;
    const boundAdmin = provisioned.provisionedAdmin;
    const tempPassword = provisioned.temporaryPassword as string;

    const firstLogin = await tryLogin(boundAdmin.loginName, tempPassword);
    if (firstLogin.token === null) throw new Error('首次临时登录失败');
    const changed = await gql<{ changeMyPassword: { isUpdated: boolean } }>(
      CHANGE_PASSWORD_MUTATION,
      { input: { currentPassword: tempPassword, newPassword: COMPANY_TOGGLE_PASSWORD } },
      firstLogin.token,
    );
    expect(changed.body.errors).toBeUndefined();

    const normalLogin = await tryLogin(boundAdmin.loginName, COMPANY_TOGGLE_PASSWORD);
    if (normalLogin.token === null) throw new Error('首次改密后无法登录');
    const staleLevelTwoToken = normalLogin.token;

    const updateStatus = async (status: 'ACTIVE' | 'DISABLED') => {
      const response = await gql<{
        adminUpdateOrganization: { id: number; status: string; isManagedCompany: boolean };
      }>(UPDATE_ORGANIZATION_MUTATION, { input: { organizationId, status } });
      expect(response.body.errors).toBeUndefined();
      return response.body.data?.adminUpdateOrganization;
    };

    expect(await updateStatus('DISABLED')).toMatchObject({
      id: organizationId,
      status: 'DISABLED',
      isManagedCompany: true,
    });

    const bindingDisabled = await gql<{ adminCompanyAdminBinding: BindingView }>(BINDING_QUERY, {
      organizationId,
    });
    expect(bindingDisabled.body.data?.adminCompanyAdminBinding).toMatchObject({
      companyStatus: 'DISABLED',
      status: 'COMPANY_DISABLED',
    });

    // 停用后旧 access token 立即失效。
    const probeWhileDisabled = await gql<{ adminOrganizationNameList: { total: number } }>(
      NAME_LIST_PROBE,
      { pagination: PAGINATION },
      staleLevelTwoToken,
    );
    expect(probeWhileDisabled.body.errors?.[0]?.extensions?.errorCode).toBe(
      'JWT_AUTHENTICATION_FAILED',
    );

    expect(await updateStatus('ACTIVE')).toMatchObject({
      id: organizationId,
      status: 'ACTIVE',
      isManagedCompany: true,
    });

    // 重新启用只恢复公司事实，不恢复停用前的旧会话（凭据代次已永久递增）。
    const probeAfterEnable = await gql<{ adminOrganizationNameList: { total: number } }>(
      NAME_LIST_PROBE,
      { pagination: PAGINATION },
      staleLevelTwoToken,
    );
    expect(probeAfterEnable.body.errors?.[0]?.extensions?.errorCode).toBe(
      'JWT_AUTHENTICATION_FAILED',
    );

    const bindingEnabled = await gql<{ adminCompanyAdminBinding: BindingView }>(BINDING_QUERY, {
      organizationId,
    });
    expect(bindingEnabled.body.data?.adminCompanyAdminBinding).toMatchObject({
      companyStatus: 'ACTIVE',
      status: 'BOUND',
      boundAccountId: boundAdmin.accountId,
    });

    // 账号本身未停用：重新登录可签发新会话，证明旧会话失效来自凭据代次。
    const freshLogin = await tryLogin(boundAdmin.loginName, COMPANY_TOGGLE_PASSWORD);
    expect(freshLogin.token).not.toBeNull();

    await trackManagementAuditEvents(organizationId);
  });

  it('未配置 / 公司停用 / 非受管：安全状态与写入口拒绝', async () => {
    const unconfiguredId = await insertCompanyFixture({
      label: 'UNCONFIGURED',
      status: 'ACTIVE',
      isManagedCompany: true,
    });
    const disabledId = await insertCompanyFixture({
      label: 'DISABLED',
      status: 'DISABLED',
      isManagedCompany: true,
    });
    const unmanagedId = await insertCompanyFixture({
      label: 'UNMANAGED',
      status: 'ACTIVE',
      isManagedCompany: false,
    });

    const readBinding = async (organizationId: number): Promise<BindingView> => {
      const response = await gql<{ adminCompanyAdminBinding: BindingView }>(BINDING_QUERY, {
        organizationId,
      });
      expect(response.body.errors).toBeUndefined();
      const view = response.body.data?.adminCompanyAdminBinding;
      if (!view) throw new Error('绑定查询缺少返回结果');
      return view;
    };

    expect(await readBinding(unconfiguredId)).toMatchObject({
      isManagedCompany: true,
      status: 'UNCONFIGURED',
      reason: null,
      boundAccountId: null,
      boundLoginNameMasked: null,
      candidateCount: 0,
      accountDisabled: false,
    });

    expect(await readBinding(disabledId)).toMatchObject({
      isManagedCompany: true,
      companyStatus: 'DISABLED',
      status: 'COMPANY_DISABLED',
      boundAccountId: null,
      candidateCount: 0,
    });

    expect(await readBinding(unmanagedId)).toMatchObject({
      isManagedCompany: false,
      status: 'UNCONFIGURED',
      boundAccountId: null,
      candidateCount: 0,
    });

    const reissueUnconfigured = await gql<{ adminReissueCompanyAdminCredential: CredentialResult }>(
      REISSUE_MUTATION,
      { input: { organizationId: unconfiguredId } },
    );
    expect(reissueUnconfigured.body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(reissueUnconfigured.body.errors?.[0]?.extensions?.errorCode).toBe(
      'ORGANIZATION_MANAGEMENT_ADMIN_BINDING_REQUIRED',
    );

    const resetUnmanaged = await gql<{ adminResetLevelTwoAdminCredential: CredentialResult }>(
      RESET_MUTATION,
      { input: { organizationId: unmanagedId, adminAccountId, reason: RESET_REASON } },
    );
    expect(resetUnmanaged.body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(resetUnmanaged.body.errors?.[0]?.extensions?.errorCode).toBe(
      'ORGANIZATION_MANAGEMENT_ADMIN_BINDING_REQUIRED',
    );

    const reissueDisabled = await gql<{ adminReissueCompanyAdminCredential: CredentialResult }>(
      REISSUE_MUTATION,
      { input: { organizationId: disabledId } },
    );
    expect(reissueDisabled.body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(reissueDisabled.body.errors?.[0]?.extensions?.errorCode).toBe(
      'ORGANIZATION_MANAGEMENT_CREDENTIAL_REISSUE_NOT_ALLOWED',
    );

    // 安全状态查询与拒绝写入口都不产生审计行。
    expect(
      await countOf(
        'SELECT COUNT(*) AS total FROM management_audit_event WHERE organization_id IN (?, ?, ?)',
        [unconfiguredId, disabledId, unmanagedId],
      ),
    ).toBe(0);
  });
});
