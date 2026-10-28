// test/06-repair-request/repair-request-delete.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type ResidueEquipmentModelFingerprint,
  type ResidueRepairRequestFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

const DELETE_REPAIR_REQUEST_MUTATION = `
  mutation DeleteMyRepairRequest($id: Int!) {
    deleteMyRepairRequest(id: $id) { id requestNo }
  }
`;

const MY_REPAIR_REQUESTS_QUERY = `
  query MyRepairRequests($pagination: PaginationArgs!) {
    myRepairRequests(pagination: $pagination) { items { id requestNo } total }
  }
`;

/** 型号自然键（不依赖固定主键）；ID 由数据库生成后登记到本轮账本。 */
const MODEL_CODE = 'E2E-DEL';
const MODEL_NAME = '删除链路型号';

interface RequestSeed {
  readonly key: 'deletable' | 'accepted' | 'otherPending' | 'otherAccepted';
  readonly requestNo: string;
  readonly customerKey: 'guestPrimary' | 'guestSecondary';
  readonly errorCode: string;
  readonly faultDescription: string;
  readonly contentMd: string;
  readonly createdAt: string;
  readonly accepted: boolean;
}

const REQUEST_SEEDS: readonly RequestSeed[] = [
  {
    key: 'deletable',
    requestNo: 'E2E-DEL-141',
    customerKey: 'guestPrimary',
    errorCode: 'E-3001',
    faultDescription: '删除成功场景',
    contentMd: '# E2E-DEL-141',
    createdAt: '2026-08-30T01:00:00.000Z',
    accepted: false,
  },
  {
    key: 'accepted',
    requestNo: 'E2E-DEL-142',
    customerKey: 'guestPrimary',
    errorCode: 'E-3002',
    faultDescription: '已接单删除拒绝场景',
    contentMd: '# E2E-DEL-142',
    createdAt: '2026-08-30T02:00:00.000Z',
    accepted: true,
  },
  {
    key: 'otherPending',
    requestNo: 'E2E-DEL-143',
    customerKey: 'guestSecondary',
    errorCode: 'E-3003',
    faultDescription: '他人未接单防探测场景',
    contentMd: '# E2E-DEL-143',
    createdAt: '2026-08-30T04:00:00.000Z',
    accepted: false,
  },
  {
    key: 'otherAccepted',
    requestNo: 'E2E-DEL-144',
    customerKey: 'guestSecondary',
    errorCode: 'E-3004',
    faultDescription: '他人已接单防探测场景',
    contentMd: '# E2E-DEL-144',
    createdAt: '2026-08-30T05:00:00.000Z',
    accepted: true,
  },
];

/**
 * 客户删除维修申请 e2e（core 组）
 *
 * 与 repair-request-auth / flow / read 分工：本文件覆盖 deleteMyRepairRequest 端点，
 * 鉴权只回归守卫挂载（未登录 / 非客户角色），业务侧按负责人 20260901 裁定 5 钉住
 * 全部拒绝语义：不存在/非本人统一 NOT_FOUND（防探测）、已接单 CONFLICT、
 * 重复删除幂等成功；并验证软删除落库事实与列表可见性联动。
 * 业务拒绝分支的单元语义由 service/usecase 单测钉住，此处不重复展开。
 *
 * 造数不占用固定主键：型号/申请 ID 均由数据库生成后登记到本轮账本，
 * 用例通过语义 key 引用真实 ID；清理只删除本轮登记 ID，不再整表删除。
 */
