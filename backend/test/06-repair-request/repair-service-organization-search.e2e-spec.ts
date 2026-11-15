// test/06-repair-request/repair-service-organization-search.e2e-spec.ts

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { useContainer } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
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

/**
 * S1.4 · 报修服务公司候选（`repairServiceOrganizationSearch`，真实 GraphQL + MySQL）。
 *
 * 验收入口口径（负责人 2026-11-15 答复）：
 * 1. 仅客户可查询，且客户必须已补齐可信公司归属；管理员即使可见客户入口也拒绝；
 * 2. 候选项固定为「启用且具备维修服务资格」，与注册候选的受管口径互不参与；
 * 3. 只返回 `id` / `name` / `shortName`，分页仅 OFFSET、单页上限 50；
 * 4. 关键字按名称子串过滤，`%` / `_` 作普通字符。
 */
describe('报修服务公司候选 repairServiceOrganizationSearch (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let organizationRepository: Repository<OrganizationEntity>;

  const RUN_TAG = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const CODE_PREFIX = `E2E_RSP_${RUN_TAG}_`;
  const NAME_PREFIX = `E2E-RSP-${RUN_TAG}-`;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();

  let guestWithOrgToken: string;
  let guestWithoutOrgToken: string;
  let adminToken: string;
  let providerAId: number;
  let providerBId: number;

  type GqlError = { message: string; extensions?: { code?: string; errorCode?: string } };
  type PageBody = {
    data?: {
      repairServiceOrganizationSearch?: {
        items: Array<{ id: number; name: string; shortName: string | null }>;
        total: number;
        page: number;
        pageSize: number;
      };
    };
    errors?: GqlError[];
  };

  const createOrganization = async (params: {
    codeSuffix: string;
    name: string;
    status?: 'ACTIVE' | 'DISABLED';
    isServiceProvider: boolean;
    isManagedCompany: boolean;
    shortName?: string | null;
    kind?: 'CLIENT' | 'PEER';
  }): Promise<number> => {
    const organizationCode = `${CODE_PREFIX}${params.codeSuffix}`;
    const saved = await organizationRepository.save(
      organizationRepository.create({
        organizationCode,
        name: params.name,
        shortName: params.shortName ?? null,
        kind: params.kind ?? 'CLIENT',
        status: params.status ?? 'ACTIVE',
        isServiceProvider: params.isServiceProvider,
        isManagedCompany: params.isManagedCompany,
      }),
    );
    recordOwnedResource(ownership, 'organization', saved.id, {
      organizationCode,
      name: params.name,
      kind: params.kind ?? 'CLIENT',
      status: params.status ?? 'ACTIVE',
      isManagedCompany: params.isManagedCompany,
    });
    return saved.id;
  };

  const search = (params: {
    token?: string;
    keyword?: string | null;
    pagination?: Record<string, unknown>;
  }) =>
    postGql({
      app,
      token: params.token,
      query: `
        query RepairServiceOrganizationSearch($pagination: PaginationArgs!, $keyword: String) {
          repairServiceOrganizationSearch(pagination: $pagination, keyword: $keyword) {
            items { id name shortName }
            total
            page
            pageSize
          }
        }
      `,
      variables: {
        pagination: params.pagination ?? { mode: 'OFFSET', page: 1, pageSize: 20 },
        keyword: params.keyword ?? null,
      },
    });

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    useContainer(app.select(ApiModule), { fallbackOnErrors: true });
    dataSource = moduleFixture.get<DataSource>(DataSource);
    organizationRepository = dataSource.getRepository(OrganizationEntity);
    await app.init();

    await seedTestAccounts({
      dataSource,
      includeKeys: ['guestPrimary', 'guest', 'admin'],
      ownership,
    });

    providerAId = await createOrganization({
      codeSuffix: 'A_PROVIDER',
      name: `${NAME_PREFIX}A 维修公司`,
      shortName: 'A维修',
      kind: 'PEER',
      isServiceProvider: true,
      // 刻意未受管：证明注册受管口径不参与维修候选
      isManagedCompany: false,
    });
    providerBId = await createOrganization({
      codeSuffix: 'B_PROVIDER',
      name: `${NAME_PREFIX}B 维修公司`,
      shortName: null,
      kind: 'CLIENT',
      isServiceProvider: true,
      isManagedCompany: true,
    });
    await createOrganization({
      codeSuffix: 'C_NOT_PROVIDER',
      name: `${NAME_PREFIX}C 无维修资格`,
      kind: 'CLIENT',
      isServiceProvider: false,
      isManagedCompany: true,
    });
    await createOrganization({
      codeSuffix: 'D_DISABLED',
      name: `${NAME_PREFIX}D 停用维修公司`,
      kind: 'CLIENT',
      status: 'DISABLED',
      isServiceProvider: true,
      isManagedCompany: true,
    });

    // 已补齐可信公司归属的客户：本用例固定指向 A 公司
    const guestAccount = await dataSource
      .getRepository(UserInfoEntity)
      .findOneOrFail({ where: { email: testAccountsConfig.guestPrimary.loginEmail } });
    await dataSource
      .getRepository(UserInfoEntity)
      .update(guestAccount.accountId, { customerOrganizationId: providerAId });
    updateOwnedExpectation(ownership, 'account', guestAccount.accountId, {
      customerOrganizationId: providerAId,
    });

    guestWithOrgToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
    guestWithoutOrgToken = await login({
      app,
      loginName: testAccountsConfig.guest.loginName,
      loginPassword: testAccountsConfig.guest.loginPassword,
    });
    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;
        await runGuardedSpecCleanup({
          dataSource,
          helper: 'repair-service-organization-search.e2e',
          owned: ownership,
        });
      },
      finalize: async () => {
        const residue = await organizationRepository
          .createQueryBuilder('organization')
          .where('organization.organization_code LIKE :prefix', { prefix: `${CODE_PREFIX}%` })
          .getCount();
        expect(residue).toBe(0);
      },
      closeApp: app
        ? async () => {
            await app.close();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        : null,
    });
  });

  it('未登录调用返回 UNAUTHENTICATED', async () => {
    const response = await search({});
    expect(response.status).toBe(200);
    const body = response.body as PageBody;
    expect(body.data?.repairServiceOrganizationSearch).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('管理员客户入口按精确角色拒绝（FORBIDDEN）', async () => {
    const response = await search({ token: adminToken });
    const body = response.body as PageBody;
    expect(body.data?.repairServiceOrganizationSearch).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('缺少可信公司归属的客户被拒绝（FORBIDDEN）', async () => {
    const response = await search({ token: guestWithoutOrgToken });
    const body = response.body as PageBody;
    expect(body.data?.repairServiceOrganizationSearch).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('仅返回启用且具备维修资格的公司，字段只有 id/name/shortName', async () => {
    const response = await search({ token: guestWithOrgToken, keyword: NAME_PREFIX });
    expect(response.status).toBe(200);
    const body = response.body as PageBody;
    expect(body.errors).toBeUndefined();

    const page = body.data?.repairServiceOrganizationSearch;
    expect(page).toBeDefined();
    expect(page?.total).toBe(2);
    expect(page?.items.map((item) => item.name)).toEqual([
      `${NAME_PREFIX}A 维修公司`,
      `${NAME_PREFIX}B 维修公司`,
    ]);
    expect(page?.items[0]?.shortName).toBe('A维修');
    expect(page?.items[1]?.shortName).toBeNull();

    // 字段最小化：只输出选择所需三字段，不泄漏联系方式/受管/维修资格等内部资料
    for (const item of page?.items ?? []) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name', 'shortName']);
    }
  });

  it('分页与页大小归一：page 缺省 1、pageSize 上限 50', async () => {
    const response = await search({
      token: guestWithOrgToken,
      keyword: NAME_PREFIX,
      // GraphQL 入参上限 100，用例层再按选择器上限截断为 50
      pagination: { mode: 'OFFSET', pageSize: 100 },
    });
    const page = (response.body as PageBody).data?.repairServiceOrganizationSearch;
    expect(page?.page).toBe(1);
    expect(page?.pageSize).toBe(50);
    expect(page?.items).toHaveLength(2);
  });

  it('第二页返回剩余项', async () => {
    const response = await search({
      token: guestWithOrgToken,
      keyword: NAME_PREFIX,
      pagination: { mode: 'OFFSET', page: 2, pageSize: 1 },
    });
    const page = (response.body as PageBody).data?.repairServiceOrganizationSearch;
    expect(page?.items.map((item) => item.name)).toEqual([`${NAME_PREFIX}B 维修公司`]);
  });

  it('非 OFFSET 分页被拒绝（PAGINATION_INVALID_PAGE_SIZE）', async () => {
    const response = await search({
      token: guestWithOrgToken,
      pagination: { mode: 'CURSOR', limit: 20 },
    });
    const body = response.body as PageBody;
    expect(body.data?.repairServiceOrganizationSearch).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('PAGINATION_INVALID_PAGE_SIZE');
  });

  it('取候选后公司被停用：旧选项不再出现（03 提交时须再复核）', async () => {
    // 1) 取候选：A、B 均可见
    const first = await search({ token: guestWithOrgToken, keyword: NAME_PREFIX });
    const firstPage = (first.body as PageBody).data?.repairServiceOrganizationSearch;
    expect(firstPage?.items.map((item) => item.id)).toEqual([providerAId, providerBId]);

    // 2) 模拟候选被取走后公司停用
    await organizationRepository.update(providerBId, { status: 'DISABLED' });
    updateOwnedExpectation(ownership, 'organization', providerBId, {
      organizationCode: `${CODE_PREFIX}B_PROVIDER`,
      name: `${NAME_PREFIX}B 维修公司`,
      kind: 'CLIENT',
      status: 'DISABLED',
      isManagedCompany: true,
    });
    try {
      // 3) 再取候选：旧选项已消失
      const second = await search({ token: guestWithOrgToken, keyword: NAME_PREFIX });
      const secondPage = (second.body as PageBody).data?.repairServiceOrganizationSearch;
      expect(secondPage?.total).toBe(1);
      expect(secondPage?.items.map((item) => item.id)).toEqual([providerAId]);
      // 04 · 提交路径由 03 在事务内按同口径复核：候选列表不构成授权
    } finally {
      // 恢复启用，避免影响清理台账
      await organizationRepository.update(providerBId, { status: 'ACTIVE' });
      updateOwnedExpectation(ownership, 'organization', providerBId, {
        organizationCode: `${CODE_PREFIX}B_PROVIDER`,
        name: `${NAME_PREFIX}B 维修公司`,
        kind: 'CLIENT',
        status: 'ACTIVE',
        isManagedCompany: true,
      });
    }
  });
});
