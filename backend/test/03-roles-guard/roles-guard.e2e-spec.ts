// test/03-roles-guard/roles-guard.e2e-spec.ts
import { INestApplication, UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { Test, TestingModule } from '@nestjs/testing';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';

import { IdentityTypeEnum, LoginTypeEnum } from '@app-types/models/account.types';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
// 添加身份实体导入
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { executeGql as executeGqlUtils } from '../utils/e2e-graphql-utils';
// 导入全局测试账户工具
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

/**
 * 测试用的 GraphQL Resolver
 * 用于测试不同角色权限场景
 */
@Resolver()
class TestRolesResolver {
  /**
   * 无角色要求的查询
   */
  @Query(() => String)
  @UseGuards(JwtAuthGuard)
  publicQuery(): string {
    return 'public access';
  }

  /**
   * 需要 ENGINEER 角色的查询
   */
  @Query(() => String)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ENGINEER')
  staffQuery(): string {
    return 'staff access';
  }

  /**
   * 需要 SUPER_ADMIN 角色的查询
   */
  @Query(() => String)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  adminQuery(): string {
    return 'admin access';
  }

  /**
   * 需要多个角色之一的查询
   */
  @Query(() => String)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ENGINEER', 'SUPER_ADMIN')
  multiRoleQuery(): string {
    return 'multi role access';
  }

  /**
   * 空角色数组的查询（应该根据用户的 accessGroup 首项判断）
   */
  @Query(() => String)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles()
  emptyRolesQuery(): string {
    return 'empty roles access';
  }

  /**
   * 仅需要认证但无角色守卫的查询
   */
  @Query(() => String)
  @UseGuards(JwtAuthGuard)
  authOnlyQuery(): string {
    return 'auth only access';
  }

  /**
   * 无任何守卫的查询
   */
  @Query(() => String)
  noGuardQuery(): string {
    return 'no guard access';
  }

  /**
   * 仅角色守卫无认证守卫的查询（用于测试未登录场景）
   */
  @Query(() => String)
  @UseGuards(RolesGuard)
  @Roles('ENGINEER')
  roleOnlyQuery(): string {
    return 'role only access';
  }
}

/**
 * RolesGuard E2E 测试
 */
describe('RolesGuard (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  let ownership = createOwnedResourceLedger();
  const residueAccounts = buildTestAccountResidue(['staff', 'admin', 'guestPrimary', 'guest']);

  beforeAll(async () => {
    // 初始化 GraphQL Schema
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
      // 直接注册测试用 Resolver，确保 GraphQL 能发现查询字段
      providers: [TestRolesResolver],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    createAccountUsecase = app.get(CreateAccountUsecase);

    await app.init();
  }, 30000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'roles-guard.e2e afterAll',
          owned: ownership,
          residue: { accounts: residueAccounts },
        }),
      closeApp: app ? () => app.close() : null,
    });
  });

  // 每个用例结束精确回收本轮账号；下一用例开始前再按完整指纹兜底残留。
  beforeEach(async () => {
    await runGuardedSpecCleanup({
      dataSource,
      helper: 'roles-guard.e2e beforeEach',
      owned: ownership,
      residue: { accounts: residueAccounts },
    });
    ownership = createOwnedResourceLedger();
  });

  afterEach(async () => {
    await runGuardedSpecCleanup({
      dataSource,
      helper: 'roles-guard.e2e afterEach',
      owned: ownership,
      residue: { accounts: residueAccounts },
    });
    ownership = createOwnedResourceLedger();
  });

  /**
   * 登录用户获取 token
   */
  const loginUser = async (loginName: string, loginPassword: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Login($input: AuthLoginInput!) {
            login(input: $input) {
              accessToken
            }
          }
        `,
        variables: {
          input: {
            loginName,
            loginPassword,
            type: LoginTypeEnum.PASSWORD,
            audience: 'DESKTOP',
          },
        },
      })
      .expect(200);

    if (!response.body.data?.login?.accessToken) {
      throw new Error(`用户 ${loginName} 登录失败`);
    }

    return response.body.data.login.accessToken as string;
  };

  /**
   * 执行 GraphQL 查询
   */
  const executeQuery = (query: string, token?: string): request.Test =>
    executeGqlUtils({ app, query, token });

  // 只用到 staff 的用例组
  describe('无 @Roles 装饰器场景', () => {
    let staffToken: string;

    beforeEach(async () => {
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['staff'],
        ownership,
      });
      staffToken = await loginUser(
        testAccountsConfig.staff.loginName,
        testAccountsConfig.staff.loginPassword,
      );
    });

    it('应该允许无角色要求的查询通过（有认证）', async () => {
      const response = await executeQuery('query { publicQuery }', staffToken).expect(200);
      expect(response.body.data.publicQuery).toBe('public access');
    });

    it('应该允许无任何守卫的查询通过（无认证）', async () => {
      const response = await executeQuery('query { noGuardQuery }').expect(200);
      expect(response.body.data.noGuardQuery).toBe('no guard access');
    });

    it('应该允许仅认证守卫的查询通过', async () => {
      const response = await executeQuery('query { authOnlyQuery }', staffToken).expect(200);
      expect(response.body.data.authOnlyQuery).toBe('auth only access');
    });
  });

  // 需要 staff + admin 的用例组
  describe("@Roles('ENGINEER') + accessGroup 匹配场景", () => {
    let staffToken: string;
    let adminToken: string;

    beforeEach(async () => {
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['staff', 'admin'],
        ownership,
      });
      staffToken = await loginUser(
        testAccountsConfig.staff.loginName,
        testAccountsConfig.staff.loginPassword,
      );
      adminToken = await loginUser(
        testAccountsConfig.admin.loginName,
        testAccountsConfig.admin.loginPassword,
      );
    });

    it('应该允许 ENGINEER 角色访问 staffQuery', async () => {
      const response = await executeQuery('query { staffQuery }', staffToken).expect(200);
      expect(response.body.data.staffQuery).toBe('staff access');
    });

    it('应该允许 SUPER_ADMIN 角色访问需要 ENGINEER 或 SUPER_ADMIN 的查询', async () => {
      const response = await executeQuery('query { multiRoleQuery }', adminToken).expect(200);
      expect(response.body.data.multiRoleQuery).toBe('multi role access');
    });

    it('应该允许 ENGINEER 角色访问需要 ENGINEER 或 SUPER_ADMIN 的查询', async () => {
      const response = await executeQuery('query { multiRoleQuery }', staffToken).expect(200);
      expect(response.body.data.multiRoleQuery).toBe('multi role access');
    });
  });

  // 需要 staff + guest 的不匹配场景
  describe("@Roles('ENGINEER') + accessGroup 不匹配场景", () => {
    let staffToken: string;
    let guestToken: string;

    beforeEach(async () => {
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['staff', 'guestPrimary'],
        ownership,
      });
      staffToken = await loginUser(
        testAccountsConfig.staff.loginName,
        testAccountsConfig.staff.loginPassword,
      );
      guestToken = await loginUser(
        testAccountsConfig.guestPrimary.loginName,
        testAccountsConfig.guestPrimary.loginPassword,
      );
    });

    it('应该拒绝 CUSTOMER 角色访问 staffQuery 并返回 403', async () => {
      const response = await executeQuery('query { staffQuery }', guestToken).expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].message).toContain('缺少所需角色');
      expect(response.body.errors[0].extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
      expect(response.body.errors[0].extensions.details.requiredRoles).toEqual(['ENGINEER']);
      expect(response.body.errors[0].extensions.details.userRoles).toEqual(['CUSTOMER']);
    });

    it('应该拒绝 CUSTOMER 角色访问 adminQuery 并返回 403', async () => {
      const response = await executeQuery('query { adminQuery }', guestToken).expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].message).toContain('缺少所需角色');
      expect(response.body.errors[0].extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
      expect(response.body.errors[0].extensions.details.requiredRoles).toEqual(['SUPER_ADMIN']);
      expect(response.body.errors[0].extensions.details.userRoles).toEqual(['CUSTOMER']);
    });

    it('应该拒绝 ENGINEER 角色访问 adminQuery 并返回 403', async () => {
      const response = await executeQuery('query { adminQuery }', staffToken).expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].message).toContain('缺少所需角色');
      expect(response.body.errors[0].extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
      expect(response.body.errors[0].extensions.details.requiredRoles).toEqual(['SUPER_ADMIN']);
      expect(response.body.errors[0].extensions.details.userRoles).toEqual(['ENGINEER']);
    });

    it('应该拒绝 CUSTOMER 角色访问需要 ENGINEER 或 SUPER_ADMIN 的查询', async () => {
      const response = await executeQuery('query { multiRoleQuery }', guestToken).expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].message).toContain('缺少所需角色');
      expect(response.body.errors[0].extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
      expect(response.body.errors[0].extensions.details.requiredRoles).toEqual([
        'ENGINEER',
        'SUPER_ADMIN',
      ]);
      expect(response.body.errors[0].extensions.details.userRoles).toEqual(['CUSTOMER']);
    });
  });

  // 不需要任何账号的场景
  describe('未登录场景（移除 JwtAuthGuard）', () => {
    it('应该拒绝未登录用户访问并返回 401', async () => {
      const response = await executeQuery('query { roleOnlyQuery }').expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].message).toContain('用户未登录');
      expect(response.body.errors[0].extensions.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
      expect(response.body.errors[0].extensions.details.requiredRoles).toEqual(['ENGINEER']);
    });
  });

  // 合法 CUSTOMER 账号访问无角色要求查询
  describe('@Roles() 空数组场景', () => {
    let guestToken: string;

    beforeEach(async () => {
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['guest'],
        ownership,
      });
      guestToken = await loginUser(
        testAccountsConfig.guest.loginName,
        testAccountsConfig.guest.loginPassword,
      );
    });

    it('应该允许合法 CUSTOMER 账号访问无角色要求查询', async () => {
      const response = await executeQuery('query { emptyRolesQuery }', guestToken).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.emptyRolesQuery).toBe('empty roles access');
    });
  });

  // 角色脏数据在 Session 校验阶段失败关闭的场景
  describe('脏数据处理测试', () => {
    let guestToken: string;

    beforeEach(async () => {
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['staff', 'guest'],
        ownership,
      });
      guestToken = await loginUser(
        testAccountsConfig.guest.loginName,
        testAccountsConfig.guest.loginPassword,
      );
    });

    it('应该正确处理数据库 accessGroup 为 null 的约束', async () => {
      // 直接修改数据库中的 accessGroup 为 null
      const userInfoRepository = dataSource.getRepository(UserInfoEntity);
      const accountRepository = dataSource.getRepository(AccountEntity);

      const account = await accountRepository.findOne({
        where: { loginName: testAccountsConfig.staff.loginName },
      });

      // 尝试更新为 null，预期会失败
      let updateError: Error | null = null;
      try {
        if (account) {
          await userInfoRepository.update(
            { accountId: account.id },
            { accessGroup: null as unknown as IdentityTypeEnum[] },
          );
        }
      } catch (error) {
        updateError = error as Error;
      }

      // 验证数据库操作抛出了错误
      expect(updateError).toBeDefined();
      // 验证错误信息包含数据库列不能为空的提示
      expect(updateError?.message).toContain('Column');
      expect(updateError?.message).toContain('cannot be null');
    });

    it('应该在旧 Token 对应角色 accessGroup 为空时拒绝受保护查询', async () => {
      const userInfoRepository = dataSource.getRepository(UserInfoEntity);
      const accountRepository = dataSource.getRepository(AccountEntity);

      const account = await accountRepository.findOne({
        where: { loginName: testAccountsConfig.guest.loginName },
      });
      expect(account).toBeDefined();

      await userInfoRepository.update({ accountId: account!.id }, { accessGroup: [] });
      // 受控变更成功后才更新台账预期，不得在写入前预置期望值
      updateOwnedExpectation(ownership, 'account', account!.id, { accessGroup: [] });

      const response = await executeQuery('query { staffQuery }', guestToken).expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
      expect(response.body.errors[0].extensions.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
    });
  });
});
