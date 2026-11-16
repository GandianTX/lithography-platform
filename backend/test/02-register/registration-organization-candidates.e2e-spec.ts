// test/02-register/registration-organization-candidates.e2e-spec.ts

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
import { postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';

/**
 * S1.4 · 注册候选链路资格一致性回归（真实 GraphQL + MySQL）。
 *
 * 契约（负责人 2026-11-15 答复）：
 * 1. `registrationOrganizationSearch`：`ACTIVE + is_managed_company`，分页 `id/name`；
 * 2. `registrationOrganizations`：旧入口兼容，仅 `ACTIVE`（不区分受管、不分页）；
 * 3. `registerWeb` 直提公司主键在事务内按 `ACTIVE + 受管` 复核，
 *    未知/停用/未受管统一 `ACCOUNT_ORGANIZATION_NOT_AVAILABLE` 且零写入；
 * 4. 维修资格不参与注册资格判断。
 */
describe('注册候选资格一致性 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let organizationRepository: Repository<OrganizationEntity>;
  let accountRepository: Repository<AccountEntity>;

  const RUN_TAG = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const CODE_PREFIX = `E2E_REGCAND_${RUN_TAG}_`;
  const NAME_PREFIX = `E2E-REGCAND-${RUN_TAG}-`;
  const PASSWORD = 'E2eRegCand@2026';

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();

  let managedActiveId: number;
  let unmanagedActiveId: number;
  let managedDisabledId: number;

  type GqlError = { message: string; extensions?: { code?: string; errorCode?: string } };
  type CandidatesBody = {
    data?: {
      registrationOrganizationSearch?: {
        items: Array<{ id: number; name: string }>;
        total: number;
        page: number;
        pageSize: number;
      };
      registrationOrganizations?: Array<{ id: number; name: string }>;
    };
    errors?: GqlError[];
  };
  type RegisterBody = {
    data?: { registerWeb?: { success?: boolean; accountId?: number } };
    errors?: GqlError[];
  };

  const createOrganization = async (params: {
    codeSuffix: string;
    name: string;
    status?: 'ACTIVE' | 'DISABLED';
    isManagedCompany: boolean;
    isServiceProvider?: boolean;
  }): Promise<number> => {
    const organizationCode = `${CODE_PREFIX}${params.codeSuffix}`;
    const saved = await organizationRepository.save(
      organizationRepository.create({
        organizationCode,
        name: params.name,
        kind: 'CLIENT',
        status: params.status ?? 'ACTIVE',
        isManagedCompany: params.isManagedCompany,
        isServiceProvider: params.isServiceProvider ?? false,
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

  const registerWeb = (input: Record<string, unknown>) =>
    postGql({
      app,
      query: `
        mutation RegisterWeb($input: RegisterWebInput!) {
          registerWeb(input: $input) { success message accountId applicationId }
        }
      `,
      variables: { input },
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
    accountRepository = dataSource.getRepository(AccountEntity);
    await app.init();

    managedActiveId = await createOrganization({
      codeSuffix: 'MANAGED_ACTIVE',
      name: `${NAME_PREFIX}A 受管启用`,
      isManagedCompany: true,
    });
    unmanagedActiveId = await createOrganization({
      codeSuffix: 'UNMANAGED_ACTIVE',
      name: `${NAME_PREFIX}B 未受管启用`,
      isManagedCompany: false,
      // 维修资格不参与注册判断
      isServiceProvider: true,
    });
    managedDisabledId = await createOrganization({
      codeSuffix: 'MANAGED_DISABLED',
      name: `${NAME_PREFIX}C 受管停用`,
      status: 'DISABLED',
      isManagedCompany: true,
    });
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;
        await runGuardedSpecCleanup({
          dataSource,
          helper: 'registration-organization-candidates.e2e',
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

  it('Web 候选只返回 ACTIVE + 受管公司', async () => {
    const response = await postGql({
      app,
      query: `
        query Candidates($pagination: PaginationArgs!, $keyword: String) {
          registrationOrganizationSearch(pagination: $pagination, keyword: $keyword) {
            items { id name }
            total
            page
            pageSize
          }
        }
      `,
      variables: {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
        keyword: NAME_PREFIX,
      },
    });
    const body = response.body as CandidatesBody;
    expect(body.errors).toBeUndefined();
    const page = body.data?.registrationOrganizationSearch;
    expect(page?.total).toBe(1);
    expect(page?.items.map((item) => item.id)).toEqual([managedActiveId]);
    expect(Object.keys(page?.items[0] ?? {}).sort()).toEqual(['id', 'name']);
  });

  it('旧接口仅按 ACTIVE 返回，含未受管、排除停用', async () => {
    const response = await postGql({
      app,
      query: `
        query Legacy {
          registrationOrganizations { id name }
        }
      `,
    });
    const body = response.body as CandidatesBody;
    expect(body.errors).toBeUndefined();
    const ids = (body.data?.registrationOrganizations ?? []).map((item) => item.id);
    expect(ids).toContain(managedActiveId);
    expect(ids).toContain(unmanagedActiveId);
    expect(ids).not.toContain(managedDisabledId);
  });

  it('直提未知/停用/未受管公司被拒绝且零写入', async () => {
    const rejected: Array<{ label: string; organizationId: number }> = [
      { label: 'unknown', organizationId: 2147483000 },
      { label: 'disabled', organizationId: managedDisabledId },
      { label: 'unmanaged', organizationId: unmanagedActiveId },
    ];

    for (const item of rejected) {
      const loginName = `e2erc${item.label}${RUN_TAG}`.slice(0, 30);
      const response = await registerWeb({
        loginName,
        loginEmail: `${loginName}@example.com`,
        loginPassword: PASSWORD,
        type: 'CUSTOMER',
        organizationId: item.organizationId,
      });
      const body = response.body as RegisterBody;
      expect(body.data?.registerWeb?.success).not.toBe(true);
      expect(body.errors?.[0]?.extensions?.errorCode).toBe('ACCOUNT_ORGANIZATION_NOT_AVAILABLE');
      // 事务整体回滚：账号不得残留
      const residue = await accountRepository.count({ where: { loginName } });
      expect(residue).toBe(0);
    }
  });

  it('取候选后公司被停用：旧选项不再出现且直提被拒绝', async () => {
    // 1) 取候选：受管启用公司此时可见
    const first = await postGql({
      app,
      query: `
        query Candidates($pagination: PaginationArgs!, $keyword: String) {
          registrationOrganizationSearch(pagination: $pagination, keyword: $keyword) {
            items { id name }
            total
          }
        }
      `,
      variables: {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
        keyword: NAME_PREFIX,
      },
    });
    expect((first.body as CandidatesBody).data?.registrationOrganizationSearch?.items).toEqual([
      { id: managedActiveId, name: `${NAME_PREFIX}A 受管启用` },
    ]);

    // 2) 模拟候选被取走后公司停用
    await organizationRepository.update(managedActiveId, { status: 'DISABLED' });
    updateOwnedExpectation(ownership, 'organization', managedActiveId, {
      organizationCode: `${CODE_PREFIX}MANAGED_ACTIVE`,
      name: `${NAME_PREFIX}A 受管启用`,
      kind: 'CLIENT',
      status: 'DISABLED',
      isManagedCompany: true,
    });
    try {
      // 3) 再取候选：旧选项不再出现
      const second = await postGql({
        app,
        query: `
          query Candidates($pagination: PaginationArgs!, $keyword: String) {
            registrationOrganizationSearch(pagination: $pagination, keyword: $keyword) {
              items { id name }
              total
            }
          }
        `,
        variables: {
          pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
          keyword: NAME_PREFIX,
        },
      });
      const page = (second.body as CandidatesBody).data?.registrationOrganizationSearch;
      expect(page?.total).toBe(0);
      expect(page?.items).toEqual([]);

      // 4) 直提旧选项：写入侧事务内按同一口径复核，拒绝且零写入
      const loginName = `e2ercstale${RUN_TAG}`.slice(0, 30);
      const response = await registerWeb({
        loginName,
        loginEmail: `${loginName}@example.com`,
        loginPassword: PASSWORD,
        type: 'CUSTOMER',
        organizationId: managedActiveId,
      });
      const body = response.body as RegisterBody;
      expect(body.data?.registerWeb?.success).not.toBe(true);
      expect(body.errors?.[0]?.extensions?.errorCode).toBe('ACCOUNT_ORGANIZATION_NOT_AVAILABLE');
      expect(await accountRepository.count({ where: { loginName } })).toBe(0);
    } finally {
      // 恢复启用，避免影响后续用例与清理台账
      await organizationRepository.update(managedActiveId, { status: 'ACTIVE' });
      updateOwnedExpectation(ownership, 'organization', managedActiveId, {
        organizationCode: `${CODE_PREFIX}MANAGED_ACTIVE`,
        name: `${NAME_PREFIX}A 受管启用`,
        kind: 'CLIENT',
        status: 'ACTIVE',
        isManagedCompany: true,
      });
    }
  });

  it('直提受管启用公司注册成功并写入客户公司归属', async () => {
    const loginName = `e2ercok${RUN_TAG}`.slice(0, 30);
    const response = await registerWeb({
      loginName,
      loginEmail: `${loginName}@example.com`,
      loginPassword: PASSWORD,
      type: 'CUSTOMER',
      organizationId: managedActiveId,
    });
    const body = response.body as RegisterBody;
    expect(body.errors).toBeUndefined();
    expect(body.data?.registerWeb?.success).toBe(true);

    const accountId = body.data?.registerWeb?.accountId;
    if (typeof accountId !== 'number') {
      throw new Error('注册成功但响应缺少 accountId');
    }
    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOneOrFail({ where: { accountId } });
    expect(userInfo.customerOrganizationId).toBe(managedActiveId);

    // 登记真实 ID 与受控事实，供本轮精确回收
    const account = await accountRepository.findOneOrFail({ where: { id: accountId } });
    recordOwnedResource(ownership, 'account', account.id, {
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
      customerOrganizationId: managedActiveId,
    });
    const membership = await dataSource
      .getRepository(OrganizationMembershipEntity)
      .findOne({ where: { accountId, organizationId: managedActiveId } });
    if (membership) {
      recordOwnedResource(ownership, 'membership', membership.id, {
        organizationId: managedActiveId,
        accountId,
        memberRole: membership.memberRole,
        status: membership.status,
      });
    }
  });
});
