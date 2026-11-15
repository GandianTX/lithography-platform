// test/02-register/admin-organization-name-list.e2e-spec.ts

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { useContainer } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { createTestAccount, seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import { seedTestMemberships } from '../utils/test-organizations';

/**
 * S1.4 · 管理员公司名称名单（`adminOrganizationNameList`，真实 GraphQL + MySQL）。
 *
 * 授权口径（负责人 2026-11-15 答复）：
 * 1. 一级/二级以请求期查库得到的 `admin_level` 与可信公司归属为准，不信任 JWT 声明；
 * 2. 等级缺失/非法、二级缺少可信公司一律拒绝；
 * 3. 名单只读最小字段（`id` / `name`），启用公司即可见，不按受管或维修资格过滤；
 * 4. 二级管理员可跨公司查看名称名单（写操作限本公司由 S2/S3 另行约束）。
 */
describe('管理员公司名称名单 adminOrganizationNameList (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let organizationRepository: Repository<OrganizationEntity>;
  let accountRepository: Repository<AccountEntity>;

  const RUN_TAG = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const CODE_PREFIX = `E2E_ADMNAME_${RUN_TAG}_`;
  const NAME_PREFIX = `E2E-ADM-${RUN_TAG}-`;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();

  let levelOneToken: string;
  let levelTwoToken: string;
  let noLevelToken: string;
  let levelTwoNoOrgToken: string;
  let customerToken: string;

  type GqlError = { message: string; extensions?: { code?: string; errorCode?: string } };
  type ListBody = {
    data?: {
      adminOrganizationNameList?: {
        items: Array<{ id: number; name: string }>;
        total: number;
        page: number;
        pageSize: number;
      };
    };
    errors?: GqlError[];
  };

  const customAdminConfig = (suffix: string) => ({
    loginName: `e2eadm${suffix}${RUN_TAG}`.slice(0, 30),
    loginEmail: `e2e.adm.${suffix}.${RUN_TAG}@example.com`,
    loginPassword: 'E2eAdmName@2026',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
    identityType: IdentityTypeEnum.SUPER_ADMIN,
  });

  const createOrganization = async (params: {
    codeSuffix: string;
    name: string;
    status?: 'ACTIVE' | 'DISABLED';
    isManagedCompany: boolean;
    isServiceProvider: boolean;
  }): Promise<number> => {
    const organizationCode = `${CODE_PREFIX}${params.codeSuffix}`;
    const saved = await organizationRepository.save(
      organizationRepository.create({
        organizationCode,
        name: params.name,
        kind: 'CLIENT',
        status: params.status ?? 'ACTIVE',
        isManagedCompany: params.isManagedCompany,
        isServiceProvider: params.isServiceProvider,
      }),
    );
    recordOwnedResource(ownership, 'organization', saved.id, {
      organizationCode,
      name: params.name,
      kind: 'CLIENT',
      status: params.status ?? 'ACTIVE',
      isManagedCompany: params.isManagedCompany,
    });
    return saved.id;
  };

  const list = (params: { token?: string; keyword?: string | null; pagination?: unknown }) =>
    postGql({
      app,
      token: params.token,
      query: `
        query AdminOrganizationNameList($pagination: PaginationArgs!, $keyword: String) {
          adminOrganizationNameList(pagination: $pagination, keyword: $keyword) {
            items { id name }
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

  const setAdminLevel = async (loginName: string, adminLevel: number | null): Promise<void> => {
    const account = await accountRepository.findOneOrFail({ where: { loginName } });
    await accountRepository.update(account.id, { adminLevel });
  };

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
    await app.init();

    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin', 'peerAdmin', 'guest'],
      ownership,
    });

    const noLevelConfig = customAdminConfig('nolevel');
    const noOrgConfig = customAdminConfig('noorg');
    await createTestAccount(dataSource, null, noLevelConfig, ownership);
    await createTestAccount(dataSource, null, noOrgConfig, ownership);

    const orgAId = await createOrganization({
      codeSuffix: 'A',
      name: `${NAME_PREFIX}A 受管维修公司`,
      isManagedCompany: true,
      isServiceProvider: true,
    });
    const orgBId = await createOrganization({
      codeSuffix: 'B',
      name: `${NAME_PREFIX}B 非受管公司`,
      isManagedCompany: false,
      isServiceProvider: false,
    });
    await createOrganization({
      codeSuffix: 'DISABLED',
      name: `${NAME_PREFIX}C 停用公司`,
      status: 'DISABLED',
      isManagedCompany: true,
      isServiceProvider: true,
    });

    // 二级管理员的可信公司归属来自请求期成员关系解析
    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: new Map([
        [`${CODE_PREFIX}A`, orgAId],
        [`${CODE_PREFIX}B`, orgBId],
      ]),
      memberships: [
        {
          accountLoginName: testAccountsConfig.peerAdmin.loginName,
          organizationCode: `${CODE_PREFIX}B`,
          memberRole: 'SUPER_ADMIN',
        },
      ],
      ownership,
    });

    await setAdminLevel(testAccountsConfig.admin.loginName, 1);
    await setAdminLevel(testAccountsConfig.peerAdmin.loginName, 2);
    await setAdminLevel(noLevelConfig.loginName, null);
    await setAdminLevel(noOrgConfig.loginName, 2);

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
    noLevelToken = await login({
      app,
      loginName: noLevelConfig.loginName,
      loginPassword: noLevelConfig.loginPassword,
    });
    levelTwoNoOrgToken = await login({
      app,
      loginName: noOrgConfig.loginName,
      loginPassword: noOrgConfig.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: testAccountsConfig.guest.loginName,
      loginPassword: testAccountsConfig.guest.loginPassword,
    });
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;
        await runGuardedSpecCleanup({
          dataSource,
          helper: 'admin-organization-name-list.e2e',
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
    const body = (await list({})).body as ListBody;
    expect(body.data?.adminOrganizationNameList).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('非管理员调用返回 FORBIDDEN', async () => {
    const body = (await list({ token: customerToken })).body as ListBody;
    expect(body.data?.adminOrganizationNameList).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('一级管理员可见启用公司，字段只有 id/name，停用公司不出现', async () => {
    const body = (await list({ token: levelOneToken, keyword: NAME_PREFIX })).body as ListBody;
    expect(body.errors).toBeUndefined();
    const page = body.data?.adminOrganizationNameList;
    expect(page?.total).toBe(2);
    expect(page?.items.map((item) => item.name)).toEqual([
      `${NAME_PREFIX}A 受管维修公司`,
      `${NAME_PREFIX}B 非受管公司`,
    ]);
    for (const item of page?.items ?? []) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name']);
    }
  });

  it('二级管理员可跨公司查看同一名称名单', async () => {
    const body = (await list({ token: levelTwoToken, keyword: NAME_PREFIX })).body as ListBody;
    expect(body.errors).toBeUndefined();
    const page = body.data?.adminOrganizationNameList;
    // 本公司为 B，仍可见 A：名单不按可信公司收窄（写操作限本公司另行约束）
    expect(page?.items.map((item) => item.name)).toEqual([
      `${NAME_PREFIX}A 受管维修公司`,
      `${NAME_PREFIX}B 非受管公司`,
    ]);
  });

  it('等级缺失或二级缺少可信公司时拒绝', async () => {
    // 非法等级（如 3）由库约束 `chk_base_user_account_admin_level` 拦截，
    // 用例层对非法值的失败关闭由 `admin-scope.policy.spec.ts` 覆盖
    for (const token of [noLevelToken, levelTwoNoOrgToken]) {
      const body = (await list({ token })).body as ListBody;
      expect(body.data?.adminOrganizationNameList).toBeUndefined();
      expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
  });

  it('分页与页大小归一：page 缺省 1、pageSize 上限 50', async () => {
    const body = (
      await list({
        token: levelOneToken,
        keyword: NAME_PREFIX,
        // GraphQL 入参上限 100，用例层再按选择器上限截断为 50
        pagination: { mode: 'OFFSET', pageSize: 100 },
      })
    ).body as ListBody;
    const page = body.data?.adminOrganizationNameList;
    expect(page?.page).toBe(1);
    expect(page?.pageSize).toBe(50);
  });

  it('第二页返回剩余项', async () => {
    const body = (
      await list({
        token: levelOneToken,
        keyword: NAME_PREFIX,
        pagination: { mode: 'OFFSET', page: 2, pageSize: 1 },
      })
    ).body as ListBody;
    expect(body.data?.adminOrganizationNameList?.items.map((item) => item.name)).toEqual([
      `${NAME_PREFIX}B 非受管公司`,
    ]);
  });
});
