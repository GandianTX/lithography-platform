// test/02-register/register-email-active.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { useContainer } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, In } from 'typeorm';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestOrganizations,
} from '../utils/test-organizations';

/**
 * 邮箱注册「注册成功即立即可用」完整链路 E2E。
 *
 * 产品语义：普通注册返回成功后应立即可用，因此新账号创建必须形成
 * `account.status = ACTIVE` / `userInfo.userState = ACTIVE`，且该写入发生在创建
 * 事务内——不存在事务提交后的补救 UPDATE。
 *
 * 覆盖三组事实：
 * 1. 完整链路：GraphQL 注册成功 → 数据库 ACTIVE / ACTIVE → 登录取 Token →
 *    Token 可访问真实受保护 GraphQL Query；
 * 2. 原子性：userInfo 保存失败时账号、密码哈希与资料全部回滚，注册接口不返回
 *    成功，也不留下 ACTIVE / PENDING；
 * 3. 安全回归：人工在隔离 fixture 中创建 ACTIVE / PENDING 后，受保护请求仍返回
 *    UNAUTHENTICATED（会话复核门禁失败关闭）。这是**回归用例**，不是存量数据
 *    迁移测试；也不通过管理员启停入口静默修复该不一致状态。
 */
describe('Register 邮箱注册 ACTIVE/ACTIVE 完整链路 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const LOGIN_NAME = 'e2e_email_active_user';
  const LOGIN_EMAIL = 'e2e_email_active_user@example.com';
  const LOGIN_PASSWORD = 'E2eActive!2026x';
  const NICKNAME = 'E2E邮箱链路用户';

  /** 安全回归 fixture 专用标识 */
  // login_name 列 varchar(30)，标识符控制在列宽内
  const LEGACY_LOGIN_NAME = 'e2e_email_legacy_act_pending';
  const LEGACY_EMAIL = 'e2e_email_legacy_act_pending@example.com';

  // 本轮台账：账号 / 成员关系 / 组织均登记真实 ID 与归属事实，按精确 ID 清理。
  // 清理器要求成员关系所属组织必须同时在本轮删除范围内，故组织与账号同批精确回收。
  let ownership: OwnedResourceLedger = createOwnedResourceLedger();
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('REGEMAIL');

  type GqlBody = {
    data?: {
      register?: { success?: boolean; accountId?: number };
      login?: { accessToken?: string };
    };
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    useContainer(app.select(ApiModule), { fallbackOnErrors: true });
    dataSource = moduleFixture.get<DataSource>(DataSource);
    await app.init();
  }, 30000);

  afterAll(async () => {
    // 先回收本轮台账中可能残留的资源（含组织），再按自然键兜底回收安全回归 fixture
    await cleanupRegistered();
    await cleanupAll();
    if (app) await app.close();
  });

  /**
   * 幂等建立本用例所需的有效组织，并登记到本用例台账。
   * 清理器要求成员关系所属组织必须同时在本轮删除范围内，故组织与账号同批精确回收。
   */
  const ensureOwnedOrganization = async (): Promise<number> => {
    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: 'E2E 邮箱注册主组织',
          kind: 'CLIENT',
        },
      ],
      ownership,
    });
    return requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
  };

  /** 精确回收本用例登记的真实账号与成员关系；成功后重置台账 */
  const cleanupRegistered = async (): Promise<void> => {
    if (!dataSource?.isInitialized) return;
    await runGuardedSpecCleanup({
      dataSource,
      owned: ownership,
      helper: 'register-email-active.e2e 逐用例精确回收',
    });
    ownership = createOwnedResourceLedger();
  };

  const cleanupAll = async (): Promise<void> => {
    if (!dataSource?.isInitialized) return;
    // 安全回归 fixture 由本规格直接建行、无成员关系，按自然键兜底回收
    await deleteByLoginNames([LEGACY_LOGIN_NAME]);
  };

  const deleteByLoginNames = async (loginNames: string[]): Promise<void> => {
    const accountRepo = dataSource.getRepository(AccountEntity);
    const userInfoRepo = dataSource.getRepository(UserInfoEntity);
    const accounts = await accountRepo.find({
      where: { loginName: In(loginNames) },
      select: { id: true },
    });
    const accountIds = accounts.map((account) => account.id);
    if (accountIds.length > 0) {
      await userInfoRepo.delete({ accountId: In(accountIds) });
      await accountRepo.delete({ id: In(accountIds) });
    }
    // 兼容清理：按邮箱再兜底一次（安全回归 fixture 可能已存在）
    const byEmail = await accountRepo.find({
      where: [{ loginEmail: In([LOGIN_EMAIL, LEGACY_EMAIL]) }],
      select: { id: true },
    });
    const emailIds = byEmail.map((account) => account.id).filter((id) => !accountIds.includes(id));
    if (emailIds.length > 0) {
      await userInfoRepo.delete({ accountId: In(emailIds) });
      await accountRepo.delete({ id: In(emailIds) });
    }
  };

  const performRegister = async (input: Record<string, unknown>) => {
    // 注册必填 organizationId：幂等建立本用例专属有效组织并登记到同一台账
    const primaryOrganizationId = await ensureOwnedOrganization();
    const payload: Record<string, unknown> = { organizationId: primaryOrganizationId, ...input };
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Register($input: RegisterInput!) {
            register(input: $input) { success message accountId }
          }
        `,
        variables: { input: payload },
      });

    // 成功即登记真实账号与成员关系（FK RESTRICT 链要求在删除账号前先删成员关系）
    const createdAccountId = Number(
      (response.body as { data?: { register?: { accountId?: unknown } } })?.data?.register
        ?.accountId,
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
    }

    return response;
  };

  const performLogin = async (loginName: string, loginPassword: string) =>
    request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Login($input: AuthLoginInput!) {
            login(input: $input) { accessToken accountId }
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
      });

  /** 受保护 GraphQL Query：读取自己的资料（JwtAuthGuard + 会话复核门禁） */
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

  describe('完整链路：注册成功后立即可用', () => {
    beforeEach(async () => {
      await cleanupRegistered();
    });

    it('注册 → 数据库 ACTIVE/ACTIVE → 登录 → Token 访问受保护 Query', async () => {
      const registerResponse = await performRegister({
        loginName: LOGIN_NAME,
        loginEmail: LOGIN_EMAIL,
        loginPassword: LOGIN_PASSWORD,
        nickname: NICKNAME,
        type: RegisterTypeEnum.CUSTOMER,
      });

      expect(registerResponse.status).toBe(200);
      const registerBody = registerResponse.body as GqlBody;
      expect(registerBody.errors).toBeUndefined();
      expect(registerBody.data?.register?.success).toBe(true);
      const accountId = registerBody.data?.register?.accountId;
      expect(typeof accountId).toBe('number');

      // 数据库事实：account.status 与 userInfo.userState 同为 ACTIVE
      const account = await dataSource
        .getRepository(AccountEntity)
        .findOne({ where: { id: accountId } });
      expect(account?.status).toBe(AccountStatus.ACTIVE);

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOne({ where: { accountId } });
      expect(userInfo?.userState).toBe(UserState.ACTIVE);

      // 使用注册凭据登录取得 Access Token
      const loginResponse = await performLogin(LOGIN_NAME, LOGIN_PASSWORD);
      expect(loginResponse.status).toBe(200);
      const loginBody = loginResponse.body as GqlBody;
      expect(loginBody.errors).toBeUndefined();
      const accessToken = loginBody.data?.login?.accessToken;
      expect(typeof accessToken).toBe('string');

      // Token 调用真实受保护 GraphQL Query 成功
      const protectedResponse = await queryProtectedUserInfo(accessToken as string, accountId!);
      expect(protectedResponse.status).toBe(200);
      const protectedBody = protectedResponse.body as {
        data?: { userInfo?: { accountId?: number; nickname?: string } };
        errors?: GqlBody['errors'];
      };
      expect(protectedBody.errors).toBeUndefined();
      expect(protectedBody.data?.userInfo?.accountId).toBe(accountId);
      expect(protectedBody.data?.userInfo?.nickname).toBeTruthy();
    });
  });

  describe('原子性：userInfo 保存失败时全量回滚', () => {
    beforeEach(async () => {
      await cleanupRegistered();
    });

    it('注册不返回成功，账号/密码哈希/资料全部回滚，不留下 ACTIVE / PENDING', async () => {
      const accountService = app.get(AccountService);
      const saveUserInfoSpy = jest
        .spyOn(accountService, 'saveUserInfo')
        .mockRejectedValueOnce(new Error('e2e forced user_info failure'));

      const registerResponse = await performRegister({
        loginName: LOGIN_NAME,
        loginEmail: LOGIN_EMAIL,
        loginPassword: LOGIN_PASSWORD,
        nickname: NICKNAME,
        type: RegisterTypeEnum.CUSTOMER,
      });

      // 注册接口不得返回成功
      expect(registerResponse.status).toBe(200);
      const body = registerResponse.body as GqlBody;
      expect(body.data?.register?.success).toBeFalsy();
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);

      // 数据库无半成品：既无账号行也无资料行，更没有 ACTIVE / PENDING 组合
      const account = await dataSource
        .getRepository(AccountEntity)
        .findOne({ where: [{ loginName: LOGIN_NAME }, { loginEmail: LOGIN_EMAIL }] });
      expect(account).toBeNull();

      saveUserInfoSpy.mockRestore();
    });
  });

  describe('安全回归：人工 ACTIVE / PENDING fixture 的受保护请求失败关闭', () => {
    beforeEach(async () => {
      await deleteByLoginNames([LEGACY_LOGIN_NAME]);
    });

    it('account.status=ACTIVE 而 userInfo.userState=PENDING 时，受保护请求返回 UNAUTHENTICATED', async () => {
      // 隔离 fixture：人工创建 ACTIVE / PENDING（不经任何业务入口，不做管理员修复）
      const accountRepo = dataSource.getRepository(AccountEntity);
      const userInfoRepo = dataSource.getRepository(UserInfoEntity);

      const temp = await accountRepo.save(
        accountRepo.create({
          loginName: LEGACY_LOGIN_NAME,
          loginEmail: LEGACY_EMAIL,
          loginPassword: 'temp',
          status: AccountStatus.ACTIVE,
          identityHint: IdentityTypeEnum.CUSTOMER,
        }),
      );
      const hashed = AccountService.hashPasswordWithTimestamp(LOGIN_PASSWORD, temp.createdAt);
      await accountRepo.update(temp.id, { loginPassword: hashed });
      await userInfoRepo.save(
        userInfoRepo.create({
          accountId: temp.id,
          nickname: `${LEGACY_LOGIN_NAME}_nickname`,
          gender: Gender.SECRET,
          email: LEGACY_EMAIL,
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
          notifyCount: 0,
          unreadCount: 0,
          userState: UserState.PENDING,
        }),
      );

      // 确认 fixture 落库形态确为 ACTIVE / PENDING
      const fixtureAccount = await accountRepo.findOne({ where: { id: temp.id } });
      const fixtureUserInfo = await userInfoRepo.findOne({ where: { accountId: temp.id } });
      expect(fixtureAccount?.status).toBe(AccountStatus.ACTIVE);
      expect(fixtureUserInfo?.userState).toBe(UserState.PENDING);

      // 登录门禁只看 account.status，因此可取得 Token
      const loginResponse = await performLogin(LEGACY_LOGIN_NAME, LOGIN_PASSWORD);
      expect(loginResponse.status).toBe(200);
      const loginBody = loginResponse.body as GqlBody;
      const accessToken = loginBody.data?.login?.accessToken;
      expect(typeof accessToken).toBe('string');

      // 但受保护请求在会话复核门禁（userState != ACTIVE）失败关闭为 UNAUTHENTICATED
      const protectedResponse = await queryProtectedUserInfo(accessToken as string, temp.id);
      const protectedBody = protectedResponse.body as {
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
      };
      expect(protectedBody.errors?.length ?? 0).toBeGreaterThan(0);
      expect(protectedBody.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    });
  });
});
