// test/02-register/engineer-registration-approval.e2e-spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  AccountStatus,
  IdentityTypeEnum,
  LoginTypeEnum,
  AudienceTypeEnum,
} from '@app-types/models/account.types';
import {
  EngineerRegistrationApplicationStatus,
  EngineerRegistrationReviewAction,
  RegistrationOutcomeStatus,
} from '@app-types/models/registration.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import { UserState } from '@app-types/models/user-info.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { EngineerRegistrationService } from '../../src/modules/lithography/engineer-registration.service';
import { OrganizationMembershipService } from '../../src/modules/lithography/organization-membership.service';
import { OrganizationMembershipEntity } from '../../src/modules/lithography/entities/organization-membership.entity';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedAccountFacts,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';

/** 本轮一次性短标识：组织编码按轮派生，避免上一轮残留被当作本轮资源接管。 */
const RUN_TAG = Math.random().toString(36).slice(2, 8).padEnd(6, '0');

/**
 * 工程师自助注册 + 组织管理员审核真实链路 E2E。
 *
 * 覆盖 S5 要求的跨进程可观察事实：
 * 1. 客户选择组织后即时开通并建立成员关系，可登录；
 * 2. 工程师注册 → `PENDING/PENDING`、无成员关系、登录与令牌被阻断；
 * 3. 本人凭据查询、拒绝后重提，历史拒绝记录保留；
 * 4. 本组织管理员队列/详情/通过/拒绝；跨组织与非管理员被拒；
 * 5. 审核通过时账号、资料、有效成员关系与申请终态同事务生效；
 * 6. 审核成员写入失败时整体回滚，申请仍待审、账号仍待审；
 * 7. 真实并发：同凭据注册、重复重提、相反决策，单待审/单有效成员约束有效；
 * 8. 清理走 `runGuardedSpecCleanup`（DATABASE() 白名单 + 账本事实核验 + 引用闭包 + 单事务），
 *    收尾后再按本轮台账断言零残留。
 *
 * 造数纪律：全部业务写入只走 GraphQL 入口；数据库仅用于只读核验与受控清理。
 */

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string; details?: unknown };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type ApplicationPayload = {
  id: number;
  accountId: number;
  organizationId: number;
  status: EngineerRegistrationApplicationStatus;
  applicationNote: string | null;
  submittedAt: string;
  reviewedByAccountId: number | null;
  reviewedAt: string | null;
  reviewComment: string | null;
};

type AdminItemPayload = {
  application: ApplicationPayload;
  organizationName: string | null;
  applicant: {
    id: number;
    loginName: string | null;
    loginEmail: string | null;
    nickname: string;
    role: IdentityTypeEnum;
    status: AccountStatus;
  };
};

/** 既有详情契约的申请人字段面：账号管理 `AdminUserDTO` */
type AdminDetailPayload = {
  application: ApplicationPayload;
  organizationName: string | null;
  applicant: {
    id: number;
    loginName: string | null;
    loginEmail: string | null;
    nickname: string;
    companyName: string | null;
    phone: string | null;
    contactEmail: string | null;
    role: IdentityTypeEnum;
    status: AccountStatus;
    createdAt: string;
    updatedAt: string;
  };
};

/** 审批详情专用读模型：申请人资料含真实姓名，不含角色 / 账号状态 / 登录邮箱 */
type AdminApprovalDetailPayload = {
  application: ApplicationPayload;
  organizationName: string | null;
  applicant: {
    id: number;
    loginName: string | null;
    nickname: string;
    realName: string | null;
    phone: string | null;
    contactEmail: string | null;
  };
};

type AdminPagePayload = {
  items: AdminItemPayload[];
  total: number;
  page: number;
  pageSize: number;
};

type RegisterPayload = {
  success: boolean;
  message: string;
  accountId?: number | null;
  registrationStatus: RegistrationOutcomeStatus;
  applicationId?: number | null;
};

/** 本规格注册入口的显式输入：登记创建事实时只使用这些确定值，不依赖回读。 */
type RegisterInput = {
  loginName?: string | null;
  loginEmail: string;
  loginPassword: string;
  nickname: string;
  realName?: string | null;
  phone?: string | null;
  type?: RegisterTypeEnum;
  organizationId: number;
  applicationNote?: string | null;
};

type LoginPayload = {
  login?: {
    accessToken?: string;
    accountId?: number;
    restriction?: string;
    registrationOrganizationId?: number | null;
  };
};

type StatusPayload = {
  accountId: number;
  latest: ApplicationPayload | null;
  applications: { items: ApplicationPayload[]; total: number; page: number; pageSize: number };
};

/** `myEngineerRegistration`：无 accountId 字段（调用者只能是本人） */
type MyRegistrationPayload = {
  applicationId: number;
  organizationId: number;
  organizationName: string | null;
  status: EngineerRegistrationApplicationStatus;
  applicationNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewComment: string | null;
};

type MySessionIdentityPayload = {
  accountId: number;
  adminLevel: number | null;
  adminOrganizationId: number | null;
  customerOrganizationId: number | null;
  engineerOrganizationId: number | null;
  registrationOrganizationId: number | null;
  restriction: SessionRestriction;
};

type ResubmitPayload = {
  applicationId: number;
  organizationId: number;
  status: EngineerRegistrationApplicationStatus;
  submittedAt: string;
};

const APPLICATION_FIELDS = `
  id accountId organizationId status applicationNote submittedAt
  reviewedByAccountId reviewedAt reviewComment
`;

const ADMIN_ITEM_FIELDS = `
  application { ${APPLICATION_FIELDS} }
  organizationName
  applicant { id loginName loginEmail nickname role status }
`;

/**
 * 本规格验证 V44 Web 注册规则（工程师必填姓名/电话、公司须受管），
 * 因此统一走 Web 独立入口 `registerWeb`；用别名保持既有断言字段不变。
 * 旧 `register` 的兼容行为见「旧入口兼容」用例。
 */
const REGISTER_MUTATION = `
  mutation Register($input: RegisterWebInput!) {
    register: registerWeb(input: $input) {
      success
      message
      accountId
      registrationStatus
      applicationId
    }
  }
`;

/**
 * 旧客户端请求形状：`RegisterInput` 不支持姓名/电话/手填公司，`organizationId` 必填。
 * 本规格用它验证主线旧行为的兼容性，不混入 Web 规则。
 */
const LEGACY_REGISTER_MUTATION = `
  mutation LegacyRegister($input: RegisterInput!) {
    register(input: $input) {
      success
      message
      accountId
      registrationStatus
      applicationId
    }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) {
      accessToken
      accountId
      restriction
      registrationOrganizationId
    }
  }
`;

const USER_INFO_QUERY = `
  query UserInfo($accountId: Int!) {
    userInfo(accountId: $accountId) { id accountId nickname userState }
  }
`;

/** 受限会话读取本人最新申请：不接受任何账号/申请 ID 参数 */
const MY_REGISTRATION_QUERY = `
  query MyRegistration {
    myEngineerRegistration {
      applicationId
      organizationId
      organizationName
      status
      applicationNote
      submittedAt
      reviewedAt
      reviewComment
    }
  }
`;

/** 每请求复核后的会话身份：审批是否真正解除限制，以此为准 */
const MY_SESSION_IDENTITY_QUERY = `
  query MySessionIdentity {
    mySessionIdentity {
      accountId
      adminLevel
      adminOrganizationId
      customerOrganizationId
      engineerOrganizationId
      registrationOrganizationId
      restriction
    }
  }
`;

/**
 * 越权注入探针：`myEngineerRegistration` 在 schema 中不声明任何参数，
 * 声明并传入 applicationId/accountId 必须在校验阶段被拒绝，不得进入用例。
 */
const MY_REGISTRATION_INJECTION_QUERY = `
  query MyRegistrationInjection($applicationId: Int!, $accountId: Int!) {
    myEngineerRegistration(applicationId: $applicationId, accountId: $accountId) {
      applicationId
      status
    }
  }
`;

const ORGANIZATIONS_QUERY = `
  query RegistrationOrganizationSearch($pagination: PaginationArgs!) {
    registrationOrganizationSearch(pagination: $pagination) {
      items { id name }
      total
      page
      pageSize
    }
  }
`;

const LEGACY_ORGANIZATIONS_QUERY = `
  query RegistrationOrganizations {
    registrationOrganizations { id name }
  }
`;

const MY_STATUS_MUTATION = `
  mutation MyStatus($input: EngineerRegistrationCredentialInput!, $pagination: PaginationArgs!) {
    myEngineerRegistrationStatus(input: $input, pagination: $pagination) {
      accountId
      latest { ${APPLICATION_FIELDS} }
      applications {
        items { ${APPLICATION_FIELDS} }
        total
        page
        pageSize
      }
    }
  }
`;

const RESUBMIT_MUTATION = `
  mutation Resubmit($input: ResubmitEngineerRegistrationInput!) {
    resubmitEngineerRegistration(input: $input) {
      applicationId
      organizationId
      status
      submittedAt
    }
  }
`;

const ADMIN_LIST_QUERY = `
  query AdminList($pagination: PaginationArgs!, $status: EngineerRegistrationApplicationStatus) {
    adminEngineerRegistrations(pagination: $pagination, status: $status) {
      items { ${ADMIN_ITEM_FIELDS} }
      total
      page
      pageSize
    }
  }
`;

/** 既有详情契约：申请人仍是账号管理 `AdminUserDTO` 字段面（无真实姓名） */
const ADMIN_DETAIL_FIELDS = `
  application { ${APPLICATION_FIELDS} }
  organizationName
  applicant { id loginName loginEmail nickname companyName phone contactEmail role status }
`;

const ADMIN_DETAIL_QUERY = `
  query AdminDetail($applicationId: Int!) {
    adminEngineerRegistrationDetail(applicationId: $applicationId) { ${ADMIN_DETAIL_FIELDS} }
  }
`;

/** 旧客户端以 fragment 选择 `AdminUserDTO`：既有入口必须继续接受该选择集 */
const ADMIN_DETAIL_FRAGMENT_QUERY = `
  fragment AdminUserFields on AdminUserDTO {
    id
    loginName
    loginEmail
    nickname
    companyName
    phone
    contactEmail
    role
    status
    createdAt
    updatedAt
  }
  query AdminDetailWithFragment($applicationId: Int!) {
    adminEngineerRegistrationDetail(applicationId: $applicationId) {
      application { id accountId organizationId status }
      organizationName
      applicant { ...AdminUserFields }
    }
  }
`;

/** 审批详情专用入口：窄字段面，额外提供真实姓名 */
const ADMIN_APPROVAL_DETAIL_FIELDS = `
  application { ${APPLICATION_FIELDS} }
  organizationName
  applicant { id loginName nickname realName phone contactEmail }
`;

const ADMIN_APPROVAL_DETAIL_QUERY = `
  query AdminApprovalDetail($applicationId: Int!) {
    adminEngineerRegistrationApprovalDetail(applicationId: $applicationId) { ${ADMIN_APPROVAL_DETAIL_FIELDS} }
  }
`;

const REVIEW_MUTATION = `
  mutation Review($input: ReviewEngineerRegistrationInput!) {
    reviewEngineerRegistration(input: $input) { ${ADMIN_ITEM_FIELDS} }
  }
`;

const DEFAULT_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 20 } as const;

const PASSWORD = 'E2eEngineer@2026';

const CUSTOMER_LOGIN_NAME = 'e2eengcustomer';
const CUSTOMER_LOGIN_EMAIL = 'e2e.eng.customer@example.com';
const CUSTOMER_DUP_LOGIN_NAME = 'e2eengdupregister';
const CUSTOMER_DUP_LOGIN_EMAIL = 'e2e.eng.dup.register@example.com';

