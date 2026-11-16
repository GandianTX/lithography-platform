// test/13-admin-organization/admin-organization-management.e2e-spec.ts

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { useContainer } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import { seedTestMemberships } from '../utils/test-organizations';

/**
 * S2 · 一级管理员公司档案完整读写（真实 GraphQL + MySQL）。
 *
 * 覆盖：
 * 1. 一级新增 / 详情 / 列表回读一致，关键字与状态筛选；
 * 2. 一级编辑只改白名单字段，编号与受管归类不变，可选字段清空，启停与维修资格分别写入；
 * 3. 同名两次新增得到两个独立公司，不做合并；
 * 4. 停用后注册候选、报修候选、名称名单同步消失；既有成员关系与在办工单仍指向原公司且未被改写；
 * 5. 二级管理员与普通客户对四个一级入口一律 FORBIDDEN，二级仍可用名称名单；
 * 6. 伪造 `organizationCode` 字段被 GraphQL 校验拒绝，库内编号与受管归类不变；
 * 7. 非法输入与不存在目标不留下幽灵行；
 * 8. 非本轮前缀的哨兵组织在清理后保持原值。
 */
describe('一级管理员公司档案 adminOrganization* (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let organizationRepository: Repository<OrganizationEntity>;
  let accountRepository: Repository<AccountEntity>;
  let membershipRepository: Repository<OrganizationMembershipEntity>;
  let equipmentModelRepository: Repository<EquipmentModelEntity>;
  let repairRequestRepository: Repository<RepairRequestEntity>;

  const RUN_TAG = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const CODE_PREFIX = `E2E_ADMORG_${RUN_TAG}_`;
  const NAME_PREFIX = `E2E-ADMORG-${RUN_TAG}-`;
  const SENTINEL_CODE = `E2E_ADMORG_SENTINEL_${RUN_TAG}`;
  const SENTINEL_NAME = `E2E-ADMORG-${RUN_TAG}-哨兵公司`;
  const REPAIR_ERROR_CODE = 'E-ADMORG-01';
  const REPAIR_FAULT_DESCRIPTION = `${NAME_PREFIX}停用前在办工单`;
  const DEFAULT_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 50 } as const;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();

  let levelOneToken: string;
  let levelTwoToken: string;
  let customerToken: string;
  let repairCustomerToken: string;

  let managedOrgId: number;
  let unmanagedOrgId: number;
  let disabledOrgId: number;
  let customerOrgId: number;
  let guestAccountId: number;
  let repairRequestId = 0;
  /** 停用前快照：停用后逐字段比对，证明历史关联未被级联改写 */
  let repairRequestBaseline: {
    requestNo: string;
    customerAccountId: number;
    ownerOrganizationId: number | null;
    equipmentModelId: number;
    errorCode: string;
    faultDescription: string;
    contentMd: string;
    isAccepted: boolean;
    deprecated: boolean;
  } | null = null;

  type GqlError = { message: string; extensions?: { code?: string } };
  type AdminOrganization = {
    id: number;
    organizationCode: string;
    name: string;
    shortName: string | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    address: string | null;
    remark: string | null;
    isServiceProvider: boolean;
    isManagedCompany: boolean;
    kind: string;
    status: string;
  };
  type MutationBody = { data?: Record<string, AdminOrganization>; errors?: GqlError[] };
  type ListBody = {
    data?: {
      adminOrganizationList?: {
        items: AdminOrganization[];
        total: number;
        page: number;
        pageSize: number;
      };
      adminOrganizationDetail?: AdminOrganization;
      adminOrganizationNameList?: { items: Array<{ id: number; name: string }> };
      registrationOrganizationSearch?: { items: Array<{ id: number; name: string }> };
      repairServiceOrganizationSearch?: { items: Array<{ id: number; name: string }> };
    };
    errors?: GqlError[];
  };

  type BooleanBody = {
    data?: { adminOrganizationNameExists?: boolean };
    errors?: GqlError[];
  };

  type RepairRequestCreated = { id: number; requestNo: string; isAccepted: boolean };
  type RepairRequestMutationBody = {
    data?: { createRepairRequest?: RepairRequestCreated };
    errors?: GqlError[];
  };
  type MyRepairListBody = {
    data?: {
      myRepairRequests?: { items: Array<{ id: number; requestNo: string }>; total: number };
    };
    errors?: GqlError[];
  };

  const ADMIN_ORGANIZATION_FIELDS = `
    id organizationCode name shortName contactName contactPhone contactEmail
    address remark isServiceProvider isManagedCompany kind status
  `;

  const CREATE_REPAIR_REQUEST_MUTATION = `
    mutation CreateRepairRequest($input: CreateRepairRequestInput!) {
      createRepairRequest(input: $input) {
        id
        requestNo
        isAccepted
      }
    }
  `;

  const MY_REPAIR_REQUESTS_QUERY = `
    query MyRepairRequests($pagination: PaginationArgs!) {
      myRepairRequests(pagination: $pagination) {
        items { id requestNo }
        total
      }
    }
  `;

  const createFixtureOrganization = async (params: {
    codeSuffix: string;
    name: string;
    status?: 'ACTIVE' | 'DISABLED';
    isManagedCompany: boolean;
    isServiceProvider: boolean;
  }): Promise<number> => {
    const organizationCode = `${CODE_PREFIX}${params.codeSuffix}`;
    const status = params.status ?? 'ACTIVE';
    const saved = await organizationRepository.save(
      organizationRepository.create({
        organizationCode,
        name: params.name,
        kind: 'CLIENT',
        status,
        isManagedCompany: params.isManagedCompany,
        isServiceProvider: params.isServiceProvider,
      }),
    );
    recordOwnedResource(ownership, 'organization', saved.id, {
      organizationCode,
      name: params.name,
      kind: 'CLIENT',
      status,
      isManagedCompany: params.isManagedCompany,
    });
    return saved.id;
  };

  const listOrganizations = (params: {
    token?: string;
    keyword?: string | null;
    status?: string | null;
    pagination?: unknown;
  }) =>
    postGql({
      app,
      token: params.token,
      query: `
        query AdminOrganizationList(
          $pagination: PaginationArgs!
          $keyword: String
          $status: OrganizationStatus
        ) {
          adminOrganizationList(pagination: $pagination, keyword: $keyword, status: $status) {
            items { ${ADMIN_ORGANIZATION_FIELDS} }
            total
            page
            pageSize
          }
        }
      `,
      variables: {
        pagination: params.pagination ?? { mode: 'OFFSET', page: 1, pageSize: 20 },
        keyword: params.keyword ?? null,
        status: params.status ?? null,
      },
    });

  const detailOrganization = (params: { token?: string; organizationId: number }) =>
    postGql({
      app,
      token: params.token,
      query: `
        query AdminOrganizationDetail($organizationId: Int!) {
          adminOrganizationDetail(organizationId: $organizationId) { ${ADMIN_ORGANIZATION_FIELDS} }
        }
      `,
      variables: { organizationId: params.organizationId },
    });

  const createOrganization = (params: {
    token?: string;
    name: string;
    contactPhone?: string;
    isServiceProvider?: boolean;
    extraInput?: Record<string, unknown>;
  }) =>
    postGql({
      app,
      token: params.token,
      query: `
        mutation AdminCreateOrganization($input: AdminCreateOrganizationInput!) {
          adminCreateOrganization(input: $input) { ${ADMIN_ORGANIZATION_FIELDS} }
        }
      `,
      variables: {
        input: {
          name: params.name,
          contactPhone: params.contactPhone ?? '021-00000000',
          isServiceProvider: params.isServiceProvider,
          ...(params.extraInput ?? {}),
        },
      },
    });

  const updateOrganization = (params: { token?: string; input: Record<string, unknown> }) =>
    postGql({
      app,
      token: params.token,
      query: `
        mutation AdminUpdateOrganization($input: AdminUpdateOrganizationInput!) {
          adminUpdateOrganization(input: $input) { ${ADMIN_ORGANIZATION_FIELDS} }
        }
      `,
      variables: { input: params.input },
    });

  const nameList = (params: { token?: string; keyword?: string | null }) =>
    postGql({
      app,
      token: params.token,
      query: `
        query AdminOrganizationNameList($pagination: PaginationArgs!, $keyword: String) {
          adminOrganizationNameList(pagination: $pagination, keyword: $keyword) {
            items { id name }
          }
        }
      `,
      variables: {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 50 },
        keyword: params.keyword ?? null,
      },
    });

  const registrationSearch = (keyword: string) =>
    postGql({
      app,
      query: `
        query RegistrationOrganizationSearch($pagination: PaginationArgs!, $keyword: String) {
          registrationOrganizationSearch(pagination: $pagination, keyword: $keyword) {
            items { id name }
          }
        }
      `,
      variables: { pagination: { mode: 'OFFSET', page: 1, pageSize: 50 }, keyword },
    });

  const repairServiceSearch = (params: { token: string; keyword: string }) =>
    postGql({
      app,
      token: params.token,
      query: `
        query RepairServiceOrganizationSearch($pagination: PaginationArgs!, $keyword: String) {
          repairServiceOrganizationSearch(pagination: $pagination, keyword: $keyword) {
            items { id name }
          }
        }
      `,
      variables: { pagination: { mode: 'OFFSET', page: 1, pageSize: 50 }, keyword: params.keyword },
    });

  const adminNameExists = (params: {
    token?: string;
    name: string;
    excludeOrganizationId?: number;
  }) =>
    postGql({
      app,
      token: params.token,
      query: `
        query AdminOrganizationNameExists($name: String!, $excludeOrganizationId: Int) {
          adminOrganizationNameExists(name: $name, excludeOrganizationId: $excludeOrganizationId)
        }
      `,
      variables: {
        name: params.name,
        excludeOrganizationId: params.excludeOrganizationId ?? null,
      },
    });

  /** 把新增成功返回的真实公司登记进台账（事实取服务端回读值，不取请求入参） */
  const trackCreatedOrganization = (organization: AdminOrganization): void => {
    recordOwnedResource(ownership, 'organization', organization.id, {
      organizationCode: organization.organizationCode,
      name: organization.name,
      kind: organization.kind,
      status: organization.status,
      isManagedCompany: organization.isManagedCompany,
    });
  };

  const countByExactName = (name: string): Promise<number> =>
    organizationRepository.count({ where: { name } });

  const countByPrefix = (): Promise<number> =>
    organizationRepository
      .createQueryBuilder('organization')
      .where('organization.name LIKE :prefix', { prefix: `${NAME_PREFIX}%` })
      .getCount();

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    useContainer(app.select(ApiModule), { fallbackOnErrors: true });
    dataSource = moduleFixture.get<DataSource>(DataSource);
    organizationRepository = dataSource.getRepository(OrganizationEntity);
    accountRepository = dataSource.getRepository(AccountEntity);
    membershipRepository = dataSource.getRepository(OrganizationMembershipEntity);
    equipmentModelRepository = dataSource.getRepository(EquipmentModelEntity);
    repairRequestRepository = dataSource.getRepository(RepairRequestEntity);
    await app.init();

    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin', 'peerAdmin', 'guest', 'guestPrimary'],
      ownership,
    });

    managedOrgId = await createFixtureOrganization({
      codeSuffix: 'MANAGED',
      name: `${NAME_PREFIX}受管维修公司`,
      isManagedCompany: true,
      isServiceProvider: true,
    });
    unmanagedOrgId = await createFixtureOrganization({
      codeSuffix: 'UNMANAGED',
      name: `${NAME_PREFIX}非受管公司`,
      isManagedCompany: false,
      isServiceProvider: false,
    });
    disabledOrgId = await createFixtureOrganization({
      codeSuffix: 'DISABLED',
      name: `${NAME_PREFIX}已停用公司`,
      status: 'DISABLED',
      isManagedCompany: true,
      isServiceProvider: true,
    });
    // 报修候选用例的客户自有公司：与本轮停用的受管公司分离，避免停用后可信公司解析失配
    customerOrgId = await createFixtureOrganization({
      codeSuffix: 'CUSTOMER',
      name: `${NAME_PREFIX}客户公司`,
      isManagedCompany: false,
      isServiceProvider: false,
    });

    // 二级管理员可信公司归属；客户成员关系用于报修候选资格与「停用不级联改写关联行」
    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: new Map([
        [`${CODE_PREFIX}UNMANAGED`, unmanagedOrgId],
        [`${CODE_PREFIX}MANAGED`, managedOrgId],
        [`${CODE_PREFIX}CUSTOMER`, customerOrgId],
      ]),
      memberships: [
        {
          accountLoginName: testAccountsConfig.peerAdmin.loginName,
          organizationCode: `${CODE_PREFIX}UNMANAGED`,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: testAccountsConfig.guest.loginName,
          organizationCode: `${CODE_PREFIX}MANAGED`,
          memberRole: 'CUSTOMER',
        },
        {
          accountLoginName: testAccountsConfig.guestPrimary.loginName,
          organizationCode: `${CODE_PREFIX}CUSTOMER`,
          memberRole: 'CUSTOMER',
        },
      ],
      ownership,
    });

    const guest = await accountRepository.findOneOrFail({
      where: { loginName: testAccountsConfig.guest.loginName },
    });
    guestAccountId = guest.id;

    const levelOne = await accountRepository.findOneOrFail({
      where: { loginName: testAccountsConfig.admin.loginName },
    });
    await accountRepository.update(levelOne.id, { adminLevel: 1 });
    const levelTwo = await accountRepository.findOneOrFail({
      where: { loginName: testAccountsConfig.peerAdmin.loginName },
    });
    await accountRepository.update(levelTwo.id, { adminLevel: 2 });

    // 报修候选准入要求客户已补齐可信公司归属（base_user_info.customer_organization_id）；
    // 归属指向独立客户公司，避免与本轮被停用的受管公司耦合。
    // 资料表主键是 `id`，`account_id` 是独立列：这里显式按 `accountId` 条件更新。
    const userInfoRepository = dataSource.getRepository(UserInfoEntity);
    const repairCustomerInfo = await userInfoRepository.findOneOrFail({
      where: { email: testAccountsConfig.guestPrimary.loginEmail },
    });

    // 构造可区分的 `id != account_id` 场景：两者相同（对齐自增）时把资料主键移到高位，
    // 使旧实现 `update(accountId, ...)`（按主键选择）必然命中 0 行，回归稳定变红。
    // 迁移只发生在本轮自有资料行上，清理按 account_id 删除，无需恢复旧主键。
    if (repairCustomerInfo.id === repairCustomerInfo.accountId) {
      const [{ nextId }] = await dataSource.query(
        'SELECT MAX(id) + 1000 AS nextId FROM base_user_info',
      );

      await dataSource.query('UPDATE base_user_info SET id = ? WHERE id = ?', [
        Number(nextId),
        repairCustomerInfo.id,
      ]);

      repairCustomerInfo.id = Number(nextId);
    }

    expect(repairCustomerInfo.id).not.toBe(repairCustomerInfo.accountId);

    const repairCustomerUpdate = await userInfoRepository.update(
      { accountId: repairCustomerInfo.accountId },
      { customerOrganizationId: customerOrgId },
    );

    expect(repairCustomerUpdate.affected).toBe(1);

    const repairCustomerInfoReloaded = await userInfoRepository.findOneOrFail({
      where: { accountId: repairCustomerInfo.accountId },
    });

    expect(repairCustomerInfoReloaded.id).toBe(repairCustomerInfo.id);
    expect(repairCustomerInfoReloaded.customerOrganizationId).toBe(customerOrgId);
    updateOwnedExpectation(ownership, 'account', repairCustomerInfo.accountId, {
      customerOrganizationId: customerOrgId,
    });

    levelOneToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    levelTwoToken = await login({
      app,
      loginName: testAccountsConfig.peerAdmin.loginName,
      loginPassword: testAccountsConfig.peerAdmin.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: testAccountsConfig.guest.loginName,
      loginPassword: testAccountsConfig.guest.loginPassword,
    });
    repairCustomerToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;
        await runGuardedSpecCleanup({
          dataSource,
          helper: 'admin-organization-management.e2e',
          owned: ownership,
        });
      },
      finalize: async () => {
        if (!dataSource?.isInitialized) return;
        // 本轮前缀不残留（含失败请求与成功请求创建的全部公司）
        const residue = await organizationRepository
          .createQueryBuilder('organization')
          .where('organization.organization_code LIKE :prefix', { prefix: `${CODE_PREFIX}%` })
          .getCount();
        expect(residue).toBe(0);

        // 合成哨兵：不在台账内，清理后必须原值不变；核验后再显式回收
        const sentinel = await organizationRepository.findOne({
          where: { organizationCode: SENTINEL_CODE },
        });
        expect(sentinel).not.toBeNull();
        expect(sentinel?.name).toBe(SENTINEL_NAME);
        expect(sentinel?.status).toBe('ACTIVE');
        expect(sentinel?.isManagedCompany).toBe(false);
        if (sentinel) {
          await organizationRepository.delete({ id: sentinel.id });
        }
      },
      closeApp: app
        ? async () => {
            await app.close();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        : null,
    });
  });

  it('未登录、二级管理员与普通客户调用一级入口一律拒绝', async () => {
    // 逐个发起：并发裸请求在 supertest 上会互相干扰（ECONNRESET），与本用例断言无关
    const anonymousList = (await listOrganizations({})).body as ListBody;
    expect(anonymousList.errors?.[0]?.extensions?.code).toBeDefined();
    expect(anonymousList.data?.adminOrganizationList).toBeUndefined();

    const anonymousDetail = (await detailOrganization({ organizationId: managedOrgId }))
      .body as ListBody;
    expect(anonymousDetail.errors?.[0]?.extensions?.code).toBeDefined();
    expect(anonymousDetail.data?.adminOrganizationDetail).toBeUndefined();

    const levelTwoList = (await listOrganizations({ token: levelTwoToken })).body as ListBody;
    expect(levelTwoList.errors?.[0]?.extensions?.code).toBeDefined();
    expect(levelTwoList.data?.adminOrganizationList).toBeUndefined();

    const customerList = (await listOrganizations({ token: customerToken })).body as ListBody;
    expect(customerList.errors?.[0]?.extensions?.code).toBeDefined();
    expect(customerList.data?.adminOrganizationList).toBeUndefined();

    const levelTwoDetail = (
      await detailOrganization({ token: levelTwoToken, organizationId: managedOrgId })
    ).body as ListBody;
    expect(levelTwoDetail.data?.adminOrganizationDetail).toBeUndefined();

    const listForbidden = (await listOrganizations({ token: levelTwoToken })).body as ListBody;
    expect(listForbidden.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    const detailForbidden = (
      await detailOrganization({ token: levelTwoToken, organizationId: managedOrgId })
    ).body as ListBody;
    expect(detailForbidden.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    for (const token of [levelTwoToken, customerToken]) {
      const created = (await createOrganization({ token, name: `${NAME_PREFIX}越权新增` }))
        .body as MutationBody;
      expect(created.data?.adminCreateOrganization).toBeUndefined();
      expect(created.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

      const updated = (
        await updateOrganization({
          token,
          input: { organizationId: managedOrgId, name: '越权改名' },
        })
      ).body as MutationBody;
      expect(updated.data?.adminUpdateOrganization).toBeUndefined();
      expect(updated.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

      // 同名提示同属一级入口：二级与普通客户一律拒绝，不暴露存档范围
      const checked = (await adminNameExists({ token, name: `${NAME_PREFIX}受管维修公司` }))
        .body as BooleanBody;
      expect(checked.data?.adminOrganizationNameExists).toBeUndefined();
      expect(checked.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }

    // 二级仍可使用最小名称名单
    const names = (await nameList({ token: levelTwoToken, keyword: NAME_PREFIX })).body as ListBody;
    expect(names.errors).toBeUndefined();
    expect(names.data?.adminOrganizationNameList?.items.map((item) => item.name)).toEqual([
      `${NAME_PREFIX}受管维修公司`,
      `${NAME_PREFIX}客户公司`,
      `${NAME_PREFIX}非受管公司`,
    ]);
  });

  it('一级新增：编号服务端生成、强制受管、初始启用，详情与列表回读一致', async () => {
    const name = `${NAME_PREFIX}新增公司`;
    const body = (
      await createOrganization({
        token: levelOneToken,
        name: `  ${name}  `,
        contactPhone: ' 021-88886666 ',
        isServiceProvider: true,
      })
    ).body as MutationBody;
    expect(body.errors).toBeUndefined();
    const created = body.data?.adminCreateOrganization;
    expect(created).toBeDefined();
    trackCreatedOrganization(created as AdminOrganization);

    expect(created?.name).toBe(name);
    expect(created?.contactPhone).toBe('021-88886666');
    expect(created?.organizationCode).toMatch(/^ADMIN_ORG_[0-9a-f-]{36}$/);
    expect(created?.isManagedCompany).toBe(true);
    expect(created?.status).toBe('ACTIVE');
    expect(created?.kind).toBe('CLIENT');
    expect(created?.isServiceProvider).toBe(true);

    const detail = (await detailOrganization({ token: levelOneToken, organizationId: created!.id }))
      .body as ListBody;
    expect(detail.errors).toBeUndefined();
    expect(detail.data?.adminOrganizationDetail).toMatchObject({
      id: created!.id,
      name,
      organizationCode: created!.organizationCode,
      isManagedCompany: true,
      status: 'ACTIVE',
    });

    const list = (
      await listOrganizations({ token: levelOneToken, keyword: name, status: 'ACTIVE' })
    ).body as ListBody;
    expect(list.errors).toBeUndefined();
    expect(list.data?.adminOrganizationList?.items.map((item) => item.id)).toEqual([created!.id]);
  });

  it('一级新增：显式状态与维修资格组合一次落定，停用公司不进入注册与维修候选', async () => {
    const combos = [
      { suffix: 'ACTIVE_SERVICE', status: 'ACTIVE', isServiceProvider: true },
      { suffix: 'ACTIVE_PLAIN', status: 'ACTIVE', isServiceProvider: false },
      { suffix: 'DISABLED_SERVICE', status: 'DISABLED', isServiceProvider: true },
      { suffix: 'DISABLED_PLAIN', status: 'DISABLED', isServiceProvider: false },
    ] as const;

    const createdIds = new Map<string, number>();
    for (const combo of combos) {
      const name = `${NAME_PREFIX}组合-${combo.suffix}`;
      const body = (
        await createOrganization({
          token: levelOneToken,
          name,
          isServiceProvider: combo.isServiceProvider,
          extraInput: { status: combo.status },
        })
      ).body as MutationBody;
      expect(body.errors).toBeUndefined();
      const created = body.data?.adminCreateOrganization as AdminOrganization;
      trackCreatedOrganization(created);
      createdIds.set(combo.suffix, created.id);

      // 返回与实库回读双向一致：状态在同一次创建中落定，维修资格独立保存
      expect(created.status).toBe(combo.status);
      expect(created.isServiceProvider).toBe(combo.isServiceProvider);
      expect(created.isManagedCompany).toBe(true);
      const row = await organizationRepository.findOneOrFail({ where: { id: created.id } });
      expect(row.status).toBe(combo.status);
      expect(row.isServiceProvider).toBe(combo.isServiceProvider);
    }

    // 注册候选：只有启用且受管的公司可见（维修资格不参与）
    const registration = (await registrationSearch(`${NAME_PREFIX}组合-`)).body as ListBody;
    expect(registration.errors).toBeUndefined();
    const registrationIds = registration.data?.registrationOrganizationSearch?.items.map(
      (item) => item.id,
    );
    expect(registrationIds).toEqual(
      expect.arrayContaining([createdIds.get('ACTIVE_SERVICE'), createdIds.get('ACTIVE_PLAIN')]),
    );
    expect(registrationIds).not.toContain(createdIds.get('DISABLED_SERVICE'));
    expect(registrationIds).not.toContain(createdIds.get('DISABLED_PLAIN'));

    // 维修候选：启用且具备维修资格，停用公司即使有资格也不可报修
    const repair = (
      await repairServiceSearch({
        token: repairCustomerToken,
        keyword: `${NAME_PREFIX}组合-`,
      })
    ).body as ListBody;
    expect(repair.errors).toBeUndefined();
    const repairIds = repair.data?.repairServiceOrganizationSearch?.items.map((item) => item.id);
    expect(repairIds).toEqual(expect.arrayContaining([createdIds.get('ACTIVE_SERVICE')]));
    expect(repairIds).not.toContain(createdIds.get('ACTIVE_PLAIN'));
    expect(repairIds).not.toContain(createdIds.get('DISABLED_SERVICE'));
    expect(repairIds).not.toContain(createdIds.get('DISABLED_PLAIN'));
  });

  it('一级同名提示：覆盖停用与未受管档案，精确匹配且编辑排除自身', async () => {
    const disabledName = `${NAME_PREFIX}已停用公司`;
    const unmanagedName = `${NAME_PREFIX}非受管公司`;

    // 停用公司与未受管公司都计入一级管理档案范围
    expect(
      ((await adminNameExists({ token: levelOneToken, name: disabledName })).body as BooleanBody)
        .data?.adminOrganizationNameExists,
    ).toBe(true);
    expect(
      ((await adminNameExists({ token: levelOneToken, name: unmanagedName })).body as BooleanBody)
        .data?.adminOrganizationNameExists,
    ).toBe(true);

    // 归一化口径与注册一致：首尾空白（含 tab / 换行）不影响命中
    expect(
      (
        (
          await adminNameExists({
            token: levelOneToken,
            name: `\t ${disabledName}  \n`,
          })
        ).body as BooleanBody
      ).data?.adminOrganizationNameExists,
    ).toBe(true);

    // 编辑排除自身：只有自己一条同名时不再提示
    expect(
      (
        (
          await adminNameExists({
            token: levelOneToken,
            name: disabledName,
            excludeOrganizationId: disabledOrgId,
          })
        ).body as BooleanBody
      ).data?.adminOrganizationNameExists,
    ).toBe(false);

    // 子串不命中：不是 LIKE 前缀/子串匹配
    expect(
      (
        (
          await adminNameExists({
            token: levelOneToken,
            name: `${NAME_PREFIX}非受管`,
          })
        ).body as BooleanBody
      ).data?.adminOrganizationNameExists,
    ).toBe(false);

    // 空白名称直接未命中，不泄露任何档案
    expect(
      ((await adminNameExists({ token: levelOneToken, name: '   ' })).body as BooleanBody).data
        ?.adminOrganizationNameExists,
    ).toBe(false);
  });

  it('一级列表：关键字匹配编号与简称，状态与受管筛选生效', async () => {
    const byCode = (
      await listOrganizations({ token: levelOneToken, keyword: `${CODE_PREFIX}MANAGED` })
    ).body as ListBody;
    expect(byCode.data?.adminOrganizationList?.items.map((item) => item.id)).toEqual([
      managedOrgId,
    ]);

    const disabled = (
      await listOrganizations({ token: levelOneToken, keyword: NAME_PREFIX, status: 'DISABLED' })
    ).body as ListBody;
    const disabledIds = disabled.data?.adminOrganizationList?.items.map((item) => item.id);
    // 本轮停用夹具 + 新增组合里的两家停用公司；启用的公司一家都不能混进来
    expect(disabledIds).toEqual(expect.arrayContaining([disabledOrgId]));
    expect(disabledIds).not.toContain(managedOrgId);
    expect(disabledIds).not.toContain(unmanagedOrgId);

    const active = (
      await listOrganizations({ token: levelOneToken, keyword: NAME_PREFIX, status: 'ACTIVE' })
    ).body as ListBody;
    expect(active.data?.adminOrganizationList?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([managedOrgId, unmanagedOrgId, customerOrgId]),
    );

    const all = (await listOrganizations({ token: levelOneToken, keyword: NAME_PREFIX }))
      .body as ListBody;
    const page = all.data?.adminOrganizationList;
    // 三个夹具公司 + 上一用例新增 1 家，全部命中名称前缀
    expect(page?.total).toBeGreaterThanOrEqual(4);
    expect(page?.items.every((item) => item.name.startsWith(NAME_PREFIX))).toBe(true);
  });

  it('停用前建立在办工单基线：成员客户经真实 GraphQL 创建，归属为本轮受管公司', async () => {
    const model = await equipmentModelRepository.save(
      equipmentModelRepository.create({
        modelCode: `${CODE_PREFIX}MODEL`,
        modelName: `${NAME_PREFIX}在办工单机型`,
        sortOrder: 0,
        enabled: true,
      }),
    );
    recordOwnedResource(ownership, 'equipmentModel', model.id, {
      modelCode: model.modelCode,
      modelName: model.modelName,
      enabled: true,
      sortOrder: 0,
    });

    const created = (
      await postGql({
        app,
        query: CREATE_REPAIR_REQUEST_MUTATION,
        token: customerToken,
        variables: {
          input: {
            equipmentModelId: model.id,
            errorCode: REPAIR_ERROR_CODE,
            faultDescription: REPAIR_FAULT_DESCRIPTION,
          },
        },
      })
    ).body as RepairRequestMutationBody;

    expect(created.errors).toBeUndefined();
    const payload = created.data?.createRepairRequest;
    expect(payload).toBeDefined();

    repairRequestId = payload!.id;
    recordOwnedResource(ownership, 'repairRequest', repairRequestId, {
      requestNo: payload!.requestNo,
      customerAccountId: guestAccountId,
      equipmentModelId: model.id,
      errorCode: REPAIR_ERROR_CODE,
      faultDescription: REPAIR_FAULT_DESCRIPTION,
    });

    const row = await repairRequestRepository.findOneOrFail({ where: { id: repairRequestId } });
    // 组织归属来自可信成员关系（guest 属于本轮受管公司），不接受客户端传入
    expect(row.ownerOrganizationId).toBe(managedOrgId);
    repairRequestBaseline = {
      requestNo: row.requestNo,
      customerAccountId: row.customerAccountId,
      ownerOrganizationId: row.ownerOrganizationId,
      equipmentModelId: row.equipmentModelId,
      errorCode: row.errorCode,
      faultDescription: row.faultDescription,
      contentMd: row.contentMd,
      isAccepted: row.isAccepted,
      deprecated: row.deprecated,
    };

    const list = (
      await postGql({
        app,
        query: MY_REPAIR_REQUESTS_QUERY,
        token: customerToken,
        variables: { pagination: DEFAULT_PAGINATION },
      })
    ).body as MyRepairListBody;
    expect(list.errors).toBeUndefined();
    expect(list.data?.myRepairRequests?.items.map((item) => item.id)).toContain(repairRequestId);
  });

  it('一级编辑：只改白名单字段，编号与受管归类不变，可选字段可清空，启停与维修资格分别写入', async () => {
    const before = (
      await detailOrganization({ token: levelOneToken, organizationId: managedOrgId })
    ).body as ListBody;
    const origin = before.data?.adminOrganizationDetail as AdminOrganization;

    const updated = (
      await updateOrganization({
        token: levelOneToken,
        input: {
          organizationId: managedOrgId,
          name: `${NAME_PREFIX}受管维修公司（更名）`,
          contactName: '李四',
          contactEmail: 'ops@example.com',
          shortName: '  ',
          remark: '',
        },
      })
    ).body as MutationBody;
    expect(updated.errors).toBeUndefined();
    const afterEdit = updated.data?.adminUpdateOrganization as AdminOrganization;
    expect(afterEdit.name).toBe(`${NAME_PREFIX}受管维修公司（更名）`);
    expect(afterEdit.contactName).toBe('李四');
    expect(afterEdit.contactEmail).toBe('ops@example.com');
    expect(afterEdit.shortName).toBeNull();
    expect(afterEdit.remark).toBeNull();
    // 编号、受管归类与类别不可改
    expect(afterEdit.organizationCode).toBe(origin.organizationCode);
    expect(afterEdit.isManagedCompany).toBe(true);
    expect(afterEdit.kind).toBe('CLIENT');
    // 未传字段保持原值
    expect(afterEdit.contactPhone).toBe(origin.contactPhone);
    expect(afterEdit.isServiceProvider).toBe(origin.isServiceProvider);
    expect(afterEdit.status).toBe('ACTIVE');

    updateOwnedExpectation(ownership, 'organization', managedOrgId, {
      name: afterEdit.name,
    });

    // 停用 + 取消维修资格：两个字段各自独立写入，不被其它字段覆盖
    const toggled = (
      await updateOrganization({
        token: levelOneToken,
        input: { organizationId: managedOrgId, status: 'DISABLED', isServiceProvider: false },
      })
    ).body as MutationBody;
    expect(toggled.errors).toBeUndefined();
    const afterToggle = toggled.data?.adminUpdateOrganization as AdminOrganization;
    expect(afterToggle.status).toBe('DISABLED');
    expect(afterToggle.isServiceProvider).toBe(false);
    expect(afterToggle.name).toBe(afterEdit.name);

    updateOwnedExpectation(ownership, 'organization', managedOrgId, {
      status: 'DISABLED',
    });
  });

  it('同名两次新增得到两个独立公司，不做合并', async () => {
    const name = `${NAME_PREFIX}同名公司`;
    const first = (await createOrganization({ token: levelOneToken, name })).body as MutationBody;
    const second = (await createOrganization({ token: levelOneToken, name })).body as MutationBody;

    expect(first.errors).toBeUndefined();
    expect(second.errors).toBeUndefined();
    trackCreatedOrganization(first.data?.adminCreateOrganization as AdminOrganization);
    trackCreatedOrganization(second.data?.adminCreateOrganization as AdminOrganization);

    const firstOrg = first.data?.adminCreateOrganization as AdminOrganization;
    const secondOrg = second.data?.adminCreateOrganization as AdminOrganization;
    expect(firstOrg.id).not.toBe(secondOrg.id);
    expect(firstOrg.organizationCode).not.toBe(secondOrg.organizationCode);
    expect(await countByExactName(name)).toBe(2);
  });

  it('停用后注册候选、报修候选与名称名单同步消失，既有成员关系与在办工单仍指向原公司且未被改写', async () => {
    // managedOrgId 在上一用例已停用：三个读入口都不应再返回它
    const registration = (await registrationSearch(NAME_PREFIX)).body as ListBody;
    expect(registration.errors).toBeUndefined();
    expect(registration.data?.registrationOrganizationSearch?.items.map((i) => i.id)).not.toContain(
      managedOrgId,
    );

    const repair = (await repairServiceSearch({ token: repairCustomerToken, keyword: NAME_PREFIX }))
      .body as ListBody;
    expect(repair.errors).toBeUndefined();
    expect(repair.data?.repairServiceOrganizationSearch?.items.map((i) => i.id)).not.toContain(
      managedOrgId,
    );

    const names = (await nameList({ token: levelOneToken, keyword: NAME_PREFIX })).body as ListBody;
    expect(names.data?.adminOrganizationNameList?.items.map((i) => i.id)).not.toContain(
      managedOrgId,
    );

    // 停用不级联：客户成员关系仍指向原公司，角色与状态保持原值
    const membership = await membershipRepository.findOneOrFail({
      where: {
        accountId: (
          await accountRepository.findOneOrFail({
            where: { loginName: testAccountsConfig.guest.loginName },
          })
        ).id,
        organizationId: managedOrgId,
      },
    });
    expect(membership.organizationId).toBe(managedOrgId);
    expect(membership.memberRole).toBe('CUSTOMER');
    expect(membership.status).toBe('ACTIVE');

    // 停用不级联：停用前建立的工单逐字段保持原值，组织归属仍是原公司
    expect(repairRequestBaseline).not.toBeNull();
    const repairRow = await repairRequestRepository.findOneOrFail({
      where: { id: repairRequestId },
    });
    expect(repairRow.requestNo).toBe(repairRequestBaseline!.requestNo);
    expect(repairRow.customerAccountId).toBe(repairRequestBaseline!.customerAccountId);
    expect(repairRow.ownerOrganizationId).toBe(repairRequestBaseline!.ownerOrganizationId);
    expect(repairRow.ownerOrganizationId).toBe(managedOrgId);
    expect(repairRow.equipmentModelId).toBe(repairRequestBaseline!.equipmentModelId);
    expect(repairRow.errorCode).toBe(repairRequestBaseline!.errorCode);
    expect(repairRow.faultDescription).toBe(repairRequestBaseline!.faultDescription);
    expect(repairRow.contentMd).toBe(repairRequestBaseline!.contentMd);
    expect(repairRow.isAccepted).toBe(repairRequestBaseline!.isAccepted);
    expect(repairRow.deprecated).toBe(repairRequestBaseline!.deprecated);

    // 历史关联不丢：客户本人停用后仍能读到该工单
    const myRepairs = (
      await postGql({
        app,
        query: MY_REPAIR_REQUESTS_QUERY,
        token: customerToken,
        variables: { pagination: DEFAULT_PAGINATION },
      })
    ).body as MyRepairListBody;
    expect(myRepairs.errors).toBeUndefined();
    expect(myRepairs.data?.myRepairRequests?.items.map((item) => item.id)).toContain(
      repairRequestId,
    );

    // 停用公司仍可在一级详情与列表（含停用筛选）中查看
    const detail = (
      await detailOrganization({ token: levelOneToken, organizationId: managedOrgId })
    ).body as ListBody;
    expect(detail.data?.adminOrganizationDetail?.status).toBe('DISABLED');
  });

  it('伪造 organizationCode / isManagedCompany 字段被 GraphQL 校验拒绝，库内事实不变', async () => {
    const before = await organizationRepository.findOneOrFail({ where: { id: unmanagedOrgId } });

    const forged = (
      await updateOrganization({
        token: levelOneToken,
        input: {
          organizationId: unmanagedOrgId,
          organizationCode: 'HACKED_CODE',
          isManagedCompany: true,
          kind: 'PEER',
        },
      })
    ).body as MutationBody;
    expect(forged.data?.adminUpdateOrganization).toBeUndefined();
    expect(forged.errors?.[0]?.message).toContain('organizationCode');

    const after = await organizationRepository.findOneOrFail({ where: { id: unmanagedOrgId } });
    expect(after.organizationCode).toBe(before.organizationCode);
    expect(after.isManagedCompany).toBe(false);
    expect(after.kind).toBe('CLIENT');
  });

  it('非法输入与不存在目标失败关闭，且不留下幽灵行', async () => {
    const beforeCount = await countByPrefix();

    const invalidCreate = (
      await createOrganization({ token: levelOneToken, name: '   ', contactPhone: '021' })
    ).body as MutationBody;
    expect(invalidCreate.data?.adminCreateOrganization).toBeUndefined();
    expect(invalidCreate.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const invalidEmail = (
      await createOrganization({
        token: levelOneToken,
        name: `${NAME_PREFIX}坏邮箱公司`,
        extraInput: { contactEmail: 'not-an-email' },
      })
    ).body as MutationBody;
    expect(invalidEmail.data?.adminCreateOrganization).toBeUndefined();
    expect(invalidEmail.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const missing = (
      await updateOrganization({
        token: levelOneToken,
        input: { organizationId: 999999999, name: '不存在的公司' },
      })
    ).body as MutationBody;
    expect(missing.data?.adminUpdateOrganization).toBeUndefined();
    expect(missing.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(await countByExactName('不存在的公司')).toBe(0);

    // 三次失败均未落库：本轮前缀公司数量与失败前一致
    expect(await countByPrefix()).toBe(beforeCount);
  });

  it('非本轮前缀的哨兵组织不受本轮写操作影响', async () => {
    const sentinel = await organizationRepository.save(
      organizationRepository.create({
        organizationCode: SENTINEL_CODE,
        name: SENTINEL_NAME,
        kind: 'CLIENT',
        status: 'ACTIVE',
        isManagedCompany: false,
        isServiceProvider: false,
      }),
    );
    // 不登记台账：清理不得认领；同时本轮新增与编辑不应波及它
    expect(sentinel.id).toBeGreaterThan(0);

    const created = (
      await createOrganization({
        token: levelOneToken,
        name: `${NAME_PREFIX}哨兵对照公司`,
      })
    ).body as MutationBody;
    trackCreatedOrganization(created.data?.adminCreateOrganization as AdminOrganization);

    const current = await organizationRepository.findOneOrFail({ where: { id: sentinel.id } });
    expect(current.name).toBe(SENTINEL_NAME);
    expect(current.isManagedCompany).toBe(false);
    expect(current.status).toBe('ACTIVE');
  });

  it('分页参数归一：pageSize 上限 50、页码缺省 1', async () => {
    const body = (
      await listOrganizations({
        token: levelOneToken,
        keyword: NAME_PREFIX,
        pagination: { mode: 'OFFSET', pageSize: 100 },
      })
    ).body as ListBody;
    expect(body.data?.adminOrganizationList?.page).toBe(1);
    expect(body.data?.adminOrganizationList?.pageSize).toBe(50);
  });
});
