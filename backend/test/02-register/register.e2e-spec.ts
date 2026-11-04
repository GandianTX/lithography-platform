// test/02-register/register.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { useContainer } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { FieldEncryptionService } from '../../src/infrastructure/field-encryption/field-encryption.service';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { OrganizationMembershipEntity } from '../../src/modules/lithography/entities/organization-membership.entity';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { createOwnedLedgerLifecycle } from '../utils/owned-ledger-lifecycle';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestOrganizations,
} from '../utils/test-organizations';
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';

/**
 * Register 模块 E2E 测试
 */
describe('Register (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  // 本规格的归属台账：只登记 register 返回的真实账号 ID 与最小预期事实，清理按 ID 精确执行
  let ownership: OwnedResourceLedger = createOwnedResourceLedger();
  // 规格级组织编码：每次造数前幂等建立并登记到本用例台账，
  // 与账号/成员关系一并精确回收（清理器禁止成员关系指向台账外的组织）。
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('REG');
  // R04：清理失败时保留台账与失败原因，只有清理成功才重置；与永久反例共用同一实现。
  const lifecycle = createOwnedLedgerLifecycle({
    helper: 'register.e2e',
    getDataSource: () => dataSource,
    getOwned: () => ownership,
    resetOwned: () => {
      ownership = createOwnedResourceLedger();
    },
  });

  const testRegisterData = {
    validUser: {
      loginName: 'testregister',
      loginEmail: 'testregister@example.com',
      loginPassword: 'TestPass123!',
      nickname: '测试用户',
      type: RegisterTypeEnum.CUSTOMER,
    },
    validCustomerSecondary: {
      loginName: 'testcustomersecondary',
      loginEmail: 'customer.secondary@example.com',
      loginPassword: 'CustomerPass123!',
      nickname: '测试客户二号',
      type: RegisterTypeEnum.CUSTOMER,
    },
    duplicateLoginName: {
      loginName: 'testregister', // 与 validUser 重复
      loginEmail: 'duplicate1@example.com',
      loginPassword: 'DuplicatePass123!',
      nickname: '重复用户名',
      type: RegisterTypeEnum.CUSTOMER,
    },
    duplicateEmail: {
      loginName: 'duplicateemail',
      loginEmail: 'testregister@example.com', // 与 validUser 重复
      loginPassword: 'DuplicatePass123!',
      nickname: '重复邮箱',
      type: RegisterTypeEnum.CUSTOMER,
    },
    duplicateNickname: {
      loginName: 'duplicatenick',
      loginEmail: 'duplicatenick@example.com',
      loginPassword: 'DuplicatePass123!',
      nickname: '测试用户', // 与 validUser 重复
      type: RegisterTypeEnum.CUSTOMER,
    },
    onlyEmailUser: {
      loginName: null, // 只提供邮箱的注册可能没有 loginName
      loginEmail: 'onlyemail@example.com',
      loginPassword: 'OnlyEmail123!',
      nickname: null, // 可能没有昵称
      type: RegisterTypeEnum.CUSTOMER,
    },
    // 新增：验证场景数据
    weakPassword: {
      loginName: 'weakpassword',
      loginEmail: 'weakpassword@example.com',
      loginPassword: '123456', // 弱密码
      nickname: '弱密码用户',
      type: RegisterTypeEnum.CUSTOMER,
    },
    invalidEmail: {
      loginName: 'invalidemail',
      loginEmail: 'invalid-email-format', // 无效邮箱格式
      loginPassword: 'TestPass123!', // 添加必需的密码字段
      nickname: '无效邮箱用户',
      type: RegisterTypeEnum.CUSTOMER,
    },
    invalidLoginName: {
      loginName: 'invalid@name', // 包含非法字符
      loginEmail: 'invalidname@example.com',
      loginPassword: 'TestPass123!',
      nickname: '无效登录名用户',
      type: RegisterTypeEnum.CUSTOMER,
    },
    invalidNickname: {
      loginName: 'invalidnickname',
      loginEmail: 'invalidnickname@example.com',
      loginPassword: 'TestPass123!',
      nickname: 'invalid@nickname', // 包含非法字符
      type: RegisterTypeEnum.CUSTOMER,
    },
    missingPassword: {
      loginName: 'missingpassword',
      loginEmail: 'missingpassword@example.com',
      // 故意缺少 loginPassword 来测试验证
      nickname: '缺少密码用户',
      type: RegisterTypeEnum.CUSTOMER,
    },
    emptyEmail: {
      loginName: 'testuser',
      loginEmail: '', // 空邮箱
      loginPassword: 'TestPass123!',
      nickname: '空邮箱用户',
      type: RegisterTypeEnum.CUSTOMER,
    },
    invalidType: {
      loginName: 'invalidtype',
      loginEmail: 'invalidtype@example.com',
      loginPassword: 'TestPass123!',
      nickname: '无效类型用户',
      type: 'INVALID_TYPE', // 无效的注册类型
    },
  };

  beforeAll(async () => {
    // 初始化 GraphQL Schema
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // ✅ 让 class-validator 使用 Nest 容器解析 IsValidPasswordConstraint 的依赖
    useContainer(app.select(ApiModule), { fallbackOnErrors: true });

    dataSource = moduleFixture.get<DataSource>(DataSource);

    await app.init();
  }, 30000);

  afterEach(async () => {
    // R04：精确回收本用例登记的真实账号（含关联 user_info）；成功后才重置台账。
    await lifecycle.afterTestCleanup();
  });

  afterAll(async () => {
    await runE2eTeardown({
      // 兜底回收本轮全部已登记资源（含 afterEach 未覆盖到的部分），失败必须使规格失败
      cleanup: async () => {
        await lifecycle.cleanupRetainedForAfterAll();
      },
      finalize: null,
      closeApp: app
        ? async () => {
            await app.close();
            // 给 WebSocket 服务器一些时间完成关闭前的收尾
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        : null,
    });
  });

  beforeEach(() => {
    // R04：不得无条件重置台账。上一用例清理失败时旧 ID 仍可能留在库中，
    // 此处失败关闭，禁止在未恢复的情况下继续造数；afterAll 仍持有该批次用于诊断/回收。
    lifecycle.assertReadyForNextTest();
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
          name: 'E2E 注册主组织',
          kind: 'CLIENT',
        },
      ],
      ownership,
    });
    return requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
  };

  /**
   * 执行 GraphQL 注册请求
   */
  const performRegister = async (input: Record<string, unknown>) => {
    // 客户/工程师注册都必填 organizationId：统一补上本用例专属有效组织
    const organizationId = await ensureOwnedOrganization();
    const payload: Record<string, unknown> = { organizationId, ...input };
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Register($input: RegisterInput!) {
            register(input: $input) {
              success
              message
              accountId
            }
          }
        `,
        variables: {
          input: payload,
        },
      });

    // 创建成功后立即登记真实账号 ID：本规格的清理只按这些 ID 精确执行，
    // 不再整表删除 user_info/account。注册失败时 data 为空，不登记。
    const registeredAccountId = (response.body as { data?: { register?: { accountId?: unknown } } })
      ?.data?.register?.accountId;
    const numericAccountId = Number(registeredAccountId);
    if (Number.isInteger(numericAccountId) && numericAccountId > 0) {
      // 预期事实来自受控注册输入与已受理的注册规则（仅允许客户注册、状态 ACTIVE）。
      const inputLoginName = typeof payload.loginName === 'string' ? payload.loginName : null;
      const inputLoginEmail = typeof payload.loginEmail === 'string' ? payload.loginEmail : '';
      // N01：昵称可能被注册规则改写（重复昵称自动加后缀），资料三项取**本次创建结果**，
      // 在注册成功后立即读取一次；不在清理阶段回读当前值作为预期。
      const createdUserInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId: numericAccountId } });
      recordOwnedResource(ownership, 'account', numericAccountId, {
        loginName: inputLoginName,
        loginEmail: inputLoginEmail,
        status: AccountStatus.ACTIVE,
        identityHint: IdentityTypeEnum.CUSTOMER,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
        nickname: createdUserInfo.nickname,
        userInfoEmail: createdUserInfo.email ?? null,
        userState: createdUserInfo.userState,
      });

      // 客户注册在同事务内建立 CUSTOMER 成员关系；申请行/成员关系对账号是 FK RESTRICT，
      // 必须登记真实成员关系 ID 才能精确回收账号与规格组织。
      const membership = await dataSource
        .getRepository(OrganizationMembershipEntity)
        .findOneOrFail({
          where: { accountId: numericAccountId, organizationId },
        });
      recordOwnedResource(ownership, 'membership', membership.id, {
        organizationId,
        accountId: numericAccountId,
        memberRole: membership.memberRole,
        status: membership.status,
      });
    }

    return response;
  };

  const performLogin = async (loginName: string, loginPassword: string) => {
    return await request(app.getHttpServer())
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
                accessGroup
              }
            }
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
  };

  describe('注册成功场景', () => {
    /**
     * 测试普通用户注册成功
     */
    it('应该支持普通用户注册成功', async () => {
      const response = await performRegister(testRegisterData.validUser);

      expect(response.status).toBe(200);
      const { data } = response.body;
      expect(data?.register.success).toBe(true);
      expect(data?.register.message).toBe('注册成功');
      expect(data?.register.accountId).toBeDefined();
      expect(typeof data?.register.accountId).toBe('number');

      // 验证账户是否正确创建
      const accountRepository = dataSource.getRepository(AccountEntity);
      const createdAccount = await accountRepository.findOne({
        where: { id: data?.register.accountId },
      });

      expect(createdAccount).toBeDefined();
      expect(createdAccount?.loginName).toBe(testRegisterData.validUser.loginName);
      expect(createdAccount?.loginEmail).toBe(testRegisterData.validUser.loginEmail);
      expect(createdAccount?.status).toBe(AccountStatus.ACTIVE);
    });

    it('应该支持显式指定 CUSTOMER 注册后登录', async () => {
      const registerResponse = await performRegister(testRegisterData.validCustomerSecondary);

      expect(registerResponse.status).toBe(200);
      const { data } = registerResponse.body;
      expect(data?.register.success).toBe(true);
      expect(data?.register.accountId).toBeDefined();

      const accountRepository = dataSource.getRepository(AccountEntity);
      const createdAccount = await accountRepository.findOne({
        where: { id: data?.register.accountId },
      });

      expect(createdAccount).toBeDefined();
      expect(createdAccount?.identityHint).toBe(IdentityTypeEnum.CUSTOMER);
      expect(createdAccount?.status).toBe(AccountStatus.ACTIVE);

      const userInfoRepository = dataSource.getRepository(UserInfoEntity);
      const userInfo = await userInfoRepository.findOne({
        where: { accountId: data?.register.accountId },
      });

      expect(userInfo?.accessGroup).toContain(IdentityTypeEnum.CUSTOMER);
      expect(userInfo?.metaDigest).toContain(IdentityTypeEnum.CUSTOMER);

      const loginResponse = await performLogin(
        testRegisterData.validCustomerSecondary.loginName,
        testRegisterData.validCustomerSecondary.loginPassword,
      );
      expect(loginResponse.status).toBe(200);
      expect(loginResponse.body.data?.login.accountId).toBe(data?.register.accountId);
      expect(loginResponse.body.data?.login.accessToken).toBeDefined();
      expect(loginResponse.body.data?.login.refreshToken).toBeDefined();
      expect(loginResponse.body.data?.login.role).toBe(IdentityTypeEnum.CUSTOMER);
      expect(loginResponse.body.data?.login.userInfo.accessGroup).toContain(
        IdentityTypeEnum.CUSTOMER,
      );
    });

    /**
     * 测试只提供邮箱注册
     */
    it('应该支持只提供邮箱的注册', async () => {
      const input = {
        loginEmail: testRegisterData.onlyEmailUser.loginEmail,
        loginPassword: testRegisterData.onlyEmailUser.loginPassword,
        type: testRegisterData.onlyEmailUser.type,
      };

      const response = await performRegister(input);

      expect(response.status).toBe(200);
      const { data } = response.body;
      expect(data?.register.success).toBe(true);
      expect(data?.register.message).toBe('注册成功');
      expect(data?.register.accountId).toBeDefined();
    });
  });

  describe('重复数据检查场景', () => {
    beforeEach(async () => {
      // 先创建一个基础用户
      await performRegister(testRegisterData.validUser);
    });

    /**
     * 测试登录名重复
     */
    it('应该正确处理登录名重复的情况', async () => {
      const response = await performRegister(testRegisterData.duplicateLoginName);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('该登录名或邮箱已被注册');
    });

    /**
     * 测试邮箱重复
     */
    it('应该正确处理邮箱重复的情况', async () => {
      const response = await performRegister(testRegisterData.duplicateEmail);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('该登录名或邮箱已被注册');
    });

    /**
     * 测试昵称重复 - 适配新的自动生成后缀功能
     */
    it('应该正确处理昵称重复的情况 - 自动生成带后缀的新昵称', async () => {
      const response = await performRegister(testRegisterData.duplicateNickname);

      expect(response.status).toBe(200);
      const { data } = response.body;
      expect(data?.register.success).toBe(true);
      expect(data?.register.message).toBe('注册成功');
      expect(data?.register.accountId).toBeDefined();

      // 验证账户是否正确创建
      const accountRepository = dataSource.getRepository(AccountEntity);
      const createdAccount = await accountRepository.findOne({
        where: { id: parseInt(data?.register.accountId) },
      });

      expect(createdAccount).toBeDefined();
      expect(createdAccount?.loginName).toBe(testRegisterData.duplicateNickname.loginName);
      expect(createdAccount?.loginEmail).toBe(testRegisterData.duplicateNickname.loginEmail);
      expect(createdAccount?.status).toBe(AccountStatus.ACTIVE);

      // 验证昵称已自动生成带后缀的新昵称
      const userInfoRepository = dataSource.getRepository(UserInfoEntity);
      const userInfo = await userInfoRepository.findOne({
        where: { accountId: parseInt(data?.register.accountId) },
      });

      expect(userInfo).toBeDefined();
      expect(userInfo?.nickname).toBeDefined();
      // 验证昵称不是原始的重复昵称，而是带后缀的新昵称
      expect(userInfo?.nickname).not.toBe(testRegisterData.duplicateNickname.nickname);
      // 验证昵称包含原始昵称作为前缀
      expect(userInfo?.nickname).toContain(testRegisterData.duplicateNickname.nickname);
      // 验证昵称包含 # 后缀分隔符
      expect(userInfo?.nickname).toMatch(/.*#[a-zA-Z0-9]{6}$/);
    });

    /**
     * 测试昵称重复
     */
    // it('应该正确处理昵称重复的情况', async () => {
    //   const response = await performRegister(testRegisterData.duplicateNickname);

    //   const { errors } = response.body;
    //   expect(errors).toBeDefined();
    //   expect(errors?.[0]?.message).toContain('昵称 "测试用户" 已被使用，请选择其他昵称');
    // });
  });

  describe('输入参数验证场景', () => {
    /**
     * 测试密码格式不正确
     */
    it('应该正确处理密码格式不正确的情况', async () => {
      const response = await performRegister(testRegisterData.weakPassword);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('密码不符合安全要求');
    });

    /**
     * 测试邮箱格式不正确
     */
    it('应该正确处理邮箱格式不正确的情况', async () => {
      const response = await performRegister(testRegisterData.invalidEmail);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('邮箱格式不正确');
    });

    /**
     * 测试登录名格式不正确
     */
    it('应该正确处理登录名格式不正确的情况', async () => {
      const response = await performRegister(testRegisterData.invalidLoginName);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('登录名只能包含英文字母、数字、下划线和短横线');
    });

    /**
     * 测试昵称格式不正确
     */
    it('应该正确处理昵称格式不正确的情况', async () => {
      const response = await performRegister(testRegisterData.invalidNickname);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('昵称长度限制：中文最多 7 个汉字');
    });

    /**
     * 测试必需参数缺失
     */
    it('应该正确处理必需参数缺失的情况', async () => {
      const response = await performRegister(testRegisterData.missingPassword);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('loginPassword');
    });

    it('应该正确处理邮箱为空的情况', async () => {
      const response = await performRegister(testRegisterData.emptyEmail);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('邮箱不能为空');
    });
  });

  describe('注册类型验证场景', () => {
    /**
     * 测试无效的注册类型
     */
    it('应该正确处理无效的注册类型', async () => {
      const response = await performRegister(testRegisterData.invalidType);

      const { errors } = response.body;
      expect(errors).toBeDefined();
      expect(errors?.[0]?.message).toContain('RegisterTypeEnum');
    });
  });

  describe('业务逻辑验证场景', () => {
    /**
     * 测试注册成功后账户状态正确
     */
    it('注册成功后账户状态应该为 ACTIVE', async () => {
      const response = await performRegister(testRegisterData.validUser);

      const { data } = response.body;
      const accountId = data?.register.accountId;

      const accountRepository = dataSource.getRepository(AccountEntity);
      const account = await accountRepository.findOne({
        where: { id: accountId },
      });

      expect(account?.status).toBe(AccountStatus.ACTIVE);
    });

    /**
     * 测试注册成功后密码已加密
     */
    it('注册成功后密码应该已加密', async () => {
      const response = await performRegister(testRegisterData.validUser);

      const { data } = response.body;
      const accountId = data?.register.accountId;

      const accountRepository = dataSource.getRepository(AccountEntity);
      const account = await accountRepository.findOne({
        where: { id: accountId },
      });

      expect(account?.loginPassword).toBeDefined();
      expect(account?.loginPassword).not.toBe(testRegisterData.validUser.loginPassword);
      expect(account?.loginPassword.length).toBeGreaterThan(50); // 加密后的密码应该很长
    });

    /**
     * 测试注册成功后用户信息正确创建
     */
    it('注册成功后应该创建对应的用户信息', async () => {
      const response = await performRegister(testRegisterData.validUser);

      const { data } = response.body;
      const accountId = data?.register.accountId;

      const userInfoRepository = dataSource.getRepository(UserInfoEntity);
      const userInfo = await userInfoRepository.findOne({
        where: { accountId },
      });

      expect(userInfo).toBeDefined();
      expect(userInfo?.nickname).toBe(testRegisterData.validUser.nickname);
    });

    /**
     * 测试注册成功后返回正确的账户 ID
     */
    it('注册成功后应该返回正确的账户 ID', async () => {
      const response = await performRegister(testRegisterData.validUser);

      const { data } = response.body;
      const accountId = data?.register.accountId;

      const accountRepository = dataSource.getRepository(AccountEntity);
      const account = await accountRepository.findOne({
        where: { id: accountId },
      });

      expect(account).toBeDefined();
      expect(account?.id).toBe(accountId);
    });
  });

  describe('数据加密验证场景', () => {
    let fieldEncryptionService: FieldEncryptionService;

    beforeEach(() => {
      // 替换旧的 EncryptionHelper
      // encryptionHelper = new EncryptionHelper();
      // 使用新的服务
      fieldEncryptionService = app.get(FieldEncryptionService);
    });

    /**
     * 测试 metaDigest 字段加密存储
     */
    it('注册成功后 metaDigest 字段应该被正确加密存储', async () => {
      const response = await performRegister(testRegisterData.validUser);

      expect(response.status).toBe(200);
      const { data } = response.body;
      const accountId = data?.register.accountId;

      // 直接查询数据库获取原始加密数据
      const rawQuery = `SELECT meta_digest FROM base_user_info WHERE account_id = ?`;
      const rawResult = await dataSource.query(rawQuery, [accountId]);
      // 调试输出移除

      expect(rawResult).toBeDefined();
      expect(rawResult.length).toBe(1);

      const encryptedMetaDigest = rawResult[0].meta_digest;
      expect(encryptedMetaDigest).toBeDefined();
      expect(typeof encryptedMetaDigest).toBe('string');

      // 验证存储的是加密后的数据，不是原始数据
      expect(encryptedMetaDigest).not.toBe('CUSTOMER');
      expect(encryptedMetaDigest).not.toContain('CUSTOMER');

      // 验证可以正确解密 - 使用新的服务
      const decryptedValue = fieldEncryptionService.decrypt(encryptedMetaDigest);
      expect(decryptedValue).toBe('["CUSTOMER"]'); // 数组被序列化为 JSON 字符串
    });

    /**
     * 测试通过 ORM 查询时 metaDigest 字段自动解密
     */
    it('通过 ORM 查询时 metaDigest 字段应该被自动解密', async () => {
      const response = await performRegister(testRegisterData.validUser);

      const { data } = response.body;
      const accountId = data?.register.accountId;

      // 通过 ORM 查询，应该自动解密
      const userInfoRepository = dataSource.getRepository(UserInfoEntity);
      const userInfo = await userInfoRepository.findOne({
        where: { accountId },
      });

      expect(userInfo).toBeDefined();
      expect(userInfo?.metaDigest).toBeDefined();

      // 验证解密后的数据是正确的
      if (typeof userInfo?.metaDigest === 'string') {
        const parsedMetaDigest = JSON.parse(userInfo.metaDigest);
        expect(Array.isArray(parsedMetaDigest)).toBe(true);
        expect(parsedMetaDigest).toContain('CUSTOMER');
      } else {
        // 如果直接是数组类型
        expect(Array.isArray(userInfo?.metaDigest)).toBe(true);
        expect(userInfo?.metaDigest).toContain('CUSTOMER');
      }
    });

    /**
     * 测试加密解密的一致性
     */
    it('加密解密应该保持数据一致性', () => {
      const originalData = '["CUSTOMER","TEST_DATA"]';

      // 加密 - 使用新的服务
      const encrypted = fieldEncryptionService.encrypt(originalData);
      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(originalData);

      // 解密 - 使用新的服务
      const decrypted = fieldEncryptionService.decrypt(encrypted);
      expect(decrypted).toBe(originalData);
    });
  });
});