const ENGINEER_PENDING = {
  loginName: 'e2eengpending',
  loginEmail: 'e2e.eng.pending@example.com',
};
const ENGINEER_REJECT = {
  loginName: 'e2eengreject',
  loginEmail: 'e2e.eng.reject@example.com',
};
const ENGINEER_CONCURRENT = {
  loginName: 'e2eengconcurrent',
  loginEmail: 'e2e.eng.concurrent@example.com',
};
const ENGINEER_SCOPE_PRIMARY = {
  loginName: 'e2engscopeown',
  loginEmail: 'e2e.eng.scope.own@example.com',
};
const ENGINEER_SCOPE_PEER = {
  loginName: 'e2engscopepeer',
  loginEmail: 'e2e.eng.scope.peer@example.com',
};
const ENGINEER_CONTRACT_DETAIL = {
  loginName: 'e2engcontractdtl',
  loginEmail: 'e2e.eng.contract.detail@example.com',
};
const ENGINEER_ROLLBACK = {
  loginName: 'e2eengrollback',
  loginEmail: 'e2e.eng.rollback@example.com',
};
const ENGINEER_INVALID_ORG = {
  loginName: 'e2eenginvalidorg',
  loginEmail: 'e2e.eng.invalid.org@example.com',
};
const ENGINEER_PARTIAL_THROW = {
  loginName: 'e2eengpartialthrow',
  loginEmail: 'e2e.eng.partial.throw@example.com',
};
const ENGINEER_PARTIAL_ASSERT_PRIMARY = {
  loginName: 'e2eengpartialasserta',
  loginEmail: 'e2e.eng.partial.assert.a@example.com',
};
const ENGINEER_PARTIAL_ASSERT_SECONDARY = {
  loginName: 'e2eengpartialassertb',
  loginEmail: 'e2e.eng.partial.assert.b@example.com',
};
const CUSTOMER_READBACK_FAILURE = {
  loginName: 'e2eengreadbackfail',
  loginEmail: 'e2e.eng.readback.fail@example.com',
};
const CUSTOMER_VERIFY_TAMPER = {
  loginName: 'e2eengverifytamper',
  loginEmail: 'e2e.eng.verify.tamper@example.com',
};
const CUSTOMER_VERIFY_TAMPER_REWRITTEN_EMAIL = 'e2e.eng.verify.tamper.rewritten@example.com';
const CUSTOMER_VERIFY_TAMPER_MIDWAY = {
  loginName: 'e2eengverifymid',
  loginEmail: 'e2e.eng.verify.mid@example.com',
};
const CUSTOMER_VERIFY_TAMPER_MIDWAY_REWRITTEN_EMAIL = 'e2e.eng.verify.mid.rewritten@example.com';

/** 必然不存在的组织主键：用于伪造组织参数 */
const MISSING_ORGANIZATION_ID = 2147483000;

