// 文件位置：test/04-user-info/update-visible-user-info.e2e-spec.ts
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { getAccountIdByLoginName } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
  updateOwnedExpectation,
} from '../utils/e2e-scoped-cleanup';
import {
  createTestAccount,
  seedTestAccounts,
  testAccountsConfig,
  type TestAccountConfig,
} from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
  seedTestMemberships,
  seedTestOrganizations,
  type TestOrganizationSpec,
} from '../utils/test-organizations';

/**
 * 本轮组织范围夹具（P1）：
 * - `orglessEngineer`：无任何组织成员关系（历史账号口径），用于「操作者无组织」拒绝；
 * - `crossOrgGuest`：与操作者不同组织的客户，用于跨组织读写拒绝；
 * - `leftMemberGuest`：成员关系已 LEFT，与操作者组织相同但没有**有效**成员关系。
 * 三者均为本轮专属账号，创建后立即登记真实 ID 与预期事实，由 afterAll 精确回收。
 */
const ORGLESS_ENGINEER: TestAccountConfig = {
  loginName: 'e2evi_orgless_engineer',
  loginEmail: 'e2e.vi.orgless.engineer@example.com',
  loginPassword: 'E2eViOrgless@2026',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  identityType: IdentityTypeEnum.ENGINEER,
};

const CROSS_ORG_GUEST: TestAccountConfig = {
  loginName: 'e2evi_cross_org_guest',
  loginEmail: 'e2e.vi.cross.org.guest@example.com',
  loginPassword: 'E2eViCrossOrg@2026',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  identityType: IdentityTypeEnum.CUSTOMER,
};

const LEFT_MEMBER_GUEST: TestAccountConfig = {
  loginName: 'e2evi_left_member_guest',
  loginEmail: 'e2e.vi.left.member.guest@example.com',
  loginPassword: 'E2eViLeftMember@2026',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  identityType: IdentityTypeEnum.CUSTOMER,
};

/**
 * 旧 `account(id)` 的管理员组织成立条件是「原 SUPER_ADMIN 权限 + 可信同组织」，
 * 因此「操作者自身组织缺失」只对具备 SUPER_ADMIN 角色的操作者可达。
 *
 * 注：库级唯一键 `uk_organization_membership_active_account` 已保证一个账号只有一个
 * ACTIVE 成员关系，多组织歧义无法通过真实数据构造；`ORGANIZATION_AMBIGUOUS_MEMBERSHIP`
 * 的失败关闭由 usecase 单测（下游替身）覆盖。
 */
const ORGLESS_ADMIN: TestAccountConfig = {
  loginName: 'e2evi_orgless_admin',
  loginEmail: 'e2e.vi.orgless.admin@example.com',
  loginPassword: 'E2eViOrglessAdmin@2026',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
  identityType: IdentityTypeEnum.SUPER_ADMIN,
};

const organizationCodes = buildSuiteOrganizationCodes('VIRG');

const SUITE_ORGANIZATIONS: readonly TestOrganizationSpec[] = [
  {
    organizationCode: organizationCodes.primary,
    name: '旧账号资料同组织（夹具专属）',
    kind: 'CLIENT',
  },
  {
    organizationCode: organizationCodes.peer,
    name: '旧账号资料跨组织（夹具专属）',
    kind: 'CLIENT',
  },
];

/**
 * 登录并获取访问令牌
 * - 使用 GraphQL `login` 变更，返回 `accessToken`
 */
async function loginAndGetToken(
  app: INestApplication,
  loginName: string,
  loginPassword: string,
): Promise<string> {
  const resp = await request(app.getHttpServer())
    .post('/graphql')
    .send({
      query: `
        mutation Login($input: AuthLoginInput!) {
          login(input: $input) { accessToken }
        }
      `,
      variables: {
        input: {
          loginName,
          loginPassword,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
        },
      },
    })
    .expect(200);
  if (resp.body.errors) throw new Error(`登录失败: ${JSON.stringify(resp.body.errors)}`);
  return resp.body.data.login.accessToken as string;
}

/**
 * 读取当前用户的 `accountId`
 * - 通过 GraphQL `login` 返回的字段获取
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
async function _getMyAccountId(
  app: INestApplication,
  loginName: string,
  loginPassword: string,
): Promise<number> {
  const resp = await request(app.getHttpServer())
    .post('/graphql')
    .send({
      query: `
        mutation Login($input: AuthLoginInput!) { login(input: $input) { accountId } }
      `,
      variables: {
        input: {
          loginName,
          loginPassword,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
        },
      },
    })
    .expect(200);
  if (resp.body.errors) throw new Error(`读取 accountId 失败: ${JSON.stringify(resp.body.errors)}`);
  return resp.body.data.login.accountId as number;
}

/**
 * 执行 `updateUserInfo` 变更
 * - 返回 `{ isUpdated, userInfo }` 结果；若有错误则携带 `errors`
 */
