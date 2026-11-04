// test/06-repair-request/repair-request-read.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { App } from 'supertest/types';
import { DataSource, In } from 'typeorm';
import { login, postGql } from '../utils/e2e-graphql-utils';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import {
  REPAIR_REQUEST_FIXTURE_ACCOUNTS,
  REPAIR_REQUEST_FIXTURE_MARKERS,
  REPAIR_REQUEST_FIXTURE_MODELS,
  cleanupRepairRequestFixtureByIds,
  cleanupRepairRequestFixtureResidue,
  createRepairRequestFixtureModel,
  createRepairRequestFixtureOwnership,
  createRepairRequestFixtureRequest,
  createRepairRequestFixtureResponse,
  runRepairRequestFixtureTeardown,
  seedRepairRequestFixtureAccounts,
  seedRepairRequestFixtureOrganizationScope,
  type RepairRequestFixtureOwnership,
} from './repair-request-fixture';

const MY_LIST_QUERY = `
  query MyRepairRequests($pagination: PaginationArgs!) {
    myRepairRequests(pagination: $pagination) {
      items {
        id
        requestNo
        errorCode
        createdAt
        isAccepted
        acceptedAt
        latestResolutionStatus
        equipmentModel { id modelCode modelName }
      }
      total
      page
      pageSize
    }
  }
`;

const ENGINEER_LIST_QUERY = `
  query EngineerRepairRequests($scope: String, $pagination: PaginationArgs!, $filter: EngineerRepairRequestFilterInput) {
    engineerRepairRequests(scope: $scope, pagination: $pagination, filter: $filter) {
      items {
        id
        requestNo
        isAccepted
        acceptedAt
        latestResolutionStatus
        customerNickname
        customerCompanyName
        acceptanceViewStatus
        acceptedEngineerNickname
        equipmentModel { id modelCode modelName }
      }
      total
      page
      pageSize
    }
  }
`;

// 详情入口按角色分开（负责人 20260901 裁定）：同 DTO，不同 Guard/数据范围
const MY_DETAIL_QUERY = `
  query MyRepairRequest($id: Int!) {
    myRepairRequest(id: $id) {
      id
      requestNo
      errorCode
      faultDescription
      contentMd
      createdAt
      isAccepted
      acceptedAt
      latestResolutionStatus
      customerNickname
      customerCompanyName
      acceptanceViewStatus
      acceptedEngineerNickname
      equipmentModel { id modelCode modelName }
      responses { id engineerNickname resolutionStatus responseText createdAt }
    }
  }
`;

const ENGINEER_DETAIL_QUERY = `
  query EngineerRepairRequest($id: Int!) {
    engineerRepairRequest(id: $id) {
      id
      requestNo
      errorCode
      faultDescription
      contentMd
      createdAt
      isAccepted
      acceptedAt
      latestResolutionStatus
      customerNickname
      customerCompanyName
      acceptanceViewStatus
      acceptedEngineerNickname
      equipmentModel { id modelCode modelName }
      responses { id engineerNickname resolutionStatus responseText createdAt }
    }
  }
`;

const OFFSET_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };

const READ_MODEL = REPAIR_REQUEST_FIXTURE_MODELS.read;

/**
 * 维修申请公共读模型回归（core 组）
 *
 * 覆盖负责人 20260901 裁定契约 + PR4 工程师列表/详情补齐：
 * - 客户列表仅本人且未删除；工程师四态（ALL 默认 / AVAILABLE / MINE / TAKEN_BY_OTHER）
 * - 工程师列表设备型号与客户昵称筛选（分页计数前完成）、OFFSET 分页与稳定排序
 * - 工程师详情任意未删除申请可读（AVAILABLE / MINE / TAKEN_BY_OTHER 视角），
 *   客户/接单工程师安全展示资料实时关联；写权限仍由写用例独立失败关闭
 * - 详情按角色分入口（myRepairRequest / engineerRepairRequest，含回复时间线、机型、末条状态口径）
 * - 回复返回工程师安全昵称（实时关联，缺失回落「工程师」）；不返回工程师账号 ID
 * - 双角色读权限矩阵 + 越权/已删除/不存在统一拒绝（防探测）
 * - 组织范围：同组织正常可读；跨组织工单对本组织不可见也不可读；
 *   无归属存量工单仅已接单的工程师本人可见（未接单的 NULL 归属不向任何人开放）
 * - SUPER_ADMIN 按角色继承规则准入；未登录与守卫角色准入；分页参数（OFFSET 强制、withTotal）
 *
 * 数据安全：本 spec 只创建/清理**专属夹具**（专属账号 + 专属组织与成员关系 + 专属型号
 * + 专属编号申请与回复），主键由数据库生成并在运行期记录；工程师列表断言一律用
 * 专属 equipmentModelId 收敛，不依赖 global-setup 的全表 TRUNCATE，也不做任何整表删除。
 */
