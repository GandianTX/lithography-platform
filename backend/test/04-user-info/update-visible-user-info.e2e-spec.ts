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
} from '../utils/e2e-scoped-cleanup';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

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
  const ownership = createOwnedResourceLedger();

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 预清理（窄范围）：只按本规格账号完整指纹回收已知残留，不整表清成员/账号
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        accounts: [
          testAccountsConfig.admin,
          testAccountsConfig.staffPrimary,
          testAccountsConfig.staffSecondary,
          testAccountsConfig.guestPrimary,
          testAccountsConfig.guestSecondary,
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

    const created = await ensureOtherGuestAccount(dataSource);
    otherGuestAccountId = created.otherGuestAccountId;
    recordOwnedResource(ownership, 'account', otherGuestAccountId);
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
    });

    it('SUPER_ADMIN 改任意 CUSTOMER：改 signature', async () => {
      const res = await updateUserInfo(app, adminToken, {
        accountId: guestSecondaryAccountId,
        signature: '管理员设置',
      });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(true);
      expect(res.body.data.updateUserInfo.userInfo.signature).toBe('管理员设置');
    });

    it('ENGINEER 改 CUSTOMER：改 phone', async () => {
      const res = await updateUserInfo(app, staffPrimaryToken, {
        accountId: guestSecondaryAccountId,
        phone: '13900001111',
      });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserInfo.isUpdated).toBe(true);
      expect(res.body.data.updateUserInfo.userInfo.phone).toBe('13900001111');
    });

    it('另一个 ENGINEER 改 CUSTOMER：改 avatarUrl', async () => {
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
});
