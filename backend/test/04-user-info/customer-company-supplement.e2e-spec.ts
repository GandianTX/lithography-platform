// test/04-user-info/customer-company-supplement.e2e-spec.ts
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { EquipmentModelEntity } from '../../src/modules/lithography/entities/equipment-model.entity';
import { OrganizationEntity } from '../../src/modules/lithography/entities/organization.entity';
import { RepairRequestEntity } from '../../src/modules/lithography/entities/repair-request.entity';
import { CreateAccountUsecase } from '../../src/usecases/account/create-account.usecase';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import {
  createTestAccount,
  seedTestAccounts,
  testAccountsConfig,
  type TestAccountConfig,
} from '../utils/test-accounts';
import { seedTestOrganizations, type TestOrganizationSpec } from '../utils/test-organizations';

/**
 * 任务 02.4 / 验收 D1：缺归属旧客户补录公司归属的真实 MySQL + GraphQL E2E。
 *
 * 与定向单测（`supplement-my-customer-company.usecase.spec.ts`、
 * `create-repair-request.usecase.spec.ts`）的分工：单测断言协作契约与事务细节；
 * 本文件断言**跨进程可观察事实**：
 * 1. 选择受管候选 / 手填公司都真实落库：`base_user_info.customer_organization_id`
 *    与 `organization_membership(memberRole=CUSTOMER)` 同事务写入，公司行数符合预期；
 * 2. 已归属客户换绑或重复提交 → `CONFLICT` / 幂等，零写入；
 * 3. 非 CUSTOMER、停用 / 未受管 / 伪造 organizationId、互斥与都缺 → 零写入；
 * 4. 同一账号两个不同候选并发提交：行锁串行化后仅一次落库，公司行不新增；
 * 5. 报修门禁：缺归属客户新增报修 `FORBIDDEN`（零申请），补录成功后新增报修写入
 *    `owner_organization_id` = 新归属；缺归属客户仍可读取本人历史申请。
 *
 * 造数纪律（同 `my-account-settings-write.e2e-spec.ts`）：
 * - 账号与组织夹具全部走受控入口（`createTestAccount` / `seedTestOrganizations`）并登记台账；
 * - 业务写入（补录、新增报修）只走 GraphQL Mutation，数据库用于只读核验；
 * - 补录事务内新建的公司 / 成员关系在成功后按返回事实补登记，供收尾精确回收；
 * - 组内存在**刻意且已声明**的顺序依赖：`alpha` 的补录成功是其后「换绑冲突 / 幂等 /
 *   新增报修」的前置；`repairUnbound` 的历史申请由 beforeAll 预置。
 */

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string; errorMessage?: string };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type MySettingsPayload = {
  companyName: string | null;
  trustedCompanyName: string | null;
  role: IdentityTypeEnum;
  status: AccountStatus;
};

type SupplementPayload = {
  isUpdated: boolean;
  sameNamedCompanyName: string | null;
  settings: MySettingsPayload;
};

type CreateRepairRequestPayload = {
  id: number;
  requestNo: string;
};

type MyRepairRequestsPayload = {
  items: Array<{ id: number; requestNo: string }>;
  total: number;
  page: number;
  pageSize: number;
};

const SUPPLEMENT_MUTATION = `
  mutation SupplementMyCustomerCompany($input: SupplementMyCustomerCompanyInput!) {
    supplementMyCustomerCompany(input: $input) {
      isUpdated
      sameNamedCompanyName
      settings { companyName trustedCompanyName role status }
    }
  }
`;

const CREATE_REPAIR_REQUEST_MUTATION = `
  mutation CreateRepairRequest($input: CreateRepairRequestInput!) {
    createRepairRequest(input: $input) { id requestNo }
  }
`;

const MY_REPAIR_REQUESTS_QUERY = `
  query MyRepairRequests($pagination: PaginationArgs!) {
    myRepairRequests(pagination: $pagination) {
      items { id requestNo }
      total
      page
      pageSize
    }
  }
`;

const MY_REPAIR_REQUEST_QUERY = `
  query MyRepairRequest($id: Int!) {
    myRepairRequest(id: $id) { id requestNo }
  }
`;

const OFFSET_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };

