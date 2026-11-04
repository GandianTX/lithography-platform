// test/06-repair-request/repair-request-accept.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { TokenHelper } from '@src/modules/auth/token.helper';
import { AudienceTypeEnum, IdentityTypeEnum } from '@app-types/models/account.types';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { login, postGql } from '../utils/e2e-graphql-utils';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import {
  REPAIR_REQUEST_FIXTURE_ACCOUNTS,
  REPAIR_REQUEST_FIXTURE_MARKERS,
  cleanupRepairRequestFixtureByIds,
  cleanupRepairRequestFixtureResidue,
  createRepairRequestFixtureModel,
  createRepairRequestFixtureOwnership,
  createRepairRequestFixtureRequest,
  runRepairRequestFixtureTeardown,
  seedRepairRequestFixtureAccounts,
  seedRepairRequestFixtureOrganizationScope,
  type RepairRequestFixtureOwnership,
  type RepairRequestFixtureRequestSeed,
} from './repair-request-fixture';

const ACCEPT_MUTATION = `
  mutation AcceptRepairRequest($id: Int!) {
    acceptRepairRequest(id: $id) {
      id
      requestNo
      errorCode
      createdAt
      isAccepted
      acceptedAt
      latestResolutionStatus
      equipmentModel { id modelCode modelName }
      responses { id engineerNickname resolutionStatus responseText createdAt }
    }
  }
`;

const ENGINEER_DETAIL_QUERY = `
  query EngineerRepairRequest($id: Int!) {
    engineerRepairRequest(id: $id) {
      id
      isAccepted
      acceptedAt
      acceptanceViewStatus
      acceptedEngineerNickname
      customerNickname
    }
  }
`;

const DELETE_MUTATION = `
  mutation DeleteMyRepairRequest($id: Int!) {
    deleteMyRepairRequest(id: $id) { id requestNo }
  }
`;

const ENGINEER_LIST_QUERY = `
  query EngineerRepairRequests($scope: String!, $pagination: PaginationArgs!, $filter: EngineerRepairRequestFilterInput) {
    engineerRepairRequests(scope: $scope, pagination: $pagination, filter: $filter) {
      items { id isAccepted acceptedAt }
      total
    }
  }
`;

const OFFSET_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };

/**
 * 工程师接单写链路回归（core 组）
 *
 * 与 read/flow spec 分工：本文件只覆盖 acceptRepairRequest Mutation：
 * - 成功路径：AVAILABLE → MINE、响应复用工程师详情读模型、
 *   数据库三个接单字段（is_accepted / accepted_by_engineer_account_id / accepted_at）
 *   与后端生成口径（接单人与时间均不可由客户端传入）
 * - 权限矩阵：CUSTOMER / SUPER_ADMIN / 未登录（写入口精确 ENGINEER，读继承不等于写继承）
 * - 混合角色（accessGroup=[SUPER_ADMIN, ENGINEER]）：所有 Token 均经真实登录/JWT 签发链路，
 *   通过测试造数阶段切换账号 identityHint 分别获得 activeRole=SUPER_ADMIN 与
 *   activeRole=ENGINEER 两个合法 Token；另有经 TokenHelper（项目真实签发入口）签发、
 *   合法签名但无 activeRole 的兼容性 Token：仅 activeRole=ENGINEER 的 Token 可接单
 * - 错误分类：不存在/已删除 → NOT_FOUND；已接单（含本人重复接单）→ CONFLICT，文案中性
 * - 并发竞争：两名工程师抢单，以及客户删除与工程师接单竞争，数据库终态只能有一个赢家
 *
 * 数据安全：本 spec 只创建/清理**专属夹具**（专属账号 + 专属接单型号 + 专属编号申请），
 * 主键由数据库生成并在运行期记录；工程师列表断言一律用专属 equipmentModelId 收敛，
 * 不依赖 global-setup 的全表 TRUNCATE，也不做任何整表删除。
 */
