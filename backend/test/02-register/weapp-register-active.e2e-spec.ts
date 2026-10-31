// test/02-register/weapp-register-active.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  ThirdPartyProviderEnum,
} from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import type { ThirdPartySession } from '@app-types/models/third-party-auth.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { ThirdPartyAuthEntity } from '@src/modules/third-party-auth/third-party-auth.entity';
import {
  THIRD_PARTY_PROVIDER_TOKENS,
  WeAppProviderContract,
} from '@src/modules/third-party-auth/contracts/third-party-provider.contract';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
} from '../utils/e2e-scoped-cleanup';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestOrganizations,
} from '../utils/test-organizations';

/**
 * 微信小程序注册「注册成功即立即可用」完整链路 E2E。
 *
 * 使用仓库现有的 WEAPP provider mock（覆写 `THIRD_PARTY_PROVIDER_TOKENS.WEAPP`，
 * 与 `test/01-auth/auth.e2e-spec.ts` 同一模式），覆盖：
 * 1. 第三方注册成功 → 数据库 `account.status = ACTIVE` / `userInfo.userState = ACTIVE`；
 * 2. 第三方登录取得 Access Token；
 * 3. Token 可访问真实受保护 GraphQL Query。
 */
describe('Register 微信小程序注册 ACTIVE/ACTIVE 完整链路 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const PROVIDER_USER_ID = `weapp_openid_e2e_register_${Date.now()}`;
  const AUTH_CREDENTIAL = 'e2e-weapp-register-code';

  // 本轮台账：账号 / 成员关系 / 第三方绑定 / 组织均登记真实 ID 与归属事实，按精确 ID 回收。
  // 清理器要求成员关系所属组织必须同时在本轮删除范围内，故组织与账号同批回收。
  const ownership = createOwnedResourceLedger();
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('WEAPPREG');
  let primaryOrganizationId = 0;

  type GqlBody = {
    data?: {
      thirdPartyRegister?: { success?: boolean; accountId?: number };
      thirdPartyLogin?: { accessToken?: string; accountId?: number };
    };
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };

  const mockWeAppProvider: WeAppProviderContract = {
    provider: ThirdPartyProviderEnum.WEAPP,
    exchangeCredential: ({
      authCredential,
    }: {
      authCredential: string;
    }): Promise<ThirdPartySession> =>
      Promise.resolve({
        providerUserId:
          authCredential === AUTH_CREDENTIAL ? PROVIDER_USER_ID : 'weapp_openid_other',
        unionId: null,
        profile: { nickname: 'WeappRegisterE2E' },
        sessionKeyRaw: 'mock-session-key',
      }),
    getAccessToken: () => Promise.resolve('mock-access-token'),
    getPhoneNumber: () =>
      Promise.resolve({
        phoneNumber: '13800138000',
        purePhoneNumber: '13800138000',
        countryCode: '86',
      }),
    createWxaCodeUnlimit: () =>
      Promise.resolve({ buffer: Buffer.from('mock-qrcode'), contentType: 'image/png' }),
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    })
      .overrideProvider(THIRD_PARTY_PROVIDER_TOKENS.WEAPP)
      .useValue(mockWeAppProvider)
      .compile();

    app = moduleFixture.createNestApplication();
    dataSource = moduleFixture.get<DataSource>(DataSource);
    await app.init();

    // 第三方注册必须选择有效组织：建立本规格专属组织并与账号链同批精确回收
    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: 'E2E 微信注册主组织',
          kind: 'CLIENT',
        },
      ],
      ownership,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // 账号链（绑定/成员关系/资料/账号）与组织在同一台账内一次精确回收
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'weapp-register-active.e2e afterAll 精确回收',
      });
    }
    if (app) await app.close();
  });

  const performThirdPartyRegister = async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation ThirdPartyRegister($input: ThirdPartyRegisterInput!) {
            thirdPartyRegister(input: $input) { success message accountId }
          }
        `,
        variables: {
          input: {
            provider: ThirdPartyProviderEnum.WEAPP,
            authCredential: AUTH_CREDENTIAL,
            audience: AudienceTypeEnum.SSTSWEAPP,
            organizationId: primaryOrganizationId,
          },
        },
      });

    // 成功即登记真实账号 / 成员关系 / 第三方绑定（均为 FK RESTRICT 链）
    const createdAccountId = Number(
      (response.body as { data?: { thirdPartyRegister?: { accountId?: unknown } } })?.data
        ?.thirdPartyRegister?.accountId,
    );
    if (Number.isInteger(createdAccountId) && createdAccountId > 0) {
      const account = await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { id: createdAccountId } });
      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId: createdAccountId } });
      recordOwnedResource(ownership, 'account', createdAccountId, {
        loginName: account.loginName ?? null,
        loginEmail: account.loginEmail,
        status: account.status,
        identityHint: account.identityHint,
        accessGroup: Array.isArray(userInfo.accessGroup)
          ? userInfo.accessGroup
          : (JSON.parse(userInfo.accessGroup) as string[]),
        nickname: userInfo.nickname,
        userInfoEmail: userInfo.email ?? null,
        userState: userInfo.userState,
      });
      const membership = await dataSource
        .getRepository(OrganizationMembershipEntity)
        .findOneOrFail({
          where: { accountId: createdAccountId, organizationId: primaryOrganizationId },
        });
      recordOwnedResource(ownership, 'membership', membership.id, {
        organizationId: primaryOrganizationId,
        accountId: createdAccountId,
        memberRole: membership.memberRole,
        status: membership.status,
      });
      const binding = await dataSource.getRepository(ThirdPartyAuthEntity).findOneOrFail({
        where: { accountId: createdAccountId, provider: ThirdPartyProviderEnum.WEAPP },
      });
      recordOwnedResource(ownership, 'thirdPartyAuth', binding.id, {
        accountId: createdAccountId,
        provider: binding.provider,
        providerUserId: binding.providerUserId,
        unionId: binding.unionId,
      });
    }

    return response;
  };

  const performThirdPartyLogin = async () =>
    request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation ThirdPartyLogin($input: ThirdPartyLoginInput!) {
            thirdPartyLogin(input: $input) { accessToken accountId }
          }
        `,
        variables: {
          input: {
            provider: ThirdPartyProviderEnum.WEAPP,
            authCredential: AUTH_CREDENTIAL,
            audience: AudienceTypeEnum.SSTSWEAPP,
          },
        },
      });

  const queryProtectedUserInfo = async (token: string, accountId: number) =>
    request(app.getHttpServer())
      .post('/graphql')
      .set('Authorization', `Bearer ${token}`)
      .send({
        query: `
          query ProtectedUserInfo($accountId: Int!) {
            userInfo(accountId: $accountId) { id accountId nickname userState }
          }
        `,
        variables: { accountId },
      });

  it('注册 → 数据库 ACTIVE/ACTIVE → 第三方登录取 Token → 访问受保护 Query', async () => {
    const registerResponse = await performThirdPartyRegister();

    expect(registerResponse.status).toBe(200);
    const registerBody = registerResponse.body as GqlBody;
    expect(registerBody.errors).toBeUndefined();
    expect(registerBody.data?.thirdPartyRegister?.success).toBe(true);
    const accountId = registerBody.data?.thirdPartyRegister?.accountId;
    expect(typeof accountId).toBe('number');

    // 数据库事实：account.status 与 userInfo.userState 同为 ACTIVE
    const account = await dataSource
      .getRepository(AccountEntity)
      .findOne({ where: { id: accountId } });
    expect(account?.status).toBe(AccountStatus.ACTIVE);
    expect(account?.identityHint).toBe(IdentityTypeEnum.CUSTOMER);

    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOne({ where: { accountId } });
    expect(userInfo?.userState).toBe(UserState.ACTIVE);
    expect(userInfo?.accessGroup).toContain(IdentityTypeEnum.CUSTOMER);

    // 第三方登录取得 Token
    const loginResponse = await performThirdPartyLogin();
    expect(loginResponse.status).toBe(200);
    const loginBody = loginResponse.body as GqlBody;
    expect(loginBody.errors).toBeUndefined();
    expect(loginBody.data?.thirdPartyLogin?.accountId).toBe(accountId);
    const accessToken = loginBody.data?.thirdPartyLogin?.accessToken;
    expect(typeof accessToken).toBe('string');

    // Token 访问真实受保护 GraphQL Query 成功
    const protectedResponse = await queryProtectedUserInfo(accessToken as string, accountId!);
    expect(protectedResponse.status).toBe(200);
    const protectedBody = protectedResponse.body as {
      data?: { userInfo?: { accountId?: number } };
      errors?: GqlBody['errors'];
    };
    expect(protectedBody.errors).toBeUndefined();
    expect(protectedBody.data?.userInfo?.accountId).toBe(accountId);
  });
});