async function updateUserInfo(
  app: INestApplication,
  token: string,
  input: Record<string, unknown>,
) {
  return await request(app.getHttpServer())
    .post('/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({
      query: `
        mutation UpdateUserInfo($input: UpdateUserInfoInput!) {
          updateUserInfo(input: $input) {
            isUpdated
            userInfo {
              accountId nickname gender birthDate avatarUrl email signature address phone tags geographic
              accessGroup notifyCount unreadCount userState createdAt updatedAt
            }
          }
        }
      `,
      variables: { input },
    })
    .expect(200);
}

async function queryAccount(app: INestApplication, token: string, accountId: number) {
  return await request(app.getHttpServer())
    .post('/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({
      query: `
        query Account($id: Int!) {
          account(id: $id) {
            id
            loginName
            loginEmail
            recentLoginHistory {
              ip
              timestamp
              audience
            }
          }
        }
      `,
      variables: { id: accountId },
    })
    .expect(200);
}

/**
 * 执行 `userInfo` 查询（非本人目标的组织范围回归直接调用真实接口）。
 */
async function readUserInfo(app: INestApplication, token: string, accountId: number) {
  return await request(app.getHttpServer())
    .post('/graphql')
    .set('Authorization', `Bearer ${token}`)
    .send({
      query: `
        query UserInfo($accountId: Int!) {
          userInfo(accountId: $accountId) {
            accountId nickname email phone address signature avatarUrl
            accessGroup notifyCount unreadCount userState updatedAt
          }
        }
      `,
      variables: { accountId },
    })
    .expect(200);
}

/**
 * 目标资料行的逐字段确定性快照。
 *
 * 用于证明被拒绝的跨组织读写在库内没有发生任何字段变化（含 `updatedAt`），
 * 而不只比较接口返回。
 */
async function snapshotUserInfoRow(dataSource: DataSource, accountId: number): Promise<string> {
  const row = await dataSource.getRepository(UserInfoEntity).findOne({ where: { accountId } });
  if (!row) {
    throw new Error(`快照失败：账号 ${accountId} 的用户资料不存在`);
  }
  return JSON.stringify({
    nickname: row.nickname,
    gender: row.gender,
    birthDate: row.birthDate,
    avatarUrl: row.avatarUrl,
    email: row.email,
    signature: row.signature,
    accessGroup: row.accessGroup,
    address: row.address,
    phone: row.phone,
    tags: row.tags,
    geographic: row.geographic,
    notifyCount: row.notifyCount,
    unreadCount: row.unreadCount,
    userState: row.userState,
    updatedAt: row.updatedAt,
  });
}

/**
 * 创建第二个 CUSTOMER 账号（用于跨账号权限测试）
 * - 保证 `user_info.metaDigest` 与 `accessGroup` 一致，避免安全检查暂停账号
 */
async function ensureOtherGuestAccount(ds: DataSource): Promise<{ otherGuestAccountId: number }> {
  const accountRepo = ds.getRepository(AccountEntity);
  const userInfoRepo = ds.getRepository(UserInfoEntity);

  const loginName = 'otherguest';
  const loginEmail = 'otherguest@example.com';

  const existed: AccountEntity | null = await accountRepo.findOne({
    where: { loginName },
  });
  let guestAccount: AccountEntity;
  if (existed) {
    guestAccount = existed;
  } else {
    const created = accountRepo.create({
      loginName,
      loginEmail,
      loginPassword: 'temp',
      identityHint: IdentityTypeEnum.CUSTOMER,
    });
    await accountRepo.save(created);
    const saved = await accountRepo.findOne({ where: { loginName } });
    if (!saved) throw new Error('创建 otherguest 账号失败');
    guestAccount = saved;
  }

  if (!existed) {
    await userInfoRepo.save(
      userInfoRepo.create({
        accountId: guestAccount.id,
        nickname: `${loginName}_nickname`,
        gender: Gender.SECRET,
        email: loginEmail,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
        metaDigest: [IdentityTypeEnum.CUSTOMER],
        notifyCount: 0,
        unreadCount: 0,
        userState: UserState.ACTIVE,
      }),
    );
  }

  return { otherGuestAccountId: guestAccount.id };
}