describe('工程师注册与组织审核 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let adminToken: string;
  let peerAdminToken: string;
  let guestToken: string;
  let adminAccountId: number;

  const suiteOrganizationCodes = buildSuiteOrganizationCodes(`ENGREG_${RUN_TAG}`);
  /** 主组织名同时用于种子与申请展示断言，避免两处字面量漂移 */
  const PRIMARY_ORGANIZATION_NAME = 'E2E 工程师注册主组织';
  /** 旧入口兼容用例专用：启用但未受管公司（Web 规则不可用，旧 register 可用） */
  const LEGACY_UNMANAGED_ORGANIZATION_CODE = `E2E_ENGREG_LEGACY_UNMANAGED_${RUN_TAG}`;
  let primaryOrganizationId = 0;
  let peerOrganizationId = 0;
  let legacyUnmanagedOrganizationId = 0;

  const ownership = createOwnedResourceLedger();

  const accountRepo = () => dataSource.getRepository(AccountEntity);
  const userInfoRepo = () => dataSource.getRepository(UserInfoEntity);
  const membershipRepo = () => dataSource.getRepository(OrganizationMembershipEntity);

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin', 'peerAdmin', 'guestPrimary'],
      ownership,
    });

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: PRIMARY_ORGANIZATION_NAME,
          kind: 'CLIENT',
          // 注册候选资格为 ACTIVE + 受管公司（V44）
          isManagedCompany: true,
        },
        {
          organizationCode: suiteOrganizationCodes.peer,
          name: 'E2E 工程师注册对侧组织',
          kind: 'PEER',
          isManagedCompany: true,
        },
        {
          organizationCode: LEGACY_UNMANAGED_ORGANIZATION_CODE,
          name: 'E2E 旧入口未受管组织',
          kind: 'CLIENT',
          // 显式未受管：只允许旧 register 入口使用
          isManagedCompany: false,
        },
      ],
      ownership,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
    peerOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.peer);
    legacyUnmanagedOrganizationId = requireOrganizationId(
      organizationIds,
      LEGACY_UNMANAGED_ORGANIZATION_CODE,
    );

    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: organizationIds,
      ownership,
      memberships: [
        {
          accountLoginName: testAccountsConfig.admin.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: testAccountsConfig.peerAdmin.loginName,
          organizationCode: suiteOrganizationCodes.peer,
          memberRole: 'SUPER_ADMIN',
        },
      ],
    });

    // 审批域权限按请求期查库的管理员等级判定：一级全范围、二级仅可信公司。
    const levelOneAdmin = await accountRepo().findOneOrFail({
      where: { loginName: testAccountsConfig.admin.loginName },
    });
    await accountRepo().update(levelOneAdmin.id, { adminLevel: 1 });
    const levelTwoAdmin = await accountRepo().findOneOrFail({
      where: { loginName: testAccountsConfig.peerAdmin.loginName },
    });
    await accountRepo().update(levelTwoAdmin.id, { adminLevel: 2 });

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    peerAdminToken = await login({
      app,
      loginName: testAccountsConfig.peerAdmin.loginName,
      loginPassword: testAccountsConfig.peerAdmin.loginPassword,
    });
    guestToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
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
          helper: 'engineer-registration-approval.e2e-spec afterAll 收尾',
        });

        // 清理后再核验本轮台账涉及的标识零残留：任何一条存在都使规格失败。
        const accountIds = ownership.accountIds;
        const organizationIds = ownership.organizationIds;
        const applicationIds = ownership.engineerRegistrationApplicationIds;
        const membershipIds = ownership.membershipIds;
        const residue: Array<[string, number]> = [];

        const countOf = async (sql: string, params: unknown[]): Promise<number> => {
          const rows = await dataSource.query(sql, params);
          return Number(rows[0]?.total ?? 0);
        };
        if (accountIds.length > 0) {
          residue.push([
            'account',
            await countOf(
              `SELECT COUNT(*) AS total FROM base_user_account WHERE id IN (${accountIds.map(() => '?').join(', ')})`,
              accountIds,
            ),
          ]);
          residue.push([
            'userInfo',
            await countOf(
              `SELECT COUNT(*) AS total FROM base_user_info WHERE account_id IN (${accountIds.map(() => '?').join(', ')})`,
              accountIds,
            ),
          ]);
        }
        if (organizationIds.length > 0) {
          residue.push([
            'organization',
            await countOf(
              `SELECT COUNT(*) AS total FROM organization WHERE id IN (${organizationIds.map(() => '?').join(', ')})`,
              organizationIds,
            ),
          ]);
        }
        if (membershipIds.length > 0) {
          residue.push([
            'membership',
            await countOf(
              `SELECT COUNT(*) AS total FROM organization_membership WHERE id IN (${membershipIds.map(() => '?').join(', ')})`,
              membershipIds,
            ),
          ]);
        }
        if (applicationIds.length > 0) {
          residue.push([
            'application',
            await countOf(
              `SELECT COUNT(*) AS total FROM engineer_registration_application WHERE id IN (${applicationIds.map(() => '?').join(', ')})`,
              applicationIds,
            ),
          ]);
        }

        const leftover = residue.filter(([, count]) => count !== 0);
        expect(leftover).toEqual([]);
      },
      finalize: null,
      closeApp: app ? async () => await app.close() : null,
    });
  });

  const gql = async <T>(params: {
    query: string;
    variables?: unknown;
    token?: string;
  }): Promise<GqlBody<T>> => {
    const response = await postGql({
      app,
      query: params.query,
      variables: params.variables,
      token: params.token,
    }).expect((res) => {
      expect([200, 400]).toContain(res.status);
    });
    return response.body as GqlBody<T>;
  };

  const errorCodeOf = (body: GqlBody<unknown>): string | undefined =>
    body.errors?.[0]?.extensions?.code;

  /**
   * 注册成功、回读之前先按响应 ID 与本轮显式输入登记创建事实。
   *
   * 回读可能失败（连接中断、行暂不可见等），但创建事实来自服务端返回值与请求输入，
   * 不依赖回读；因此失败也必须在受保护清理范围内，而不是退化成「只按 ID 删除」。
   */
  const recordRegisteredAccountCreation = (
    accountId: number,
    input: RegisterInput,
    registrationStatus: RegistrationOutcomeStatus,
    options: { readonly webEntry?: boolean } = {},
  ): void => {
    const role =
      input.type === RegisterTypeEnum.ENGINEER
        ? IdentityTypeEnum.ENGINEER
        : IdentityTypeEnum.CUSTOMER;
    // Web 入口客户在创建事务内写可信公司归属；旧入口与工程师保持 null（V44）。
    const webEntry = options.webEntry ?? true;
    const pending = registrationStatus === RegistrationOutcomeStatus.PENDING_REVIEW;
    recordOwnedResource(ownership, 'account', accountId, {
      loginName: input.loginName ?? null,
      loginEmail: input.loginEmail,
      status: pending ? AccountStatus.PENDING : AccountStatus.ACTIVE,
      identityHint: role,
      accessGroup: [role],
      nickname: input.nickname,
      userInfoEmail: input.loginEmail,
      userState: pending ? UserState.PENDING : UserState.ACTIVE,
      // Web 客户注册在创建事务内写入可信公司归属；工程师与旧入口写 null（V44）。
      // 该字段是清理引用闭包的强制预期：缺登记会在首删前失败关闭。
      customerOrganizationId:
        role === IdentityTypeEnum.CUSTOMER && webEntry ? input.organizationId : null,
    });
  };

  /**
   * 回读核验：把数据库真实值与已登记的创建事实逐字段比对。
   *
   * 绝不用回读值回填/覆盖预期事实：若注册成功后、回读前归属字段被外部改写，
   * 覆盖式更新会把改写后的数据重新认定为本轮所有，清理随后就会删除他人数据。
   * 不一致时必须报错并保留原账本，让受保护清理在第一条 DELETE 前失败关闭。
   */
  const verifyRegisteredAccount = async (accountId: number): Promise<void> => {
    const expected = ownership.facts.account.get(accountId);
    if (expected === undefined) {
      throw new Error(`回读核验失败：账号 ${accountId} 未登记预期事实，拒绝用回读值补登记`);
    }
    const account = await accountRepo().findOneOrFail({ where: { id: accountId } });
    const userInfo = await userInfoRepo().findOneOrFail({ where: { accountId } });
    const actualAccessGroup = Array.isArray(userInfo.accessGroup)
      ? userInfo.accessGroup
      : (JSON.parse(userInfo.accessGroup) as string[]);
    const mismatches: string[] = [];
    if ((account.loginName ?? null) !== expected.loginName) mismatches.push('loginName');
    if (account.loginEmail !== expected.loginEmail) mismatches.push('loginEmail');
    if (String(account.status) !== String(expected.status)) mismatches.push('status');
    if ((account.identityHint ?? null) !== expected.identityHint) {
      mismatches.push('identityHint');
    }
    if (JSON.stringify(actualAccessGroup) !== JSON.stringify(expected.accessGroup)) {
      mismatches.push('accessGroup');
    }
    if (userInfo.nickname !== expected.nickname) mismatches.push('nickname');
    if ((userInfo.email ?? null) !== expected.userInfoEmail) mismatches.push('userInfoEmail');
    if (String(userInfo.userState) !== String(expected.userState)) mismatches.push('userState');
    if ((userInfo.customerOrganizationId ?? null) !== (expected.customerOrganizationId ?? null)) {
      mismatches.push('customerOrganizationId');
    }
    if (mismatches.length > 0) {
      throw new Error(
        `回读核验失败：账号 ${accountId} 归属字段已与本轮登记事实不一致（${mismatches.join(', ')}），` +
          '保留原始预期事实并拒绝清理删除',
      );
    }
  };

  const recordActiveMembership = async (
    organizationId: number,
    accountId: number,
    memberRole: string,
  ): Promise<void> => {
    const membership = await membershipRepo().findOneOrFail({
      where: { organizationId, accountId },
    });
    recordOwnedResource(ownership, 'membership', membership.id, {
      organizationId,
      accountId,
      memberRole,
      status: membership.status,
    });
  };

  const recordApplication = (
    applicationId: number,
    accountId: number,
    organizationId: number,
    applicationNote: string | null,
  ): void => {
    recordOwnedResource(ownership, 'engineerRegistrationApplication', applicationId, {
      accountId,
      organizationId,
      applicationNote,
    });
  };

  const register = async (input: RegisterInput): Promise<GqlBody<{ register?: RegisterPayload }>> =>
    await gql<{ register?: RegisterPayload }>({
      query: REGISTER_MUTATION,
      variables: { input },
    });

  /** 旧 `register` 入口：请求形状与主线旧客户端一致 */
  const legacyRegister = async (
    input: RegisterInput,
  ): Promise<GqlBody<{ register?: RegisterPayload }>> =>
    await gql<{ register?: RegisterPayload }>({
      query: LEGACY_REGISTER_MUTATION,
      variables: { input },
    });

  /**
   * 注册分支：成功响应一旦返回账号主键，就先按响应 ID 与本轮显式输入登记创建事实，
   * 再做回读核验与成员关系登记。
   * 配合 `Promise.allSettled` 时，任一分支失败都不会影响其它分支的登记，
   * 回读失败也不会让已成功的数据漏出清理台账。
   */
  const registerAndRecord = async (
    input: RegisterInput,
    record: { organizationId: number; memberRole: string },
    verify: (accountId: number) => Promise<void> = verifyRegisteredAccount,
  ): Promise<GqlBody<{ register?: RegisterPayload }>> => {
    const body = await register(input);
    const payload = body.data?.register;
    const accountId = payload?.accountId;
    if (payload?.success === true && typeof accountId === 'number') {
      recordRegisteredAccountCreation(accountId, input, payload.registrationStatus);
      await verify(accountId);
      await recordActiveMembership(record.organizationId, accountId, record.memberRole);
    }
    return body;
  };

  const performLogin = async (loginName: string, loginPassword: string) =>
    await gql<LoginPayload>({
      query: LOGIN_MUTATION,
      variables: {
        input: {
          loginName,
          loginPassword,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
        },
      },
    });

  const myStatus = async (
    accountIdentifier: string,
    password: string,
  ): Promise<GqlBody<{ myEngineerRegistrationStatus?: StatusPayload }>> =>
    await gql<{ myEngineerRegistrationStatus?: StatusPayload }>({
      query: MY_STATUS_MUTATION,
      variables: {
        input: { accountIdentifier, password },
        pagination: DEFAULT_PAGINATION,
      },
    });

  const resubmit = async (input: {
    accountIdentifier: string;
    password: string;
    organizationId: number;
    applicationNote?: string;
  }): Promise<GqlBody<{ resubmitEngineerRegistration?: ResubmitPayload }>> =>
    await gql<{ resubmitEngineerRegistration?: ResubmitPayload }>({
      query: RESUBMIT_MUTATION,
      variables: { input },
    });

  /**
   * 重提分支：成功响应一旦返回申请 ID，立即按响应 ID 与本轮明确输入登记，再返回响应。
   * 调用方必须用 `Promise.allSettled` 等待全部分支：一方失败不能跳过另一方的登记，
   * 也不能在其它分支尚未结束时进入 teardown。
   */
  const resubmitAndRecord = async (
    input: {
      accountIdentifier: string;
      password: string;
      organizationId: number;
      applicationNote?: string;
    },
    accountId: number,
  ): Promise<GqlBody<{ resubmitEngineerRegistration?: ResubmitPayload }>> => {
    const body = await resubmit(input);
    const applicationId = body.data?.resubmitEngineerRegistration?.applicationId;
    if (typeof applicationId === 'number') {
      recordApplication(
        applicationId,
        accountId,
        input.organizationId,
        input.applicationNote?.trim() || null,
      );
    }
    return body;
  };

  const adminList = async (
    token: string,
    status?: EngineerRegistrationApplicationStatus,
  ): Promise<GqlBody<{ adminEngineerRegistrations?: AdminPagePayload }>> =>
    await gql<{ adminEngineerRegistrations?: AdminPagePayload }>({
      query: ADMIN_LIST_QUERY,
      variables: { pagination: DEFAULT_PAGINATION, status: status ?? null },
      token,
    });

  const adminDetail = async (
    token: string,
    applicationId: number,
  ): Promise<GqlBody<{ adminEngineerRegistrationDetail?: AdminDetailPayload }>> =>
    await gql<{ adminEngineerRegistrationDetail?: AdminDetailPayload }>({
      query: ADMIN_DETAIL_QUERY,
      variables: { applicationId },
      token,
    });

  const adminDetailWithFragment = async (
    token: string,
    applicationId: number,
  ): Promise<GqlBody<{ adminEngineerRegistrationDetail?: AdminDetailPayload }>> =>
    await gql<{ adminEngineerRegistrationDetail?: AdminDetailPayload }>({
      query: ADMIN_DETAIL_FRAGMENT_QUERY,
      variables: { applicationId },
      token,
    });

  const adminApprovalDetail = async (
    token: string,
    applicationId: number,
  ): Promise<GqlBody<{ adminEngineerRegistrationApprovalDetail?: AdminApprovalDetailPayload }>> =>
    await gql<{ adminEngineerRegistrationApprovalDetail?: AdminApprovalDetailPayload }>({
      query: ADMIN_APPROVAL_DETAIL_QUERY,
      variables: { applicationId },
      token,
    });

  const review = async (params: {
    token: string;
    applicationId: number;
    action: EngineerRegistrationReviewAction;
    reviewComment?: string;
  }): Promise<GqlBody<{ reviewEngineerRegistration?: AdminItemPayload }>> =>
    await gql<{ reviewEngineerRegistration?: AdminItemPayload }>({
      query: REVIEW_MUTATION,
      variables: {
        input: {
          applicationId: params.applicationId,
          action: params.action,
          reviewComment: params.reviewComment ?? null,
        },
      },
      token: params.token,
    });

  /** 工程师注册的显式输入；登记创建事实时复用同一份输入。 */
  const engineerRegisterInput = (params: {
    loginName: string;
    loginEmail: string;
    note?: string;
    organizationId?: number;
  }): RegisterInput => ({
    loginName: params.loginName,
    loginEmail: params.loginEmail,
    loginPassword: PASSWORD,
    // 工程师注册的姓名与电话为必填（V44）
    realName: 'E2E 工程师',
    phone: '13800000000',
    // 昵称必须与登录名一样一一对应且不超过 20 字符：若用固定截断前缀，
    // 前缀相同的两个账号会触发服务端追加随机后缀，回读值便与登记事实不一致。
    nickname: params.loginName,
    type: RegisterTypeEnum.ENGINEER,
    organizationId: params.organizationId ?? primaryOrganizationId,
    applicationNote: params.note ?? null,
  });

  /** 注册成功后登记本轮账号/申请台账（真实 ID + 预期事实） */
  const registerEngineerAndRecord = async (params: {
    loginName: string;
    loginEmail: string;
    note?: string;
    organizationId?: number;
  }): Promise<{
    body: GqlBody<{ register?: RegisterPayload }>;
    accountId: number;
    applicationId: number;
  }> => {
    const input = engineerRegisterInput(params);
    const body = await register(input);
    const accountId = body.data?.register?.accountId;
    const applicationId = body.data?.register?.applicationId;
    if (typeof accountId !== 'number' || typeof applicationId !== 'number') {
      throw new Error(`工程师注册未返回账号/申请主键：${JSON.stringify(body)}`);
    }
    // 先登记已知 ID 与创建事实、再做可失败的资料回读：登记不依赖回读结果，
    // 回读失败只会让本轮用例报错，不得把已落库的申请/账号漏出清理台账。
    recordApplication(
      applicationId,
      accountId,
      params.organizationId ?? primaryOrganizationId,
      params.note?.trim() || null,
    );
    recordRegisteredAccountCreation(accountId, input, RegistrationOutcomeStatus.PENDING_REVIEW);
    await verifyRegisteredAccount(accountId);
    return { body, accountId, applicationId };
  };

  // ---------------------------------------------------------------------------
  // 客户即时开通
  // ---------------------------------------------------------------------------
  describe('客户选择组织后即时开通', () => {
    it('注册成功即 ACTIVE/ACTIVE、建立 CUSTOMER 成员关系并可登录', async () => {
      const body = await registerAndRecord(
        {
          loginName: CUSTOMER_LOGIN_NAME,
          loginEmail: CUSTOMER_LOGIN_EMAIL,
          loginPassword: PASSWORD,
          nickname: 'E2E 客户注册',
          type: RegisterTypeEnum.CUSTOMER,
          organizationId: primaryOrganizationId,
        },
        { organizationId: primaryOrganizationId, memberRole: 'CUSTOMER' },
      );
      expect(body.errors).toBeUndefined();
      expect(body.data?.register?.success).toBe(true);
      expect(body.data?.register?.registrationStatus).toBe(RegistrationOutcomeStatus.REGISTERED);
      const accountId = body.data?.register?.accountId;
      expect(typeof accountId).toBe('number');

      const account = await accountRepo().findOne({ where: { id: accountId as number } });
      expect(account?.status).toBe(AccountStatus.ACTIVE);
      const userInfo = await userInfoRepo().findOne({ where: { accountId: accountId as number } });
      expect(userInfo?.userState).toBe(UserState.ACTIVE);
      const membership = await membershipRepo().findOne({
        where: { organizationId: primaryOrganizationId, accountId: accountId as number },
      });
      expect(membership?.memberRole).toBe(IdentityTypeEnum.CUSTOMER);
      expect(membership?.status).toBe('ACTIVE');

      const loginBody = await performLogin(CUSTOMER_LOGIN_NAME, PASSWORD);
      expect(loginBody.errors).toBeUndefined();
      const accessToken = loginBody.data?.login?.accessToken;
      expect(typeof accessToken).toBe('string');
      const protectedBody = await gql<{ userInfo?: { accountId?: number } }>({
        query: USER_INFO_QUERY,
        variables: { accountId },
        token: accessToken,
      });
      expect(protectedBody.errors).toBeUndefined();
      expect(protectedBody.data?.userInfo?.accountId).toBe(accountId);
    });

    it('注册成功、随后回读失败：创建事实已登记且可由受保护清理回收', async () => {
      const nickname = `${CUSTOMER_READBACK_FAILURE.loginName.slice(0, 15)}_nd`;
      const input = {
        loginName: CUSTOMER_READBACK_FAILURE.loginName,
        loginEmail: CUSTOMER_READBACK_FAILURE.loginEmail,
        loginPassword: PASSWORD,
        nickname,
        type: RegisterTypeEnum.CUSTOMER,
        organizationId: primaryOrganizationId,
      };
      const readbackFailure = new Error('forced account readback failure');
      let recordedAccountId = 0;

      let readbackError: unknown;
      try {
        await registerAndRecord(
          input,
          { organizationId: primaryOrganizationId, memberRole: 'CUSTOMER' },
          (accountId) => {
            recordedAccountId = accountId;
            return Promise.reject(readbackFailure);
          },
        );
      } catch (error) {
        readbackError = error;
      }

      expect(readbackError).toBe(readbackFailure);
      expect(recordedAccountId).toBeGreaterThan(0);
      // 账号在回读之前已按响应 ID 与显式输入登记，未漏出受保护收尾范围
      expect(ownership.accountIds).toContain(recordedAccountId);

      // 创建事实必须与库内真实行一致：清理仍走严格所有权核验，不靠放宽比对
      const account = await accountRepo().findOne({ where: { id: recordedAccountId } });
      const userInfo = await userInfoRepo().findOne({ where: { accountId: recordedAccountId } });
      expect(account?.loginName).toBe(CUSTOMER_READBACK_FAILURE.loginName);
      expect(account?.loginEmail).toBe(CUSTOMER_READBACK_FAILURE.loginEmail);
      expect(account?.status).toBe(AccountStatus.ACTIVE);
      expect(account?.identityHint).toBe(IdentityTypeEnum.CUSTOMER);
      expect(userInfo?.nickname).toBe(nickname);
      expect(userInfo?.email).toBe(CUSTOMER_READBACK_FAILURE.loginEmail);
      expect(userInfo?.userState).toBe(UserState.ACTIVE);
      expect(ownership.facts.account.get(recordedAccountId)).toEqual({
        loginName: CUSTOMER_READBACK_FAILURE.loginName,
        loginEmail: CUSTOMER_READBACK_FAILURE.loginEmail,
        status: AccountStatus.ACTIVE,
        identityHint: IdentityTypeEnum.CUSTOMER,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
        nickname,
        userInfoEmail: CUSTOMER_READBACK_FAILURE.loginEmail,
        userState: UserState.ACTIVE,
        customerOrganizationId: primaryOrganizationId,
      });
    });

    it('伪造组织主键被拒绝且零落库', async () => {
      const body = await register({
        loginName: ENGINEER_INVALID_ORG.loginName,
        loginEmail: ENGINEER_INVALID_ORG.loginEmail,
        loginPassword: PASSWORD,
        nickname: 'E2E 非法组织',
        type: RegisterTypeEnum.CUSTOMER,
        organizationId: MISSING_ORGANIZATION_ID,
      });
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(body)).toBe('BAD_USER_INPUT');
      const account = await accountRepo().findOne({
        where: { loginEmail: ENGINEER_INVALID_ORG.loginEmail },
      });
      expect(account).toBeNull();
    });

    it('同凭据并发注册只成功一次，单账号行', async () => {
      const input = {
        loginName: CUSTOMER_DUP_LOGIN_NAME,
        loginEmail: CUSTOMER_DUP_LOGIN_EMAIL,
        loginPassword: PASSWORD,
        nickname: 'E2E 并发注册',
        type: RegisterTypeEnum.CUSTOMER,
        organizationId: primaryOrganizationId,
      };
      const outcomes = await Promise.allSettled([
        registerAndRecord(input, {
          organizationId: primaryOrganizationId,
          memberRole: 'CUSTOMER',
        }),
        registerAndRecord(input, {
          organizationId: primaryOrganizationId,
          memberRole: 'CUSTOMER',
        }),
      ]);
      // 成功分支已在返回前登记账号与成员关系；这里先保留原始失败，再做业务断言。
      const rejectedReasons = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome) => outcome.reason);
      expect(rejectedReasons).toEqual([]);
      const bodies = outcomes
        .filter(
          (outcome): outcome is PromiseFulfilledResult<GqlBody<{ register?: RegisterPayload }>> =>
            outcome.status === 'fulfilled',
        )
        .map((outcome) => outcome.value);
      const successAccountIds = bodies
        .map((body) => {
          const payload = body.data?.register;
          return payload?.success === true ? payload.accountId : undefined;
        })
        .filter((accountId): accountId is number => typeof accountId === 'number');
      expect(successAccountIds).toHaveLength(1);
      const accountId = successAccountIds[0];

      const rows = await accountRepo().find({ where: { loginEmail: CUSTOMER_DUP_LOGIN_EMAIL } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(accountId);
      const loser = bodies.find((body) => body.data?.register?.success !== true);
      expect(loser?.errors?.length ?? 0).toBeGreaterThan(0);
    });

    it('公开组织选项仅返回有效组织且包含本轮主组织', async () => {
      const body = await gql<{
        registrationOrganizationSearch?: {
          items: Array<{ id: number; name: string }>;
          total: number;
          page: number;
          pageSize: number;
        };
      }>({
        query: ORGANIZATIONS_QUERY,
        variables: { pagination: { mode: 'OFFSET', page: 1, pageSize: 50 } },
      });
      expect(body.errors).toBeUndefined();
      const ids = (body.data?.registrationOrganizationSearch?.items ?? []).map((item) => item.id);
      expect(ids).toContain(primaryOrganizationId);
      expect(ids).toContain(peerOrganizationId);

      // 兼容入口：无参 `registrationOrganizations` 仍返回 `{ id name }` 数组
      const legacy = await gql<{
        registrationOrganizations?: Array<{ id: number; name: string }>;
      }>({ query: LEGACY_ORGANIZATIONS_QUERY });
      expect(legacy.errors).toBeUndefined();
      const legacyIds = (legacy.data?.registrationOrganizations ?? []).map((item) => item.id);
      expect(Array.isArray(legacy.data?.registrationOrganizations)).toBe(true);
      expect(legacyIds).toContain(primaryOrganizationId);
      expect(legacyIds).toContain(peerOrganizationId);
    });
  });

  // ---------------------------------------------------------------------------
  // 旧 register 入口兼容（主线旧请求形状）
  // ---------------------------------------------------------------------------
  describe('旧入口 register 行为兼容', () => {
    it('旧工程师请求省略姓名与电话：创建待审账号与申请，无成员关系', async () => {
      const input: RegisterInput = {
        loginName: 'e2e_legacy_engineer',
        loginEmail: 'e2e_legacy_engineer@example.com',
        loginPassword: PASSWORD,
        nickname: 'e2e_legacy_engineer',
        type: RegisterTypeEnum.ENGINEER,
        organizationId: primaryOrganizationId,
      };

      const body = await legacyRegister(input);
      expect(body.errors).toBeUndefined();
      const payload = body.data?.register;
      expect(payload?.success).toBe(true);
      expect(payload?.registrationStatus).toBe(RegistrationOutcomeStatus.PENDING_REVIEW);

      const accountId = payload?.accountId;
      const applicationId = payload?.applicationId;
      expect(typeof accountId).toBe('number');
      expect(typeof applicationId).toBe('number');
      if (typeof accountId !== 'number' || typeof applicationId !== 'number') {
        throw new Error(`旧入口工程师注册未返回主键：${JSON.stringify(body)}`);
      }

      // 先登记创建事实，再做可失败的回读核验
      recordApplication(applicationId, accountId, primaryOrganizationId, null);
      recordRegisteredAccountCreation(accountId, input, RegistrationOutcomeStatus.PENDING_REVIEW, {
        webEntry: false,
      });
      await verifyRegisteredAccount(accountId);

      const userInfo = await userInfoRepo().findOneOrFail({ where: { accountId } });
      expect(userInfo.realName ?? null).toBeNull();
      expect(userInfo.phone ?? null).toBeNull();
      const memberships = await membershipRepo().count({ where: { accountId } });
      expect(memberships).toBe(0);

      // 与主线一致：待审账号仍不能登录
      const loginBody = await performLogin('e2e_legacy_engineer', PASSWORD);
      expect(loginBody.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(loginBody)).toBe('FORBIDDEN');
      expect(loginBody.data?.login?.accessToken).toBeUndefined();
    });

    it('旧客户选择启用未受管公司：按主线约定开通，且不写 customer_organization_id', async () => {
      const input: RegisterInput = {
        loginName: 'e2e_legacy_customer',
        loginEmail: 'e2e_legacy_customer@example.com',
        loginPassword: PASSWORD,
        nickname: 'e2e_legacy_customer',
        type: RegisterTypeEnum.CUSTOMER,
        organizationId: legacyUnmanagedOrganizationId,
      };

      const body = await legacyRegister(input);
      expect(body.errors).toBeUndefined();
      const payload = body.data?.register;
      expect(payload?.success).toBe(true);
      expect(payload?.registrationStatus).toBe(RegistrationOutcomeStatus.REGISTERED);

      const accountId = payload?.accountId;
      expect(typeof accountId).toBe('number');
      if (typeof accountId !== 'number') {
        throw new Error(`旧入口客户注册未返回账号主键：${JSON.stringify(body)}`);
      }

      recordRegisteredAccountCreation(accountId, input, RegistrationOutcomeStatus.REGISTERED, {
        webEntry: false,
      });
      await verifyRegisteredAccount(accountId);
      await recordActiveMembership(
        legacyUnmanagedOrganizationId,
        accountId,
        IdentityTypeEnum.CUSTOMER,
      );

      // 基线差异：旧入口沿用主线行为，不写可信公司归属
      const userInfo = await userInfoRepo().findOneOrFail({ where: { accountId } });
      expect(userInfo.customerOrganizationId ?? null).toBeNull();
    });

    it('Web 入口拒绝同一未受管公司：明确拒绝且零落库', async () => {
      const loginEmail = 'e2e_web_unmanaged@example.com';
      const body = await register({
        loginName: 'e2e_web_unmanaged',
        loginEmail,
        loginPassword: PASSWORD,
        nickname: 'e2e_web_unmanaged',
        realName: 'E2E 工程师',
        phone: '13800000000',
        type: RegisterTypeEnum.ENGINEER,
        organizationId: legacyUnmanagedOrganizationId,
      });

      expect(body.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(body)).toBe('BAD_USER_INPUT');
      const account = await accountRepo().findOne({ where: { loginEmail } });
      expect(account).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 受限会话本人资料写入白名单（RQ3）
  // ---------------------------------------------------------------------------
  describe('受限会话本人资料写入白名单', () => {
    const RESTRICTED_ENGINEER = {
      loginName: 'e2eengrestricted',
      loginEmail: 'e2e.eng.restricted@example.com',
    };
    const UPDATE_MY_ACCOUNT_SETTINGS_MUTATION = `
      mutation UpdateMyAccountSettings($input: UpdateMyAccountSettingsInput!) {
        updateMyAccountSettings(input: $input) {
          isUpdated
          settings { loginName loginEmail nickname companyName phone contactEmail role status }
        }
      }
    `;

    type SettingsSnapshot = {
      loginName: string | null;
      loginEmail: string | null;
      nickname: string;
      companyName: string | null;
      phone: string | null;
      contactEmail: string | null;
      customerOrganizationId: number | null;
    };

    let restrictedAccountId = 0;
    let restrictedApplicationId = 0;
    let restrictedToken = '';

    /** 只读快照：账号凭据、本人资料与可信公司归属（都不应被越界写入改动） */
    const readSnapshot = async (): Promise<SettingsSnapshot> => {
      const account = await accountRepo().findOneOrFail({ where: { id: restrictedAccountId } });
      const userInfo = await userInfoRepo().findOneOrFail({
        where: { accountId: restrictedAccountId },
      });
      return {
        loginName: account.loginName ?? null,
        loginEmail: account.loginEmail ?? null,
        nickname: userInfo.nickname,
        companyName: userInfo.companyName ?? null,
        phone: userInfo.phone ?? null,
        contactEmail: userInfo.email ?? null,
        customerOrganizationId: userInfo.customerOrganizationId ?? null,
      };
    };

    const updateSettings = async (input: Record<string, unknown>) =>
      await gql<{
        updateMyAccountSettings?: { isUpdated: boolean; settings: SettingsSnapshot };
      }>({
        query: UPDATE_MY_ACCOUNT_SETTINGS_MUTATION,
        variables: { input },
        token: restrictedToken,
      });

    /** 越界请求后核验：本人资料、申请目标、有效成员与账号归属均保持原值 */
    const expectNoSideEffects = async (before: SettingsSnapshot): Promise<void> => {
      expect(await readSnapshot()).toEqual(before);
      const detail = await adminDetail(adminToken, restrictedApplicationId);
      expect(detail.errors).toBeUndefined();
      expect(detail.data?.adminEngineerRegistrationDetail?.application.organizationId).toBe(
        primaryOrganizationId,
      );
      expect(await membershipRepo().count({ where: { accountId: restrictedAccountId } })).toBe(0);
    };

    beforeAll(async () => {
      const recorded = await registerEngineerAndRecord(RESTRICTED_ENGINEER);
      restrictedAccountId = recorded.accountId;
      restrictedApplicationId = recorded.applicationId;

      // 普通登录仍被拒绝；显式允许受限会话后才签发令牌，并核对服务端限制结论
      const plainLogin = await performLogin(RESTRICTED_ENGINEER.loginName, PASSWORD);
      expect(errorCodeOf(plainLogin)).toBe('FORBIDDEN');

      const loginBody = await gql<LoginPayload>({
        query: LOGIN_MUTATION,
        variables: {
          input: {
            loginName: RESTRICTED_ENGINEER.loginName,
            loginPassword: PASSWORD,
            type: LoginTypeEnum.PASSWORD,
            audience: AudienceTypeEnum.DESKTOP,
            allowRestrictedSession: true,
          },
        },
      });
      expect(loginBody.errors).toBeUndefined();
      expect(loginBody.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_PENDING);
      expect(loginBody.data?.login?.registrationOrganizationId).toBe(primaryOrganizationId);
      restrictedToken = loginBody.data?.login?.accessToken ?? '';
      expect(restrictedToken).not.toBe('');
    });

    it('越界字段与混传整体拒绝且零部分写入', async () => {
      const before = await readSnapshot();
      expect(before.companyName).toBeNull();

      const rejectedInputs: Array<Record<string, unknown>> = [
        { companyName: '复验另一个公司名称' },
        { companyName: null },
        { loginName: 'e2eengrestricted2' },
        { loginEmail: 'e2e.eng.restricted2@example.com' },
        // 合法昵称 + 非法公司混传：同样整体拒绝，昵称不得被写入
        { nickname: 'E2E 混传昵称', companyName: '复验另一个公司名称' },
      ];

      for (const input of rejectedInputs) {
        const body = await updateSettings(input);
        expect(errorCodeOf(body)).toBe('FORBIDDEN');
        await expectNoSideEffects(before);
      }
    });

    it('获准字段（昵称／电话／联系邮箱）可写入并在回读时一致', async () => {
      const before = await readSnapshot();
      const body = await updateSettings({
        nickname: 'E2E 受限昵称',
        phone: '13900000000',
        contactEmail: 'e2e.eng.restricted.contact@example.com',
      });

      expect(body.errors).toBeUndefined();
      expect(body.data?.updateMyAccountSettings?.isUpdated).toBe(true);
      const settings = body.data?.updateMyAccountSettings?.settings;
      expect(settings?.nickname).toBe('E2E 受限昵称');
      expect(settings?.phone).toBe('13900000000');
      expect(settings?.contactEmail).toBe('e2e.eng.restricted.contact@example.com');
      // 只读字段不受影响
      expect(settings?.companyName ?? null).toBe(before.companyName);
      expect(settings?.loginName).toBe(before.loginName);
      expect(settings?.loginEmail).toBe(before.loginEmail);

      expect(await readSnapshot()).toEqual({
        ...before,
        nickname: 'E2E 受限昵称',
        phone: '13900000000',
        contactEmail: 'e2e.eng.restricted.contact@example.com',
      });
      // 本人获准字段的写入属刻意行为：同步清理台账预期事实，避免收尾预检误判为归属漂移
      updateOwnedExpectation(ownership, 'account', restrictedAccountId, {
        nickname: 'E2E 受限昵称',
        userInfoEmail: 'e2e.eng.restricted.contact@example.com',
      });
      const detail = await adminDetail(adminToken, restrictedApplicationId);
      expect(detail.data?.adminEngineerRegistrationDetail?.application.organizationId).toBe(
        primaryOrganizationId,
      );
      expect(await membershipRepo().count({ where: { accountId: restrictedAccountId } })).toBe(0);
    });

    it('伪造角色、管理员等级、公司 ID 与目标账号字段被拒绝且零写入', async () => {
      const before = await readSnapshot();
      const body = await updateSettings({
        nickname: 'E2E 伪造字段昵称',
        role: IdentityTypeEnum.SUPER_ADMIN,
        adminLevel: 1,
        customerOrganizationId: peerOrganizationId,
        accountId: adminAccountId,
      });

      // Schema 层拒绝未知输入字段：请求不进入用例，不产生任何写入
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);
      await expectNoSideEffects(before);
      expect((await readSnapshot()).nickname).toBe(before.nickname);
    });
  });

  // ---------------------------------------------------------------------------
  // 工程师待审 → 管理员通过
  // ---------------------------------------------------------------------------
  describe('工程师待审、越权拒绝与审核通过', () => {
    let engineerAccountId = 0;
    let applicationId = 0;

    beforeAll(async () => {
      const recorded = await registerEngineerAndRecord({
        loginName: ENGINEER_PENDING.loginName,
        loginEmail: ENGINEER_PENDING.loginEmail,
        note: '请审核我的工程师注册',
      });
      expect(recorded.body.errors).toBeUndefined();
      expect(recorded.body.data?.register?.success).toBe(true);
      expect(recorded.body.data?.register?.registrationStatus).toBe(
        RegistrationOutcomeStatus.PENDING_REVIEW,
      );
      engineerAccountId = recorded.accountId;
      applicationId = recorded.applicationId;
    });

    it('工程师注册后为 PENDING/PENDING、无成员关系、登录被阻断', async () => {
      const account = await accountRepo().findOne({ where: { id: engineerAccountId } });
      expect(account?.status).toBe(AccountStatus.PENDING);
      expect(account?.identityHint).toBe(IdentityTypeEnum.ENGINEER);
      const userInfo = await userInfoRepo().findOne({ where: { accountId: engineerAccountId } });
      expect(userInfo?.userState).toBe(UserState.PENDING);
      const memberships = await membershipRepo().count({ where: { accountId: engineerAccountId } });
      expect(memberships).toBe(0);

      const loginBody = await performLogin(ENGINEER_PENDING.loginName, PASSWORD);
      expect(loginBody.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(loginBody)).toBe('FORBIDDEN');
      expect(loginBody.data?.login?.accessToken).toBeUndefined();
    });

    it('本人凭据可查询申请；错误密码与客户账号被拒', async () => {
      const body = await myStatus(ENGINEER_PENDING.loginName, PASSWORD);
      expect(body.errors).toBeUndefined();
      expect(body.data?.myEngineerRegistrationStatus?.accountId).toBe(engineerAccountId);
      expect(body.data?.myEngineerRegistrationStatus?.latest?.status).toBe(
        EngineerRegistrationApplicationStatus.PENDING,
      );
      expect(body.data?.myEngineerRegistrationStatus?.applications.total).toBe(1);

      const wrongPassword = await myStatus(ENGINEER_PENDING.loginName, 'WrongPass@2026');
      expect(wrongPassword.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(wrongPassword)).toBe('UNAUTHENTICATED');

      // 客户账号不是工程师注册账号：凭据正确也不返回他人/不存在的申请
      const customerStatus = await myStatus(CUSTOMER_LOGIN_NAME, PASSWORD);
      expect(customerStatus.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(customerStatus)).toBe('NOT_FOUND');

      // 旧 Mutation 只承诺 OFFSET 语义：CURSOR 必须在用例层显式拒绝，而不是静默改写分页
      const cursorPagination = await gql<{ myEngineerRegistrationStatus?: StatusPayload }>({
        query: MY_STATUS_MUTATION,
        variables: {
          input: { accountIdentifier: ENGINEER_PENDING.loginName, password: PASSWORD },
          pagination: { mode: 'CURSOR', page: 1, pageSize: 20 },
        },
      });
      expect(cursorPagination.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(cursorPagination)).toBe('BAD_USER_INPUT');
    });

    it('匿名读取本人申请被拒；注入 applicationId/accountId 在 schema 层被拒', async () => {
      const anonymous = await gql<{ myEngineerRegistration?: unknown }>({
        query: MY_REGISTRATION_QUERY,
      });
      expect(anonymous.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(anonymous)).toBe('UNAUTHENTICATED');
      expect(anonymous.data?.myEngineerRegistration ?? null).toBeNull();

      const anonymousIdentity = await gql<{ mySessionIdentity?: unknown }>({
        query: MY_SESSION_IDENTITY_QUERY,
      });
      expect(anonymousIdentity.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(anonymousIdentity)).toBe('UNAUTHENTICATED');
      expect(anonymousIdentity.data?.mySessionIdentity ?? null).toBeNull();

      // 账号主键只能来自 Session：请求里带参数即校验失败，不进入用例、不返回任何申请
      const injected = await gql<{ myEngineerRegistration?: unknown }>({
        query: MY_REGISTRATION_INJECTION_QUERY,
        variables: { applicationId, accountId: engineerAccountId },
      });
      expect(injected.errors?.length ?? 0).toBeGreaterThan(0);
      expect(injected.errors?.[0]?.message ?? '').toMatch(/Unknown argument/i);
      expect(injected.data?.myEngineerRegistration ?? null).toBeNull();
    });

    it('非管理员不能查看审核队列；对侧管理员看不到且不能审核本组织申请', async () => {
      const forbidden = await adminList(guestToken);
      expect(forbidden.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(forbidden)).toBe('FORBIDDEN');

      const peerList = await adminList(peerAdminToken);
      expect(peerList.errors).toBeUndefined();
      const peerIds = (peerList.data?.adminEngineerRegistrations?.items ?? []).map(
        (item) => item.application.id,
      );
      expect(peerIds).not.toContain(applicationId);

      const peerDetail = await adminDetail(peerAdminToken, applicationId);
      expect(peerDetail.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(peerDetail)).toBe('NOT_FOUND');

      const peerReview = await review({
        token: peerAdminToken,
        applicationId,
        action: EngineerRegistrationReviewAction.APPROVE,
      });
      expect(peerReview.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(peerReview)).toBe('NOT_FOUND');
    });

    it('本组织管理员通过：账号/资料/成员/申请同事务生效，登录可用', async () => {
      const list = await adminList(adminToken, EngineerRegistrationApplicationStatus.PENDING);
      expect(list.errors).toBeUndefined();
      const ids = (list.data?.adminEngineerRegistrations?.items ?? []).map(
        (item) => item.application.id,
      );
      expect(ids).toContain(applicationId);

      const detail = await adminDetail(adminToken, applicationId);
      expect(detail.errors).toBeUndefined();
      expect(detail.data?.adminEngineerRegistrationDetail?.application.accountId).toBe(
        engineerAccountId,
      );

      const approved = await review({
        token: adminToken,
        applicationId,
        action: EngineerRegistrationReviewAction.APPROVE,
      });
      expect(approved.errors).toBeUndefined();
      expect(approved.data?.reviewEngineerRegistration?.application.status).toBe(
        EngineerRegistrationApplicationStatus.APPROVED,
      );
      expect(approved.data?.reviewEngineerRegistration?.application.reviewedByAccountId).toBe(
        adminAccountId,
      );

      const account = await accountRepo().findOne({ where: { id: engineerAccountId } });
      expect(account?.status).toBe(AccountStatus.ACTIVE);
      const userInfo = await userInfoRepo().findOne({ where: { accountId: engineerAccountId } });
      expect(userInfo?.userState).toBe(UserState.ACTIVE);
      const membership = await membershipRepo().findOne({
        where: { organizationId: primaryOrganizationId, accountId: engineerAccountId },
      });
      expect(membership?.memberRole).toBe(IdentityTypeEnum.ENGINEER);
      expect(membership?.status).toBe('ACTIVE');
      await recordActiveMembership(primaryOrganizationId, engineerAccountId, 'ENGINEER');
      updateOwnedExpectation(ownership, 'account', engineerAccountId, {
        status: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });

      const loginBody = await performLogin(ENGINEER_PENDING.loginName, PASSWORD);
      expect(loginBody.errors).toBeUndefined();
      const token = loginBody.data?.login?.accessToken;
      expect(typeof token).toBe('string');
      const protectedBody = await gql<{ userInfo?: { accountId?: number } }>({
        query: USER_INFO_QUERY,
        variables: { accountId: engineerAccountId },
        token,
      });
      expect(protectedBody.errors).toBeUndefined();
      expect(protectedBody.data?.userInfo?.accountId).toBe(engineerAccountId);

      // 批准后申请者本人读到终态：申请已通过，展示组织为主组织
      const myRegistration = await gql<{ myEngineerRegistration?: MyRegistrationPayload }>({
        query: MY_REGISTRATION_QUERY,
        token,
      });
      expect(myRegistration.errors).toBeUndefined();
      expect(myRegistration.data?.myEngineerRegistration).toMatchObject({
        applicationId,
        organizationId: primaryOrganizationId,
        organizationName: PRIMARY_ORGANIZATION_NAME,
        status: EngineerRegistrationApplicationStatus.APPROVED,
        applicationNote: '请审核我的工程师注册',
        reviewComment: null,
      });
      expect(typeof myRegistration.data?.myEngineerRegistration?.submittedAt).toBe('string');
      expect(typeof myRegistration.data?.myEngineerRegistration?.reviewedAt).toBe('string');

      // 同一时刻的会话身份必须已解除限制：限制只看服务端每请求复核结果，不看前端缓存
      const identity = await gql<{ mySessionIdentity?: MySessionIdentityPayload }>({
        query: MY_SESSION_IDENTITY_QUERY,
        token,
      });
      expect(identity.errors).toBeUndefined();
      expect(identity.data?.mySessionIdentity).toMatchObject({
        accountId: engineerAccountId,
        engineerOrganizationId: primaryOrganizationId,
        registrationOrganizationId: primaryOrganizationId,
        restriction: SessionRestriction.NONE,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 管理员作用域：一级全范围 / 二级本公司
  // ---------------------------------------------------------------------------
  describe('管理员作用域：一级全范围与二级本公司', () => {
    let primaryEngineerAccountId = 0;
    let primaryApplicationId = 0;
    let peerEngineerAccountId = 0;
    let peerApplicationId = 0;

    beforeAll(async () => {
      const primaryRecorded = await registerEngineerAndRecord({
        loginName: ENGINEER_SCOPE_PRIMARY.loginName,
        loginEmail: ENGINEER_SCOPE_PRIMARY.loginEmail,
        note: '申请加入主组织',
      });
      expect(primaryRecorded.body.errors).toBeUndefined();
      primaryEngineerAccountId = primaryRecorded.accountId;
      primaryApplicationId = primaryRecorded.applicationId;

      const peerRecorded = await registerEngineerAndRecord({
        loginName: ENGINEER_SCOPE_PEER.loginName,
        loginEmail: ENGINEER_SCOPE_PEER.loginEmail,
        note: '申请加入对侧组织',
        organizationId: peerOrganizationId,
      });
      expect(peerRecorded.body.errors).toBeUndefined();
      peerEngineerAccountId = peerRecorded.accountId;
      peerApplicationId = peerRecorded.applicationId;
    });

    it('一级管理员队列跨公司返回申请，并带出各申请的目标公司名', async () => {
      const list = await adminList(adminToken, EngineerRegistrationApplicationStatus.PENDING);
      expect(list.errors).toBeUndefined();
      const items = list.data?.adminEngineerRegistrations?.items ?? [];
      const primaryItem = items.find((item) => item.application.id === primaryApplicationId);
      const peerItem = items.find((item) => item.application.id === peerApplicationId);
      expect(primaryItem?.organizationName).toBe('E2E 工程师注册主组织');
      expect(peerItem?.organizationName).toBe('E2E 工程师注册对侧组织');
      expect(peerItem?.application.organizationId).toBe(peerOrganizationId);
    });

    it('一级管理员可跨公司读取详情', async () => {
      const primaryDetail = await adminDetail(adminToken, primaryApplicationId);
      expect(primaryDetail.errors).toBeUndefined();
      expect(primaryDetail.data?.adminEngineerRegistrationDetail?.application.accountId).toBe(
        primaryEngineerAccountId,
      );

      const peerDetail = await adminDetail(adminToken, peerApplicationId);
      expect(peerDetail.errors).toBeUndefined();
      expect(peerDetail.data?.adminEngineerRegistrationDetail?.application.accountId).toBe(
        peerEngineerAccountId,
      );
      expect(peerDetail.data?.adminEngineerRegistrationDetail?.organizationName).toBe(
        'E2E 工程师注册对侧组织',
      );
    });

    it('二级管理员队列与分页总数仅含本公司，跨公司详情/审核统一 NOT_FOUND', async () => {
      const list = await adminList(peerAdminToken, EngineerRegistrationApplicationStatus.PENDING);
      expect(list.errors).toBeUndefined();
      const items = list.data?.adminEngineerRegistrations?.items ?? [];
      expect(items.map((item) => item.application.id)).toContain(peerApplicationId);
      expect(items.every((item) => item.application.organizationId === peerOrganizationId)).toBe(
        true,
      );
      expect(list.data?.adminEngineerRegistrations?.total).toBe(items.length);

      const crossDetail = await adminDetail(peerAdminToken, primaryApplicationId);
      expect(crossDetail.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(crossDetail)).toBe('NOT_FOUND');

      const crossReview = await review({
        token: peerAdminToken,
        applicationId: primaryApplicationId,
        action: EngineerRegistrationReviewAction.REJECT,
        reviewComment: '越权尝试',
      });
      expect(crossReview.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(crossReview)).toBe('NOT_FOUND');

      const untouched = await dataSource.query(
        'SELECT status FROM engineer_registration_application WHERE id = ?',
        [primaryApplicationId],
      );
      expect(untouched[0]?.status).toBe(EngineerRegistrationApplicationStatus.PENDING);
    });

    it('一级管理员批准对侧公司申请：成员关系写入申请目标公司', async () => {
      const approved = await review({
        token: adminToken,
        applicationId: peerApplicationId,
        action: EngineerRegistrationReviewAction.APPROVE,
      });
      expect(approved.errors).toBeUndefined();
      expect(approved.data?.reviewEngineerRegistration?.application.status).toBe(
        EngineerRegistrationApplicationStatus.APPROVED,
      );
      expect(approved.data?.reviewEngineerRegistration?.organizationName).toBe(
        'E2E 工程师注册对侧组织',
      );

      const account = await accountRepo().findOne({ where: { id: peerEngineerAccountId } });
      expect(account?.status).toBe(AccountStatus.ACTIVE);
      const userInfo = await userInfoRepo().findOne({
        where: { accountId: peerEngineerAccountId },
      });
      expect(userInfo?.userState).toBe(UserState.ACTIVE);

      const membership = await membershipRepo().findOne({
        where: { organizationId: peerOrganizationId, accountId: peerEngineerAccountId },
      });
      expect(membership?.memberRole).toBe(IdentityTypeEnum.ENGINEER);
      expect(membership?.status).toBe('ACTIVE');
      await recordActiveMembership(peerOrganizationId, peerEngineerAccountId, 'ENGINEER');
      updateOwnedExpectation(ownership, 'account', peerEngineerAccountId, {
        status: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });

      // 成员关系只落在申请目标公司，不得回落到管理员自身的可信公司。
      const wrongMembership = await membershipRepo().count({
        where: { organizationId: primaryOrganizationId, accountId: peerEngineerAccountId },
      });
      expect(wrongMembership).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 审批详情契约：既有 AdminUserDTO 入口保持兼容，新入口只提供真实姓名
  // ---------------------------------------------------------------------------
  describe('审批详情契约兼容与实名入口', () => {
    let contractAccountId = 0;
    let contractApplicationId = 0;
    let restrictedEngineerToken = '';

    beforeAll(async () => {
      const recorded = await registerEngineerAndRecord({
        loginName: ENGINEER_CONTRACT_DETAIL.loginName,
        loginEmail: ENGINEER_CONTRACT_DETAIL.loginEmail,
        note: '审批详情契约回归',
      });
      contractAccountId = recorded.accountId;
      contractApplicationId = recorded.applicationId;

      const loginBody = await gql<LoginPayload>({
        query: LOGIN_MUTATION,
        variables: {
          input: {
            loginName: ENGINEER_CONTRACT_DETAIL.loginName,
            loginPassword: PASSWORD,
            type: LoginTypeEnum.PASSWORD,
            audience: AudienceTypeEnum.DESKTOP,
            allowRestrictedSession: true,
          },
        },
      });
      expect(loginBody.errors).toBeUndefined();
      expect(loginBody.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_PENDING);
      restrictedEngineerToken = loginBody.data?.login?.accessToken ?? '';
      expect(restrictedEngineerToken).not.toBe('');
    });

    it('既有详情入口原字段直查可用，申请人仍是 AdminUserDTO 字段面', async () => {
      const body = await adminDetail(adminToken, contractApplicationId);

      expect(body.errors).toBeUndefined();
      expect(body.data?.adminEngineerRegistrationDetail?.application.accountId).toBe(
        contractAccountId,
      );
      expect(body.data?.adminEngineerRegistrationDetail?.applicant.role).toBe(
        IdentityTypeEnum.ENGINEER,
      );
      expect(body.data?.adminEngineerRegistrationDetail?.applicant.status).toBe(
        AccountStatus.PENDING,
      );
    });

    it('旧 AdminUserDTO fragment 选择集继续被接受', async () => {
      const body = await adminDetailWithFragment(adminToken, contractApplicationId);

      expect(body.errors).toBeUndefined();
      const applicant = body.data?.adminEngineerRegistrationDetail?.applicant;
      expect(applicant?.id).toBe(contractAccountId);
      expect(applicant?.nickname).toBe(ENGINEER_CONTRACT_DETAIL.loginName);
      expect(typeof applicant?.createdAt).toBe('string');
      expect(typeof applicant?.updatedAt).toBe('string');
    });

    it('新实名入口返回真实姓名，且不暴露角色 / 状态字段', async () => {
      const body = await adminApprovalDetail(adminToken, contractApplicationId);

      expect(body.errors).toBeUndefined();
      const detail = body.data?.adminEngineerRegistrationApprovalDetail;
      expect(detail?.application.accountId).toBe(contractAccountId);
      expect(detail?.applicant.id).toBe(contractAccountId);
      expect(detail?.applicant.realName).toBe('E2E 工程师');
      expect(detail?.organizationName).toBe('E2E 工程师注册主组织');

      const roleSelection = await gql<{
        adminEngineerRegistrationApprovalDetail?: { applicant?: { role?: string } };
      }>({
        query: `
          query AdminApprovalDetailRole($applicationId: Int!) {
            adminEngineerRegistrationApprovalDetail(applicationId: $applicationId) {
              applicant { role }
            }
          }
        `,
        variables: { applicationId: contractApplicationId },
        token: adminToken,
      });
      expect(roleSelection.errors?.length ?? 0).toBeGreaterThan(0);
    });

    it('二级跨公司、匿名与受限账号在两个入口上按原口径拒绝', async () => {
      const crossDetail = await adminDetail(peerAdminToken, contractApplicationId);
      const crossApproval = await adminApprovalDetail(peerAdminToken, contractApplicationId);
      expect(errorCodeOf(crossDetail)).toBe('NOT_FOUND');
      expect(errorCodeOf(crossApproval)).toBe('NOT_FOUND');

      const anonymousDetail = await gql<{
        adminEngineerRegistrationDetail?: AdminDetailPayload;
      }>({ query: ADMIN_DETAIL_QUERY, variables: { applicationId: contractApplicationId } });
      const anonymousApproval = await gql<{
        adminEngineerRegistrationApprovalDetail?: AdminApprovalDetailPayload;
      }>({
        query: ADMIN_APPROVAL_DETAIL_QUERY,
        variables: { applicationId: contractApplicationId },
      });
      expect(errorCodeOf(anonymousDetail)).toBe('UNAUTHENTICATED');
      expect(errorCodeOf(anonymousApproval)).toBe('UNAUTHENTICATED');

      const restrictedDetail = await adminDetail(restrictedEngineerToken, contractApplicationId);
      const restrictedApproval = await adminApprovalDetail(
        restrictedEngineerToken,
        contractApplicationId,
      );
      expect(errorCodeOf(restrictedDetail)).toBe('FORBIDDEN');
      expect(errorCodeOf(restrictedApproval)).toBe('FORBIDDEN');
    });
  });

  // ---------------------------------------------------------------------------
  // 拒绝与重提
  // ---------------------------------------------------------------------------
  describe('拒绝与拒绝后重提', () => {
    let engineerAccountId = 0;
    let originalApplicationId = 0;

    beforeAll(async () => {
      const recorded = await registerEngineerAndRecord({
        loginName: ENGINEER_REJECT.loginName,
        loginEmail: ENGINEER_REJECT.loginEmail,
        note: '第一次申请',
      });
      engineerAccountId = recorded.accountId;
      originalApplicationId = recorded.applicationId;
    });

    it('拒绝必须填写审核意见；无意见时 BAD_USER_INPUT 且申请仍待审', async () => {
      const rejected = await review({
        token: adminToken,
        applicationId: originalApplicationId,
        action: EngineerRegistrationReviewAction.REJECT,
      });
      expect(rejected.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(rejected)).toBe('BAD_USER_INPUT');

      const statusRows = await dataSource.query(
        'SELECT status FROM engineer_registration_application WHERE id = ?',
        [originalApplicationId],
      );
      expect(statusRows[0]?.status).toBe(EngineerRegistrationApplicationStatus.PENDING);
    });

    it('拒绝写入终态但账号保持待审，可凭本人凭据重提并保留拒绝历史', async () => {
      const rejected = await review({
        token: adminToken,
        applicationId: originalApplicationId,
        action: EngineerRegistrationReviewAction.REJECT,
        reviewComment: '资料不完整，请补充后重提',
      });
      expect(rejected.errors).toBeUndefined();
      expect(rejected.data?.reviewEngineerRegistration?.application.status).toBe(
        EngineerRegistrationApplicationStatus.REJECTED,
      );
      expect(rejected.data?.reviewEngineerRegistration?.application.reviewComment).toBe(
        '资料不完整，请补充后重提',
      );

      const account = await accountRepo().findOne({ where: { id: engineerAccountId } });
      expect(account?.status).toBe(AccountStatus.PENDING);
      const memberships = await membershipRepo().count({ where: { accountId: engineerAccountId } });
      expect(memberships).toBe(0);

      const resubmitted = await resubmitAndRecord(
        {
          accountIdentifier: ENGINEER_REJECT.loginName,
          password: PASSWORD,
          organizationId: primaryOrganizationId,
          applicationNote: '已补充资料，重新申请',
        },
        engineerAccountId,
      );
      expect(resubmitted.errors).toBeUndefined();
      const newApplicationId = resubmitted.data?.resubmitEngineerRegistration?.applicationId;
      expect(typeof newApplicationId).toBe('number');
      expect(resubmitted.data?.resubmitEngineerRegistration?.status).toBe(
        EngineerRegistrationApplicationStatus.PENDING,
      );
      // 申请已由 resubmitAndRecord 在返回前登记，此处不再重复登记。

      const status = await myStatus(ENGINEER_REJECT.loginName, PASSWORD);
      expect(status.errors).toBeUndefined();
      expect(status.data?.myEngineerRegistrationStatus?.applications.total).toBe(2);
      const statuses = (status.data?.myEngineerRegistrationStatus?.applications.items ?? []).map(
        (item) => item.status,
      );
      expect(statuses).toContain(EngineerRegistrationApplicationStatus.REJECTED);
      expect(status.data?.myEngineerRegistrationStatus?.latest?.status).toBe(
        EngineerRegistrationApplicationStatus.PENDING,
      );

      // 已有待审申请时不能并发提交第二份
      const duplicate = await resubmit({
        accountIdentifier: ENGINEER_REJECT.loginName,
        password: PASSWORD,
        organizationId: primaryOrganizationId,
      });
      expect(duplicate.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(duplicate)).toBe('CONFLICT');
    });

    it('已开通客户不能以重提方式绕过成员边界', async () => {
      const body = await resubmit({
        accountIdentifier: CUSTOMER_LOGIN_NAME,
        password: PASSWORD,
        organizationId: primaryOrganizationId,
      });
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(body)).toBe('CONFLICT');
    });
  });

  // ---------------------------------------------------------------------------
  // 逐阶段失败注入
  // ---------------------------------------------------------------------------
  describe('审批事务失败回滚', () => {
    let engineerAccountId = 0;
    let applicationId = 0;

    beforeAll(async () => {
      const recorded = await registerEngineerAndRecord({
        loginName: ENGINEER_ROLLBACK.loginName,
        loginEmail: ENGINEER_ROLLBACK.loginEmail,
      });
      engineerAccountId = recorded.accountId;
      applicationId = recorded.applicationId;
    });

    it('注册写入申请失败时账号与资料整体回滚', async () => {
      const engineerRegistrationService = app.get(EngineerRegistrationService);
      const spy = jest
        .spyOn(engineerRegistrationService, 'insertApplication')
        .mockRejectedValueOnce(new Error('e2e forced application insert failure'));

      const body = await register(
        engineerRegisterInput({
          loginName: `${ENGINEER_ROLLBACK.loginName}b`,
          loginEmail: 'e2e.eng.rollback.b@example.com',
        }),
      );
      spy.mockRestore();

      expect(body.data?.register?.success).toBeFalsy();
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);

      const account = await accountRepo().findOne({
        where: { loginEmail: 'e2e.eng.rollback.b@example.com' },
      });
      expect(account).toBeNull();
      // 申请行与账号同事务写入：账号已回滚，按该账号定位不应残留任何申请
      const applications = await dataSource.query(
        `SELECT COUNT(*) AS total FROM engineer_registration_application
           WHERE account_id IN (SELECT id FROM base_user_account WHERE login_email = ?)`,
        ['e2e.eng.rollback.b@example.com'],
      );
      expect(Number(applications[0]?.total ?? 0)).toBe(0);
    });

    it('审核成员写入失败时申请仍待审、账号仍待审，零部分写入', async () => {
      const membershipService = app.get(OrganizationMembershipService);
      const spy = jest
        .spyOn(membershipService, 'insertMembership')
        .mockRejectedValueOnce(new Error('e2e forced membership failure'));

      const failed = await review({
        token: adminToken,
        applicationId,
        action: EngineerRegistrationReviewAction.APPROVE,
      });
      spy.mockRestore();

      expect(failed.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(failed)).toBe('INTERNAL_SERVER_ERROR');

      const statusRows = await dataSource.query(
        'SELECT status FROM engineer_registration_application WHERE id = ?',
        [applicationId],
      );
      expect(statusRows[0]?.status).toBe(EngineerRegistrationApplicationStatus.PENDING);
      const account = await accountRepo().findOne({ where: { id: engineerAccountId } });
      expect(account?.status).toBe(AccountStatus.PENDING);
      const userInfo = await userInfoRepo().findOne({ where: { accountId: engineerAccountId } });
      expect(userInfo?.userState).toBe(UserState.PENDING);
      const memberships = await membershipRepo().count({ where: { accountId: engineerAccountId } });
      expect(memberships).toBe(0);
    });

    it('恢复后再次通过成功，同事务生效', async () => {
      const approved = await review({
        token: adminToken,
        applicationId,
        action: EngineerRegistrationReviewAction.APPROVE,
      });
      expect(approved.errors).toBeUndefined();
      expect(approved.data?.reviewEngineerRegistration?.application.status).toBe(
        EngineerRegistrationApplicationStatus.APPROVED,
      );
      await recordActiveMembership(primaryOrganizationId, engineerAccountId, 'ENGINEER');
      updateOwnedExpectation(ownership, 'account', engineerAccountId, {
        status: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 真实并发
  // ---------------------------------------------------------------------------
  describe('真实并发：重复重提与相反决策', () => {
    let engineerAccountId = 0;
    let rejectedApplicationId = 0;
    let pendingApplicationId = 0;

    beforeAll(async () => {
      const recorded = await registerEngineerAndRecord({
        loginName: ENGINEER_CONCURRENT.loginName,
        loginEmail: ENGINEER_CONCURRENT.loginEmail,
      });
      engineerAccountId = recorded.accountId;
      rejectedApplicationId = recorded.applicationId;

      const rejected = await review({
        token: adminToken,
        applicationId: rejectedApplicationId,
        action: EngineerRegistrationReviewAction.REJECT,
        reviewComment: '并发测试前置拒绝',
      });
      expect(rejected.errors).toBeUndefined();
    });

    it('同账号并发重提只产生一份新待审申请', async () => {
      const params = {
        accountIdentifier: ENGINEER_CONCURRENT.loginName,
        password: PASSWORD,
        organizationId: primaryOrganizationId,
        applicationNote: '并发重提',
      };
      // 每个重提分支在收到成功响应后立即登记；allSettled 保证等待全部分支结束，
      // 一方失败（或抛错）不会跳过另一方的登记，也不会提前进入 teardown。
      const outcomes = await Promise.allSettled([
        resubmitAndRecord(params, engineerAccountId),
        resubmitAndRecord(params, engineerAccountId),
      ]);
      const rejectedReasons = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome) => outcome.reason);
      expect(rejectedReasons).toEqual([]);
      const bodies = outcomes
        .filter(
          (
            outcome,
          ): outcome is PromiseFulfilledResult<
            GqlBody<{ resubmitEngineerRegistration?: ResubmitPayload }>
          > => outcome.status === 'fulfilled',
        )
        .map((outcome) => outcome.value);
      const successApplicationIds = bodies
        .map((body) => body.data?.resubmitEngineerRegistration?.applicationId)
        .filter((applicationId): applicationId is number => typeof applicationId === 'number');
      expect(successApplicationIds).toHaveLength(1);
      pendingApplicationId = successApplicationIds[0];

      const rows = await dataSource.query(
        'SELECT status FROM engineer_registration_application WHERE account_id = ? ORDER BY id ASC',
        [engineerAccountId],
      );
      expect(rows).toHaveLength(2);
      expect(
        rows.map((row: { status: EngineerRegistrationApplicationStatus }) => row.status),
      ).toEqual([
        EngineerRegistrationApplicationStatus.REJECTED,
        EngineerRegistrationApplicationStatus.PENDING,
      ]);
      const loser = bodies.find(
        (body) => body.data?.resubmitEngineerRegistration?.applicationId === undefined,
      );
      expect(loser?.errors?.length ?? 0).toBeGreaterThan(0);
      expect(errorCodeOf(loser as GqlBody<unknown>)).toBe('CONFLICT');
    });

    it('两个管理员相反决策只有一个生效，终态与账号/成员一致', async () => {
      const [approveBody, rejectBody] = await Promise.all([
        review({
          token: adminToken,
          applicationId: pendingApplicationId,
          action: EngineerRegistrationReviewAction.APPROVE,
        }),
        review({
          token: adminToken,
          applicationId: pendingApplicationId,
          action: EngineerRegistrationReviewAction.REJECT,
          reviewComment: '并发拒绝',
        }),
      ]);

      const outcomes = [approveBody, rejectBody].map((body) =>
        body.errors?.length
          ? 'ERROR'
          : (body.data?.reviewEngineerRegistration?.application.status ?? 'NONE'),
      );
      expect(outcomes.filter((outcome) => outcome !== 'ERROR')).toHaveLength(1);

      const rows = await dataSource.query(
        'SELECT status FROM engineer_registration_application WHERE id = ?',
        [pendingApplicationId],
      );
      expect(rows).toHaveLength(1);
      const finalStatus = rows[0]?.status;

      const account = await accountRepo().findOne({ where: { id: engineerAccountId } });
      const userInfo = await userInfoRepo().findOne({ where: { accountId: engineerAccountId } });
      const membership = await membershipRepo().findOne({
        where: { organizationId: primaryOrganizationId, accountId: engineerAccountId },
      });

      if (finalStatus === EngineerRegistrationApplicationStatus.APPROVED) {
        expect(account?.status).toBe(AccountStatus.ACTIVE);
        expect(userInfo?.userState).toBe(UserState.ACTIVE);
        expect(membership?.memberRole).toBe(IdentityTypeEnum.ENGINEER);
        expect(membership?.status).toBe('ACTIVE');
        await recordActiveMembership(primaryOrganizationId, engineerAccountId, 'ENGINEER');
        updateOwnedExpectation(ownership, 'account', engineerAccountId, {
          status: AccountStatus.ACTIVE,
          userState: UserState.ACTIVE,
        });
      } else {
        expect(finalStatus).toBe(EngineerRegistrationApplicationStatus.REJECTED);
        expect(account?.status).toBe(AccountStatus.PENDING);
        expect(userInfo?.userState).toBe(UserState.PENDING);
        expect(membership).toBeNull();
      }

      const failed = [approveBody, rejectBody].find((body) => body.errors?.length);
      expect(errorCodeOf(failed as GqlBody<unknown>)).toBe('CONFLICT');
    });
  });

  // ---------------------------------------------------------------------------
  // 部分成功与登记顺序
  // ---------------------------------------------------------------------------
  describe('真实并发：部分成功与登记顺序', () => {
    let throwAccountId = 0;
    let assertPrimaryAccountId = 0;
    let assertSecondaryAccountId = 0;

    /** 注册工程师并前置拒绝，使其处于可重提状态 */
    const setupRejectedEngineer = async (params: {
      loginName: string;
      loginEmail: string;
    }): Promise<number> => {
      const recorded = await registerEngineerAndRecord(params);
      const rejected = await review({
        token: adminToken,
        applicationId: recorded.applicationId,
        action: EngineerRegistrationReviewAction.REJECT,
        reviewComment: '部分成功场景前置拒绝',
      });
      expect(rejected.errors).toBeUndefined();
      return recorded.accountId;
    };

    beforeAll(async () => {
      throwAccountId = await setupRejectedEngineer(ENGINEER_PARTIAL_THROW);
      assertPrimaryAccountId = await setupRejectedEngineer(ENGINEER_PARTIAL_ASSERT_PRIMARY);
      assertSecondaryAccountId = await setupRejectedEngineer(ENGINEER_PARTIAL_ASSERT_SECONDARY);
    });

    it('一方成功、另一方抛错：成功申请已登记且原始失败保留', async () => {
      const params = {
        accountIdentifier: ENGINEER_PARTIAL_THROW.loginName,
        password: PASSWORD,
        organizationId: primaryOrganizationId,
        applicationNote: '部分成功-抛错分支',
      };
      const originalFailure = new Error('forced branch transport failure');

      const outcomes = await Promise.allSettled([
        resubmitAndRecord(params, throwAccountId),
        Promise.reject(originalFailure),
      ]);

      const successOutcome = outcomes[0];
      expect(successOutcome.status).toBe('fulfilled');
      const applicationId =
        successOutcome.status === 'fulfilled'
          ? successOutcome.value.data?.resubmitEngineerRegistration?.applicationId
          : undefined;
      expect(typeof applicationId).toBe('number');
      // 成功分支已在返回前登记：后续断言失败也不会漏出清理台账
      expect(ownership.engineerRegistrationApplicationIds).toContain(applicationId as number);

      // 原始失败按引用保留，没有被 allSettled 吞掉或改写
      const failureOutcome = outcomes[1];
      expect(failureOutcome.status).toBe('rejected');
      if (failureOutcome.status === 'rejected') {
        expect(failureOutcome.reason).toBe(originalFailure);
      }

      const pendingRows = await dataSource.query(
        'SELECT id, status FROM engineer_registration_application WHERE account_id = ? AND status = ?',
        [throwAccountId, EngineerRegistrationApplicationStatus.PENDING],
      );
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]?.id).toBe(applicationId);
    });

    it('双方返回后业务断言失败：成功申请均已登记，断言错误保留', async () => {
      // 用两个不同账号构造「两方都成功」，再用一个必然失败的竞争断言验证
      // 登记发生在断言之前：断言抛错时成功申请仍在台账中，afterAll 受保护清理仍能执行。
      const outcomes = await Promise.allSettled([
        resubmitAndRecord(
          {
            accountIdentifier: ENGINEER_PARTIAL_ASSERT_PRIMARY.loginName,
            password: PASSWORD,
            organizationId: primaryOrganizationId,
            applicationNote: '部分成功-断言分支 A',
          },
          assertPrimaryAccountId,
        ),
        resubmitAndRecord(
          {
            accountIdentifier: ENGINEER_PARTIAL_ASSERT_SECONDARY.loginName,
            password: PASSWORD,
            organizationId: primaryOrganizationId,
            applicationNote: '部分成功-断言分支 B',
          },
          assertSecondaryAccountId,
        ),
      ]);
      const bodies = outcomes
        .filter(
          (
            outcome,
          ): outcome is PromiseFulfilledResult<
            GqlBody<{ resubmitEngineerRegistration?: ResubmitPayload }>
          > => outcome.status === 'fulfilled',
        )
        .map((outcome) => outcome.value);
      const successApplicationIds = bodies
        .map((body) => body.data?.resubmitEngineerRegistration?.applicationId)
        .filter((applicationId): applicationId is number => typeof applicationId === 'number');
      expect(successApplicationIds).toHaveLength(2);

      let assertionError: unknown;
      try {
        expect(successApplicationIds).toHaveLength(1);
      } catch (error) {
        assertionError = error;
      }
      expect(assertionError).toBeInstanceOf(Error);
      for (const applicationId of successApplicationIds) {
        expect(ownership.engineerRegistrationApplicationIds).toContain(applicationId);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 回读核验与账本隔离
  // ---------------------------------------------------------------------------
  describe('注册成功后回读前归属字段被改写', () => {
    /**
     * 注册 → 外部改写邮箱 → 执行断言 → 无论断言是否失败都恢复字段并登记成员关系。
     *
     * 主流程、恢复、登记三段错误分别保留；恢复前必须确认实际值仍是本轮注入值，
     * 避免覆盖其他来源的改写。
     */
    const runTamperScenario = async (params: {
      input: RegisterInput;
      tamperedEmail: string;
      onTampered: (accountId: number, originalFacts: OwnedAccountFacts) => Promise<void> | void;
    }): Promise<{
      accountId: number;
      originalFacts?: OwnedAccountFacts;
      primaryError?: unknown;
      restoreError?: unknown;
      recordError?: unknown;
    }> => {
      let accountId = 0;
      let originalFacts: OwnedAccountFacts | undefined = undefined;
      let primaryError: unknown = undefined;
      let restoreError: unknown = undefined;
      let recordError: unknown = undefined;

      const restoreTamperedField = async (): Promise<void> => {
        if (accountId <= 0) {
          throw new Error('收尾恢复失败：本轮未取得账号主键');
        }
        const account = await accountRepo().findOne({ where: { id: accountId } });
        if (account === null) {
          throw new Error(`收尾恢复失败：账号 ${accountId} 已不存在，拒绝猜测`);
        }
        if (account.loginEmail !== params.tamperedEmail) {
          throw new Error(
            `收尾恢复失败：账号 ${accountId} 邮箱已不是本轮注入值（${String(account.loginEmail)}），拒绝覆盖其他改写`,
          );
        }
        await accountRepo().update({ id: accountId }, { loginEmail: params.input.loginEmail });
      };

      try {
        await registerAndRecord(
          params.input,
          { organizationId: primaryOrganizationId, memberRole: 'CUSTOMER' },
          async (id) => {
            accountId = id;
            const recorded = ownership.facts.account.get(id);
            if (recorded === undefined) {
              throw new Error(`账号 ${id} 未登记预期事实`);
            }
            originalFacts = structuredClone(recorded);
            // 注册成功、回读之前模拟外部改写归属字段
            await accountRepo().update({ id }, { loginEmail: params.tamperedEmail });
            await params.onTampered(id, originalFacts);
          },
        );
      } catch (error) {
        primaryError = error;
      } finally {
        try {
          await restoreTamperedField();
        } catch (error) {
          restoreError = error;
        }
        try {
          await recordActiveMembership(primaryOrganizationId, accountId, 'CUSTOMER');
        } catch (error) {
          recordError = error;
        }
      }

      return { accountId, originalFacts, primaryError, restoreError, recordError };
    };

    it('回读核验失败、原始账本不变、受保护清理零删除', async () => {
      const input: RegisterInput = {
        loginName: CUSTOMER_VERIFY_TAMPER.loginName,
        loginEmail: CUSTOMER_VERIFY_TAMPER.loginEmail,
        loginPassword: PASSWORD,
        nickname: CUSTOMER_VERIFY_TAMPER.loginName,
        type: RegisterTypeEnum.CUSTOMER,
        organizationId: primaryOrganizationId,
      };

      const outcome = await runTamperScenario({
        input,
        tamperedEmail: CUSTOMER_VERIFY_TAMPER_REWRITTEN_EMAIL,
        onTampered: async (accountId, originalFacts) => {
          let verifyError: unknown = undefined;
          try {
            await verifyRegisteredAccount(accountId);
          } catch (error) {
            verifyError = error;
          }
          // 核验必须失败，而不是把改写后的值重新认定为本轮所有
          expect(verifyError).toBeInstanceOf(Error);
          const verifyMessage = (verifyError as Error).message;
          expect(verifyMessage).toContain('归属字段已与本轮登记事实不一致');
          expect(verifyMessage).toContain('loginEmail');
          expect(ownership.facts.account.get(accountId)).toEqual(originalFacts);

          // 原账本仍持有原始事实：受保护清理必须在第一条 DELETE 前拒绝漂移的账号
          const tamperLedger = createOwnedResourceLedger();
          recordOwnedResource(tamperLedger, 'account', accountId, originalFacts);
          await expect(
            runGuardedSpecCleanup({
              dataSource,
              owned: tamperLedger,
              helper: 'engineer-registration-approval.e2e-spec 回读改写回归',
            }),
          ).rejects.toThrow(/本轮登记事实漂移/);

          // 零删除：被改写的账号及其成员关系都仍然存在
          expect(await accountRepo().count({ where: { id: accountId } })).toBe(1);
          expect(await membershipRepo().count({ where: { accountId } })).toBe(1);
        },
      });

      // 主流程、恢复、登记三段错误分别保留；正常路径三段都应为空
      expect(outcome.primaryError).toBeUndefined();
      expect(outcome.restoreError).toBeUndefined();
      expect(outcome.recordError).toBeUndefined();
      const membership = await membershipRepo().findOneOrFail({
        where: { organizationId: primaryOrganizationId, accountId: outcome.accountId },
      });
      expect(ownership.membershipIds).toContain(membership.id);
      expect(ownership.facts.membership.get(membership.id)).toBeDefined();
    });

    it('字段改写后中途断言失败仍执行 finally 恢复与成员关系登记', async () => {
      const input: RegisterInput = {
        loginName: CUSTOMER_VERIFY_TAMPER_MIDWAY.loginName,
        loginEmail: CUSTOMER_VERIFY_TAMPER_MIDWAY.loginEmail,
        loginPassword: PASSWORD,
        nickname: CUSTOMER_VERIFY_TAMPER_MIDWAY.loginName,
        type: RegisterTypeEnum.CUSTOMER,
        organizationId: primaryOrganizationId,
      };

      const outcome = await runTamperScenario({
        input,
        tamperedEmail: CUSTOMER_VERIFY_TAMPER_MIDWAY_REWRITTEN_EMAIL,
        onTampered: () => {
          // 模拟字段改写后的中途断言失败：断言抛错也必须走 finally 收尾
          expect('midway assertion').toBe('must not be reached');
        },
      });

      // 主错误保留，恢复与登记错误分别为空，证明 finally 已执行且成功
      expect(outcome.primaryError).toBeInstanceOf(Error);
      expect((outcome.primaryError as Error).message).toContain('must not be reached');
      expect(outcome.restoreError).toBeUndefined();
      expect(outcome.recordError).toBeUndefined();

      const account = await accountRepo().findOneOrFail({ where: { id: outcome.accountId } });
      expect(account.loginEmail).toBe(input.loginEmail);
      const membership = await membershipRepo().findOneOrFail({
        where: { organizationId: primaryOrganizationId, accountId: outcome.accountId },
      });
      expect(ownership.membershipIds).toContain(membership.id);
    });
  });
});