describe('客户删除维修申请 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let modelRepository: Repository<EquipmentModelEntity>;
  let requestRepository: Repository<RepairRequestEntity>;
  let customerToken: string;
  let engineerToken: string;
  let adminToken: string;

  const ownership = createOwnedResourceLedger();
  const residueAccounts = buildTestAccountResidue([
    'staff',
    'guestPrimary',
    'guestSecondary',
    'admin',
  ]);
  const residueModel: ResidueEquipmentModelFingerprint = {
    modelCode: MODEL_CODE,
    modelName: MODEL_NAME,
    enabled: true,
    sortOrder: 1,
  };
  const residueRequests: ResidueRepairRequestFingerprint[] = REQUEST_SEEDS.map((seed) => ({
    requestNo: seed.requestNo,
    customerAccountLoginName: testAccountsConfig[seed.customerKey].loginName,
    equipmentModelCode: MODEL_CODE,
    errorCode: seed.errorCode,
    faultDescription: seed.faultDescription,
    contentMd: seed.contentMd,
  }));

  const requestIdByKey: Record<RequestSeed['key'], number> = {
    deletable: 0,
    accepted: 0,
    otherPending: 0,
    otherAccepted: 0,
  };

  const deleteMutation = (id: number, token: string) =>
    postGql({
      app,
      query: DELETE_REPAIR_REQUEST_MUTATION,
      variables: { id },
      token,
    });

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    modelRepository = dataSource.getRepository(EquipmentModelEntity);
    requestRepository = dataSource.getRepository(RepairRequestEntity);

    await app.init();

    await runGuardedSpecCleanup({
      dataSource,
      helper: 'repair-request-delete.e2e beforeAll',
      residue: {
        accounts: residueAccounts,
        equipmentModels: [residueModel],
        repairRequests: residueRequests,
      },
    });

    await seedTestAccounts({
      dataSource,
      createAccountUsecase: app.get(CreateAccountUsecase),
      includeKeys: ['staff', 'guestPrimary', 'guestSecondary', 'admin'],
      ownership,
    });
    customerToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
    engineerToken = await login({
      app,
      loginName: testAccountsConfig.staff.loginName,
      loginPassword: testAccountsConfig.staff.loginPassword,
    });
    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    const customerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestPrimary.loginName,
    );
    const otherCustomerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestSecondary.loginName,
    );
    const engineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staff.loginName,
    );

    const [model] = await modelRepository.save(
      modelRepository.create([
        {
          modelCode: MODEL_CODE,
          modelName: MODEL_NAME,
          enabled: true,
          sortOrder: 1,
        },
      ]),
    );
    recordOwnedResource(ownership, 'equipmentModel', model.id, {
      modelCode: MODEL_CODE,
      modelName: MODEL_NAME,
      enabled: true,
      sortOrder: 1,
    });

    const customerIdByKey = {
      guestPrimary: customerAccountId,
      guestSecondary: otherCustomerAccountId,
    } as const;

    const savedRequests = await requestRepository.save(
      requestRepository.create(
        REQUEST_SEEDS.map((seed) => ({
          requestNo: seed.requestNo,
          customerAccountId: customerIdByKey[seed.customerKey],
          equipmentModelId: model.id,
          errorCode: seed.errorCode,
          faultDescription: seed.faultDescription,
          contentMd: seed.contentMd,
          createdAt: new Date(seed.createdAt),
          isAccepted: seed.accepted,
          acceptedByEngineerAccountId: seed.accepted ? engineerAccountId : null,
          acceptedAt: seed.accepted
            ? new Date(new Date(seed.createdAt).getTime() + 60 * 60 * 1000)
            : null,
          deprecated: false,
          deletedAt: null,
        })),
      ),
    );
    for (const request of savedRequests) {
      const seed = REQUEST_SEEDS.find((candidate) => candidate.requestNo === request.requestNo);
      if (seed) {
        requestIdByKey[seed.key] = request.id;
        recordOwnedResource(ownership, 'repairRequest', request.id, {
          requestNo: seed.requestNo,
          customerAccountId: customerIdByKey[seed.customerKey],
          equipmentModelId: model.id,
          errorCode: seed.errorCode,
          faultDescription: seed.faultDescription,
        });
      }
    }
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'repair-request-delete.e2e afterAll',
          owned: ownership,
          residue: {
            accounts: residueAccounts,
            equipmentModels: [residueModel],
            repairRequests: residueRequests,
          },
        }),
      closeApp: app ? () => app.close() : null,
    });
  });

  describe('端点鉴权（守卫挂载回归）', () => {
    it('未登录应返回 UNAUTHENTICATED', async () => {
      const response = await postGql({
        app,
        query: DELETE_REPAIR_REQUEST_MUTATION,
        variables: { id: requestIdByKey.deletable },
      }).expect(200);
      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });

    it('ENGINEER 应返回 FORBIDDEN（requiredRoles 仅 CUSTOMER）', async () => {
      const response = await deleteMutation(requestIdByKey.deletable, engineerToken).expect(200);
      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(response.body.errors[0].extensions.details).toMatchObject({
        requiredRoles: ['CUSTOMER'],
        userRoles: ['ENGINEER'],
      });
    });

    it('SUPER_ADMIN 应返回 FORBIDDEN（裁定 2：超管不以客户身份删除）', async () => {
      const response = await deleteMutation(requestIdByKey.deletable, adminToken).expect(200);
      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(response.body.errors[0].extensions.details).toMatchObject({
        requiredRoles: ['CUSTOMER'],
        userRoles: ['SUPER_ADMIN'],
      });
    });
  });

  describe('业务语义（裁定 5）', () => {
    it('删除本人未接单申请成功，落库为软删除且从列表消失', async () => {
      const response = await deleteMutation(requestIdByKey.deletable, customerToken).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.deleteMyRepairRequest).toEqual({
        id: requestIdByKey.deletable,
        requestNo: 'E2E-DEL-141',
      });

      const row = await requestRepository.findOne({ where: { id: requestIdByKey.deletable } });
      expect(row).not.toBeNull();
      expect(row!.deprecated).toBe(true);
      expect(row!.deletedAt).not.toBeNull();
      expect(row!.isAccepted).toBe(false);

      // 列表可见性联动：已删申请不再出现，其他申请不受影响
      const list = await postGql({
        app,
        query: MY_REPAIR_REQUESTS_QUERY,
        variables: { pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true } },
        token: customerToken,
      }).expect(200);
      expect(list.body.errors).toBeUndefined();
      const ids = list.body.data.myRepairRequests.items.map((item: { id: number }) => item.id);
      expect(ids).not.toContain(requestIdByKey.deletable);
      expect(ids).toContain(requestIdByKey.accepted);
    });

    it('重复删除同一申请幂等成功，返回与首次一致的结果', async () => {
      const response = await deleteMutation(requestIdByKey.deletable, customerToken).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.deleteMyRepairRequest).toEqual({
        id: requestIdByKey.deletable,
        requestNo: 'E2E-DEL-141',
      });
    });

    it('删除不存在的申请返回 NOT_FOUND', async () => {
      const response = await deleteMutation(999999, customerToken).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');
    });

    it.each(['otherPending', 'otherAccepted'] as const)(
      '删除他人%s的申请统一返回 NOT_FOUND（防探测，不泄露存在性与状态）',
      async (key) => {
        const otherRequestId = requestIdByKey[key];
        const response = await deleteMutation(otherRequestId, customerToken).expect(200);

        expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
        expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');
        // 防探测基准：他人可删除状态的申请也不被误删
        const row = await requestRepository.findOne({ where: { id: otherRequestId } });
        expect(row!.deprecated).toBe(false);
      },
    );

    it('删除本人已接单申请返回 CONFLICT 且落库未变（接单/删除互斥）', async () => {
      const response = await deleteMutation(requestIdByKey.accepted, customerToken).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(response.body.errors[0].extensions.errorCode).toBe('REPAIR_REQUEST_ALREADY_ACCEPTED');

      const row = await requestRepository.findOne({ where: { id: requestIdByKey.accepted } });
      expect(row!.deprecated).toBe(false);
      expect(row!.deletedAt).toBeNull();
      expect(row!.isAccepted).toBe(true);
    });
  });
});
