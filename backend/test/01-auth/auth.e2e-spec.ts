// test/01-auth/auth.e2e-spec.ts
import {
  AccountStatus,
  IdentityTypeEnum,
  LoginTypeEnum,
  ThirdPartyProviderEnum,
} from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { ThirdPartySession } from '@app-types/models/third-party-auth.types';
import {
  THIRD_PARTY_PROVIDER_TOKENS,
  WeAppProviderContract,
} from '@src/modules/third-party-auth/contracts/third-party-provider.contract';
import { ThirdPartyAuthEntity } from '@src/modules/third-party-auth/third-party-auth.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
  type ResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedSpecialStatusAccount } from '../utils/special-status-account';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

/**
 * Auth 模块基础 E2E 测试
 */
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;

  // 使用统一的测试账号配置
  const { guest: activeUser } = testAccountsConfig;

  // WeApp 模拟的 openid/unionid（绑定/未绑定场景）
  const MOCK_WEAPP_OPENID_BOUND = 'weapp_openid_e2e_guest_1';
  const MOCK_WEAPP_OPENID_UNBOUND = 'weapp_openid_e2e_unbound_1';
  const MOCK_WEAPP_UNIONID = 'weapp_union_e2e_guest_1';

  // 额外的测试账号（仅用于特殊状态测试）
  const bannedUser = {
    loginName: 'banneduser',
    loginEmail: 'banned@example.com',
    loginPassword: 'testBanned@2024',
    status: AccountStatus.BANNED,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  };

  const pendingUser = {
    loginName: 'pendinguser',
    loginEmail: 'pending@example.com',
    loginPassword: 'testPending@2024',
    status: AccountStatus.PENDING,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  };

  /** 残留定位：自然键 + 逐字段指纹，不使用整表删除。 */
  const specialAccountResidues: ResidueAccountFingerprint[] = [bannedUser, pendingUser].map(
    (account) => ({
      loginName: account.loginName,
      loginEmail: account.loginEmail,
      status: account.status,
      identityHint: account.identityType,
      nickname: `${account.loginName}_nickname`,
      accessGroup: account.accessGroup,
    }),
  );

  let ownership = createOwnedResourceLedger();

  // 覆写 WeAppProvider：根据 authCredential 返回不同的 openid（绑定 / 未绑定）
  const mockWeAppProvider: WeAppProviderContract = {
    provider: ThirdPartyProviderEnum.WEAPP,
    exchangeCredential: ({ authCredential }): Promise<ThirdPartySession> => {
      if (authCredential === 'e2e-unbound') {
        return Promise.resolve({
          providerUserId: MOCK_WEAPP_OPENID_UNBOUND,
          unionId: null,
          profile: { nickname: 'UnboundUser' },
          sessionKeyRaw: 'mock-session-key-unbound',
        });
      }
      return Promise.resolve({
        providerUserId: MOCK_WEAPP_OPENID_BOUND,
        unionId: MOCK_WEAPP_UNIONID,
        profile: { nickname: 'BoundUser' },
        sessionKeyRaw: 'mock-session-key-bound',
      });
    },
    getAccessToken: () => Promise.resolve('mock-access-token'),
    getPhoneNumber: () =>
      Promise.resolve({
        phoneNumber: '13800138000',
        purePhoneNumber: '13800138000',
        countryCode: '86',
      }),
    createWxaCodeUnlimit: () =>
      Promise.resolve({
        buffer: Buffer.from('mock-qrcode'),
        contentType: 'image/png',
      }),
  };

  beforeAll(async () => {
    // 初始化 GraphQL Schema
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    })
      .overrideProvider(THIRD_PARTY_PROVIDER_TOKENS.WEAPP)
      .useValue(mockWeAppProvider)
      .compile();

    app = moduleFixture.createNestApplication();
    dataSource = moduleFixture.get<DataSource>(DataSource);
    createAccountUsecase = moduleFixture.get<CreateAccountUsecase>(CreateAccountUsecase);
    await app.init();
  }, 30000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () => cleanupTestData(ownership, 'auth.e2e afterAll'),
      closeApp: app ? () => app.close() : null,
    });
  });

  beforeEach(async () => {
    // 先回收上一用例的本轮资源（首轮为空），再按完整指纹兜底残留。
    await cleanupTestData(ownership, 'auth.e2e beforeEach');
    ownership = createOwnedResourceLedger();
    await createTestAccounts();
  });

  /**
   * 清理测试数据：只删除本轮登记的精确 ID 与完整指纹命中的残留，
   * 不再整表删除第三方绑定 / 成员关系 / 账号。
   */
  const cleanupTestData = async (owned: OwnedResourceLedger, helper: string): Promise<void> => {
    await runGuardedSpecCleanup({
      dataSource,
      helper,
      owned,
      residue: {
        accounts: [...buildTestAccountResidue(['guest']), ...specialAccountResidues],
        thirdPartyAuths: [
          {
            accountLoginName: activeUser.loginName,
            provider: ThirdPartyProviderEnum.WEAPP,
            providerUserId: MOCK_WEAPP_OPENID_BOUND,
            unionId: MOCK_WEAPP_UNIONID,
          },
        ],
      },
    });
  };

  /**
   * 创建测试账户数据
   */
  const createTestAccounts = async (): Promise<void> => {
    try {
      // 创建统一测试账号
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['guest'], // 只创建 guest 账号作为 activeUser
        ownership,
      });

      // 创建额外的特殊状态测试账号。
      // 这些 fixture 刻意保留「非 ACTIVE 账号状态 + userState=ACTIVE」的历史不一致形态，
      // 而 CreateAccountUsecase 已对双状态一致性失败关闭（BANNED 无对应 UserState），
      // 因此直接走 repo 造数，不经过 Usecase；登录拒绝断言只依赖 account.status。
      const specialAccounts = [bannedUser, pendingUser];
      // R03：并行造数必须等待全部 settle 再抛出首个错误，避免兄弟写入与收尾竞争。
      const specialResults = await Promise.allSettled(
        specialAccounts.map((account) =>
          seedSpecialStatusAccount({ dataSource, account, ownership }),
        ),
      );
      const failedSpecial = specialResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedSpecial) {
        throw failedSpecial.reason;
      }

      // 绑定 WeApp 第三方登录到 guest 账号
      await seedWeAppThirdPartyBinding();
    } catch (error) {
      console.error('❌ 创建测试账户失败:', error);
      throw error;
    }
  };

  /**
   * 为 guest 账号绑定 WeApp 第三方登录
   */
  const seedWeAppThirdPartyBinding = async (): Promise<void> => {
    const accountRepository = dataSource.getRepository(AccountEntity);
    const thirdPartyRepo = dataSource.getRepository(ThirdPartyAuthEntity);

    const account = await accountRepository.findOne({ where: { loginName: activeUser.loginName } });
    if (!account) return;

    const existed = await thirdPartyRepo.findOne({
      where: { accountId: account.id, provider: ThirdPartyProviderEnum.WEAPP },
    });

    if (!existed) {
      const saved = await thirdPartyRepo.save(
        thirdPartyRepo.create({
          accountId: account.id,
          provider: ThirdPartyProviderEnum.WEAPP,
          providerUserId: MOCK_WEAPP_OPENID_BOUND,
          unionId: MOCK_WEAPP_UNIONID,
          accessToken: null,
        }),
      );
      recordOwnedResource(ownership, 'thirdPartyAuth', saved.id, {
        accountId: account.id,
        provider: ThirdPartyProviderEnum.WEAPP,
        providerUserId: MOCK_WEAPP_OPENID_BOUND,
        unionId: MOCK_WEAPP_UNIONID,
      });
    } else {
      recordOwnedResource(ownership, 'thirdPartyAuth', existed.id, {
        accountId: account.id,
        provider: ThirdPartyProviderEnum.WEAPP,
        providerUserId: MOCK_WEAPP_OPENID_BOUND,
        unionId: MOCK_WEAPP_UNIONID,
      });
    }
  };

  /**
   * 执行 GraphQL 登录请求
   */
  const performLogin = async (
    loginName: string,
    loginPassword: string,
    type: LoginTypeEnum = LoginTypeEnum.PASSWORD,
    audience: string = 'DESKTOP',
    ip: string = '127.0.0.1',
  ) => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Login($input: AuthLoginInput!) {
            login(input: $input) {
              accessToken
              refreshToken
              accountId
              role
              userInfo {
                userInfoId: id
                accountId
                nickname
                gender
                birthDate
                avatarUrl
                email
                signature
                accessGroup
                address
                phone
                tags
                geographic
                notifyCount
                unreadCount
                userState
                createdAt
                updatedAt
              }
            }
          }
        `,
        variables: {
          input: {
            loginName,
            loginPassword,
            type,
            audience,
            ip,
          },
        },
      });

    return response;
  };

  /**
   * 执行 GraphQL 第三方 WeApp 登录请求
   */
  const performThirdPartyLogin = async (
    provider: ThirdPartyProviderEnum,
    authCredential: string,
    audience: string = 'SSTSTEST',
    ip: string = '127.0.0.1',
  ) => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation ThirdPartyLogin($input: ThirdPartyLoginInput!) {
            thirdPartyLogin(input: $input) {
              accessToken
              refreshToken
              accountId
              role
              userInfo {
                userInfoId: id
                accountId
                nickname
                gender
                birthDate
                avatarUrl
                email
                signature
                accessGroup
                address
                phone
                tags
                geographic
                notifyCount
                unreadCount
                userState
                createdAt
                updatedAt
              }
            }
          }
        `,
        variables: {
          input: {
            provider,
            authCredential,
            audience,
            ip,
          },
        },
      });

    return response;
  };

  describe('登录成功场景', () => {
    it('应该支持用户名登录成功', async () => {
      const response = await performLogin(
        activeUser.loginName,
        activeUser.loginPassword,
        LoginTypeEnum.PASSWORD,
        'DESKTOP',
      );

      const { data } = response.body;
      expect(data?.login.accountId).toBeDefined();
      expect(data?.login.accessToken).toBeDefined();
      expect(data?.login.refreshToken).toBeDefined();
      expect(data?.login.role).toBeDefined();
      expect(typeof data?.login.accessToken).toBe('string');
      expect(typeof data?.login.refreshToken).toBe('string');
      expect(Object.values(IdentityTypeEnum)).toContain(data?.login.role);
    });

    it('应该支持邮箱登录成功', async () => {
      const response = await performLogin(activeUser.loginEmail, activeUser.loginPassword);

      const { data } = response.body;
      expect(data?.login.accountId).toBeDefined();
      expect(data?.login.accessToken).toBeDefined();
      expect(data?.login.refreshToken).toBeDefined();
      expect(data?.login.role).toBeDefined();
      expect(typeof data?.login.accessToken).toBe('string');
      expect(typeof data?.login.refreshToken).toBe('string');
      expect(Object.values(IdentityTypeEnum)).toContain(data?.login.role);
    });

    it('应该支持有效的 audience 登录成功', async () => {
      const response = await performLogin(
        activeUser.loginName,
        activeUser.loginPassword,
        LoginTypeEnum.PASSWORD,
        'SSTSTEST',
      );

      const { data } = response.body;
      expect(data?.login.accountId).toBeDefined();
      expect(data?.login.accessToken).toBeDefined();
      expect(data?.login.refreshToken).toBeDefined();
      expect(data?.login.role).toBeDefined();
      expect(typeof data?.login.accessToken).toBe('string');
      expect(typeof data?.login.refreshToken).toBe('string');
      expect(Object.values(IdentityTypeEnum)).toContain(data?.login.role);
    });

    it('登录成功后应该返回正确的用户 ID', async () => {
      const accountRepository = dataSource.getRepository(AccountEntity);
      const account = await accountRepository.findOne({
        where: { loginName: activeUser.loginName },
      });

      const response = await performLogin(activeUser.loginName, activeUser.loginPassword);

      const { data } = response.body;
      expect(data?.login.accountId).toBe(account?.id);
    });

    it('应该正确决策用户角色', async () => {
      const response = await performLogin(activeUser.loginName, activeUser.loginPassword);

      const { data } = response.body;
      expect(Object.values(IdentityTypeEnum)).toContain(data?.login.role);
      expect(data?.login.role).toBe(activeUser.identityType);
    });

    it('应该拒绝无效的 audience', async () => {
      const response = await performLogin(
        activeUser.loginName,
        activeUser.loginPassword,
        LoginTypeEnum.PASSWORD,
        'invalid-audience',
      );

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain(
        'Value "invalid-audience" does not exist in "AudienceTypeEnum" enum.',
      );
    });
  });

  describe('第三方登录 - WeApp', () => {
    it('应该支持绑定账号的 WeApp 第三方登录', async () => {
      const response = await performThirdPartyLogin(
        ThirdPartyProviderEnum.WEAPP,
        'e2e-bound',
        'SSTSTEST',
      );

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();

      const accountRepository = dataSource.getRepository(AccountEntity);
      const account = await accountRepository.findOne({
        where: { loginName: activeUser.loginName },
      });

      expect(data?.thirdPartyLogin.accountId).toBe(account?.id);
      expect(data?.thirdPartyLogin.role).toBe(activeUser.identityType);
      expect(typeof data?.thirdPartyLogin.accessToken).toBe('string');
      expect(typeof data?.thirdPartyLogin.refreshToken).toBe('string');
    });

    it('未绑定的 WeApp 第三方登录应返回未绑定错误', async () => {
      const response = await performThirdPartyLogin(
        ThirdPartyProviderEnum.WEAPP,
        'e2e-unbound',
        'SSTSTEST',
      );

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('该第三方账户未绑定');
    });
  });

  describe('账户状态相关场景', () => {
    it('应该正确处理账户不存在的情况', async () => {
      const response = await performLogin('nonexistent', 'password123');

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('账户不存在');
    });

    it('应该正确处理账户被禁用的情况', async () => {
      const response = await performLogin(bannedUser.loginName, bannedUser.loginPassword);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('账户未激活或已被禁用');
    });

    it('应该正确处理待激活账户的情况', async () => {
      const response = await performLogin(pendingUser.loginName, pendingUser.loginPassword);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('账户未激活或已被禁用');
    });
  });

  describe('密码验证场景', () => {
    it('应该正确处理密码错误的情况', async () => {
      const response = await performLogin(activeUser.loginName, 'wrongpassword');

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('密码错误');
    });

    it('应该正确处理空密码的情况', async () => {
      const response = await performLogin(activeUser.loginName, '');

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('密码不能为空或纯空白字符');
    });
  });

  describe('输入参数验证', () => {
    it('应该正确处理空用户名的情况', async () => {
      const response = await performLogin('', 'password123');

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('账户不存在');
    });

    it('应该正确验证必需参数', async () => {
      const response = await request(app.getHttpServer())
        .post('/graphql')
        .send({
          query: `
            mutation Login {
              login {
                accessToken
                refreshToken
                accountId
                role
              }
            }
          `,
        })
        .expect(400);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('input');
    });

    it('登录成功后应该返回有效的 JWT Token', async () => {
      const response = await performLogin(activeUser.loginName, activeUser.loginPassword);

      const { data } = response.body;
      const accessToken = data?.login.accessToken;
      const refreshToken = data?.login.refreshToken;

      expect(accessToken).toBeDefined();
      expect(refreshToken).toBeDefined();
      expect(typeof accessToken).toBe('string');
      expect(typeof refreshToken).toBe('string');
      expect(accessToken.split('.')).toHaveLength(3);
      expect(refreshToken.split('.')).toHaveLength(3);
    });
  });
});