describe('UpdateVisibleUserInfo (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let adminToken: string;
  let staffPrimaryToken: string;
  let staffSecondaryToken: string;
  let guestPrimaryToken: string;
  let guestSecondaryToken: string;

  let staffPrimaryAccountId: number;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let staffSecondaryAccountId: number;
  let guestPrimaryAccountId: number;
  let guestSecondaryAccountId: number;

  let otherGuestAccountId: number;

  // P1 组织范围夹具（无组织 / 跨组织 / 已 LEFT）
  let orglessEngineerToken: string;
  let orglessEngineerAccountId: number;
  let crossOrgGuestAccountId: number;
  let leftMemberGuestAccountId: number;

  // 旧 account(id) 的组织失败关闭（管理员自身无组织）
  let orglessAdminToken: string;
  let orglessAdminAccountId: number;

  const ownership = createOwnedResourceLedger();

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 预清理（窄范围）：只按本规格账号/组织完整指纹回收已知残留，不整表清成员/账号
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: SUITE_ORGANIZATIONS,
        accounts: [
          testAccountsConfig.admin,
          testAccountsConfig.staffPrimary,
          testAccountsConfig.staffSecondary,
          testAccountsConfig.guestPrimary,
          testAccountsConfig.guestSecondary,
          ORGLESS_ENGINEER,
          CROSS_ORG_GUEST,
          LEFT_MEMBER_GUEST,
          ORGLESS_ADMIN,
        ]
          .map(toResidueAccountFingerprint)
          .concat({
            loginName: 'otherguest',
            loginEmail: 'otherguest@example.com',
            status: AccountStatus.PENDING,
            identityHint: IdentityTypeEnum.CUSTOMER,
            nickname: 'otherguest_nickname',
            accessGroup: [IdentityTypeEnum.CUSTOMER],
          }),
      },
      helper: 'update-visible-user-info.e2e-spec beforeAll 预清理',
    });
    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin', 'staffPrimary', 'staffSecondary', 'guestPrimary', 'guestSecondary'],
      ownership,
    });

    // P1 组织范围夹具：先建账号，再建本轮专属组织与成员关系（同组织 / 跨组织 / 已 LEFT / 无组织）
    orglessEngineerAccountId = (
      await createTestAccount(dataSource, null, ORGLESS_ENGINEER, ownership)
    ).accountId;
    crossOrgGuestAccountId = (await createTestAccount(dataSource, null, CROSS_ORG_GUEST, ownership))
      .accountId;
    leftMemberGuestAccountId = (
      await createTestAccount(dataSource, null, LEFT_MEMBER_GUEST, ownership)
    ).accountId;
    orglessAdminAccountId = (await createTestAccount(dataSource, null, ORGLESS_ADMIN, ownership))
      .accountId;

    const organizationIdsByCode = await seedTestOrganizations({
      dataSource,
      organizations: SUITE_ORGANIZATIONS,
      ownership,
    });
    await seedTestMemberships({
      dataSource,
      organizationIdsByCode,
      ownership,
      memberships: [
        {
          accountLoginName: testAccountsConfig.admin.loginName,
          organizationCode: organizationCodes.primary,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: testAccountsConfig.staffPrimary.loginName,
          organizationCode: organizationCodes.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.staffSecondary.loginName,
          organizationCode: organizationCodes.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.guestPrimary.loginName,
          organizationCode: organizationCodes.primary,
          memberRole: 'CUSTOMER',
        },
        {
          accountLoginName: testAccountsConfig.guestSecondary.loginName,
          organizationCode: organizationCodes.primary,
          memberRole: 'CUSTOMER',
        },
        {
          accountLoginName: CROSS_ORG_GUEST.loginName,
          organizationCode: organizationCodes.peer,
          memberRole: 'CUSTOMER',
        },
        {
          accountLoginName: LEFT_MEMBER_GUEST.loginName,
          organizationCode: organizationCodes.primary,
          memberRole: 'CUSTOMER',
          status: 'LEFT',
        },
      ],
    });

    adminToken = await loginAndGetToken(
      app,
      testAccountsConfig.admin.loginName,
      testAccountsConfig.admin.loginPassword,
    );
    staffPrimaryToken = await loginAndGetToken(
      app,
      testAccountsConfig.staffPrimary.loginName,
      testAccountsConfig.staffPrimary.loginPassword,
    );
    staffSecondaryToken = await loginAndGetToken(
      app,
      testAccountsConfig.staffSecondary.loginName,
      testAccountsConfig.staffSecondary.loginPassword,
    );
    guestPrimaryToken = await loginAndGetToken(
      app,
      testAccountsConfig.guestPrimary.loginName,
      testAccountsConfig.guestPrimary.loginPassword,
    );
    guestSecondaryToken = await loginAndGetToken(
      app,
      testAccountsConfig.guestSecondary.loginName,
      testAccountsConfig.guestSecondary.loginPassword,
    );

    staffPrimaryAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffPrimary.loginName,
    );
    staffSecondaryAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffSecondary.loginName,
    );
    guestPrimaryAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestPrimary.loginName,
    );
    guestSecondaryAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestSecondary.loginName,
    );
    orglessEngineerToken = await loginAndGetToken(
      app,
      ORGLESS_ENGINEER.loginName,
      ORGLESS_ENGINEER.loginPassword,
    );
    orglessEngineerAccountId = await getAccountIdByLoginName(
      dataSource,
      ORGLESS_ENGINEER.loginName,
    );
    orglessAdminToken = await loginAndGetToken(
      app,
      ORGLESS_ADMIN.loginName,
      ORGLESS_ADMIN.loginPassword,
    );

    const created = await ensureOtherGuestAccount(dataSource);
    otherGuestAccountId = created.otherGuestAccountId;
    recordOwnedResource(ownership, 'account', otherGuestAccountId, {
      loginName: 'otherguest',
      loginEmail: 'otherguest@example.com',
      // 该 fixture 未显式设置状态，按实体默认值 PENDING 登记（与预清理残留指纹一致）。
      status: AccountStatus.PENDING,
      identityHint: IdentityTypeEnum.CUSTOMER,
      accessGroup: [IdentityTypeEnum.CUSTOMER],
      nickname: 'otherguest_nickname',
      userInfoEmail: 'otherguest@example.com',
      userState: 'ACTIVE',
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'update-visible-user-info.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
  });

  describe('正例', () => {
    it('自己改自己（ENGINEER）：只改 nickname', async () => {
      const newNickname = 'staff_primary_nickname_new';
      const res = await updateUserInfo(app, staffPrimaryToken, { nickname: newNickname });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(true);
      expect(res.body.data.updateUserInfo.userInfo.nickname).toBe(newNickname);
      // N01：合法资料变更后同步更新本轮预期，清理预检不应把受控变更判为漂移。
      updateOwnedExpectation(ownership, 'account', staffPrimaryAccountId, {
        nickname: newNickname,
      });
    });

    it('SUPER_ADMIN 改同组织 CUSTOMER：改 signature', async () => {
      const res = await updateUserInfo(app, adminToken, {
        accountId: guestSecondaryAccountId,
        signature: '管理员设置',
      });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(true);
      expect(res.body.data.updateUserInfo.userInfo.signature).toBe('管理员设置');
    });

    it('ENGINEER 改同组织 CUSTOMER：改 phone', async () => {
      const res = await updateUserInfo(app, staffPrimaryToken, {
        accountId: guestSecondaryAccountId,
        phone: '13900001111',
      });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(true);
      expect(res.body.data.updateUserInfo.userInfo.phone).toBe('13900001111');
    });

    it('另一个 ENGINEER 改同组织 CUSTOMER：改 avatarUrl', async () => {
      const res = await updateUserInfo(app, staffSecondaryToken, {
        accountId: guestPrimaryAccountId,
        avatarUrl: 'https://example.com/avatar.png',
      });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(true);
      expect(res.body.data.updateUserInfo.userInfo.avatarUrl).toBe(
        'https://example.com/avatar.png',
      );
    });

    it('幂等：空 patch → isUpdated=false，不写库', async () => {
      const before = await updateUserInfo(app, staffPrimaryToken, {});
      expect(before.body.errors).toBeUndefined();
      const updatedAt1 = before.body.data.updateUserInfo.userInfo.updatedAt;

      const after = await updateUserInfo(app, staffPrimaryToken, {});
      expect(after.body.errors).toBeUndefined();
      const updatedAt2 = after.body.data.updateUserInfo.userInfo.updatedAt;

      expect(after.body.data.updateUserInfo.isUpdated).toBe(false);
      expect(updatedAt2).toBe(updatedAt1);
    });

    it('幂等：patch 与当前值一样 → isUpdated=false', async () => {
      // 读取当前 nickname
      const readResp = await request(app.getHttpServer())
        .post('/graphql')
        .set('Authorization', `Bearer ${guestPrimaryToken}`)
        .send({
          query: `query { userInfo(accountId: ${guestPrimaryAccountId}) { nickname } }`,
        })
        .expect(200);
      if (readResp.body.errors)
        throw new Error(`读取用户信息失败: ${JSON.stringify(readResp.body.errors)}`);
      const currentNickname = readResp.body.data.userInfo.nickname as string;

      const res = await updateUserInfo(app, guestPrimaryToken, {
        accountId: guestPrimaryAccountId,
        nickname: currentNickname,
      });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(false);
      expect(res.body.data.updateUserInfo.userInfo.nickname).toBe(currentNickname);
    });

    it('清空字段：传 null 正确落库（email/phone/address/signature/avatarUrl）', async () => {
      const res = await updateUserInfo(app, staffPrimaryToken, {
        email: null,
        phone: null,
        address: null,
        signature: null,
        avatarUrl: null,
      });
      expect(res.body.errors).toBeUndefined();
      const ui = res.body.data.updateUserInfo.userInfo as {
        email: string | null;
        phone: string | null;
        address: string | null;
        signature: string | null;
        avatarUrl: string | null;
      };
      expect(ui.email).toBeNull();
      expect(ui.phone).toBeNull();
      expect(ui.address).toBeNull();
      expect(ui.signature).toBeNull();
      expect(ui.avatarUrl).toBeNull();
      // N01：邮箱被合法清空后同步更新本轮预期（只更新实际成功写入的字段）。
      updateOwnedExpectation(ownership, 'account', staffPrimaryAccountId, {
        userInfoEmail: null,
      });
    });
  });

  describe('负例', () => {
    it('CUSTOMER 修改另一个客户账号 → 拒绝', async () => {
      const res = await updateUserInfo(app, guestSecondaryToken, {
        accountId: guestPrimaryAccountId,
        nickname: 'x',
      });
      expect(res.body.errors).toBeDefined();
      const code = res.body.errors?.[0]?.extensions?.errorCode;
      expect(code).toBe('ACCESS_DENIED');
    });

    it('CUSTOMER 修改工程师账号 → 拒绝', async () => {
      const res = await updateUserInfo(app, guestPrimaryToken, {
        accountId: otherGuestAccountId,
        nickname: 'not-allowed',
      });
      expect(res.body.errors).toBeDefined();
      const code = res.body.errors?.[0]?.extensions?.errorCode;
      expect(code).toBe('ACCESS_DENIED');
    });

    it('CUSTOMER 改 ENGINEER → 拒绝', async () => {
      const res = await updateUserInfo(app, guestPrimaryToken, {
        accountId: staffPrimaryAccountId,
        nickname: 'nope',
      });
      expect(res.body.errors).toBeDefined();
      const code = res.body.errors?.[0]?.extensions?.errorCode;
      expect(code).toBe('ACCESS_DENIED');
    });

    it('昵称唯一性冲突（NICKNAME_TAKEN）', async () => {
      const duplicateNickname = `${testAccountsConfig.guestPrimary.loginName}_nickname`;
      const res = await updateUserInfo(app, staffPrimaryToken, { nickname: duplicateNickname });
      expect(res.body.errors).toBeDefined();
      const code = res.body.errors?.[0]?.extensions?.errorCode;
      const gqlCode = res.body.errors?.[0]?.extensions?.code;
      expect(code).toBe('NICKNAME_TAKEN');
      expect(gqlCode).toBe('CONFLICT');
    });

    it('birthDate 格式错误（YYYY-MM-DD）', async () => {
      const res = await updateUserInfo(app, staffPrimaryToken, { birthDate: '2024/01/01' });
      expect(res.body.errors).toBeDefined();
      const code = res.body.errors?.[0]?.extensions?.errorCode;
      const gqlCode = res.body.errors?.[0]?.extensions?.code;
      expect(code).toBe('OPERATION_NOT_SUPPORTED');
      expect(gqlCode).toBe('BAD_USER_INPUT');
      const msg = res.body.errors?.[0]?.message ?? '';
      expect(msg).toContain('出生日期格式必须为 YYYY-MM-DD');
    });

    it('email 长度上限 50', async () => {
      const overEmail = 'a'.repeat(51) + '@example.com';
      const r = await updateUserInfo(app, staffPrimaryToken, { email: overEmail });
      expect(r.body.errors).toBeDefined();
      expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('phone 长度上限 20', async () => {
      const overPhone = '1'.repeat(21);
      const r = await updateUserInfo(app, staffPrimaryToken, { phone: overPhone });
      expect(r.body.errors).toBeDefined();
      expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('address 长度上限 255', async () => {
      const overAddr = 'X'.repeat(256);
      const r = await updateUserInfo(app, staffPrimaryToken, { address: overAddr });
      expect(r.body.errors).toBeDefined();
      expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('signature 长度上限 100', async () => {
      const overSign = 'S'.repeat(101);
      const r = await updateUserInfo(app, staffPrimaryToken, { signature: overSign });
      expect(r.body.errors).toBeDefined();
      expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('avatarUrl 长度上限 255', async () => {
      const overAvatar = 'A'.repeat(256);
      const r = await updateUserInfo(app, staffPrimaryToken, { avatarUrl: overAvatar });
      expect(r.body.errors).toBeDefined();
      expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('tags 类型不对时报错（GraphQL BAD_USER_INPUT）', async () => {
      const resp = await request(app.getHttpServer())
        .post('/graphql')
        .set('Authorization', `Bearer ${staffPrimaryToken}`)
        .send({
          query: `
            mutation Update($input: UpdateUserInfoInput!) {
              updateUserInfo(input: $input) { isUpdated }
            }
          `,
          variables: { input: { tags: 123 } },
        })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });
      expect(resp.body.errors).toBeDefined();
      const gqlCode = resp.body.errors?.[0]?.extensions?.code;
      expect(gqlCode).toBe('BAD_USER_INPUT');
    });

    it('account 查询跨账号读取应拒绝', async () => {
      const res = await queryAccount(app, staffPrimaryToken, guestSecondaryAccountId);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('ACCESS_DENIED');
    });
  });

  describe('account 查询鉴权', () => {
    it('account 查询本人账号应允许', async () => {
      const res = await queryAccount(app, staffPrimaryToken, staffPrimaryAccountId);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.account.id).toBe(staffPrimaryAccountId);
      expect(res.body.data.account.loginEmail).toBeDefined();
    });

    it('account 查询管理员跨账号应允许读取敏感字段', async () => {
      const res = await queryAccount(app, adminToken, guestSecondaryAccountId);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.account.id).toBe(guestSecondaryAccountId);
      expect(res.body.data.account.loginEmail).toBeDefined();
    });
  });

  /**
   * 旧 `account(id)` 的跨组织旁路回归（P1）。
   *
   * 授权口径与 `userInfo` 一致：本人保留；非本人仍是**原 SUPER_ADMIN 权限**，
   * 通过后再叠加可信同组织校验。跨组织 / 目标无有效成员关系 / 目标不存在统一为
   * `USER_INFO_NOT_FOUND`（对外 NOT_FOUND），且拒绝时不得返回登录邮箱、登录名或登录历史。
   */
  describe('account 查询组织范围（非本人目标）', () => {
    const NON_EXISTENT_ACCOUNT_ID = 2_147_000_000;
    const TARGET_UNAVAILABLE_MESSAGE = '目标用户不存在';

    type AccountQueryResponse = {
      body: {
        data?: { account?: unknown } | null;
        errors?: Array<{
          message?: string;
          extensions?: { errorCode?: string; code?: string };
        }>;
      };
    };

    const expectTargetUnavailable = (res: AccountQueryResponse): void => {
      expect(res.body.data?.account ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('USER_INFO_NOT_FOUND');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(res.body.errors?.[0]?.message).toBe(TARGET_UNAVAILABLE_MESSAGE);
    };

    it('管理员查询同组织目标：按原字段契约返回', async () => {
      const res = await queryAccount(app, adminToken, guestSecondaryAccountId);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.account).toMatchObject({
        id: guestSecondaryAccountId,
        loginName: testAccountsConfig.guestSecondary.loginName,
        loginEmail: testAccountsConfig.guestSecondary.loginEmail,
      });
      expect(res.body.data.account.recentLoginHistory).not.toBeUndefined();
    });

    it('管理员查询跨组织目标：拒绝且不泄露敏感字段', async () => {
      const res = await queryAccount(app, adminToken, crossOrgGuestAccountId);
      expectTargetUnavailable(res);
      // 拒绝响应不得包含目标的登录邮箱或登录名
      expect(JSON.stringify(res.body)).not.toContain(CROSS_ORG_GUEST.loginEmail);
      expect(JSON.stringify(res.body)).not.toContain(CROSS_ORG_GUEST.loginName);
    });

    it('管理员查询无有效组织成员关系（同组织已 LEFT）的目标：拒绝', async () => {
      const res = await queryAccount(app, adminToken, leftMemberGuestAccountId);
      expectTargetUnavailable(res);
      expect(JSON.stringify(res.body)).not.toContain(LEFT_MEMBER_GUEST.loginEmail);
    });

    it('管理员查询完全不存在的目标：与跨组织使用同一拒绝口径', async () => {
      const crossOrgRes = await queryAccount(app, adminToken, crossOrgGuestAccountId);
      const missingRes = await queryAccount(app, adminToken, NON_EXISTENT_ACCOUNT_ID);
      expectTargetUnavailable(missingRes);
      expect(missingRes.body.errors?.[0]?.extensions?.errorCode).toBe(
        crossOrgRes.body.errors?.[0]?.extensions?.errorCode,
      );
      expect(missingRes.body.errors?.[0]?.extensions?.code).toBe(
        crossOrgRes.body.errors?.[0]?.extensions?.code,
      );
      expect(missingRes.body.errors?.[0]?.message).toBe(crossOrgRes.body.errors?.[0]?.message);
    });

    it('非本人但没有原管理员权限（ENGINEER）：仍拒绝且不返回敏感字段', async () => {
      const res = await queryAccount(app, staffPrimaryToken, guestSecondaryAccountId);
      expect(res.body.data?.account ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('ACCESS_DENIED');
      expect(JSON.stringify(res.body)).not.toContain(testAccountsConfig.guestSecondary.loginEmail);
    });

    it('管理员自身组织事实缺失：失败关闭（FORBIDDEN），不返回目标数据', async () => {
      const res = await queryAccount(app, orglessAdminToken, guestPrimaryAccountId);
      expect(res.body.data?.account ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('ORGANIZATION_NO_ACTIVE_MEMBERSHIP');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(JSON.stringify(res.body)).not.toContain(testAccountsConfig.guestPrimary.loginEmail);
    });

    it('无组织历史管理员查询本人：原行为保留（仍可自查）', async () => {
      const res = await queryAccount(app, orglessAdminToken, orglessAdminAccountId);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.account.id).toBe(orglessAdminAccountId);
      expect(res.body.data.account.loginEmail).toBe(ORGLESS_ADMIN.loginEmail);
    });

    it('无组织历史管理员查询无组织工程师目标：按跨组织口径拒绝', async () => {
      const res = await queryAccount(app, adminToken, orglessEngineerAccountId);
      expectTargetUnavailable(res);
      expect(JSON.stringify(res.body)).not.toContain(ORGLESS_ENGINEER.loginEmail);
    });
  });

  /**
   * P1 组织范围回归：直接调用真实 `userInfo` / `updateUserInfo`。
   *
   * 拒绝口径：非本人目标在「跨组织 / 目标无有效成员关系 / 目标不存在」三种情况下
   * 统一为 `USER_INFO_NOT_FOUND`（对外 `NOT_FOUND`）+ 固定文案，不泄露目标存在性；
   * 操作者自身缺少唯一有效组织时为 `ORGANIZATION_NO_ACTIVE_MEMBERSHIP`（对外 `FORBIDDEN`）。
   */
  describe('组织范围（非本人目标）', () => {
    const NON_EXISTENT_ACCOUNT_ID = 2_147_000_000;
    const TARGET_UNAVAILABLE_MESSAGE = '目标用户不存在';

    it('本人读取：无组织历史账号仍可自查', async () => {
      const res = await readUserInfo(app, orglessEngineerToken, orglessEngineerAccountId);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.userInfo.accountId).toBe(orglessEngineerAccountId);
      expect(res.body.data.userInfo.nickname).toBe(`${ORGLESS_ENGINEER.loginName}_nickname`);
    });

    it('本人修改：无组织历史账号仍可自改', async () => {
      const newNickname = 'orgless_engineer_nickname_new';
      const res = await updateUserInfo(app, orglessEngineerToken, { nickname: newNickname });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(true);
      expect(res.body.data.updateUserInfo.userInfo.nickname).toBe(newNickname);
      updateOwnedExpectation(ownership, 'account', orglessEngineerAccountId, {
        nickname: newNickname,
      });
    });

    it('同组织读取：ENGINEER 读取同组织客户通过', async () => {
      const res = await readUserInfo(app, staffPrimaryToken, guestSecondaryAccountId);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.userInfo.accountId).toBe(guestSecondaryAccountId);
      expect(res.body.data.userInfo.phone).toBe('13900001111');
    });

    it('同组织读取：SUPER_ADMIN 读取同组织客户通过', async () => {
      const res = await readUserInfo(app, adminToken, guestSecondaryAccountId);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.userInfo.accountId).toBe(guestSecondaryAccountId);
      expect(res.body.data.userInfo.signature).toBe('管理员设置');
    });

    it('跨组织读取：ENGINEER 拒绝，目标逐字段不变', async () => {
      const before = await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId);
      const res = await readUserInfo(app, staffPrimaryToken, crossOrgGuestAccountId);
      expect(res.body.data?.userInfo ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('USER_INFO_NOT_FOUND');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(res.body.errors?.[0]?.message).toBe(TARGET_UNAVAILABLE_MESSAGE);
      expect(await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId)).toBe(before);
    });

    it('跨组织读取：SUPER_ADMIN 拒绝，目标逐字段不变', async () => {
      const before = await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId);
      const res = await readUserInfo(app, adminToken, crossOrgGuestAccountId);
      expect(res.body.data?.userInfo ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('USER_INFO_NOT_FOUND');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId)).toBe(before);
    });

    it('跨组织修改：ENGINEER 拒绝，目标逐字段不变', async () => {
      const before = await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId);
      const res = await updateUserInfo(app, staffPrimaryToken, {
        accountId: crossOrgGuestAccountId,
        signature: '跨组织越权写入',
      });
      expect(res.body.data?.updateUserInfo ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('USER_INFO_NOT_FOUND');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(res.body.errors?.[0]?.message).toBe(TARGET_UNAVAILABLE_MESSAGE);
      expect(await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId)).toBe(before);
    });

    it('跨组织修改：SUPER_ADMIN 拒绝，目标逐字段不变', async () => {
      const before = await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId);
      const res = await updateUserInfo(app, adminToken, {
        accountId: crossOrgGuestAccountId,
        phone: '13800000000',
      });
      expect(res.body.data?.updateUserInfo ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('USER_INFO_NOT_FOUND');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(await snapshotUserInfoRow(dataSource, crossOrgGuestAccountId)).toBe(before);
    });

    it('操作者无有效组织：读取非本人被拒绝（FORBIDDEN）', async () => {
      const before = await snapshotUserInfoRow(dataSource, guestPrimaryAccountId);
      const res = await readUserInfo(app, orglessEngineerToken, guestPrimaryAccountId);
      expect(res.body.data?.userInfo ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('ORGANIZATION_NO_ACTIVE_MEMBERSHIP');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(await snapshotUserInfoRow(dataSource, guestPrimaryAccountId)).toBe(before);
    });

    it('操作者无有效组织：修改非本人被拒绝（FORBIDDEN）且不写库', async () => {
      const before = await snapshotUserInfoRow(dataSource, guestPrimaryAccountId);
      const res = await updateUserInfo(app, orglessEngineerToken, {
        accountId: guestPrimaryAccountId,
        signature: '无组织越权写入',
      });
      expect(res.body.data?.updateUserInfo ?? null).toBeNull();
      expect(res.body.errors?.[0]?.extensions?.errorCode).toBe('ORGANIZATION_NO_ACTIVE_MEMBERSHIP');
      expect(res.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(await snapshotUserInfoRow(dataSource, guestPrimaryAccountId)).toBe(before);
    });

    it('目标有效成员关系缺失（同组织已 LEFT）：读取与修改拒绝', async () => {
      const before = await snapshotUserInfoRow(dataSource, leftMemberGuestAccountId);
      const readRes = await readUserInfo(app, staffPrimaryToken, leftMemberGuestAccountId);
      expect(readRes.body.errors?.[0]?.extensions?.errorCode).toBe('USER_INFO_NOT_FOUND');

      const writeRes = await updateUserInfo(app, staffPrimaryToken, {
        accountId: leftMemberGuestAccountId,
        signature: '已离职成员越权写入',
      });
      expect(writeRes.body.errors?.[0]?.extensions?.errorCode).toBe('USER_INFO_NOT_FOUND');
      expect(writeRes.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(await snapshotUserInfoRow(dataSource, leftMemberGuestAccountId)).toBe(before);
    });

    it('目标不存在与跨组织使用同一拒绝口径（读取）', async () => {
      const crossOrgRes = await readUserInfo(app, staffPrimaryToken, crossOrgGuestAccountId);
      const missingRes = await readUserInfo(app, staffPrimaryToken, NON_EXISTENT_ACCOUNT_ID);
      expect(missingRes.body.errors?.[0]?.extensions?.errorCode).toBe(
        crossOrgRes.body.errors?.[0]?.extensions?.errorCode,
      );
      expect(missingRes.body.errors?.[0]?.extensions?.code).toBe(
        crossOrgRes.body.errors?.[0]?.extensions?.code,
      );
      expect(missingRes.body.errors?.[0]?.message).toBe(crossOrgRes.body.errors?.[0]?.message);
    });

    it('目标不存在与跨组织使用同一拒绝口径（修改）', async () => {
      const crossOrgRes = await updateUserInfo(app, staffPrimaryToken, {
        accountId: crossOrgGuestAccountId,
        signature: '对照写入',
      });
      const missingRes = await updateUserInfo(app, staffPrimaryToken, {
        accountId: NON_EXISTENT_ACCOUNT_ID,
        signature: '对照写入',
      });
      expect(crossOrgRes.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(missingRes.body.errors?.[0]?.extensions?.errorCode).toBe(
        crossOrgRes.body.errors?.[0]?.extensions?.errorCode,
      );
      expect(missingRes.body.errors?.[0]?.extensions?.code).toBe(
        crossOrgRes.body.errors?.[0]?.extensions?.code,
      );
      expect(missingRes.body.errors?.[0]?.message).toBe(crossOrgRes.body.errors?.[0]?.message);
    });

    it('同组织合法访问仍受既有字段白名单约束：ENGINEER 改他人 email 不落库', async () => {
      const before = await snapshotUserInfoRow(dataSource, guestSecondaryAccountId);
      const res = await updateUserInfo(app, staffPrimaryToken, {
        accountId: guestSecondaryAccountId,
        email: 'forbidden@example.com',
      });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(false);
      expect(res.body.data.updateUserInfo.userInfo.email).toBe(
        testAccountsConfig.guestSecondary.loginEmail,
      );
      expect(await snapshotUserInfoRow(dataSource, guestSecondaryAccountId)).toBe(before);
    });
  });
});
