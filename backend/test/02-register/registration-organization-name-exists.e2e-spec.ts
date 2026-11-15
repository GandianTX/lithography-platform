// test/02-register/registration-organization-name-exists.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { useContainer } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';

/**
 * P2-2 · Web 注册手填公司名精确同名提示（真实 GraphQL + MySQL）。
 *
 * 最小复现：候选按名称、主键升序，前端只加载第 1 页（20 条）。手填一个位于第 2 页的
 * 启用受管公司名称时，前端旧的 candidates.some 判断不会命中。本规格证明独立精确查询：
 * 1. 目标在候选首屏之外时仍精确命中；
 * 2. 前缀、停用、未受管、不存在、`%` / `_` 字面值均不命中；
 * 3. 空白归一、英文大小写、名称最大长度（200）按注册口径处理；
 * 4. 查询是公开只读，不依赖候选分页或任何登录态。
 *
 * 清理：本轮全部公司按唯一编码登记到台账，afterAll 经 `runGuardedSpecCleanup`
 * 在同一事务内预检并精确回收；物理清理需显式授权。
 */
describe('Web 注册手填公司名精确同名提示 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let organizationRepository: Repository<OrganizationEntity>;

  const RUN_TAG = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  /** 本轮公司编码前缀：唯一且可核对零残留 */
  const CODE_PREFIX = `E2E_NM_${RUN_TAG}_`;
  /** 候选首屏排序用的名称前缀（ASCII 保证排序稳定） */
  const NAME_PREFIX = `E2E-NM-${RUN_TAG}-`;

  /** 候选首屏（20 条）之外的目标公司名称 */
  const TARGET_NAME = `${NAME_PREFIX}99`;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();

  type GqlBody = {
    data?: { registrationOrganizationNameExists?: boolean | null };
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };

  /**
   * 直接建行并登记台账。
   * `seedTestOrganizations` 固定 ACTIVE，本规格需要停用/未受管反例，故在此统一建行。
   */
  const createOrganization = async (params: {
    codeSuffix: string;
    name: string;
    status?: 'ACTIVE' | 'DISABLED';
    isManagedCompany?: boolean;
  }): Promise<number> => {
    const organizationCode = `${CODE_PREFIX}${params.codeSuffix}`;
    const status = params.status ?? 'ACTIVE';
    const isManagedCompany = params.isManagedCompany ?? true;

    const existing = await organizationRepository.findOne({ where: { organizationCode } });
    if (existing) {
      throw new Error(
        `本轮公司编码碰撞：${organizationCode} 已存在（ID=${existing.id}），拒绝认领非本轮创建的行`,
      );
    }

    const saved = await organizationRepository.save(
      organizationRepository.create({
        organizationCode,
        name: params.name,
        kind: 'CLIENT',
        status,
        isManagedCompany,
      }),
    );

    recordOwnedResource(ownership, 'organization', saved.id, {
      organizationCode,
      name: params.name,
      kind: 'CLIENT',
      status,
      isManagedCompany,
    });
    return saved.id;
  };

  const queryNameExists = (name: string) =>
    request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          query RegistrationOrganizationNameExists($name: String!) {
            registrationOrganizationNameExists(name: $name)
          }
        `,
        variables: { name },
      });

  /** 读取精确查询结果；有 GraphQL 错误即失败（契约是布尔结果，不返回错误） */
  const expectNameExists = async (name: string): Promise<boolean> => {
    const response = await queryNameExists(name);
    expect(response.status).toBe(200);
    const body = response.body as GqlBody;
    expect(body.errors).toBeUndefined();
    const value = body.data?.registrationOrganizationNameExists;
    expect(typeof value).toBe('boolean');
    return value as boolean;
  };

  /** 读取候选第 1 页（与前端默认分页一致） */
  const queryFirstCandidatePage = async (): Promise<{
    items: Array<{ id: number; name: string }>;
    total: number;
  }> => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          query FirstCandidatePage($pagination: PaginationArgs!) {
            registrationOrganizationSearch(pagination: $pagination) {
              items { id name }
              total
              page
              pageSize
            }
          }
        `,
        variables: {
          pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
        },
      });
    expect(response.status).toBe(200);
    const body = response.body as {
      data?: {
        registrationOrganizationSearch?: {
          items: Array<{ id: number; name: string }>;
          total: number;
        };
      };
      errors?: GqlBody['errors'];
    };
    expect(body.errors).toBeUndefined();
    const page = body.data?.registrationOrganizationSearch;
    if (!page) {
      throw new Error('候选第 1 页响应缺失');
    }
    return page;
  };

  const DOUBLE_SPACE_NAME = `E2E NM  SPACE ${RUN_TAG}`;
  const MIXED_CASE_NAME = `E2E-Case-Mixed-${RUN_TAG}`;
  const PERCENT_NAME = `E2E-PCT%${RUN_TAG}`;
  const UNDERSCORE_NAME = `E2E-USC_${RUN_TAG}`;
  const MAX_LENGTH_NAME = `${CODE_PREFIX}L200`.padEnd(200, 'x');
  /** 重音敏感：库内名带重音，输入无重音必须不命中 */
  const CAFE_NAME = `E2E-Café-${RUN_TAG}`;
  const CAFE_PLAIN_NAME = `E2E-Cafe-${RUN_TAG}`;
  /** 存储侧首尾 tab / 换行：只有「先合并空白、再 TRIM」才可能命中 */
  const STORED_WS_NAME = `E2E-STORED-WS-${RUN_TAG}`;
  const STORED_WS_RAW_NAME = `\t${STORED_WS_NAME}\n`;

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

    // 24 条启用受管公司占满候选首屏，目标排在其后（第 2 页）
    for (let index = 1; index <= 24; index += 1) {
      await createOrganization({
        codeSuffix: `FILL_${String(index).padStart(2, '0')}`,
        name: `${NAME_PREFIX}${String(index).padStart(2, '0')}`,
      });
    }

    await createOrganization({ codeSuffix: 'TARGET', name: TARGET_NAME });
    await createOrganization({
      codeSuffix: 'DISABLED',
      name: `${NAME_PREFIX}DISABLED`,
      status: 'DISABLED',
    });
    await createOrganization({
      codeSuffix: 'UNMANAGED',
      name: `${NAME_PREFIX}UNMANAGED`,
      isManagedCompany: false,
    });
    await createOrganization({ codeSuffix: 'DBL', name: DOUBLE_SPACE_NAME });
    await createOrganization({ codeSuffix: 'CASE', name: MIXED_CASE_NAME });
    await createOrganization({ codeSuffix: 'PCT', name: PERCENT_NAME });
    await createOrganization({ codeSuffix: 'USC', name: UNDERSCORE_NAME });
    await createOrganization({ codeSuffix: 'MAXLEN', name: MAX_LENGTH_NAME });
    await createOrganization({ codeSuffix: 'CAFE', name: CAFE_NAME });
    await createOrganization({ codeSuffix: 'STOREDWS', name: STORED_WS_RAW_NAME });
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        await runGuardedSpecCleanup({
          dataSource,
          helper: 'registration-organization-name-exists.e2e',
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

  it('目标在候选首屏之外时仍精确命中，且查询为公开只读', async () => {
    const firstPage = await queryFirstCandidatePage();

    // 首屏共 20 条，目标不在其中：证明前端从未加载第 2 页也能得到同名提示
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.items.some((item) => item.name === TARGET_NAME)).toBe(false);
    expect(firstPage.total).toBeGreaterThanOrEqual(24);

    // 未携带 Authorization，公开请求直接命中
    await expect(expectNameExists(TARGET_NAME)).resolves.toBe(true);
  });

  it('前缀、停用、未受管、不存在均不命中', async () => {
    // 仅同一前缀（不是完整名称）
    await expect(expectNameExists(`${NAME_PREFIX}9`)).resolves.toBe(false);
    // 停用公司即使受管也不命中
    await expect(expectNameExists(`${NAME_PREFIX}DISABLED`)).resolves.toBe(false);
    // 启用但未进入一级维护名单
    await expect(expectNameExists(`${NAME_PREFIX}UNMANAGED`)).resolves.toBe(false);
    // 不存在
    await expect(expectNameExists(`${NAME_PREFIX}NOT-EXIST`)).resolves.toBe(false);
  });

  it('百分号与下划线按字面值比较，不作 LIKE 通配符', async () => {
    await expect(expectNameExists(PERCENT_NAME)).resolves.toBe(true);
    await expect(expectNameExists(`E2E-PCTX${RUN_TAG}`)).resolves.toBe(false);

    await expect(expectNameExists(UNDERSCORE_NAME)).resolves.toBe(true);
    await expect(expectNameExists(`E2E-USCX${RUN_TAG}`)).resolves.toBe(false);
  });

  it('去首尾空白、合并连续空白、忽略大小写后精确命中', async () => {
    await expect(expectNameExists(`  ${TARGET_NAME}  `)).resolves.toBe(true);
    await expect(expectNameExists(TARGET_NAME.toLowerCase())).resolves.toBe(true);

    // 库内名称含连续空白：输入单空格仍命中
    await expect(expectNameExists(`E2E NM SPACE ${RUN_TAG}`)).resolves.toBe(true);
    await expect(expectNameExists(MIXED_CASE_NAME.toLowerCase())).resolves.toBe(true);

    // 输入侧带首尾 tab / 换行（用例归一化 trim 后命中）
    await expect(expectNameExists(`\t\n  ${TARGET_NAME}  \n\t`)).resolves.toBe(true);
  });

  it('重音敏感：库内 Café 不被 Cafe 命中', async () => {
    await expect(expectNameExists(CAFE_NAME)).resolves.toBe(true);
    await expect(expectNameExists(CAFE_NAME.toLowerCase())).resolves.toBe(true);
    await expect(expectNameExists(CAFE_PLAIN_NAME)).resolves.toBe(false);
  });

  it('存储侧首尾 tab / 换行：先合并空白再 TRIM 才命中（顺序不可交换）', async () => {
    // 库内保存的是 `\t<名称>\n`；旧顺序 TRIM→REGEXP_REPLACE 会留下首尾空格而漏命中
    await expect(expectNameExists(STORED_WS_NAME)).resolves.toBe(true);
  });

  it('名称最大长度 200 不套用候选关键字上限，201 直接未命中', async () => {
    expect(MAX_LENGTH_NAME).toHaveLength(200);
    await expect(expectNameExists(`  ${MAX_LENGTH_NAME}  `)).resolves.toBe(true);

    const overLimit = `${MAX_LENGTH_NAME}x`;
    expect(overLimit).toHaveLength(201);
    await expect(expectNameExists(overLimit)).resolves.toBe(false);
  });

  it('手填注册仍创建独立未受管公司，不自动合并到同名受管公司', async () => {
    const loginName = `e2enm_${RUN_TAG}`;
    const loginEmail = `${loginName}@ex.com`;
    const registerResponse = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `
          mutation Register($input: RegisterWebInput!) {
            registerWeb(input: $input) { success message accountId applicationId }
          }
        `,
        variables: {
          input: {
            loginName,
            loginEmail,
            loginPassword: 'E2eName!2026x',
            type: 'CUSTOMER',
            organizationName: TARGET_NAME,
          },
        },
      });

    expect(registerResponse.status).toBe(200);
    const registerBody = registerResponse.body as {
      data?: { registerWeb?: { success?: boolean; accountId?: number } };
      errors?: GqlBody['errors'];
    };
    expect(registerBody.errors).toBeUndefined();
    expect(registerBody.data?.registerWeb?.success).toBe(true);

    // 新公司与目标受管公司 ID 不同、未进入一级维护名单，因而不会出现在工程师候选
    const created = await organizationRepository
      .createQueryBuilder('organization')
      .where('organization.name = :name', { name: TARGET_NAME })
      .orderBy('organization.id', 'DESC')
      .getMany();
    expect(created.length).toBeGreaterThanOrEqual(2);
    const selfFilled = created[0];
    const managed = created[created.length - 1];
    expect(selfFilled.id).not.toBe(managed.id);
    expect(selfFilled.isManagedCompany).toBe(false);
    expect(managed.isManagedCompany).toBe(true);

    // 新账号与成员关系登记到本轮台账，确保按真实外键顺序回收
    const accountId = registerBody.data?.registerWeb?.accountId;
    if (typeof accountId !== 'number') {
      throw new Error('手填公司注册成功但响应缺少 accountId');
    }
    const account = await dataSource.getRepository(AccountEntity).findOneOrFail({
      where: { id: accountId },
    });
    const userInfo = await dataSource.getRepository(UserInfoEntity).findOneOrFail({
      where: { accountId },
    });
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
      customerOrganizationId: selfFilled.id,
    });
    recordOwnedResource(ownership, 'organization', selfFilled.id, {
      organizationCode: selfFilled.organizationCode,
      name: selfFilled.name,
      kind: selfFilled.kind,
      status: selfFilled.status,
      isManagedCompany: Boolean(selfFilled.isManagedCompany),
    });
    const membership = await dataSource
      .getRepository(OrganizationMembershipEntity)
      .findOne({ where: { accountId, organizationId: selfFilled.id } });
    if (membership) {
      recordOwnedResource(ownership, 'membership', membership.id, {
        organizationId: selfFilled.id,
        accountId,
        memberRole: membership.memberRole,
        status: membership.status,
      });
    }

    // 新公司不具备注册候选资格（未受管）
    const firstPage = await queryFirstCandidatePage();
    expect(firstPage.items.some((item) => item.id === selfFilled.id)).toBe(false);
  });
});