describe('维修申请公共读模型 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let customerAToken: string;
  let customerBToken: string;
  let engineerAToken: string;
  let engineerBToken: string;
  let crossOrgCustomerToken: string;
  let crossOrgEngineerToken: string;
  let adminToken: string;
  let customerAAccountId: number;
  let customerBAccountId: number;
  let crossOrgCustomerAccountId: number;
  let engineerAAccountId: number;
  let engineerBAccountId: number;
  let crossOrgEngineerAccountId: number;
  let primaryOrganizationId: number;
  let peerOrganizationId: number;
  let readModelId: number;
  let unacceptedRequestId: number;
  let acceptedByEngineerARequestId: number;
  let deletedRequestId: number;
  let customerBUnacceptedRequestId: number;
  let customerBAcceptedByEngineerBRequestId: number;
  /** 归属 peer 组织（跨组织）的未接单申请 */
  let peerOrganizationRequestId: number;
  /** 无归属存量：已由跨组织工程师接单（仅该工程师本人可读） */
  let legacyAcceptedRequestId: number;
  /** 无归属存量：未接单（对任何工程师都不可见/不可读） */
  let legacyUnacceptedRequestId: number;
  let pendingResponseId: number;
  let resolvedResponseId: number;
  const ownership: RepairRequestFixtureOwnership = createRepairRequestFixtureOwnership();
  /** 仅当 beforeAll 在「写夹具之前」完成白名单验证才置位，afterAll 据此决定能否清理 */
  let fixtureTargetValidated = false;

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
    customerAAccountId = accounts.customerA;
    customerBAccountId = accounts.customerB;
    crossOrgCustomerAccountId = accounts.crossOrgCustomer;
    engineerAAccountId = accounts.engineerA;
    engineerBAccountId = accounts.engineerB;
    crossOrgEngineerAccountId = accounts.crossOrgEngineer;

    // 本轮专属组织与唯一 ACTIVE 成员关系：primary 承载同组织场景，peer 承载跨组织场景
    const organizationScope = await seedRepairRequestFixtureOrganizationScope({
      dataSource,
      ownership,
      accountIds: accounts,
    });
    primaryOrganizationId = organizationScope.primaryOrganizationId;
    peerOrganizationId = organizationScope.peerOrganizationId;

    customerAToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerA.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerA.loginPassword,
    });
    customerBToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerB.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerB.loginPassword,
    });
    engineerAToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerA.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerA.loginPassword,
    });
    engineerBToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerB.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerB.loginPassword,
    });
    crossOrgEngineerToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.crossOrgEngineer.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.crossOrgEngineer.loginPassword,
    });
    crossOrgCustomerToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.crossOrgCustomer.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.crossOrgCustomer.loginPassword,
    });
    adminToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.admin.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.admin.loginPassword,
    });

    readModelId = await createRepairRequestFixtureModel({
      dataSource,
      ownership,
      key: 'read',
    });
    // 客户甲未接单；客户甲由工程师甲接单（含两条回复）；客户甲已软删除；
    // 客户乙未接单（待接单池）；客户乙由工程师乙接单（他人已接单）
    unacceptedRequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
        customerAccountId: customerAAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: primaryOrganizationId,
        errorCode: 'E-1001',
        faultDescription: '未接单场景',
        contentMd: '# E2E-RR-111',
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });
    acceptedByEngineerARequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[1],
        customerAccountId: customerAAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: primaryOrganizationId,
        errorCode: 'E-1002',
        faultDescription: '本人接单场景',
        contentMd: '# E2E-RR-112',
        createdAt: new Date('2026-08-26T01:00:00.000Z'),
        isAccepted: true,
        acceptedByEngineerAccountId: engineerAAccountId,
        acceptedAt: new Date('2026-08-27T01:00:00.000Z'),
        deprecated: false,
        deletedAt: null,
      },
    });
    deletedRequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[2],
        customerAccountId: customerAAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: primaryOrganizationId,
        errorCode: 'E-1003',
        faultDescription: '已删除场景',
        contentMd: '# E2E-RR-113',
        createdAt: new Date('2026-08-27T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: true,
        deletedAt: new Date('2026-08-27T02:00:00.000Z'),
      },
    });
    customerBUnacceptedRequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[3],
        customerAccountId: customerBAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: primaryOrganizationId,
        errorCode: 'E-1004',
        faultDescription: '他人未接单场景',
        contentMd: '# E2E-RR-114',
        createdAt: new Date('2026-08-28T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });
    customerBAcceptedByEngineerBRequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[4],
        customerAccountId: customerBAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: primaryOrganizationId,
        errorCode: 'E-1005',
        faultDescription: '他人已接单场景',
        contentMd: '# E2E-RR-115',
        createdAt: new Date('2026-08-29T01:00:00.000Z'),
        isAccepted: true,
        acceptedByEngineerAccountId: engineerBAccountId,
        acceptedAt: new Date('2026-08-29T02:00:00.000Z'),
        deprecated: false,
        deletedAt: null,
      },
    });
    // 归属 peer 组织：跨组织场景（本组织工程师不可见/不可读）
    peerOrganizationRequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[7],
        customerAccountId: crossOrgCustomerAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: peerOrganizationId,
        errorCode: 'E-1008',
        faultDescription: '跨组织未接单场景',
        contentMd: '# E2E-RR-118',
        createdAt: new Date('2026-08-30T13:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });
    // 无归属存量：已由跨组织工程师接单（仅接单工程师本人可读）
    legacyAcceptedRequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[8],
        customerAccountId: crossOrgCustomerAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: null,
        errorCode: 'E-1009',
        faultDescription: '无归属存量本人已接单场景',
        contentMd: '# E2E-RR-119',
        createdAt: new Date('2026-08-30T14:00:00.000Z'),
        isAccepted: true,
        acceptedByEngineerAccountId: crossOrgEngineerAccountId,
        acceptedAt: new Date('2026-08-30T14:10:00.000Z'),
        deprecated: false,
        deletedAt: null,
      },
    });
    // 无归属存量：未接单（不因组织列缺失向任何工程师开放）
    legacyUnacceptedRequestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[9],
        customerAccountId: crossOrgCustomerAccountId,
        equipmentModelId: readModelId,
        ownerOrganizationId: null,
        errorCode: 'E-1010',
        faultDescription: '无归属存量未接单场景',
        contentMd: '# E2E-RR-120',
        createdAt: new Date('2026-08-30T15:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });
    pendingResponseId = await createRepairRequestFixtureResponse({
      dataSource,
      ownership,
      seed: {
        key: 'pending',
        requestId: acceptedByEngineerARequestId,
        engineerAccountId: engineerAAccountId,
        customerAccountId: customerAAccountId,
        resolutionStatus: EngineerResolutionStatus.PENDING,
        responseText: '已受理，排查中',
        createdAt: new Date('2026-08-27T02:00:00.000Z'),
      },
    });
    resolvedResponseId = await createRepairRequestFixtureResponse({
      dataSource,
      ownership,
      seed: {
        key: 'resolved',
        requestId: acceptedByEngineerARequestId,
        engineerAccountId: engineerAAccountId,
        customerAccountId: customerAAccountId,
        resolutionStatus: EngineerResolutionStatus.RESOLVED,
        responseText: '已更换部件，问题解决',
        createdAt: new Date('2026-08-27T03:00:00.000Z'),
      },
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

  const expectAccessDenied = (error: unknown): void => {
    const err = error as { extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('FORBIDDEN');
    expect(err.extensions.errorCode).toBe('ACCESS_DENIED');
  };

  const expectUnauthenticated = (error: unknown): void => {
    const err = error as { extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('UNAUTHENTICATED');
    expect(err.extensions.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
  };

  /** 工程师列表断言一律收敛到专属型号，避免受同库其它 spec 数据影响 */
  const engineerListVariables = (params: {
    pagination: Record<string, unknown>;
    scope?: string;
    filter?: Record<string, unknown>;
  }) => ({
    ...(params.scope !== undefined ? { scope: params.scope } : {}),
    pagination: params.pagination,
    filter: { equipmentModelId: readModelId, ...(params.filter ?? {}) },
  });

  describe('myRepairRequests 客户列表', () => {
    it('仅返回本人未删除申请，创建时间倒序，含机型与末条处理状态', async () => {
      const response = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: OFFSET_PAGINATION },
        token: customerAToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const page = response.body.data.myRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        acceptedByEngineerARequestId,
        unacceptedRequestId,
      ]);
      expect(page.total).toBe(2);
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(10);
      expect(page.items[0]).toMatchObject({
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[1],
        isAccepted: true,
        latestResolutionStatus: 'RESOLVED',
        equipmentModel: {
          id: readModelId,
          modelCode: READ_MODEL.modelCode,
          modelName: READ_MODEL.modelName,
        },
      });
      expect(page.items[1].latestResolutionStatus).toBeNull();
      // 契约防泄漏：输出不得含归属类账号 ID
      for (const item of page.items) {
        expect(item).not.toHaveProperty('customerAccountId');
        expect(item).not.toHaveProperty('acceptedByEngineerAccountId');
      }
    });

    it('分页参数生效（pageSize=1 第二页取到次新一条）', async () => {
      const response = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: { mode: 'OFFSET', page: 2, pageSize: 1, withTotal: true } },
        token: customerAToken,
      }).expect(200);

      const page = response.body.data.myRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([unacceptedRequestId]);
      expect(page.total).toBe(2);
      expect(page.page).toBe(2);
      expect(page.pageSize).toBe(1);
    });

    it('CURSOR 分页第一版拒绝', async () => {
      const response = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: { mode: 'CURSOR', limit: 5 } },
        token: customerAToken,
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_INVALID_PARAMS');
    });
  });

  const getNicknameByAccountId = async (accountId: number): Promise<string> => {
    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOne({ where: { accountId } });
    const nickname = userInfo?.nickname?.trim();
    expect(nickname).toBeTruthy();
    return nickname as string;
  };

  describe('engineerRepairRequests 四态与筛选', () => {
    it('缺省 scope 默认 ALL：仅返回未删除申请（含已接单/他人接单），排序稳定', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ pagination: OFFSET_PAGINATION }),
        token: engineerAToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        customerBAcceptedByEngineerBRequestId,
        customerBUnacceptedRequestId,
        acceptedByEngineerARequestId,
        unacceptedRequestId,
      ]);
      expect(page.total).toBe(4);
    });

    it('同 createdAt 申请按 id DESC 稳定排序（主键兜底序）', async () => {
      // 与 115 同刻创建：期望 [新2, 新1, 115, ...] 证明 id DESC 兜底生效
      const sameCreatedAt = new Date('2026-08-29T01:00:00.000Z');
      const firstSameId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: {
          requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[5],
          customerAccountId: customerAAccountId,
          equipmentModelId: readModelId,
          ownerOrganizationId: primaryOrganizationId,
          errorCode: 'E-1006',
          faultDescription: '同刻排序场景一',
          contentMd: '# E2E-RR-116',
          createdAt: sameCreatedAt,
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: false,
          deletedAt: null,
        },
      });
      const secondSameId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: {
          requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[6],
          customerAccountId: customerAAccountId,
          equipmentModelId: readModelId,
          ownerOrganizationId: primaryOrganizationId,
          errorCode: 'E-1007',
          faultDescription: '同刻排序场景二',
          contentMd: '# E2E-RR-117',
          createdAt: sameCreatedAt,
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: false,
          deletedAt: null,
        },
      });
      expect(secondSameId).toBeGreaterThan(firstSameId);
      try {
        const response = await postGql({
          app,
          query: ENGINEER_LIST_QUERY,
          variables: engineerListVariables({ pagination: OFFSET_PAGINATION }),
          token: engineerAToken,
        }).expect(200);

        expect(response.body.errors).toBeUndefined();
        const page = response.body.data.engineerRepairRequests;
        expect(page.items.map((item: { id: number }) => item.id)).toEqual([
          secondSameId,
          firstSameId,
          customerBAcceptedByEngineerBRequestId,
          customerBUnacceptedRequestId,
          acceptedByEngineerARequestId,
          unacceptedRequestId,
        ]);
        expect(page.total).toBe(6);
      } finally {
        // 清理本用例造数（按本轮记录 ID，逐主键删除），不影响后续用例对种子集合的精确断言
        await dataSource
          .getRepository(RepairRequestEntity)
          .delete({ id: In([firstSameId, secondSameId]) });
      }
    });

    it('AVAILABLE 范围仅返回未删除且未接单的申请', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({
          scope: 'AVAILABLE',
          pagination: OFFSET_PAGINATION,
        }),
        token: engineerAToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        customerBUnacceptedRequestId,
        unacceptedRequestId,
      ]);
      expect(page.items.every((item: { isAccepted: boolean }) => item.isAccepted === false)).toBe(
        true,
      );
    });

    it('MINE 范围仅返回本人已接单的申请', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'MINE', pagination: OFFSET_PAGINATION }),
        token: engineerAToken,
      }).expect(200);

      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        acceptedByEngineerARequestId,
      ]);
      expect(page.items[0].acceptedAt).not.toBeNull();
      expect(page.items[0].acceptanceViewStatus).toBe('MINE');
    });

    it('另一位工程师的 MINE 范围互不串扰', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'MINE', pagination: OFFSET_PAGINATION }),
        token: engineerBToken,
      }).expect(200);

      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        customerBAcceptedByEngineerBRequestId,
      ]);
    });

    it('TAKEN_BY_OTHER 范围按当前会话判定他人已接单申请', async () => {
      const engineerAView = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({
          scope: 'TAKEN_BY_OTHER',
          pagination: OFFSET_PAGINATION,
        }),
        token: engineerAToken,
      }).expect(200);
      expect(
        engineerAView.body.data.engineerRepairRequests.items.map((i: { id: number }) => i.id),
      ).toEqual([customerBAcceptedByEngineerBRequestId]);

      // 工程师乙视角下，客户甲被甲接单的申请才是他人已接单
      const engineerBView = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({
          scope: 'TAKEN_BY_OTHER',
          pagination: OFFSET_PAGINATION,
        }),
        token: engineerBToken,
      }).expect(200);
      expect(
        engineerBView.body.data.engineerRepairRequests.items.map((i: { id: number }) => i.id),
      ).toEqual([acceptedByEngineerARequestId]);
    });

    it('列表项富集客户昵称/公司与接单工程师昵称，视角状态按会话计算', async () => {
      const customerANickname = await getNicknameByAccountId(customerAAccountId);
      const engineerBNickname = await getNicknameByAccountId(engineerBAccountId);
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'ALL', pagination: OFFSET_PAGINATION }),
        token: engineerAToken,
      }).expect(200);

      const items = response.body.data.engineerRepairRequests.items;
      const itemTakenByOther = items.find(
        (i: { id: number }) => i.id === customerBAcceptedByEngineerBRequestId,
      );
      expect(itemTakenByOther).toMatchObject({
        customerNickname: await getNicknameByAccountId(customerBAccountId),
        acceptanceViewStatus: 'TAKEN_BY_OTHER',
        acceptedEngineerNickname: engineerBNickname,
      });
      const itemAvailable = items.find((i: { id: number }) => i.id === unacceptedRequestId);
      expect(itemAvailable).toMatchObject({
        customerNickname: customerANickname,
        acceptanceViewStatus: 'AVAILABLE',
        acceptedEngineerNickname: null,
      });
      // 契约防泄漏：输出不得含归属类账号 ID
      for (const item of items) {
        expect(item).not.toHaveProperty('customerAccountId');
        expect(item).not.toHaveProperty('acceptedByEngineerAccountId');
      }
    });

    it('设备型号筛选（等值）参与 total 计算与分页', async () => {
      const matched = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'ALL', pagination: OFFSET_PAGINATION }),
        token: engineerAToken,
      }).expect(200);
      expect(matched.body.data.engineerRepairRequests.total).toBe(4);

      const unmatched = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: {
          scope: 'ALL',
          pagination: OFFSET_PAGINATION,
          filter: { equipmentModelId: 999999 },
        },
        token: engineerAToken,
      }).expect(200);
      expect(unmatched.body.data.engineerRepairRequests).toMatchObject({
        items: [],
        total: 0,
      });
    });

    it('客户昵称关键词筛选命中对应客户的申请（分页计数前完成筛选）', async () => {
      const customerBNickname = await getNicknameByAccountId(customerBAccountId);
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: {
          scope: 'ALL',
          pagination: OFFSET_PAGINATION,
          filter: { customerNickname: customerBNickname },
        },
        token: engineerAToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        customerBAcceptedByEngineerBRequestId,
        customerBUnacceptedRequestId,
      ]);
      expect(page.total).toBe(2);
      expect(
        page.items.every(
          (item: { customerNickname: string }) => item.customerNickname === customerBNickname,
        ),
      ).toBe(true);
    });

    it('客户昵称关键词子串匹配生效', async () => {
      const customerBNickname = await getNicknameByAccountId(customerBAccountId);
      const substring = customerBNickname.slice(1, -1);
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: {
          scope: 'ALL',
          pagination: OFFSET_PAGINATION,
          filter: { customerNickname: substring },
        },
        token: engineerAToken,
      }).expect(200);

      const page = response.body.data.engineerRepairRequests;
      expect(page.total).toBeGreaterThanOrEqual(2);
      expect(
        page.items.some(
          (item: { id: number }) => item.id === customerBAcceptedByEngineerBRequestId,
        ),
      ).toBe(true);
    });

    it('客户昵称关键词中 LIKE 通配符被转义，不扩大匹配范围', async () => {
      const customerBNickname = await getNicknameByAccountId(customerBAccountId);
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: {
          scope: 'ALL',
          pagination: OFFSET_PAGINATION,
          filter: { customerNickname: `${customerBNickname}%` },
        },
        token: engineerAToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      // 通配符按字面量处理：真实昵称不含 %，拼接后不应命中任何记录
      expect(response.body.data.engineerRepairRequests.total).toBe(0);
      expect(response.body.data.engineerRepairRequests.items).toEqual([]);
    });

    it('组合筛选（状态 + 客户昵称）同时生效', async () => {
      const customerBNickname = await getNicknameByAccountId(customerBAccountId);
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: {
          scope: 'AVAILABLE',
          pagination: OFFSET_PAGINATION,
          filter: { customerNickname: customerBNickname },
        },
        token: engineerAToken,
      }).expect(200);

      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        customerBUnacceptedRequestId,
      ]);
      expect(page.total).toBe(1);
    });

    it('ALL 范围分页边界：pageSize=2 第二页取到剩余申请，total 不变', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({
          scope: 'ALL',
          pagination: { mode: 'OFFSET', page: 2, pageSize: 2, withTotal: true },
        }),
        token: engineerAToken,
      }).expect(200);

      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        acceptedByEngineerARequestId,
        unacceptedRequestId,
      ]);
      expect(page.total).toBe(4);
      expect(page.page).toBe(2);
      expect(page.pageSize).toBe(2);
    });

    it('非法范围字符串拒绝', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: { scope: 'BOGUS', pagination: OFFSET_PAGINATION },
        token: engineerAToken,
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_INVALID_PARAMS');
    });
  });

  describe('myRepairRequest / engineerRepairRequest 详情（按角色分入口）', () => {
    const getExpectedEngineerNickname = async (): Promise<string> => {
      const userInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOne({ where: { accountId: engineerAAccountId } });
      const nickname = userInfo?.nickname?.trim();
      return nickname ? nickname : '工程师';
    };

    it('客户本人未接单申请可读（无回复时状态为空）', async () => {
      const response = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: unacceptedRequestId },
        token: customerAToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const detail = response.body.data.myRepairRequest;
      expect(detail).toMatchObject({
        id: unacceptedRequestId,
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
        faultDescription: '未接单场景',
        contentMd: '# E2E-RR-111',
        isAccepted: false,
        latestResolutionStatus: null,
        equipmentModel: {
          id: readModelId,
          modelCode: READ_MODEL.modelCode,
          modelName: READ_MODEL.modelName,
        },
        responses: [],
      });
      expect(detail).not.toHaveProperty('customerAccountId');
    });

    it('客户本人已接单申请含回复时间线与工程师当前昵称（时间正序，末条状态为最新）', async () => {
      const expectedNickname = await getExpectedEngineerNickname();
      const response = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: acceptedByEngineerARequestId },
        token: customerAToken,
      }).expect(200);

      const detail = response.body.data.myRepairRequest;
      expect(detail.latestResolutionStatus).toBe('RESOLVED');
      expect(detail.responses.map((item: { id: number }) => item.id)).toEqual([
        pendingResponseId,
        resolvedResponseId,
      ]);
      expect(detail.responses[1]).toMatchObject({
        engineerNickname: expectedNickname,
        resolutionStatus: 'RESOLVED',
        responseText: '已更换部件，问题解决',
      });
    });

    it('工程师可读未接单申请（AVAILABLE 视角，无接单工程师昵称）', async () => {
      const customerBNickname = await getNicknameByAccountId(customerBAccountId);
      const response = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: customerBUnacceptedRequestId },
        token: engineerAToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.engineerRepairRequest).toMatchObject({
        id: customerBUnacceptedRequestId,
        isAccepted: false,
        acceptanceViewStatus: 'AVAILABLE',
        acceptedEngineerNickname: null,
        customerNickname: customerBNickname,
      });
    });

    it('工程师本人已接单申请为 MINE 视角并富集客户与接单工程师资料', async () => {
      const engineerNickname = await getNicknameByAccountId(engineerAAccountId);
      const response = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: acceptedByEngineerARequestId },
        token: engineerAToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.engineerRepairRequest).toMatchObject({
        id: acceptedByEngineerARequestId,
        isAccepted: true,
        acceptanceViewStatus: 'MINE',
        acceptedEngineerNickname: engineerNickname,
        acceptedAt: expect.any(String),
      });
      // 契约防泄漏：详情输出不得含归属类账号 ID
      expect(response.body.data.engineerRepairRequest).not.toHaveProperty('customerAccountId');
      expect(response.body.data.engineerRepairRequest).not.toHaveProperty(
        'acceptedByEngineerAccountId',
      );
    });

    it('工程师可只读他人已接单申请（TAKEN_BY_OTHER，含真实接单工程师昵称与接单时间）', async () => {
      const engineerBNickname = await getNicknameByAccountId(engineerBAccountId);
      const customerBNickname = await getNicknameByAccountId(customerBAccountId);
      const response = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: customerBAcceptedByEngineerBRequestId },
        token: engineerAToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.engineerRepairRequest).toMatchObject({
        id: customerBAcceptedByEngineerBRequestId,
        isAccepted: true,
        acceptanceViewStatus: 'TAKEN_BY_OTHER',
        acceptedEngineerNickname: engineerBNickname,
        customerNickname: customerBNickname,
        acceptedAt: expect.any(String),
      });
    });

    it('客户入口详情不携带工程师视角富集字段（为空）', async () => {
      const response = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: acceptedByEngineerARequestId },
        token: customerAToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      const detail = response.body.data.myRepairRequest;
      expect(detail.acceptanceViewStatus).toBeNull();
      expect(detail.acceptedEngineerNickname).toBeNull();
      expect(detail.customerNickname).toBeNull();
      expect(detail.customerCompanyName).toBeNull();
    });

    it('客户访问他人申请 / 本人已删除申请统一拒绝（防探测）', async () => {
      const others = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: customerBUnacceptedRequestId },
        token: customerAToken,
      }).expect(200);
      expect(others.body.errors).toHaveLength(1);
      expectAccessDenied(others.body.errors[0]);

      const deleted = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: deletedRequestId },
        token: customerAToken,
      }).expect(200);
      expect(deleted.body.errors).toHaveLength(1);
      expectAccessDenied(deleted.body.errors[0]);
    });

    it('工程师访问已删除申请 / 不存在申请统一拒绝', async () => {
      const deleted = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: deletedRequestId },
        token: engineerAToken,
      }).expect(200);
      expect(deleted.body.errors).toHaveLength(1);
      expectAccessDenied(deleted.body.errors[0]);

      const missing = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: 999999 },
        token: engineerAToken,
      }).expect(200);
      expect(missing.body.errors).toHaveLength(1);
      expectAccessDenied(missing.body.errors[0]);
    });

    it('CUSTOMER 调工程师详情入口被守卫拒绝（入口按角色分开）', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: unacceptedRequestId },
        token: customerAToken,
      }).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(response.body.errors[0].extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('回复契约不再包含 engineerAccountId 字段（负责人裁定 3，查询未知字段拒绝）', async () => {
      const legacyQuery = `
        query MyRepairRequest($id: Int!) {
          myRepairRequest(id: $id) {
            responses { id engineerAccountId }
          }
        }
      `;
      const response = await postGql({
        app,
        query: legacyQuery,
        variables: { id: acceptedByEngineerARequestId },
        token: customerAToken,
      });

      // 未知字段在 schema 校验阶段被拒（400 或 200+errors），且不返回数据
      expect([200, 400]).toContain(response.status);
      expect(response.body.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(response.body.errors)).toContain('engineerAccountId');
      expect(response.body.data ?? null).toBeNull();
    });
  });

  describe('SUPER_ADMIN 按角色继承规则准入（负责人 20260901 裁定 2）', () => {
    it('超管经工程师入口可读未接单申请（继承工程师访问能力）', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: unacceptedRequestId },
        token: adminToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.engineerRepairRequest.id).toBe(unacceptedRequestId);
    });

    it('超管继承工程师身份可只读他人已接单申请（读继承不等于写继承）', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: customerBAcceptedByEngineerBRequestId },
        token: adminToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.engineerRepairRequest).toMatchObject({
        id: customerBAcceptedByEngineerBRequestId,
        isAccepted: true,
        acceptanceViewStatus: 'TAKEN_BY_OTHER',
      });
    });

    it('超管经客户入口仅见本人名下申请（不可见客户申请）', async () => {
      const response = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: unacceptedRequestId },
        token: adminToken,
      }).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectAccessDenied(response.body.errors[0]);
    });

    it('超管调工程师列表可见待接单池', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({
          scope: 'AVAILABLE',
          pagination: OFFSET_PAGINATION,
        }),
        token: adminToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        customerBUnacceptedRequestId,
        unacceptedRequestId,
      ]);
    });

    it('超管 TAKEN_BY_OTHER 视角下全部已接单申请均为他人接单（超管不能接单）', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({
          scope: 'TAKEN_BY_OTHER',
          pagination: OFFSET_PAGINATION,
        }),
        token: adminToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const page = response.body.data.engineerRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        customerBAcceptedByEngineerBRequestId,
        acceptedByEngineerARequestId,
      ]);
      expect(
        page.items.every(
          (item: { acceptanceViewStatus: string }) =>
            item.acceptanceViewStatus === 'TAKEN_BY_OTHER',
        ),
      ).toBe(true);
    });
  });

  describe('组织范围（跨组织与无归属存量）', () => {
    it('跨组织工程师只看到本组织工单；无归属存量仅在 MINE 视角出现', async () => {
      const all = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'ALL', pagination: OFFSET_PAGINATION }),
        token: crossOrgEngineerToken,
      }).expect(200);
      expect(all.body.errors).toBeUndefined();
      expect(
        all.body.data.engineerRepairRequests.items.map((item: { id: number }) => item.id),
      ).toEqual([peerOrganizationRequestId]);
      expect(all.body.data.engineerRepairRequests.total).toBe(1);

      const available = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'AVAILABLE', pagination: OFFSET_PAGINATION }),
        token: crossOrgEngineerToken,
      }).expect(200);
      expect(
        available.body.data.engineerRepairRequests.items.map((item: { id: number }) => item.id),
      ).toEqual([peerOrganizationRequestId]);

      const mine = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'MINE', pagination: OFFSET_PAGINATION }),
        token: crossOrgEngineerToken,
      }).expect(200);
      expect(
        mine.body.data.engineerRepairRequests.items.map((item: { id: number }) => item.id),
      ).toEqual([legacyAcceptedRequestId]);

      // 未接单的无归属存量不因组织列缺失进入任何视角
      for (const page of [all, available, mine]) {
        expect(
          page.body.data.engineerRepairRequests.items.map((item: { id: number }) => item.id),
        ).not.toContain(legacyUnacceptedRequestId);
      }
    });

    it('本组织工程师列表不因跨组织/无归属夹具而扩大（ALL 仍为 4 条同组织工单）', async () => {
      const response = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: engineerListVariables({ scope: 'ALL', pagination: OFFSET_PAGINATION }),
        token: engineerAToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const ids = response.body.data.engineerRepairRequests.items.map(
        (item: { id: number }) => item.id,
      );
      expect(ids).toEqual([
        customerBAcceptedByEngineerBRequestId,
        customerBUnacceptedRequestId,
        acceptedByEngineerARequestId,
        unacceptedRequestId,
      ]);
      expect(ids).not.toContain(peerOrganizationRequestId);
      expect(ids).not.toContain(legacyAcceptedRequestId);
      expect(ids).not.toContain(legacyUnacceptedRequestId);
    });

    it('跨组织详情统一拒绝，且与「不存在」同码同文案（不泄露存在性）', async () => {
      const crossOrg = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: peerOrganizationRequestId },
        token: engineerAToken,
      }).expect(200);
      expect(crossOrg.body.errors).toHaveLength(1);
      expectAccessDenied(crossOrg.body.errors[0]);

      const missing = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: 999999 },
        token: engineerAToken,
      }).expect(200);
      expect(missing.body.errors).toHaveLength(1);
      expect(crossOrg.body.errors[0].message).toBe(missing.body.errors[0].message);
      expect(crossOrg.body.errors[0].extensions.errorCode).toBe(
        missing.body.errors[0].extensions.errorCode,
      );
    });

    it('无归属存量仅原接单工程师可读；未接单或非接单人一律拒绝', async () => {
      const crossOrgEngineerNickname = await getNicknameByAccountId(crossOrgEngineerAccountId);
      const ownerView = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: legacyAcceptedRequestId },
        token: crossOrgEngineerToken,
      }).expect(200);
      expect(ownerView.body.errors).toBeUndefined();
      expect(ownerView.body.data.engineerRepairRequest).toMatchObject({
        id: legacyAcceptedRequestId,
        isAccepted: true,
        acceptanceViewStatus: 'MINE',
        acceptedEngineerNickname: crossOrgEngineerNickname,
      });

      const otherEngineer = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: legacyAcceptedRequestId },
        token: engineerAToken,
      }).expect(200);
      expect(otherEngineer.body.errors).toHaveLength(1);
      expectAccessDenied(otherEngineer.body.errors[0]);

      const unaccepted = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: legacyUnacceptedRequestId },
        token: crossOrgEngineerToken,
      }).expect(200);
      expect(unaccepted.body.errors).toHaveLength(1);
      expectAccessDenied(unaccepted.body.errors[0]);

      const otherCustomer = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: legacyAcceptedRequestId },
        token: customerAToken,
      }).expect(200);
      expect(otherCustomer.body.errors).toHaveLength(1);
      expectAccessDenied(otherCustomer.body.errors[0]);
    });

    it('跨组织客户的客户入口仍只见本人三名下申请（组织归属不影响客户本人范围）', async () => {
      const response = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: OFFSET_PAGINATION },
        token: crossOrgCustomerToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const page = response.body.data.myRepairRequests;
      expect(page.items.map((item: { id: number }) => item.id)).toEqual([
        legacyUnacceptedRequestId,
        legacyAcceptedRequestId,
        peerOrganizationRequestId,
      ]);
      expect(page.total).toBe(3);
    });
  });

  describe('端点守卫与未登录', () => {
    it('未登录访问读入口均返回 UNAUTHENTICATED', async () => {
      const myList = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: OFFSET_PAGINATION },
      }).expect(200);
      expectUnauthenticated(myList.body.errors[0]);

      const engineerList = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: { scope: 'AVAILABLE', pagination: OFFSET_PAGINATION },
      }).expect(200);
      expectUnauthenticated(engineerList.body.errors[0]);

      const myDetail = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: unacceptedRequestId },
      }).expect(200);
      expectUnauthenticated(myDetail.body.errors[0]);

      const engineerDetail = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: unacceptedRequestId },
      }).expect(200);
      expectUnauthenticated(engineerDetail.body.errors[0]);
    });

    it('角色互斥：CUSTOMER 调工程师列表 / ENGINEER 调客户列表均被拒', async () => {
      const customerAsEngineer = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: { scope: 'AVAILABLE', pagination: OFFSET_PAGINATION },
        token: customerAToken,
      }).expect(200);
      expect(customerAsEngineer.body.errors[0].extensions.code).toBe('FORBIDDEN');

      const engineerAsCustomer = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: OFFSET_PAGINATION },
        token: engineerAToken,
      }).expect(200);
      expect(engineerAsCustomer.body.errors[0].extensions.code).toBe('FORBIDDEN');

      const customerB = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: OFFSET_PAGINATION },
        token: customerBToken,
      }).expect(200);
      expect(customerB.body.errors).toBeUndefined();
      expect(customerB.body.data.myRepairRequests.items.map((i: { id: number }) => i.id)).toEqual([
        customerBAcceptedByEngineerBRequestId,
        customerBUnacceptedRequestId,
      ]);
    });
  });
});