describe('工程师接单写链路 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let engineerToken: string;
  let otherEngineerToken: string;
  let customerToken: string;
  let adminToken: string;
  let hybridTokenSuperAdmin: string;
  let hybridTokenEngineer: string;
  let noActiveRoleToken: string;
  let engineerAccountId: number;
  let otherEngineerAccountId: number;
  let customerAccountId: number;
  let crossOrgCustomerAccountId: number;
  let hybridAccountId: number;
  let primaryOrganizationId: number;
  let peerOrganizationId: number;
  let acceptModelId: number;
  let successTargetId: number;
  let conflictTargetId: number;
  let deletedTargetId: number;
  let permissionTargetId: number;
  let hybridRejectTargetId: number;
  let hybridSuccessTargetId: number;
  let noActiveRoleTargetId: number;
  /** 归属 peer 组织（跨组织）的未接单申请 */
  let crossOrgTargetId: number;
  /** 无归属存量（NULL）未接单申请 */
  let nullOwnerTargetId: number;
  const ownership: RepairRequestFixtureOwnership = createRepairRequestFixtureOwnership();
  /** 仅当 beforeAll 在「写夹具之前」完成白名单验证才置位，afterAll 据此决定能否清理 */
  let fixtureTargetValidated = false;

  const acceptMutation = (token: string | undefined, id: number) =>
    postGql({ app, query: ACCEPT_MUTATION, variables: { id }, token });

  const expectForbidden = (error: unknown): void => {
    const err = error as { extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('FORBIDDEN');
    expect(err.extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  };

  const expectUnauthenticated = (error: unknown): void => {
    const err = error as { extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('UNAUTHENTICATED');
    expect(err.extensions.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
  };

  const buildRequestSeed = (params: {
    markerIndex: number;
    faultDescription: string;
    errorCode: string;
    contentMd: string;
    createdAt: Date;
    isAccepted?: boolean;
    acceptedByEngineerAccountId?: number | null;
    acceptedAt?: Date | null;
    deprecated?: boolean;
    deletedAt?: Date | null;
    /** 默认客户端为夹具客户甲；跨组织场景显式传 peer 组织客户 */
    customerAccountId?: number;
    /** 省略 = 同组织正常场景；null = 无归属存量旧工单；peer 组织 ID = 跨组织场景 */
    ownerOrganizationId?: number | null;
  }): RepairRequestFixtureRequestSeed => ({
    requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.acceptRequestNos[params.markerIndex],
    customerAccountId: params.customerAccountId ?? customerAccountId,
    equipmentModelId: acceptModelId,
    ownerOrganizationId:
      params.ownerOrganizationId === undefined ? primaryOrganizationId : params.ownerOrganizationId,
    errorCode: params.errorCode,
    faultDescription: params.faultDescription,
    contentMd: params.contentMd,
    createdAt: params.createdAt,
    isAccepted: params.isAccepted ?? false,
    acceptedByEngineerAccountId: params.acceptedByEngineerAccountId ?? null,
    acceptedAt: params.acceptedAt ?? null,
    deprecated: params.deprecated ?? false,
    deletedAt: params.deletedAt ?? null,
  });

  const loginWithTemporaryHybridIdentityHint = async (
    authenticate: () => Promise<string>,
  ): Promise<string> => {
    const accountRepo = dataSource.getRepository(AccountEntity);
    await accountRepo.update(
      { id: hybridAccountId },
      { identityHint: IdentityTypeEnum.SUPER_ADMIN },
    );
    try {
      return await authenticate();
    } finally {
      await accountRepo.update(
        { id: hybridAccountId },
        { identityHint: IdentityTypeEnum.ENGINEER },
      );
    }
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    // 🔒 第一条写/删除之前复用不可跳过的目标库白名单守卫
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    fixtureTargetValidated = true;
    // 先按专属标记 + 完整归属校验回收上轮崩溃残留；无残留时 no-op（连跑两遍幂等）
    await cleanupRepairRequestFixtureResidue(dataSource);

    const accounts = await seedRepairRequestFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    engineerAccountId = accounts.engineerA;
    otherEngineerAccountId = accounts.engineerB;
    customerAccountId = accounts.customerA;
    crossOrgCustomerAccountId = accounts.crossOrgCustomer;
    hybridAccountId = accounts.hybrid;

    // 本轮专属组织与唯一 ACTIVE 成员关系：primary 承载同组织场景，peer 承载跨组织场景
    const organizationScope = await seedRepairRequestFixtureOrganizationScope({
      dataSource,
      ownership,
      accountIds: accounts,
    });
    primaryOrganizationId = organizationScope.primaryOrganizationId;
    peerOrganizationId = organizationScope.peerOrganizationId;

    engineerToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerA.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerA.loginPassword,
    });
    otherEngineerToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerB.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerB.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerA.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerA.loginPassword,
    });
    adminToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.admin.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.admin.loginPassword,
    });

    // 混合角色账号：先以造数 identityHint=ENGINEER 登录，得到 activeRole=ENGINEER 的 Token B；
    // 再临时切换 identityHint=SUPER_ADMIN 后重新登录，得到 activeRole=SUPER_ADMIN 的 Token A
    // （两条 Token 都经过真实登录/JWT 签发链路），签发完成后立即还原 identityHint=ENGINEER，
    // 使夹具归属核验（identityHint 必须等于造数期望）保持一致。
    hybridTokenEngineer = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.hybrid.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.hybrid.loginPassword,
    });
    hybridTokenSuperAdmin = await loginWithTemporaryHybridIdentityHint(() =>
      login({
        app,
        loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.hybrid.loginName,
        loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.hybrid.loginPassword,
      }),
    );

    // 合法签名但无 activeRole 的兼容性 Token：使用项目真实签发入口 TokenHelper，
    // 不伪造无签名 Token；当前登录链路仅在 accessGroup 非空时写入 activeRole，
    // 此处模拟兼容旧 Token 的场景用于验证失败关闭
    const hybridNickname = (
      await dataSource.getRepository(UserInfoEntity).findOneByOrFail({ accountId: hybridAccountId })
    ).nickname;
    noActiveRoleToken = app.get(TokenHelper).generateAccessToken({
      payload: {
        sub: hybridAccountId,
        username: hybridNickname,
        email: REPAIR_REQUEST_FIXTURE_ACCOUNTS.hybrid.loginEmail,
        accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
      },
      audience: AudienceTypeEnum.DESKTOP,
    });

    acceptModelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'accept' });

    // 131 未接单（成功路径目标）；132 已被工程师甲接单（冲突/重复接单目标）；
    // 133 已删除未接单（NOT_FOUND 目标）；134 未接单（权限拒绝目标，全程不产生写入）；
    // 137 混合角色 activeRole=SUPER_ADMIN 拒绝目标（全程不产生写入）；
    // 138 混合角色 activeRole=ENGINEER 接单成功目标；
    // 139 无 activeRole 兼容性 Token 拒绝目标（全程不产生写入）
    successTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 0,
        faultDescription: '接单成功场景',
        errorCode: 'E-3001',
        contentMd: '# E2E-AC-131',
        createdAt: new Date('2026-08-30T01:00:00.000Z'),
      }),
    });
    conflictTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 1,
        faultDescription: '已被接单场景',
        errorCode: 'E-3002',
        contentMd: '# E2E-AC-132',
        createdAt: new Date('2026-08-30T02:00:00.000Z'),
        isAccepted: true,
        acceptedByEngineerAccountId: engineerAccountId,
        acceptedAt: new Date('2026-08-30T03:00:00.000Z'),
      }),
    });
    deletedTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 2,
        faultDescription: '已删除场景',
        errorCode: 'E-3003',
        contentMd: '# E2E-AC-133',
        createdAt: new Date('2026-08-30T04:00:00.000Z'),
        deprecated: true,
        deletedAt: new Date('2026-08-30T05:00:00.000Z'),
      }),
    });
    permissionTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 3,
        faultDescription: '权限拒绝场景',
        errorCode: 'E-3004',
        contentMd: '# E2E-AC-134',
        createdAt: new Date('2026-08-30T06:00:00.000Z'),
      }),
    });
    hybridRejectTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 6,
        faultDescription: '混合角色 activeRole=SUPER_ADMIN 拒绝场景',
        errorCode: 'E-3007',
        contentMd: '# E2E-AC-137',
        createdAt: new Date('2026-08-30T09:00:00.000Z'),
      }),
    });
    hybridSuccessTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 7,
        faultDescription: '混合角色 activeRole=ENGINEER 接单成功场景',
        errorCode: 'E-3008',
        contentMd: '# E2E-AC-138',
        createdAt: new Date('2026-08-30T10:00:00.000Z'),
      }),
    });
    noActiveRoleTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 8,
        faultDescription: '无 activeRole 兼容性 Token 拒绝场景',
        errorCode: 'E-3009',
        contentMd: '# E2E-AC-139',
        createdAt: new Date('2026-08-30T11:00:00.000Z'),
      }),
    });
    // 141 归属 peer 组织（跨组织）：主组织工程师接单必须失败关闭，且目标逐字段不变
    crossOrgTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 10,
        customerAccountId: crossOrgCustomerAccountId,
        ownerOrganizationId: peerOrganizationId,
        faultDescription: '跨组织接单拒绝场景',
        errorCode: 'E-3011',
        contentMd: '# E2E-AC-141',
        createdAt: new Date('2026-08-31T01:00:00.000Z'),
      }),
    });
    // 142 无归属存量（NULL）：解析不到同组织事实，接单必须失败关闭且零写入
    nullOwnerTargetId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: buildRequestSeed({
        markerIndex: 11,
        ownerOrganizationId: null,
        faultDescription: '无归属存量接单拒绝场景',
        errorCode: 'E-3012',
        contentMd: '# E2E-AC-142',
        createdAt: new Date('2026-08-31T02:00:00.000Z'),
      }),
    });
  }, 60000);

  afterAll(async () => {
    // 守卫拒绝 / 装配失败 / DataSource 未就绪 → 只关闭 app；精确清理失败仍关闭 app 且不吞错
    await runRepairRequestFixtureTeardown({
      app,
      dataSource,
      targetValidated: fixtureTargetValidated,
      cleanup: (ds) => cleanupRepairRequestFixtureByIds(ds, ownership),
    });
  });

  describe('权限矩阵', () => {
    it('CUSTOMER 调接单被守卫拒绝（写入口精确 ENGINEER）', async () => {
      const response = await acceptMutation(customerToken, permissionTargetId).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectForbidden(response.body.errors[0]);

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: permissionTargetId } });
      expect(row.isAccepted).toBe(false);
      expect(row.acceptedByEngineerAccountId).toBeNull();
      expect(row.acceptedAt).toBeNull();
    });

    it('SUPER_ADMIN 调接单被守卫拒绝（读权限继承不等于写权限继承）', async () => {
      const response = await acceptMutation(adminToken, permissionTargetId).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectForbidden(response.body.errors[0]);

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: permissionTargetId } });
      expect(row.isAccepted).toBe(false);
    });

    it('未登录调接单返回 UNAUTHENTICATED', async () => {
      const response = await acceptMutation(undefined, permissionTargetId).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectUnauthenticated(response.body.errors[0]);
    });
  });

  it('临时 identityHint 登录失败时仍恢复账号字段，夹具可继续安全收尾', async () => {
    await expect(
      loginWithTemporaryHybridIdentityHint(() =>
        Promise.reject(new Error('injected login failure')),
      ),
    ).rejects.toThrow('injected login failure');

    const account = await dataSource
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: hybridAccountId });
    expect(account.identityHint).toBe(IdentityTypeEnum.ENGINEER);
  });

  describe('混合角色 activeRole 精确准入（accessGroup=[SUPER_ADMIN, ENGINEER]）', () => {
    it('activeRole=SUPER_ADMIN 的合法 Token 被拒绝（守卫准入不等于接单写权限）', async () => {
      const response = await acceptMutation(hybridTokenSuperAdmin, hybridRejectTargetId).expect(
        200,
      );

      expect(response.body.errors).toHaveLength(1);
      expectForbidden(response.body.errors[0]);

      // 拒绝路径不启动事务，数据库三个接单字段完全未改变
      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: hybridRejectTargetId } });
      expect(row.isAccepted).toBe(false);
      expect(row.acceptedByEngineerAccountId).toBeNull();
      expect(row.acceptedAt).toBeNull();
    });

    it('activeRole=ENGINEER 的合法 Token 接单成功：接单人等于该账号，三个接单字段一致', async () => {
      const response = await acceptMutation(hybridTokenEngineer, hybridSuccessTargetId).expect(200);

      expect(response.body.errors).toBeUndefined();
      const detail = response.body.data.acceptRepairRequest;
      expect(detail).toMatchObject({
        id: hybridSuccessTargetId,
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.acceptRequestNos[7],
        isAccepted: true,
      });
      expect(detail.acceptedAt).not.toBeNull();

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: hybridSuccessTargetId } });
      expect(row.isAccepted).toBe(true);
      expect(row.acceptedByEngineerAccountId).toBe(hybridAccountId);
      expect(row.acceptedAt).not.toBeNull();
    });

    it('合法签名但无 activeRole 的兼容性 Token 被拒绝（失败关闭），数据库不产生写入', async () => {
      const response = await acceptMutation(noActiveRoleToken, noActiveRoleTargetId).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectForbidden(response.body.errors[0]);

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: noActiveRoleTargetId } });
      expect(row.isAccepted).toBe(false);
      expect(row.acceptedByEngineerAccountId).toBeNull();
      expect(row.acceptedAt).toBeNull();
    });
  });

  describe('错误分类', () => {
    it('接单不存在的申请返回 NOT_FOUND', async () => {
      const response = await acceptMutation(engineerToken, 999999).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');
      // 前端契约依赖点：业务消息只读 extensions.errorMessage
      expect(typeof response.body.errors[0].extensions.errorMessage).toBe('string');
      expect(response.body.errors[0].extensions.errorMessage.length).toBeGreaterThan(0);
    });

    it('接单已删除的申请统一返回 NOT_FOUND（防探测，不区分不存在与已删除）', async () => {
      const response = await acceptMutation(engineerToken, deletedTargetId).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');

      // 不产生写入：已删除申请的接单状态保持原样
      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: deletedTargetId } });
      expect(row.isAccepted).toBe(false);
      expect(row.acceptedByEngineerAccountId).toBeNull();
    });

    it('接单已被他人接单的申请返回 CONFLICT', async () => {
      const response = await acceptMutation(otherEngineerToken, conflictTargetId).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_ALREADY_ACCEPTED');

      // 冲突不覆盖原接单人
      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: conflictTargetId } });
      expect(row.acceptedByEngineerAccountId).toBe(engineerAccountId);
    });

    it('本人重复接单同样 CONFLICT，文案与他人的接单冲突中性一致', async () => {
      const selfResponse = await acceptMutation(engineerToken, conflictTargetId).expect(200);
      const otherResponse = await acceptMutation(otherEngineerToken, conflictTargetId).expect(200);

      const selfError = selfResponse.body.errors[0];
      const otherError = otherResponse.body.errors[0];
      expect(selfError.extensions.code).toBe('CONFLICT');
      expect(selfError.extensions.errorCode).toBe('REPAIR_REQUEST_ALREADY_ACCEPTED');
      // 中性文案：不区分本人重复接单与他人接单，不泄漏接单工程师身份
      expect(selfError.extensions.errorMessage).toBe(otherError.extensions.errorMessage);
      // 错误 details 仅含 requestId，不含接单人与身份类字段
      expect(selfError.extensions.details).toEqual({ requestId: conflictTargetId });
      expect(JSON.stringify(selfError)).not.toContain('engineerAccountId');
    });
  });

  describe('组织范围（跨组织与无归属存量）', () => {
    it('主组织工程师接单 peer 组织工单失败关闭：与不存在同口径且目标逐字段不变', async () => {
      const missingResponse = await acceptMutation(engineerToken, 999999).expect(200);
      const crossOrgResponse = await acceptMutation(engineerToken, crossOrgTargetId).expect(200);

      // 与不存在目标一致：同一 code / errorCode / 文案，不泄露目标是否存在
      expect(crossOrgResponse.body.errors).toHaveLength(1);
      const crossOrgError = crossOrgResponse.body.errors[0];
      expect(crossOrgError.extensions.code).toBe('NOT_FOUND');
      expect(crossOrgError.extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');
      expect(crossOrgError.message).toBe(missingResponse.body.errors[0].message);
      expect(crossOrgError.extensions.errorMessage).toBe(
        missingResponse.body.errors[0].extensions.errorMessage,
      );

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: crossOrgTargetId } });
      expect(row.ownerOrganizationId).toBe(peerOrganizationId);
      expect(row.isAccepted).toBe(false);
      expect(row.acceptedByEngineerAccountId).toBeNull();
      expect(row.acceptedAt).toBeNull();
      expect(row.deprecated).toBe(false);
      expect(row.deletedAt).toBeNull();
    });

    it('主组织工程师接单无归属存量（NULL）工单失败关闭：不产生写入', async () => {
      const response = await acceptMutation(engineerToken, nullOwnerTargetId).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: nullOwnerTargetId } });
      expect(row.ownerOrganizationId).toBeNull();
      expect(row.isAccepted).toBe(false);
      expect(row.acceptedByEngineerAccountId).toBeNull();
      expect(row.acceptedAt).toBeNull();
    });
  });

  describe('成功路径（AVAILABLE → MINE）', () => {
    it('接单成功：响应复用工程师详情读模型，数据库三个接单字段正确', async () => {
      const response = await acceptMutation(engineerToken, successTargetId).expect(200);

      expect(response.body.errors).toBeUndefined();
      const detail = response.body.data.acceptRepairRequest;
      expect(detail).toMatchObject({
        id: successTargetId,
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.acceptRequestNos[0],
        isAccepted: true,
      });
      expect(detail.acceptedAt).not.toBeNull();
      // 接单成功后申请仍无回复，读模型字段齐全
      expect(detail.responses).toEqual([]);

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: successTargetId } });
      expect(row.isAccepted).toBe(true);
      expect(row.acceptedByEngineerAccountId).toBe(engineerAccountId);
      expect(row.acceptedAt).not.toBeNull();
    });

    it('接单后 AVAILABLE 范围移除该申请，MINE 范围收录该申请', async () => {
      const available = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: {
          scope: 'AVAILABLE',
          pagination: OFFSET_PAGINATION,
          filter: { equipmentModelId: acceptModelId },
        },
        token: engineerToken,
      }).expect(200);
      expect(
        available.body.data.engineerRepairRequests.items.some(
          (item: { id: number }) => item.id === successTargetId,
        ),
      ).toBe(false);

      const mine = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: {
          scope: 'MINE',
          pagination: OFFSET_PAGINATION,
          filter: { equipmentModelId: acceptModelId },
        },
        token: engineerToken,
      }).expect(200);
      const mineItem = mine.body.data.engineerRepairRequests.items.find(
        (item: { id: number }) => item.id === successTargetId,
      );
      expect(mineItem).toBeDefined();
      expect(mineItem.isAccepted).toBe(true);
      expect(mineItem.acceptedAt).not.toBeNull();
    });
  });

  describe('并发竞争', () => {
    it('两名工程师真实并发接单同一申请：仅一方成功，数据库最终只有一个接单人', async () => {
      const targetId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: buildRequestSeed({
          markerIndex: 4,
          faultDescription: '并发竞争场景',
          errorCode: 'E-3005',
          contentMd: '# E2E-AC-135',
          createdAt: new Date('2026-08-30T07:00:00.000Z'),
        }),
      });

      // 同一事件循环真实并发发出两个 Mutation，不做任何先后编排
      const [first, second] = await Promise.all([
        acceptMutation(engineerToken, targetId),
        acceptMutation(otherEngineerToken, targetId),
      ]);

      const bodies = [first.body, second.body];
      const successBodies = bodies.filter((body) => body.data?.acceptRepairRequest);
      const conflictBodies = bodies.filter((body) => body.errors?.length > 0);

      // 恰好一方成功、一方冲突（胜负顺序不固定）
      expect(successBodies).toHaveLength(1);
      expect(conflictBodies).toHaveLength(1);
      expect(successBodies[0].data.acceptRepairRequest.isAccepted).toBe(true);
      expect(conflictBodies[0].errors[0].extensions.code).toBe('CONFLICT');
      expect(conflictBodies[0].errors[0].extensions.errorCode).toBe(
        'REPAIR_REQUEST_ALREADY_ACCEPTED',
      );

      // 数据库终态：有且仅有一个接单人；接单人 ID 不在响应 DTO 中（契约防泄漏），
      // 胜负与接单人身份以数据库为准，来自会话而非客户端传入
      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: targetId } });
      expect(row.isAccepted).toBe(true);
      expect([engineerAccountId, otherEngineerAccountId]).toContain(
        row.acceptedByEngineerAccountId,
      );
      expect(row.acceptedAt).not.toBeNull();
    });

    it('客户删除与工程师接单真实并发同一申请：仅一方成功，数据库终态互斥', async () => {
      const targetId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: buildRequestSeed({
          markerIndex: 5,
          faultDescription: '删除与接单并发竞争场景',
          errorCode: 'E-3006',
          contentMd: '# E2E-AC-136',
          createdAt: new Date('2026-08-30T08:00:00.000Z'),
        }),
      });

      const [acceptResponse, deleteResponse] = await Promise.all([
        acceptMutation(engineerToken, targetId),
        postGql({
          app,
          query: DELETE_MUTATION,
          variables: { id: targetId },
          token: customerToken,
        }),
      ]);

      const acceptSucceeded = Boolean(acceptResponse.body.data?.acceptRepairRequest);
      const deleteSucceeded = Boolean(deleteResponse.body.data?.deleteMyRepairRequest);
      expect(Number(acceptSucceeded) + Number(deleteSucceeded)).toBe(1);

      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: targetId } });
      if (acceptSucceeded) {
        expect(deleteResponse.body.errors[0].extensions.code).toBe('CONFLICT');
        expect(deleteResponse.body.errors[0].extensions.errorCode).toBe(
          'REPAIR_REQUEST_ALREADY_ACCEPTED',
        );
        expect(row).toMatchObject({
          isAccepted: true,
          acceptedByEngineerAccountId: engineerAccountId,
          deprecated: false,
          deletedAt: null,
        });
        expect(row.acceptedAt).not.toBeNull();
      } else {
        expect(acceptResponse.body.errors[0].extensions.code).toBe('NOT_FOUND');
        expect(acceptResponse.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');
        expect(row).toMatchObject({
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: true,
        });
        expect(row.deletedAt).not.toBeNull();
      }

      expect(row.isAccepted && row.deprecated).toBe(false);
    });

    it('并发接单失败方重读详情：看到真实接单工程师与接单时间（不覆盖成功方）', async () => {
      const targetId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: buildRequestSeed({
          markerIndex: 9,
          faultDescription: '失败方重读场景',
          errorCode: 'E-3010',
          contentMd: '# E2E-AC-140',
          createdAt: new Date('2026-08-30T12:00:00.000Z'),
        }),
      });

      const [first, second] = await Promise.all([
        acceptMutation(engineerToken, targetId),
        acceptMutation(otherEngineerToken, targetId),
      ]);
      const loserToken = first.body.errors?.length > 0 ? engineerToken : otherEngineerToken;
      const conflictBody = first.body.errors?.length > 0 ? first.body : second.body;
      expect(conflictBody.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_ALREADY_ACCEPTED');

      // 失败方重读真实状态：接单工程师昵称与接单时间来自后端，与数据库一致
      const row = await dataSource
        .getRepository(RepairRequestEntity)
        .findOneOrFail({ where: { id: targetId } });
      expect(row.acceptedByEngineerAccountId).not.toBeNull();
      const winnerNickname = await dataSource
        .getRepository(UserInfoEntity)
        .findOneOrFail({ where: { accountId: row.acceptedByEngineerAccountId! } })
        .then((info) => info.nickname.trim());
      expect(winnerNickname).toBeTruthy();

      const reread = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: targetId },
        token: loserToken,
      }).expect(200);

      expect(reread.body.errors).toBeUndefined();
      expect(reread.body.data.engineerRepairRequest).toMatchObject({
        id: targetId,
        isAccepted: true,
        acceptanceViewStatus: 'TAKEN_BY_OTHER',
        acceptedEngineerNickname: winnerNickname,
      });
      expect(reread.body.data.engineerRepairRequest.acceptedAt).not.toBeNull();
    });
  });
});