/** 五个缺归属客户各自承担独立场景，避免用例间共享可变状态（除已声明的顺序依赖） */
const customers = {
  alpha: {
    loginName: 's4companyalpha',
    loginEmail: 's4.company.alpha@example.com',
    loginPassword: 'S4CompanyAlpha@2026',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  beta: {
    loginName: 's4companybeta',
    loginEmail: 's4.company.beta@example.com',
    loginPassword: 'S4CompanyBeta@2026',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  invalid: {
    loginName: 's4companyinvalid',
    loginEmail: 's4.company.invalid@example.com',
    loginPassword: 'S4CompanyInvalid@2026',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  concurrent: {
    loginName: 's4companyconcurrent',
    loginEmail: 's4.company.concurrent@example.com',
    loginPassword: 'S4CompanyConcurrent@2026',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  repairUnbound: {
    loginName: 's4companyrepair',
    loginEmail: 's4.company.repair@example.com',
    loginPassword: 'S4CompanyRepair@2026',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
} satisfies Record<string, TestAccountConfig>;

const CUSTOMER_CONFIGS: readonly TestAccountConfig[] = Object.values(customers);

/** 受管公司候选（ACTIVE + is_managed_company）；固定编码配合残留指纹回收 */
const MANAGED_COMPANIES: readonly TestOrganizationSpec[] = [
  {
    organizationCode: 'E2E_S4_COMPANY_A',
    name: 'S4 受管公司甲',
    kind: 'CLIENT',
    isManagedCompany: true,
  },
  {
    organizationCode: 'E2E_S4_COMPANY_B',
    name: 'S4 受管公司乙',
    kind: 'CLIENT',
    isManagedCompany: true,
  },
];

/** 未受管组织：具备 ACTIVE 状态但不在维护名单，补录时必须拒绝 */
const UNMANAGED_COMPANY: TestOrganizationSpec = {
  organizationCode: 'E2E_S4_COMPANY_UNMANAGED',
  name: 'S4 未受管公司',
  kind: 'CLIENT',
  isManagedCompany: false,
};

const SELF_FILLED_COMPANY_NAME = 'S4 手填客户公司';

const REPAIR_ERROR_CODE = 'E-4A01';
const REPAIR_FAULT_DESCRIPTION = '补录完成后提交的维修申请';

describe('缺归属旧客户补录公司归属 supplementMyCustomerCompany (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ownership: OwnedResourceLedger;
  let createAccountUsecase: CreateAccountUsecase;

  let managedCompanyAId: number;
  let managedCompanyBId: number;
  let unmanagedCompanyId: number;
  let disabledCompanyId: number;
  let equipmentModelId: number;

  let alphaAccountId: number;
  let betaAccountId: number;
  let invalidAccountId: number;
  let concurrentAccountId: number;
  let repairAccountId: number;

  let alphaToken: string;
  let betaToken: string;
  let invalidToken: string;
  let concurrentToken: string;
  let repairToken: string;
  let engineerToken: string;

  let legacyRequestId: number;
  const legacyRequestNo = 'E2E-S4-LEGACY-0001';

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);
    createAccountUsecase = app.get(CreateAccountUsecase);

    // 预清理（窄范围）：回收上次中断残留的已知账号 / 组织指纹，再开始本轮造数
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        accounts: [
          ...CUSTOMER_CONFIGS.map(toResidueAccountFingerprint),
          toResidueAccountFingerprint(testAccountsConfig.staff),
        ],
        organizations: [...MANAGED_COMPANIES, UNMANAGED_COMPANY],
      },
      helper: 'customer-company-supplement.e2e-spec beforeAll 预清理',
    });

    ownership = createOwnedResourceLedger();

    for (const config of CUSTOMER_CONFIGS) {
      await createTestAccount(dataSource, createAccountUsecase, config, ownership);
    }
    await seedTestAccounts({
      dataSource,
      createAccountUsecase,
      includeKeys: ['staff'],
      ownership,
    });

    const organizationIdsByCode = await seedTestOrganizations({
      dataSource,
      organizations: [...MANAGED_COMPANIES, UNMANAGED_COMPANY],
      ownership,
    });
    managedCompanyAId = requireId(organizationIdsByCode, MANAGED_COMPANIES[0].organizationCode);
    managedCompanyBId = requireId(organizationIdsByCode, MANAGED_COMPANIES[1].organizationCode);
    unmanagedCompanyId = requireId(organizationIdsByCode, UNMANAGED_COMPANY.organizationCode);

    disabledCompanyId = await seedDisabledCompany();
    equipmentModelId = await seedEquipmentModel();

    alphaAccountId = await getAccountIdByLoginName(dataSource, customers.alpha.loginName);
    betaAccountId = await getAccountIdByLoginName(dataSource, customers.beta.loginName);
    invalidAccountId = await getAccountIdByLoginName(dataSource, customers.invalid.loginName);
    concurrentAccountId = await getAccountIdByLoginName(dataSource, customers.concurrent.loginName);
    repairAccountId = await getAccountIdByLoginName(dataSource, customers.repairUnbound.loginName);

    alphaToken = await loginCustomer(customers.alpha);
    betaToken = await loginCustomer(customers.beta);
    invalidToken = await loginCustomer(customers.invalid);
    concurrentToken = await loginCustomer(customers.concurrent);
    repairToken = await loginCustomer(customers.repairUnbound);
    engineerToken = await login({
      app,
      loginName: testAccountsConfig.staff.loginName,
      loginPassword: testAccountsConfig.staff.loginPassword,
    });

    legacyRequestId = await seedLegacyRepairRequest(repairAccountId);
  }, 60000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        residue: {
          accounts: [
            ...CUSTOMER_CONFIGS.map(toResidueAccountFingerprint),
            toResidueAccountFingerprint(testAccountsConfig.staff),
          ],
          organizations: [...MANAGED_COMPANIES, UNMANAGED_COMPANY],
        },
        helper: 'customer-company-supplement.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
  });

  // ---------------------------------------------------------------------------
  // 夹具与请求 helper
  // ---------------------------------------------------------------------------

  /** 登录取 Token（预清理后账号必然由本轮创建） */
  async function loginCustomer(config: TestAccountConfig): Promise<string> {
    return login({ app, loginName: config.loginName, loginPassword: config.loginPassword });
  }

  function requireId(map: ReadonlyMap<string, number>, code: string): number {
    const id = map.get(code);
    if (id === undefined) throw new Error(`组织夹具初始化失败：${code}`);
    return id;
  }

  /**
   * 停用组织：`seedTestOrganizations` 只创建 ACTIVE 行，这里直接落库并登记预期事实。
   * 编码带唯一后缀，避免上一轮异常中断留下的行与唯一索引冲突。
   */
  async function seedDisabledCompany(): Promise<number> {
    const repository = dataSource.getRepository(OrganizationEntity);
    const saved = await repository.save(
      repository.create({
        organizationCode: `E2E_S4_COMPANY_DISABLED_${Date.now().toString(36)}`,
        name: 'S4 停用公司',
        kind: 'CLIENT',
        status: 'DISABLED',
        isManagedCompany: true,
        isServiceProvider: false,
      }),
    );
    recordOwnedResource(ownership, 'organization', saved.id, {
      organizationCode: saved.organizationCode,
      name: saved.name,
      kind: saved.kind,
      status: saved.status,
      isManagedCompany: saved.isManagedCompany,
    });
    return saved.id;
  }

  async function seedEquipmentModel(): Promise<number> {
    const repository = dataSource.getRepository(EquipmentModelEntity);
    const saved = await repository.save(
      repository.create({
        modelCode: `E2E-S4-MODEL-${Date.now().toString(36)}`,
        modelName: 'S4 报修型号',
        enabled: true,
        sortOrder: 0,
      }),
    );
    recordOwnedResource(ownership, 'equipmentModel', saved.id, {
      modelCode: saved.modelCode,
      modelName: saved.modelName,
      enabled: saved.enabled,
      sortOrder: saved.sortOrder,
    });
    return saved.id;
  }

  /** 历史遗留申请：补录前已存在、无组织归属，用于验证缺归属客户仍可读取历史 */
  async function seedLegacyRepairRequest(accountId: number): Promise<number> {
    const repository = dataSource.getRepository(RepairRequestEntity);
    const saved = await repository.save(
      repository.create({
        requestNo: legacyRequestNo,
        customerAccountId: accountId,
        equipmentModelId,
        errorCode: REPAIR_ERROR_CODE,
        faultDescription: '补录前提交的历史维修申请',
        contentMd: '# 历史维修申请\n\n补录前数据',
        ownerOrganizationId: null,
        isAccepted: false,
        deprecated: false,
      }),
    );
    recordOwnedResource(ownership, 'repairRequest', saved.id, {
      requestNo: saved.requestNo,
      customerAccountId: saved.customerAccountId,
      equipmentModelId: saved.equipmentModelId,
      errorCode: saved.errorCode,
      faultDescription: saved.faultDescription,
    });
    return saved.id;
  }

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

  const supplement = (
    token: string | undefined,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ supplementMyCustomerCompany?: SupplementPayload }>> =>
    gql({ query: SUPPLEMENT_MUTATION, variables: { input }, token });

  const createRepairRequest = (
    token: string | undefined,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ createRepairRequest?: CreateRepairRequestPayload }>> =>
    gql({ query: CREATE_REPAIR_REQUEST_MUTATION, variables: { input }, token });

  const readCustomerOrganizationId = async (accountId: number): Promise<number | null> => {
    const rows = await dataSource.query<Array<{ customer_organization_id: number | null }>>(
      'SELECT customer_organization_id FROM base_user_info WHERE account_id = ?',
      [accountId],
    );
    return rows[0]?.customer_organization_id ?? null;
  };

  const countActiveMemberships = async (accountId: number): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: number }>>(
      "SELECT COUNT(*) AS total FROM organization_membership WHERE account_id = ? AND status = 'ACTIVE'",
      [accountId],
    );
    return Number(rows[0]?.total ?? 0);
  };

  const countOrganizations = async (): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: number }>>(
      'SELECT COUNT(*) AS total FROM organization',
    );
    return Number(rows[0]?.total ?? 0);
  };

  const countCustomerRepairRequests = async (accountId: number): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: number }>>(
      'SELECT COUNT(*) AS total FROM repair_request WHERE customer_account_id = ?',
      [accountId],
    );
    return Number(rows[0]?.total ?? 0);
  };

  type OrganizationRow = {
    id: number;
    organization_code: string;
    name: string;
    kind: string;
    status: string;
    is_managed_company: number | boolean;
    is_service_provider: number | boolean;
  };

  const readOrganizationRow = async (organizationId: number): Promise<OrganizationRow> => {
    const rows = await dataSource.query<OrganizationRow[]>(
      `SELECT id, organization_code, name, kind, status, is_managed_company, is_service_provider
         FROM organization WHERE id = ?`,
      [organizationId],
    );
    const row = rows[0];
    if (!row) throw new Error(`组织行不存在：${organizationId}`);
    return row;
  };

  /**
   * 补录事务内新建的公司与成员关系不在夹具台账里：按业务写入后的真实行补登记，
   * 事实一律来自本次受控输入与事务内不变量（名称已知、状态/角色由用例保证）。
   */
  const registerBusinessWrittenCompany = async (accountId: number): Promise<number> => {
    const organizationId = await readCustomerOrganizationId(accountId);
    if (organizationId === null) {
      throw new Error(`账号 ${accountId} 补录后仍缺公司归属`);
    }
    if (!ownership.organizationIds.includes(organizationId)) {
      const row = await readOrganizationRow(organizationId);
      recordOwnedResource(ownership, 'organization', organizationId, {
        organizationCode: row.organization_code,
        name: row.name,
        kind: row.kind,
        status: row.status,
        isManagedCompany: Number(row.is_managed_company) === 1,
      });
    }
    const memberships = await dataSource.query<
      Array<{
        id: number;
        organization_id: number;
        account_id: number;
        member_role: string;
        status: string;
      }>
    >(
      `SELECT id, organization_id, account_id, member_role, status
         FROM organization_membership WHERE account_id = ?`,
      [accountId],
    );
    for (const membership of memberships) {
      if (!ownership.membershipIds.includes(membership.id)) {
        recordOwnedResource(ownership, 'membership', membership.id, {
          organizationId: membership.organization_id,
          accountId: membership.account_id,
          memberRole: membership.member_role,
          status: membership.status,
        });
      }
    }
    updateOwnedExpectation(ownership, 'account', accountId, {
      customerOrganizationId: organizationId,
    });
    return organizationId;
  };

  // ---------------------------------------------------------------------------
  // 选择受管候选（组内顺序依赖：本组第一条成功后，后续用例以已归属为前提）
  // ---------------------------------------------------------------------------

  describe('缺归属客户选择受管候选', () => {
    it('写入 FK 与 1 条 CUSTOMER 关系，且不新增公司行', async () => {
      expect(await readCustomerOrganizationId(alphaAccountId)).toBeNull();
      expect(await countActiveMemberships(alphaAccountId)).toBe(0);
      const organizationsBefore = await countOrganizations();

      const body = await supplement(alphaToken, { organizationId: managedCompanyAId });

      expect(body.errors).toBeUndefined();
      const payload = body.data?.supplementMyCustomerCompany;
      expect(payload).toBeDefined();
      expect(payload!.isUpdated).toBe(true);
      expect(payload!.sameNamedCompanyName).toBeNull();
      expect(payload!.settings.role).toBe(IdentityTypeEnum.CUSTOMER);
      expect(payload!.settings.trustedCompanyName).toBe(MANAGED_COMPANIES[0].name);
      // 旧展示字段 company_name 不参与绑定，也不被补录写入
      expect(payload!.settings.companyName).toBeNull();

      expect(await readCustomerOrganizationId(alphaAccountId)).toBe(managedCompanyAId);
      expect(await countActiveMemberships(alphaAccountId)).toBe(1);
      const membershipRows = await dataSource.query<
        Array<{ organization_id: number; member_role: string; status: string }>
      >(
        `SELECT organization_id, member_role, status
           FROM organization_membership WHERE account_id = ?`,
        [alphaAccountId],
      );
      expect(membershipRows).toEqual([
        {
          organization_id: managedCompanyAId,
          member_role: IdentityTypeEnum.CUSTOMER,
          status: 'ACTIVE',
        },
      ]);
      expect(await countOrganizations()).toBe(organizationsBefore);

      await registerBusinessWrittenCompany(alphaAccountId);
    });

    it('已归属客户改选其他候选：CONFLICT 且零写入', async () => {
      const membershipsBefore = await countActiveMemberships(alphaAccountId);
      const organizationsBefore = await countOrganizations();

      const body = await supplement(alphaToken, { organizationId: managedCompanyBId });

      expect(body.errors).toHaveLength(1);
      expect(body.errors![0].extensions?.code).toBe('CONFLICT');
      expect(body.errors![0].extensions?.errorCode).toBe(
        'MY_ACCOUNT_CUSTOMER_COMPANY_ALREADY_BOUND',
      );

      expect(await readCustomerOrganizationId(alphaAccountId)).toBe(managedCompanyAId);
      expect(await countActiveMemberships(alphaAccountId)).toBe(membershipsBefore);
      expect(await countOrganizations()).toBe(organizationsBefore);
    });

    it('已归属客户重复提交同一候选：幂等 isUpdated=false 且无新增行', async () => {
      const membershipsBefore = await countActiveMemberships(alphaAccountId);
      const organizationsBefore = await countOrganizations();

      const body = await supplement(alphaToken, { organizationId: managedCompanyAId });

      expect(body.errors).toBeUndefined();
      const payload = body.data?.supplementMyCustomerCompany;
      expect(payload!.isUpdated).toBe(false);
      expect(payload!.settings.trustedCompanyName).toBe(MANAGED_COMPANIES[0].name);

      expect(await readCustomerOrganizationId(alphaAccountId)).toBe(managedCompanyAId);
      expect(await countActiveMemberships(alphaAccountId)).toBe(membershipsBefore);
      expect(await countOrganizations()).toBe(organizationsBefore);
    });

    it('补录成功后新增报修成功，工单归属新公司', async () => {
      const body = await createRepairRequest(alphaToken, {
        equipmentModelId,
        errorCode: REPAIR_ERROR_CODE,
        faultDescription: REPAIR_FAULT_DESCRIPTION,
      });

      expect(body.errors).toBeUndefined();
      const created = body.data?.createRepairRequest;
      expect(created?.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);

      const rows = await dataSource.query<
        Array<{ owner_organization_id: number | null; customer_account_id: number }>
      >('SELECT owner_organization_id, customer_account_id FROM repair_request WHERE id = ?', [
        created!.id,
      ]);
      expect(rows[0].customer_account_id).toBe(alphaAccountId);
      expect(rows[0].owner_organization_id).toBe(managedCompanyAId);

      recordOwnedResource(ownership, 'repairRequest', created!.id, {
        requestNo: created!.requestNo,
        customerAccountId: alphaAccountId,
        equipmentModelId,
        errorCode: REPAIR_ERROR_CODE,
        faultDescription: REPAIR_FAULT_DESCRIPTION,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 手填公司
  // ---------------------------------------------------------------------------

  describe('缺归属客户手填公司', () => {
    it('新建启用且未受管的公司，并把 FK 指向新公司', async () => {
      expect(await readCustomerOrganizationId(betaAccountId)).toBeNull();
      const organizationsBefore = await countOrganizations();

      const body = await supplement(betaToken, { organizationName: SELF_FILLED_COMPANY_NAME });

      expect(body.errors).toBeUndefined();
      const payload = body.data?.supplementMyCustomerCompany;
      expect(payload!.isUpdated).toBe(true);
      expect(payload!.sameNamedCompanyName).toBeNull();
      expect(payload!.settings.trustedCompanyName).toBe(SELF_FILLED_COMPANY_NAME);

      const organizationId = await readCustomerOrganizationId(betaAccountId);
      expect(organizationId).not.toBeNull();
      expect(organizationId).not.toBe(managedCompanyAId);

      const row = await readOrganizationRow(organizationId!);
      expect(row.name).toBe(SELF_FILLED_COMPANY_NAME);
      expect(row.kind).toBe('CLIENT');
      expect(row.status).toBe('ACTIVE');
      expect(Number(row.is_managed_company)).toBe(0);
      expect(Number(row.is_service_provider)).toBe(0);
      expect(await countOrganizations()).toBe(organizationsBefore + 1);
      expect(await countActiveMemberships(betaAccountId)).toBe(1);

      await registerBusinessWrittenCompany(betaAccountId);
    });
  });

  // ---------------------------------------------------------------------------
  // 非客户角色
  // ---------------------------------------------------------------------------

  describe('非 CUSTOMER 角色', () => {
    it('工程师补录被拒：FORBIDDEN 且零写入', async () => {
      const staffAccountId = await getAccountIdByLoginName(
        dataSource,
        testAccountsConfig.staff.loginName,
      );
      const organizationsBefore = await countOrganizations();

      const body = await supplement(engineerToken, { organizationName: '工程师自建公司' });

      expect(body.errors).toHaveLength(1);
      expect(body.errors![0].extensions?.code).toBe('FORBIDDEN');
      expect(body.errors![0].extensions?.errorCode).toBe('INSUFFICIENT_PERMISSIONS');

      expect(await readCustomerOrganizationId(staffAccountId)).toBeNull();
      expect(await countActiveMemberships(staffAccountId)).toBe(0);
      expect(await countOrganizations()).toBe(organizationsBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // 非法组织与互斥输入（同一客户全部失败，故始终缺归属）
  // ---------------------------------------------------------------------------

  describe('停用 / 未受管 / 伪造公司与互斥输入', () => {
    it.each([
      { title: '停用组织', resolveOrganizationId: () => disabledCompanyId },
      { title: '未受管组织', resolveOrganizationId: () => unmanagedCompanyId },
      { title: '伪造 organizationId', resolveOrganizationId: () => 987654321 },
    ])('$title 被拒为 BAD_USER_INPUT 且零写入', async ({ resolveOrganizationId }) => {
      const organizationsBefore = await countOrganizations();

      const body = await supplement(invalidToken, {
        organizationId: resolveOrganizationId(),
      });

      expect(body.errors).toHaveLength(1);
      expect(body.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors![0].extensions?.errorCode).toBe('ACCOUNT_ORGANIZATION_NOT_AVAILABLE');

      expect(await readCustomerOrganizationId(invalidAccountId)).toBeNull();
      expect(await countActiveMemberships(invalidAccountId)).toBe(0);
      expect(await countOrganizations()).toBe(organizationsBefore);
    });

    it('同时提交 organizationId 与 organizationName：BAD_USER_INPUT 且零写入', async () => {
      const body = await supplement(invalidToken, {
        organizationId: managedCompanyAId,
        organizationName: 'S4 互斥公司',
      });

      expect(body.errors).toHaveLength(1);
      expect(body.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors![0].message).toContain('二者不能同时提交');
      expect(await readCustomerOrganizationId(invalidAccountId)).toBeNull();
      expect(await countActiveMemberships(invalidAccountId)).toBe(0);
    });

    it('两者都不提交：BAD_USER_INPUT 且零写入', async () => {
      const body = await supplement(invalidToken, {});

      expect(body.errors).toHaveLength(1);
      expect(body.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors![0].message).toContain('请选择名单内公司或填写公司名称');
      expect(await readCustomerOrganizationId(invalidAccountId)).toBeNull();
    });

    it('手填公司名超过 100 字符：BAD_USER_INPUT 且零写入', async () => {
      const body = await supplement(invalidToken, { organizationName: '长'.repeat(101) });

      expect(body.errors).toHaveLength(1);
      expect(body.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors![0].message).toContain('公司名称不能超过 100 个字符');
      expect(await readCustomerOrganizationId(invalidAccountId)).toBeNull();
      expect(await countActiveMemberships(invalidAccountId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 并发：同一账号两个不同候选
  // ---------------------------------------------------------------------------

  describe('并发补录', () => {
    it('两个不同候选并行提交：仅一个落库，另一个 CONFLICT，公司行不新增', async () => {
      const organizationsBefore = await countOrganizations();

      const [first, second] = await Promise.all([
        supplement(concurrentToken, { organizationId: managedCompanyAId }),
        supplement(concurrentToken, { organizationId: managedCompanyBId }),
      ]);

      const succeeded = [first, second].filter(
        (body) => body.errors === undefined && body.data?.supplementMyCustomerCompany?.isUpdated,
      );
      const rejected = [first, second].filter((body) => body.errors !== undefined);
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].errors![0].extensions?.code).toBe('CONFLICT');
      expect(rejected[0].errors![0].extensions?.errorCode).toBe(
        'MY_ACCOUNT_CUSTOMER_COMPANY_ALREADY_BOUND',
      );

      const organizationId = await readCustomerOrganizationId(concurrentAccountId);
      expect([managedCompanyAId, managedCompanyBId]).toContain(organizationId);
      expect(await countActiveMemberships(concurrentAccountId)).toBe(1);
      expect(await countOrganizations()).toBe(organizationsBefore);

      await registerBusinessWrittenCompany(concurrentAccountId);
    });
  });

  // ---------------------------------------------------------------------------
  // 报修门禁与历史读取（缺归属客户）
  // ---------------------------------------------------------------------------

  describe('缺归属客户的报修门禁与历史读取', () => {
    it('新增报修被拒为 FORBIDDEN（CUSTOMER_COMPANY_REQUIRED）且零申请', async () => {
      const requestsBefore = await countCustomerRepairRequests(repairAccountId);

      const body = await createRepairRequest(repairToken, {
        equipmentModelId,
        errorCode: REPAIR_ERROR_CODE,
        faultDescription: '缺归属时提交的维修申请',
      });

      expect(body.errors).toHaveLength(1);
      expect(body.errors![0].extensions?.code).toBe('FORBIDDEN');
      expect(body.errors![0].extensions?.errorCode).toBe(
        'REPAIR_REQUEST_CUSTOMER_COMPANY_REQUIRED',
      );
      expect(await countCustomerRepairRequests(repairAccountId)).toBe(requestsBefore);
      expect(await readCustomerOrganizationId(repairAccountId)).toBeNull();
    });

    it('缺归属客户仍可读取本人历史申请列表与详情', async () => {
      const listBody = await gql<{ myRepairRequests?: MyRepairRequestsPayload }>({
        query: MY_REPAIR_REQUESTS_QUERY,
        variables: { pagination: OFFSET_PAGINATION },
        token: repairToken,
      });
      expect(listBody.errors).toBeUndefined();
      const page = listBody.data!.myRepairRequests!;
      expect(page.total).toBe(1);
      expect(page.items.map((item) => item.id)).toEqual([legacyRequestId]);
      expect(page.items[0].requestNo).toBe(legacyRequestNo);

      const detailBody = await gql<{ myRepairRequest?: { id: number; requestNo: string } }>({
        query: MY_REPAIR_REQUEST_QUERY,
        variables: { id: legacyRequestId },
        token: repairToken,
      });
      expect(detailBody.errors).toBeUndefined();
      expect(detailBody.data!.myRepairRequest).toEqual({
        id: legacyRequestId,
        requestNo: legacyRequestNo,
      });
    });
  });
});
