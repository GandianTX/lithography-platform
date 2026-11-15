// test/02-register/register-email-active.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { useContainer } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, EntityManager, FindOptionsWhere, Like } from 'typeorm';
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
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { EngineerRegistrationApplicationEntity } from '@src/modules/lithography/entities/engineer-registration-application.entity';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import { ACCOUNT_ERROR } from '@core/common/errors';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { createOwnedLedgerLifecycle } from '../utils/owned-ledger-lifecycle';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from '../utils/e2e-teardown';
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
 *
 * I2（独立终审）：本规格不再按固定登录名/邮箱反查后删除任何行。每一轮使用
 * 按进程生成的一次性短标识（登录名 ≤30、资料邮箱 ≤50），创建成功后立即把真实
 * ID 与事先已知的事实登记到本轮台账，清理统一走 `runGuardedSpecCleanup`。
 * 非本轮的历史账号（原固定邮箱）只作**外部**哨兵：由外部 harness 预注入，
 * 本规格只读快照并逐字段比对，绝不被认领删除（F3）。
 */
describe('Register 邮箱注册 ACTIVE/ACTIVE 完整链路 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  /** 本轮一次性短标识：同一进程内唯一，跨进程几乎不可能碰撞（前缀用于残留核对） */
  const RUN_TAG = Math.random().toString(36).slice(2, 10).padEnd(8, '0');

  const ROUND_LOGIN_PREFIX = 'e2e_ea_';
  const LEGACY_LOGIN_PREFIX = 'e2e_el_';
  const GUARD_LOGIN_PREFIX = 'e2e_gd_';

  const LOGIN_NAME = `${ROUND_LOGIN_PREFIX}${RUN_TAG}`;
  const LOGIN_EMAIL = `${LOGIN_NAME}@ex.com`;
  const LOGIN_PASSWORD = 'E2eActive!2026x';
  const NICKNAME = 'E2E邮箱链路用户';

  /** 安全回归 fixture 专用标识（短且独立，登录名列宽 30、资料邮箱列宽 50） */
  const LEGACY_LOGIN_NAME = `${LEGACY_LOGIN_PREFIX}${RUN_TAG}`;
  const LEGACY_EMAIL = `${LEGACY_LOGIN_NAME}@ex.com`;

  /**
   * 原固定邮箱的非本轮账号：只作**外部**哨兵（F3）。
   *
   * 共享规格不再创建它，也不按固定登录名/邮箱接管；已存在的行只做只读快照，
   * 清理结束后逐字段比对。外部 harness 负责在规格启动前注入（固定旧邮箱 +
   * 独立登录名），并在本规格全部检查结束后按自己的明确台账回收。
   */
  const SENTINEL_LOGIN_EMAIL = 'e2e_email_active_user@example.com';

  // 本轮台账：账号 / 成员关系 / 组织均登记真实 ID 与归属事实，按精确 ID 清理。
  // 清理器要求成员关系所属组织必须同时在本轮删除范围内，故组织与账号同批精确回收。
  let ownership: OwnedResourceLedger = createOwnedResourceLedger();
  // 组织编码带本轮标识：不重登旧行、也不覆盖旧行的受管标记（I10 口径）。
  const suiteOrganizationCodes = buildSuiteOrganizationCodes(`REGEMAIL_${RUN_TAG}`);

  // R04：清理失败时保留台账与失败原因，只有清理成功才重置；与永久反例共用同一实现。
  const lifecycle = createOwnedLedgerLifecycle({
    helper: 'register-email-active.e2e',
    getDataSource: () => dataSource,
    getOwned: () => ownership,
    resetOwned: () => {
      ownership = createOwnedResourceLedger();
    },
  });

  type SentinelSnapshot = {
    account: {
      id: number;
      loginName: string | null;
      loginEmail: string | null;
      status: string;
      identityHint: string | null;
      loginPassword: string;
    };
    userInfo: {
      id: number;
      accountId: number;
      nickname: string;
      email: string | null;
      userState: string | null;
      accessGroup: string[];
    } | null;
  } | null;

  let sentinelSnapshot: SentinelSnapshot = null;

  type GqlBody = {
    data?: {
      register?: { success?: boolean; accountId?: number };
      login?: { accessToken?: string };
    };
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };

  /** 读取哨兵当前行；不存在返回 null */
  const readSentinel = async (): Promise<SentinelSnapshot> => {
    const account = await dataSource
      .getRepository(AccountEntity)
      .findOne({ where: { loginEmail: SENTINEL_LOGIN_EMAIL } });
    if (!account) return null;

    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOne({ where: { accountId: account.id } });

    return {
      account: {
        id: account.id,
        loginName: account.loginName ?? null,
        loginEmail: account.loginEmail,
        status: account.status,
        identityHint: account.identityHint ?? null,
        loginPassword: account.loginPassword,
      },
      userInfo: userInfo
        ? {
            id: userInfo.id,
            accountId: userInfo.accountId,
            nickname: userInfo.nickname,
            email: userInfo.email ?? null,
            userState: userInfo.userState,
            accessGroup: Array.isArray(userInfo.accessGroup)
              ? [...userInfo.accessGroup]
              : (JSON.parse(userInfo.accessGroup) as string[]),
          }
        : null,
    };
  };

  /**
   * 只读快照外部哨兵（F3）。
   *
   * 哨兵由外部 harness 预注入，本规格绝不创建、登记或回收它；不存在时
   * （干净库路径）保持 null，不做任何断言。
   */
  const captureExternalSentinel = async (): Promise<void> => {
    sentinelSnapshot = await readSentinel();
  };

  /** 清理结束后核对：哨兵仍在且逐字段一致（任何删除/漂移都失败关闭） */
  const assertSentinelUnchanged = async (): Promise<void> => {
    if (!sentinelSnapshot) return;
    const current = await readSentinel();
    expect(current).toEqual(sentinelSnapshot);
  };

  /** 本轮账号/资料/成员/组织零残留（按本轮前缀精确核对，不看全局清库结果） */
  const assertRoundResidueZero = async (): Promise<void> => {
    const accountRows = await dataSource.query(
      `SELECT id FROM base_user_account
        WHERE login_name LIKE ? OR login_name LIKE ? OR login_name LIKE ?
           OR login_email LIKE ? OR login_email LIKE ? OR login_email LIKE ?`,
      [
        `${ROUND_LOGIN_PREFIX}%`,
        `${LEGACY_LOGIN_PREFIX}%`,
        `${GUARD_LOGIN_PREFIX}%`,
        `${ROUND_LOGIN_PREFIX}%`,
        `${LEGACY_LOGIN_PREFIX}%`,
        `${GUARD_LOGIN_PREFIX}%`,
      ],
    );
    expect(accountRows).toHaveLength(0);

    const userInfoRows = await dataSource.query(
      `SELECT account_id FROM base_user_info
        WHERE email LIKE ? OR email LIKE ? OR email LIKE ?`,
      [`${ROUND_LOGIN_PREFIX}%`, `${LEGACY_LOGIN_PREFIX}%`, `${GUARD_LOGIN_PREFIX}%`],
    );
    expect(userInfoRows).toHaveLength(0);

    const organizationRows = await dataSource
      .getRepository(OrganizationEntity)
      .find({ where: { organizationCode: Like(`E2E_REGEMAIL_${RUN_TAG}%`) } });
    expect(organizationRows).toHaveLength(0);
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

    await captureExternalSentinel();
  }, 30000);

  afterEach(async () => {
    // 精确回收本用例登记的真实账号（含资料/成员/组织）；成功后才重置台账。
    await lifecycle.afterTestCleanup();
  });

  afterAll(async () => {
    await runE2eTeardown({
      // 兜底回收本轮全部已登记资源；失败必须使规格失败
      cleanup: async () => {
        await lifecycle.cleanupRetainedForAfterAll();
      },
      // 哨兵与本轮残留核对放在清理之后：清理动作本身不能成为“清空数据库”的替代证据
      finalize: async () => {
        await assertSentinelUnchanged();
        await assertRoundResidueZero();
      },
      closeApp: app
        ? async () => {
            await app.close();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        : null,
    });
  });

  beforeEach(() => {
    // 不得无条件重置台账：上一用例清理失败时失败关闭，禁止在未恢复前继续造数。
    lifecycle.assertReadyForNextTest();
  });

  /** 碰撞检测：本轮标识必须全新；已有同登录名/邮箱的行一律失败，不认领旧行 */
  const assertNoCollision = async (loginName: string, loginEmail: string): Promise<void> => {
    const existing = await dataSource.getRepository(AccountEntity).find({
      where: [{ loginName }, { loginEmail }],
      select: { id: true },
    });
    if (existing.length > 0) {
      throw new Error(
        `本轮标识碰撞：登录名 ${loginName} 或邮箱 ${loginEmail} 已存在（ID=${existing
          .map((row) => row.id)
          .join(',')}），拒绝认领非本轮创建的行`,
      );
    }
  };

  /**
   * 直接建行的隔离 fixture（账号 + 资料，同一事务）。
   * 事务提交成功后才登记真实 ID 与事先已知事实；中途失败整体回滚，不会留下半账号。
   */
  const createFixtureAccount = async (
    loginName: string,
    loginEmail: string,
    ledger: OwnedResourceLedger,
    /** 资料昵称：默认由登录名推导；传入时用于构造昵称冲突等受控前置事实 */
    nickname?: string,
  ): Promise<number> => {
    await assertNoCollision(loginName, loginEmail);
    const fixtureNickname = nickname ?? `${loginName}_nickname`;

    const accountId = await dataSource.transaction(async (manager) => {
      const accountRepo = manager.getRepository(AccountEntity);
      const userInfoRepo = manager.getRepository(UserInfoEntity);

      const account = await accountRepo.save(
        accountRepo.create({
          loginName,
          loginEmail,
          loginPassword: 'temp',
          status: AccountStatus.ACTIVE,
          identityHint: IdentityTypeEnum.CUSTOMER,
        }),
      );
      const hashed = AccountService.hashPasswordWithTimestamp(LOGIN_PASSWORD, account.createdAt);
      await accountRepo.update(account.id, { loginPassword: hashed });
      await userInfoRepo.save(
        userInfoRepo.create({
          accountId: account.id,
          nickname: fixtureNickname,
          gender: Gender.SECRET,
          email: loginEmail,
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
          notifyCount: 0,
          unreadCount: 0,
          userState: UserState.ACTIVE,
        }),
      );
      return account.id;
    });

    recordOwnedResource(ledger, 'account', accountId, {
      loginName,
      loginEmail,
      status: AccountStatus.ACTIVE,
      identityHint: IdentityTypeEnum.CUSTOMER,
      accessGroup: [IdentityTypeEnum.CUSTOMER],
      nickname: fixtureNickname,
      userInfoEmail: loginEmail,
      userState: UserState.ACTIVE,
    });
    return accountId;
  };

  /**
   * 幂等建立本用例所需的有效组织，并登记到本用例台账。
   * 清理器要求成员关系所属组织必须同时在本轮删除范围内，故组织与账号同批精确回收。
   */
  const ensureOwnedOrganization = async (
    ledger: OwnedResourceLedger = ownership,
  ): Promise<number> => {
    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: 'E2E 邮箱注册主组织',
          kind: 'CLIENT',
          // Web 注册资格为 ACTIVE + 受管公司（V44）
          isManagedCompany: true,
        },
      ],
      ownership: ledger,
    });
    return requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
  };

  /**
   * 注册成功后立即登记本轮真实账号与从属资源。
   *
   * - 账号：读回实际行登记登录名/邮箱/状态/角色/资料事实（创建输入可能被归一化）；
   * - 成员关系：`membershipOrganizationId` 非空时按「账号 + 组织」定位，缺失即失败；
   * - 工程师待审申请：响应返回 applicationId 时读回行并登记（FK RESTRICT 要求先删申请）。
   *
   * 业务断言一律放在登记之后，避免断言失败时既没登记也没回收。
   */
  const recordCreatedWebRegistration = async (
    ledger: OwnedResourceLedger,
    response: request.Response,
    options: {
      membershipOrganizationId: number | null;
      /**
       * 客户资料的可信归属预期：Web 客户注册由入口确定，必须与创建请求一致。
       * 工程师/旧入口不写该字段时显式传 null；未登录时保持 undefined（无引用边时兼容）。
       */
      customerOrganizationId?: number | null;
    } = { membershipOrganizationId: null },
  ): Promise<void> => {
    const payload = (
      response.body as {
        data?: { register?: { accountId?: unknown; applicationId?: unknown } };
      }
    )?.data?.register;
    const createdAccountId = Number(payload?.accountId);
    if (!Number.isInteger(createdAccountId) || createdAccountId <= 0) {
      return;
    }

    const account = await dataSource
      .getRepository(AccountEntity)
      .findOneOrFail({ where: { id: createdAccountId } });
    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOneOrFail({ where: { accountId: createdAccountId } });
    recordOwnedResource(ledger, 'account', createdAccountId, {
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
      customerOrganizationId: options.customerOrganizationId,
    });

    if (options.membershipOrganizationId !== null) {
      const membership = await dataSource.getRepository(OrganizationMembershipEntity).findOne({
        where: { accountId: createdAccountId, organizationId: options.membershipOrganizationId },
      });
      if (!membership) {
        throw new Error(
          `本轮客户账号 ${createdAccountId} 缺少组织 ${options.membershipOrganizationId} 的成员关系，拒绝在清理范围不明时继续`,
        );
      }
      recordOwnedResource(ledger, 'membership', membership.id, {
        organizationId: options.membershipOrganizationId,
        accountId: createdAccountId,
        memberRole: membership.memberRole,
        status: membership.status,
      });
    }

    const createdApplicationId = Number(payload?.applicationId);
    if (Number.isInteger(createdApplicationId) && createdApplicationId > 0) {
      const application = await dataSource
        .getRepository(EngineerRegistrationApplicationEntity)
        .findOneOrFail({ where: { id: createdApplicationId } });
      recordOwnedResource(ledger, 'engineerRegistrationApplication', application.id, {
        accountId: application.accountId,
        organizationId: application.organizationId,
        applicationNote: application.applicationNote,
      });
    }
  };

  const performRegister = async (
    input: Record<string, unknown>,
    ledger: OwnedResourceLedger = ownership,
    options: { expectMembership?: boolean } = {},
  ) => {
    // 注册必填 organizationId：幂等建立本用例专属有效组织并登记到同一台账
    const primaryOrganizationId = await ensureOwnedOrganization(ledger);
    const payload: Record<string, unknown> = { organizationId: primaryOrganizationId, ...input };
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Register($input: RegisterWebInput!) {
            register: registerWeb(input: $input) { success message accountId applicationId }
          }
        `,
        variables: { input: payload },
      });

    // 成功即登记真实账号与成员关系（FK RESTRICT 链要求在删除账号前先删成员关系）。
    // 工程师注册不建成员关系、不写客户归属，调用方以 expectMembership=false 明确声明。
    await recordCreatedWebRegistration(ledger, response, {
      membershipOrganizationId: options.expectMembership === false ? null : primaryOrganizationId,
      customerOrganizationId: options.expectMembership === false ? null : primaryOrganizationId,
    });

    return response;
  };

  /**
   * 不建立组织夹具的直接调用：用于输入边界/重复冲突等**预期零新增**的用例。
   * 这些用例不得经由 `ensureOwnedOrganization` 提前造出组织，否则无法证明越界输入
   * 未新增任何公司/账号/资料/成员。
   */
  const performRegisterWithoutFixture = async (input: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Register($input: RegisterWebInput!) {
            register: registerWeb(input: $input) { success message accountId applicationId }
          }
        `,
        variables: { input },
      });

  /** 登记手填公司注册成功后的公司/成员/可信归属（并入参 response 必须已成功） */
  const recordSelfFilledRegistration = async (
    ledger: OwnedResourceLedger,
    response: request.Response,
    organizationName: string,
  ): Promise<void> => {
    await recordCreatedWebRegistration(ledger, response, { membershipOrganizationId: null });

    const company = await dataSource
      .getRepository(OrganizationEntity)
      .findOne({ where: { name: organizationName } });
    if (!company) {
      throw new Error(
        `手填公司注册成功后未找到公司「${organizationName}」，拒绝在清理范围不明时继续`,
      );
    }

    recordOwnedResource(ledger, 'organization', company.id, {
      organizationCode: company.organizationCode,
      name: company.name,
      kind: company.kind,
      status: company.status,
      isManagedCompany: Boolean(company.isManagedCompany),
    });

    const accountId = Number(
      (response.body as { data?: { register?: { accountId?: unknown } } })?.data?.register
        ?.accountId,
    );
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return;
    }

    const membership = await dataSource
      .getRepository(OrganizationMembershipEntity)
      .findOne({ where: { accountId, organizationId: company.id } });
    if (membership) {
      recordOwnedResource(ledger, 'membership', membership.id, {
        organizationId: company.id,
        accountId,
        memberRole: membership.memberRole,
        status: membership.status,
      });
    }
    // 手填公司分支写可信归属：存在公司删除边时必须登记预期
    updateOwnedExpectation(ledger, 'account', accountId, {
      customerOrganizationId: company.id,
    });
  };

  /** 旧 `register`（LEGACY）入口的原始调用：不建立组织夹具 */
  const postLegacyRegister = (input: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Register($input: RegisterInput!) {
            register(input: $input) { success message accountId applicationId }
          }
        `,
        variables: { input },
      });

  /** 旧 `register` 成功注册：建立并登记本用例组织，再登记账号与成员关系 */
  const performLegacyRegister = async (
    input: Record<string, unknown>,
    ledger: OwnedResourceLedger = ownership,
  ) => {
    const organizationId = await ensureOwnedOrganization(ledger);
    const response = await postLegacyRegister({ organizationId, ...input });
    await recordCreatedWebRegistration(ledger, response, {
      membershipOrganizationId: organizationId,
    });
    return response;
  };

  /** 按总长度构造合法邮箱（本地部分用 `x` 补齐），用于列宽边界样本 */
  const boundaryEmail = (localSeed: string, totalLength: number): string => {
    const domain = '@ex.com';
    return `${localSeed.padEnd(totalLength - domain.length, 'x')}${domain}`;
  };

  type GqlErrorBody = {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: string; extensions?: { code?: string; errorCode?: string } }>;
  };

  /** 读取首个 GraphQL 错误（无错误即失败） */
  const firstError = (
    response: request.Response,
  ): { code?: string; errorCode?: string; message: string } => {
    const body = response.body as GqlErrorBody;
    expect(body.errors?.length ?? 0).toBeGreaterThan(0);
    const error = body.errors?.[0];
    return {
      code: error?.extensions?.code,
      errorCode: error?.extensions?.errorCode,
      message: error?.message ?? '',
    };
  };

  /** 输入层拒绝：稳定大类必须是 BAD_USER_INPUT，且不是 MySQL 列宽兜底 */
  const expectInputRejected = (response: request.Response, expectedFragment: string): void => {
    const error = firstError(response);
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain(expectedFragment);
    expect(error.message).not.toMatch(/Data too long/i);
  };

  /** 输入被拒后账号/资料/组织零新增（成员关系依附账号，无账号即无成员） */
  const assertNoRegistrationResidue = async (params: {
    loginName?: string;
    loginEmail?: string;
    companyName?: string;
  }): Promise<void> => {
    const accountWhere: FindOptionsWhere<AccountEntity>[] = [];
    if (params.loginName) accountWhere.push({ loginName: params.loginName });
    if (params.loginEmail) accountWhere.push({ loginEmail: params.loginEmail });
    if (accountWhere.length > 0) {
      const accounts = await dataSource
        .getRepository(AccountEntity)
        .find({ where: accountWhere, select: { id: true } });
      expect(accounts).toHaveLength(0);
    }

    if (params.loginEmail) {
      const userInfos = await dataSource
        .getRepository(UserInfoEntity)
        .find({ where: { email: params.loginEmail }, select: { id: true } });
      expect(userInfos).toHaveLength(0);
    }

    if (params.companyName) {
      const companies = await dataSource
        .getRepository(OrganizationEntity)
        .find({ where: { name: params.companyName }, select: { id: true } });
      expect(companies).toHaveLength(0);
    }
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

  // 计数/失败注入代理：只包装真实 DataSource 的事务 manager，不触碰 src
  interface TransactionStats {
    transactionCount: number;
    deleteCount: number;
  }

  const isDeleteSql = (sql: string): boolean => /^\s*DELETE\b/i.test(sql);

  const createDeleteCountingDataSource = (
    target: DataSource,
  ): { dataSource: DataSource; stats: TransactionStats } => {
    const stats: TransactionStats = { transactionCount: 0, deleteCount: 0 };
    const proxy = new Proxy(target, {
      get: (object, property, receiver) => {
        if (property === 'transaction') {
          return (run: (manager: EntityManager) => Promise<unknown>) => {
            stats.transactionCount += 1;
            return target.transaction(async (manager) => {
              const wrappedManager = new Proxy(manager, {
                get: (managerTarget, managerProperty, managerReceiver) => {
                  if (managerProperty === 'query') {
                    return (sql: string, params?: unknown[]) => {
                      if (isDeleteSql(sql)) stats.deleteCount += 1;
                      return manager.query(sql, params);
                    };
                  }
                  return Reflect.get(managerTarget, managerProperty, managerReceiver);
                },
              });
              return run(wrappedManager);
            });
          };
        }
        return Reflect.get(object, property, receiver);
      },
    });
    return { dataSource: proxy, stats };
  };

  const createFailNthDeleteDataSource = (
    target: DataSource,
    failAt: number,
  ): { dataSource: DataSource; stats: TransactionStats; injectedError: Error } => {
    const stats: TransactionStats = { transactionCount: 0, deleteCount: 0 };
    const injectedError = new Error(`注入：第 ${failAt} 次 DELETE 失败`);
    const proxy = new Proxy(target, {
      get: (object, property, receiver) => {
        if (property === 'transaction') {
          return (run: (manager: EntityManager) => Promise<unknown>) => {
            stats.transactionCount += 1;
            return target.transaction(async (manager) => {
              const wrappedManager = new Proxy(manager, {
                get: (managerTarget, managerProperty, managerReceiver) => {
                  if (managerProperty === 'query') {
                    return (sql: string, params?: unknown[]) => {
                      if (isDeleteSql(sql)) {
                        stats.deleteCount += 1;
                        if (stats.deleteCount === failAt) return Promise.reject(injectedError);
                      }
                      return manager.query(sql, params);
                    };
                  }
                  return Reflect.get(managerTarget, managerProperty, managerReceiver);
                },
              });
              return run(wrappedManager);
            });
          };
        }
        return Reflect.get(object, property, receiver);
      },
    });
    return { dataSource: proxy, stats, injectedError };
  };

  describe('完整链路：注册成功后立即可用', () => {
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
    it('注册不返回成功，账号/密码哈希/资料全部回滚，不留下 ACTIVE / PENDING', async () => {
      const accountService = app.get(AccountService);
      const saveUserInfoSpy = jest
        .spyOn(accountService, 'saveUserInfo')
        .mockRejectedValueOnce(new Error('e2e forced user_info failure'));

      try {
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
      } finally {
        saveUserInfoSpy.mockRestore();
      }
    });
  });

  describe('安全回归：人工 ACTIVE / PENDING fixture 的受保护请求失败关闭', () => {
    it('签发 Token 后 userState 降级为 PENDING，受保护请求按每请求复核返回 UNAUTHENTICATED', async () => {
      // 隔离 fixture：人工创建 ACTIVE / ACTIVE（不经任何业务入口，不做管理员修复）
      const accountId = await createFixtureAccount(LEGACY_LOGIN_NAME, LEGACY_EMAIL, ownership);
      const accountRepo = dataSource.getRepository(AccountEntity);
      const userInfoRepo = dataSource.getRepository(UserInfoEntity);

      // 确认 fixture 落库形态确为 ACTIVE / ACTIVE
      const fixtureAccount = await accountRepo.findOne({ where: { id: accountId } });
      const fixtureUserInfo = await userInfoRepo.findOne({ where: { accountId } });
      expect(fixtureAccount?.status).toBe(AccountStatus.ACTIVE);
      expect(fixtureUserInfo?.userState).toBe(UserState.ACTIVE);

      // 正常状态可登录并取得 Token
      const loginResponse = await performLogin(LEGACY_LOGIN_NAME, LOGIN_PASSWORD);
      expect(loginResponse.status).toBe(200);
      const loginBody = loginResponse.body as GqlBody;
      const accessToken = loginBody.data?.login?.accessToken;
      expect(typeof accessToken).toBe('string');

      // 已签发 Token 之后 userState 降级：受保护请求在每请求复核门禁失败关闭为 UNAUTHENTICATED
      await userInfoRepo.update({ accountId }, { userState: UserState.PENDING });
      // 受控的状态变化必须同步到台账预期，清理前仍会逐字段核对
      updateOwnedExpectation(ownership, 'account', accountId, { userState: UserState.PENDING });

      const protectedResponse = await queryProtectedUserInfo(accessToken as string, accountId);
      const protectedBody = protectedResponse.body as {
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
      };
      expect(protectedBody.errors?.length ?? 0).toBeGreaterThan(0);
      expect(protectedBody.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('清理门禁与本轮归属（定向）', () => {
    it('缺少清理许可：拒绝执行，DELETE=0，随后恢复许可可精确回收', async () => {
      const ledger: OwnedResourceLedger = createOwnedResourceLedger();
      await createFixtureAccount(
        `${GUARD_LOGIN_PREFIX}${RUN_TAG}c1`,
        `${GUARD_LOGIN_PREFIX}${RUN_TAG}c1@ex.com`,
        ledger,
      );

      const consent = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
      const counted = createDeleteCountingDataSource(dataSource);
      try {
        delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
        await expect(
          runGuardedSpecCleanup({
            dataSource: counted.dataSource,
            owned: ledger,
            helper: 'register-email-active 无许可反例',
          }),
        ).rejects.toThrow(/清理许可门禁/);
        expect(counted.stats.deleteCount).toBe(0);
        expect(counted.stats.transactionCount).toBe(0);
      } finally {
        restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consent);
        // 恢复许可后按同一台账精确回收，证明反例本身没有制造残留
        await runGuardedSpecCleanup({
          dataSource,
          owned: ledger,
          helper: 'register-email-active 无许可反例恢复',
        });
      }
    });

    it('库名不在白名单：拒绝执行，DELETE=0，不触碰真实行', async () => {
      const ledger: OwnedResourceLedger = createOwnedResourceLedger();
      await createFixtureAccount(
        `${GUARD_LOGIN_PREFIX}${RUN_TAG}c2`,
        `${GUARD_LOGIN_PREFIX}${RUN_TAG}c2@ex.com`,
        ledger,
      );

      const allowed = captureEnvValue('E2E_ALLOWED_DB_NAMES');
      const counted = createDeleteCountingDataSource(dataSource);
      try {
        process.env.E2E_ALLOWED_DB_NAMES = 'e2e_not_the_current_database';
        await expect(
          runGuardedSpecCleanup({
            dataSource: counted.dataSource,
            owned: ledger,
            helper: 'register-email-active 错库反例',
          }),
        ).rejects.toThrow(/不在允许的 E2E 库白名单/);
        expect(counted.stats.deleteCount).toBe(0);
      } finally {
        restoreEnvValue('E2E_ALLOWED_DB_NAMES', allowed);
        await runGuardedSpecCleanup({
          dataSource,
          owned: ledger,
          helper: 'register-email-active 错库反例恢复',
        });
      }
    });

    it('状态字段漂移：首删前拒绝且 DELETE=0，恢复预期后可回收', async () => {
      const ledger: OwnedResourceLedger = createOwnedResourceLedger();
      const loginName = `${GUARD_LOGIN_PREFIX}${RUN_TAG}c3`;
      const accountId = await createFixtureAccount(loginName, `${loginName}@ex.com`, ledger);

      const accountRepo = dataSource.getRepository(AccountEntity);
      await accountRepo.update({ id: accountId }, { status: AccountStatus.SUSPENDED });

      const counted = createDeleteCountingDataSource(dataSource);
      try {
        await expect(
          runGuardedSpecCleanup({
            dataSource: counted.dataSource,
            owned: ledger,
            helper: 'register-email-active 状态漂移反例',
          }),
        ).rejects.toThrow(/漂移/);
        expect(counted.stats.deleteCount).toBe(0);

        // 漂移现场保持不变（拒绝发生在任何 DELETE 之前）
        const drifted = await accountRepo.findOne({ where: { id: accountId } });
        expect(drifted?.status).toBe(AccountStatus.SUSPENDED);
      } finally {
        await accountRepo.update({ id: accountId }, { status: AccountStatus.ACTIVE });
        await runGuardedSpecCleanup({
          dataSource,
          owned: ledger,
          helper: 'register-email-active 状态漂移恢复',
        });
      }
    });

    it('后序 DELETE 注错：真实事务回滚，行集合保持不变，随后正常回收零残留', async () => {
      const ledger: OwnedResourceLedger = createOwnedResourceLedger();
      const registerResponse = await performRegister(
        {
          loginName: `${GUARD_LOGIN_PREFIX}${RUN_TAG}c4`,
          loginEmail: `${GUARD_LOGIN_PREFIX}${RUN_TAG}c4@ex.com`,
          loginPassword: LOGIN_PASSWORD,
          nickname: 'E2E清理注入用户',
          type: RegisterTypeEnum.CUSTOMER,
        },
        ledger,
      );
      expect((registerResponse.body as GqlBody).data?.register?.success).toBe(true);

      const accountId = ledger.accountIds[0];
      const membershipId = ledger.membershipIds[0];
      const organizationId = ledger.organizationIds[0];
      expect(accountId).toBeGreaterThan(0);
      expect(membershipId).toBeGreaterThan(0);
      expect(organizationId).toBeGreaterThan(0);

      // 至少 3 条 DELETE（成员/资料/组织/账号），第 2 条注错必定发生在已执行部分删除之后
      const failing = createFailNthDeleteDataSource(dataSource, 2);
      try {
        await expect(
          runGuardedSpecCleanup({
            dataSource: failing.dataSource,
            owned: ledger,
            helper: 'register-email-active 后序 DELETE 注错',
          }),
        ).rejects.toThrow(failing.injectedError.message);
        expect(failing.stats.deleteCount).toBe(2);

        // 事务回滚：本轮账号、资料、成员、组织仍然存在（不是“结束后清库”代证）
        expect(
          await dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } }),
        ).not.toBeNull();
        expect(
          await dataSource.getRepository(UserInfoEntity).findOne({ where: { accountId } }),
        ).not.toBeNull();
        expect(
          await dataSource
            .getRepository(OrganizationMembershipEntity)
            .findOne({ where: { id: membershipId } }),
        ).not.toBeNull();
        expect(
          await dataSource
            .getRepository(OrganizationEntity)
            .findOne({ where: { id: organizationId } }),
        ).not.toBeNull();
      } finally {
        // 正常清理：注册链按真实外键顺序回收，零残留
        await runGuardedSpecCleanup({
          dataSource,
          owned: ledger,
          helper: 'register-email-active 后序 DELETE 注错恢复',
        });
      }

      expect(
        await dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } }),
      ).toBeNull();
    });
  });

  /**
   * I5（独立终审）：Web 注册的输入边界必须与写入列宽一致。
   *
   * 列宽事实：`base_user_account.login_name` 30、`base_user_account.login_email` 100、
   * `base_user_info.email` 50、`base_user_info.nickname` 50。Web 联系邮箱默认取登录邮箱，
   * 因此登录邮箱上限收敛到两列共同支持的 50；登录名仍为 4–30；默认昵称候选最多 43
   * 个字符，为冲突后缀（`#` + 6 位）预留空间。
   *
   * 越界用例必须表现为**输入层拒绝**（`BAD_USER_INPUT`），而不是 MySQL `Data too long`
   * 兜底，并且账号、资料、公司、成员零新增。
   */
  describe('I5 · Web 注册输入与写入约束（真实 GraphQL）', () => {
    const I5_LOGIN_PREFIX = 'e2ei5_';

    it('客户：50 字符登录邮箱成功，两邮箱列、默认昵称与 CUSTOMER 归属一致', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}a`;
      const loginEmail = boundaryEmail(loginName, 50);
      expect(loginEmail).toHaveLength(50);

      const response = await performRegister({
        loginName,
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      const body = response.body as GqlBody;
      expect(body.errors).toBeUndefined();
      expect(body.data?.register?.success).toBe(true);
      const accountId = body.data?.register?.accountId;

      const account = await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { id: accountId } });
      expect(account.loginName).toBe(loginName);
      expect(account.loginEmail).toBe(loginEmail);
      expect(account.loginEmail).toHaveLength(50);
      expect(account.status).toBe(AccountStatus.ACTIVE);

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId } });
      expect(userInfo.email).toBe(loginEmail);
      // 默认昵称优先级：显式昵称 > 登录名 > 邮箱前缀 > 兜底
      expect(userInfo.nickname).toBe(loginName);
      expect(userInfo.userState).toBe(UserState.ACTIVE);

      const organizationId = ownership.organizationIds[0];
      expect(userInfo.customerOrganizationId).toBe(organizationId);
      const membership = await dataSource
        .getRepository(OrganizationMembershipEntity)
        .findOneOrFail({ where: { accountId, organizationId } });
      expect(membership.memberRole).toBe(IdentityTypeEnum.CUSTOMER);
      expect(membership.status).toBe('ACTIVE');
    });

    it('客户：51 字符邮箱 + 手填公司 → BAD_USER_INPUT，账号/资料/组织零新增', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}b`;
      const loginEmail = boundaryEmail(loginName, 51);
      const companyName = `E2E 越界手填公司 ${RUN_TAG}b`;
      expect(loginEmail).toHaveLength(51);

      const response = await performRegisterWithoutFixture({
        loginName,
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
        organizationName: companyName,
      });

      expectInputRejected(response, '50');
      await assertNoRegistrationResidue({ loginName, loginEmail, companyName });
    });

    it('客户：31 字符登录名 → BAD_USER_INPUT，账号/资料/组织零新增', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}c`.padEnd(31, 'c');
      const loginEmail = `${loginName}@ex.com`;
      const companyName = `E2E 越界手填公司 ${RUN_TAG}c`;
      expect(loginName).toHaveLength(31);

      const response = await performRegisterWithoutFixture({
        loginName,
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
        organizationName: companyName,
      });

      expectInputRejected(response, '30');
      await assertNoRegistrationResidue({ loginName, loginEmail, companyName });
    });

    it('客户：30 字符登录名成功写入（列宽上限）', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}d`.padEnd(30, 'd');
      const loginEmail = `${loginName}@ex.com`;
      expect(loginName).toHaveLength(30);

      const response = await performRegister({
        loginName,
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      const body = response.body as GqlBody;
      expect(body.errors).toBeUndefined();

      const account = await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { id: body.data?.register?.accountId } });
      expect(account.loginName).toBe(loginName);
      expect(account.loginName).toHaveLength(30);
    });

    it('客户：首尾空格去除、邮箱小写归一后再写入', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}e`;
      const loginEmail = `${loginName}@Ex.Com`;

      const response = await performRegister({
        loginName: `  ${loginName}  `,
        loginEmail: `  ${loginEmail}  `,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      const body = response.body as GqlBody;
      expect(body.errors).toBeUndefined();

      const accountId = body.data?.register?.accountId;
      const account = await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { id: accountId } });
      expect(account.loginName).toBe(loginName);
      expect(account.loginEmail).toBe(loginEmail.toLowerCase());

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId } });
      expect(userInfo.email).toBe(loginEmail.toLowerCase());
    });

    it('客户：昵称显式 null 时回落到登录名候选', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}f`;

      const response = await performRegister({
        loginName,
        loginEmail: `${loginName}@ex.com`,
        loginPassword: LOGIN_PASSWORD,
        nickname: null,
        type: RegisterTypeEnum.CUSTOMER,
      });
      const body = response.body as GqlBody;
      expect(body.errors).toBeUndefined();

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId: body.data?.register?.accountId } });
      expect(userInfo.nickname).toBe(loginName);
    });

    it('客户：省略登录名与昵称时以 43 字符邮箱前缀作为默认昵称', async () => {
      const loginEmail = boundaryEmail(`${I5_LOGIN_PREFIX}${RUN_TAG}g`, 50);
      const localPart = loginEmail.split('@')[0];
      expect(Array.from(localPart)).toHaveLength(43);

      const response = await performRegister({
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      const body = response.body as GqlBody;
      expect(body.errors).toBeUndefined();

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId: body.data?.register?.accountId } });
      expect(userInfo.nickname).toBe(localPart);
      expect(userInfo.nickname).toHaveLength(43);
    });

    it('客户：默认昵称冲突时追加后缀，总长不超过 50', async () => {
      const loginEmail = boundaryEmail(`${I5_LOGIN_PREFIX}${RUN_TAG}h`, 50);
      const localPart = loginEmail.split('@')[0];
      const holderLoginName = `${I5_LOGIN_PREFIX}${RUN_TAG}h0`;
      // 受控前置事实：占用同名昵称（资料昵称直接写入 fixture，登记到本轮台账）
      await createFixtureAccount(
        holderLoginName,
        `${holderLoginName}@ex.com`,
        ownership,
        localPart,
      );

      const response = await performRegister({
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      const body = response.body as GqlBody;
      expect(body.errors).toBeUndefined();

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId: body.data?.register?.accountId } });
      expect(userInfo.nickname.startsWith(`${localPart}#`)).toBe(true);
      expect(userInfo.nickname.length).toBeGreaterThan(localPart.length);
      expect(userInfo.nickname.length).toBeLessThanOrEqual(50);
    });

    it('客户：中文昵称（Unicode）原样写入', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}i`;
      const nickname = '邮箱注册用户·甲';

      const response = await performRegister({
        loginName,
        loginEmail: `${loginName}@ex.com`,
        loginPassword: LOGIN_PASSWORD,
        nickname,
        type: RegisterTypeEnum.CUSTOMER,
      });
      const body = response.body as GqlBody;
      expect(body.errors).toBeUndefined();

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId: body.data?.register?.accountId } });
      expect(userInfo.nickname).toBe(nickname);
    });

    it('工程师：50 字符邮箱成功，双状态 PENDING、仅落待审申请且无成员关系', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}j`;
      const loginEmail = boundaryEmail(loginName, 50);

      const response = await performRegister(
        {
          loginName,
          loginEmail,
          loginPassword: LOGIN_PASSWORD,
          type: RegisterTypeEnum.ENGINEER,
          realName: 'E2E 工程师',
          phone: '13800000000',
        },
        ownership,
        { expectMembership: false },
      );
      const body = response.body as {
        data?: { register?: { success?: boolean; accountId?: number; applicationId?: number } };
        errors?: GqlErrorBody['errors'];
      };
      expect(body.errors).toBeUndefined();
      const accountId = body.data?.register?.accountId;
      const applicationId = body.data?.register?.applicationId;
      expect(typeof applicationId).toBe('number');

      const account = await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { id: accountId } });
      expect(account.status).toBe(AccountStatus.PENDING);

      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId } });
      expect(userInfo.userState).toBe(UserState.PENDING);
      expect(userInfo.email).toBe(loginEmail);

      const application = await dataSource
        .getRepository(EngineerRegistrationApplicationEntity)
        .findOneOrFail({ where: { id: applicationId } });
      expect(application.accountId).toBe(accountId);
      expect(application.status).toBe('PENDING');
      expect(application.organizationId).toBe(ownership.organizationIds[0]);
      expect(application.applicationNote).toBeNull();

      const memberships = await dataSource
        .getRepository(OrganizationMembershipEntity)
        .find({ where: { accountId } });
      expect(memberships).toHaveLength(0);
    });

    it('工程师：51 字符邮箱 → BAD_USER_INPUT，账号与待审申请零新增', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}k`;
      const loginEmail = boundaryEmail(loginName, 51);
      const organizationId = await ensureOwnedOrganization();

      const response = await performRegisterWithoutFixture({
        loginName,
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.ENGINEER,
        realName: 'E2E 工程师',
        phone: '13800000000',
        organizationId,
      });

      expectInputRejected(response, '50');
      await assertNoRegistrationResidue({ loginName, loginEmail });
      const applications = await dataSource
        .getRepository(EngineerRegistrationApplicationEntity)
        .find({ where: { organizationId }, select: { id: true } });
      expect(applications).toHaveLength(0);
    });

    it('工程师：31 字符登录名 → BAD_USER_INPUT，账号与待审申请零新增', async () => {
      const loginName = `${I5_LOGIN_PREFIX}${RUN_TAG}l`.padEnd(31, 'l');
      const loginEmail = `${loginName}@ex.com`;
      const organizationId = await ensureOwnedOrganization();

      const response = await performRegisterWithoutFixture({
        loginName,
        loginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.ENGINEER,
        realName: 'E2E 工程师',
        phone: '13800000000',
        organizationId,
      });

      expectInputRejected(response, '30');
      await assertNoRegistrationResidue({ loginName, loginEmail });
      const applications = await dataSource
        .getRepository(EngineerRegistrationApplicationEntity)
        .find({ where: { organizationId }, select: { id: true } });
      expect(applications).toHaveLength(0);
    });
  });

  /**
   * I6（独立终审）：重复账号事实与入口类别必须区分。
   *
   * 基线旧 `register` 的 `ACCOUNT_ALREADY_EXISTS` 稳定大类是 `BAD_USER_INPUT`；
   * Web `registerWeb` 使用独立错误码 `REGISTRATION_ACCOUNT_EXISTS` 并映射 `CONFLICT`。
   * 两条重复路径（预检查、唯一索引兜底）共用同一决定点，类别随入口而非数据来源。
   */
  describe('I6 · 重复账号的错误类别（真实 GraphQL）', () => {
    const I6_LOGIN_PREFIX = 'e2ei6_';

    it('同邮箱/同登录名重复：Web 为 CONFLICT，旧 register 为 BAD_USER_INPUT', async () => {
      const webLoginName = `${I6_LOGIN_PREFIX}${RUN_TAG}w`;
      const webLoginEmail = `${webLoginName}@ex.com`;
      const webResponse = await performRegister({
        loginName: webLoginName,
        loginEmail: webLoginEmail,
        loginPassword: LOGIN_PASSWORD,
        nickname: '重复入口用户',
        type: RegisterTypeEnum.CUSTOMER,
      });
      expect((webResponse.body as GqlBody).data?.register?.success).toBe(true);

      const legacyLoginName = `${I6_LOGIN_PREFIX}${RUN_TAG}l`;
      const legacyLoginEmail = `${legacyLoginName}@ex.com`;
      const legacyResponse = await performLegacyRegister({
        loginName: legacyLoginName,
        loginEmail: legacyLoginEmail,
        loginPassword: LOGIN_PASSWORD,
        nickname: '旧入口用户',
        type: RegisterTypeEnum.CUSTOMER,
      });
      expect((legacyResponse.body as GqlBody).data?.register?.success).toBe(true);

      const organizationId = await ensureOwnedOrganization();

      const webDupEmail = await performRegisterWithoutFixture({
        loginName: `${I6_LOGIN_PREFIX}${RUN_TAG}w2`,
        loginEmail: webLoginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
        organizationId,
      });
      expect(firstError(webDupEmail)).toMatchObject({
        code: 'CONFLICT',
        errorCode: ACCOUNT_ERROR.REGISTRATION_ACCOUNT_EXISTS,
      });

      const webDupLoginName = await performRegisterWithoutFixture({
        loginName: webLoginName,
        loginEmail: `${I6_LOGIN_PREFIX}${RUN_TAG}w3@ex.com`,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
        organizationId,
      });
      expect(firstError(webDupLoginName)).toMatchObject({
        code: 'CONFLICT',
        errorCode: ACCOUNT_ERROR.REGISTRATION_ACCOUNT_EXISTS,
      });

      const legacyDupEmail = await postLegacyRegister({
        organizationId,
        loginName: `${I6_LOGIN_PREFIX}${RUN_TAG}l2`,
        loginEmail: legacyLoginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      expect(firstError(legacyDupEmail)).toMatchObject({
        code: 'BAD_USER_INPUT',
        errorCode: ACCOUNT_ERROR.ACCOUNT_ALREADY_EXISTS,
      });

      const legacyDupLoginName = await postLegacyRegister({
        organizationId,
        loginName: legacyLoginName,
        loginEmail: `${I6_LOGIN_PREFIX}${RUN_TAG}l3@ex.com`,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      expect(firstError(legacyDupLoginName)).toMatchObject({
        code: 'BAD_USER_INPUT',
        errorCode: ACCOUNT_ERROR.ACCOUNT_ALREADY_EXISTS,
      });

      // 交叉入口：类别随入口选择，不随重复事实来自哪条通道
      const legacyHitsWebEmail = await postLegacyRegister({
        organizationId,
        loginName: `${I6_LOGIN_PREFIX}${RUN_TAG}l4`,
        loginEmail: webLoginEmail,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
      });
      expect(firstError(legacyHitsWebEmail)).toMatchObject({
        code: 'BAD_USER_INPUT',
        errorCode: ACCOUNT_ERROR.ACCOUNT_ALREADY_EXISTS,
      });

      const webHitsLegacyLoginName = await performRegisterWithoutFixture({
        loginName: legacyLoginName,
        loginEmail: `${I6_LOGIN_PREFIX}${RUN_TAG}w4@ex.com`,
        loginPassword: LOGIN_PASSWORD,
        type: RegisterTypeEnum.CUSTOMER,
        organizationId,
      });
      expect(firstError(webHitsLegacyLoginName)).toMatchObject({
        code: 'CONFLICT',
        errorCode: ACCOUNT_ERROR.REGISTRATION_ACCOUNT_EXISTS,
      });
    });

    /**
     * 自然并发：两个请求同时提交同一登录名（各自手填不同公司）。
     * 只能有一个成功；失败方的事务必须整体回滚，不留下孤立公司/账号/资料/申请。
     */
    it('并发同登录名注册：只成功一个，失败方无孤立公司/账号/资料', async () => {
      const contestedLoginName = `${I6_LOGIN_PREFIX}${RUN_TAG}c`;
      const candidates = [
        {
          companyName: `E2E 并发公司甲 ${RUN_TAG}`,
          loginEmail: `${contestedLoginName}a@ex.com`,
          nickname: '并发注册甲',
        },
        {
          companyName: `E2E 并发公司乙 ${RUN_TAG}`,
          loginEmail: `${contestedLoginName}b@ex.com`,
          nickname: '并发注册乙',
        },
      ];

      const responses = await Promise.all(
        candidates.map((candidate) =>
          performRegisterWithoutFixture({
            loginName: contestedLoginName,
            loginEmail: candidate.loginEmail,
            loginPassword: LOGIN_PASSWORD,
            nickname: candidate.nickname,
            type: RegisterTypeEnum.CUSTOMER,
            organizationName: candidate.companyName,
          }),
        ),
      );

      const outcomes = candidates.map((candidate, index) => ({
        ...candidate,
        response: responses[index],
        success: (responses[index].body as GqlBody).data?.register?.success === true,
      }));
      const winners = outcomes.filter((outcome) => outcome.success);
      const losers = outcomes.filter((outcome) => !outcome.success);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      expect(firstError(losers[0].response)).toMatchObject({
        code: 'CONFLICT',
        errorCode: ACCOUNT_ERROR.REGISTRATION_ACCOUNT_EXISTS,
      });

      // 成功方资源全部登记（账号/成员/公司/可信归属），失败方整体回滚
      await recordSelfFilledRegistration(ownership, winners[0].response, winners[0].companyName);

      const accounts = await dataSource
        .getRepository(AccountEntity)
        .find({ where: { loginName: contestedLoginName } });
      expect(accounts).toHaveLength(1);
      expect(accounts[0].loginEmail).toBe(winners[0].loginEmail);

      const loserCompanyRows = await dataSource
        .getRepository(OrganizationEntity)
        .find({ where: { name: losers[0].companyName }, select: { id: true } });
      expect(loserCompanyRows).toHaveLength(0);

      const loserUserInfos = await dataSource
        .getRepository(UserInfoEntity)
        .find({ where: { email: losers[0].loginEmail }, select: { id: true } });
      expect(loserUserInfos).toHaveLength(0);

      const applications = await dataSource
        .getRepository(EngineerRegistrationApplicationEntity)
        .find({ where: { accountId: accounts[0].id }, select: { id: true } });
      expect(applications).toHaveLength(0);
    });

    /**
     * 受控竞态：把重复预检查固定为「未命中」，强制两个请求都进入写入事务，
     * 由 `uk_login_name` 唯一索引兜底——证明兜底路径同样映射 Web 的
     * `REGISTRATION_ACCOUNT_EXISTS` / `CONFLICT`，且失败事务无孤立公司。
     */
    it('唯一索引兜底：预检查放行后仍只成功一个，失败方整体回滚', async () => {
      const contestedLoginName = `${I6_LOGIN_PREFIX}${RUN_TAG}d`;
      const candidates = [
        {
          companyName: `E2E 兜底公司甲 ${RUN_TAG}`,
          loginEmail: `${contestedLoginName}a@ex.com`,
          nickname: '兜底注册甲',
        },
        {
          companyName: `E2E 兜底公司乙 ${RUN_TAG}`,
          loginEmail: `${contestedLoginName}b@ex.com`,
          nickname: '兜底注册乙',
        },
      ];

      const accountQueryService = app.get(AccountQueryService);
      const precheckSpy = jest
        .spyOn(accountQueryService, 'checkAccountExists')
        .mockResolvedValue(false);
      let responses: request.Response[];
      try {
        responses = await Promise.all(
          candidates.map((candidate) =>
            performRegisterWithoutFixture({
              loginName: contestedLoginName,
              loginEmail: candidate.loginEmail,
              loginPassword: LOGIN_PASSWORD,
              nickname: candidate.nickname,
              type: RegisterTypeEnum.CUSTOMER,
              organizationName: candidate.companyName,
            }),
          ),
        );
      } finally {
        precheckSpy.mockRestore();
      }

      const outcomes = candidates.map((candidate, index) => ({
        ...candidate,
        response: responses[index],
        success: (responses[index].body as GqlBody).data?.register?.success === true,
      }));
      const winners = outcomes.filter((outcome) => outcome.success);
      const losers = outcomes.filter((outcome) => !outcome.success);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(firstError(losers[0].response)).toMatchObject({
        code: 'CONFLICT',
        errorCode: ACCOUNT_ERROR.REGISTRATION_ACCOUNT_EXISTS,
      });

      await recordSelfFilledRegistration(ownership, winners[0].response, winners[0].companyName);

      const accounts = await dataSource
        .getRepository(AccountEntity)
        .find({ where: { loginName: contestedLoginName } });
      expect(accounts).toHaveLength(1);

      const loserCompanyRows = await dataSource
        .getRepository(OrganizationEntity)
        .find({ where: { name: losers[0].companyName }, select: { id: true } });
      expect(loserCompanyRows).toHaveLength(0);

      const loserUserInfos = await dataSource
        .getRepository(UserInfoEntity)
        .find({ where: { email: losers[0].loginEmail }, select: { id: true } });
      expect(loserUserInfos).toHaveLength(0);
    });
  });
});
