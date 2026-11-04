// test/06-repair-request/repair-request-flow.e2e-spec.ts
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
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

const EQUIPMENT_MODELS_QUERY = 'query { equipmentModels { id modelCode modelName } }';

const CREATE_REPAIR_REQUEST_MUTATION = `
  mutation CreateRepairRequest($input: CreateRepairRequestInput!) {
    createRepairRequest(input: $input) {
      id
      requestNo
      equipmentModelId
      errorCode
      faultDescription
      createdAt
      isAccepted
    }
  }
`;

/**
 * 维修申请业务流程回归（core 组）
 *
 * 与 repair-request-auth.e2e-spec.ts 分工：鉴权路径由后者覆盖，
 * 本文件覆盖 CUSTOMER 通过鉴权后的业务正路径与错误路径，
 * 并回归 @ValidateInput 装配（超长输入必须在 DTO 层被拒）。
 */
describe('维修申请业务流程 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let modelRepository: Repository<EquipmentModelEntity>;
  let requestRepository: Repository<RepairRequestEntity>;
  let customerToken: string;
  let customerAccountId: number;
  let ownership = createOwnedResourceLedger();

  const residueAccounts = buildTestAccountResidue(['guestPrimary']);
  const residueModels: ResidueEquipmentModelFingerprint[] = [
    { modelCode: 'E2E-A', modelName: '型号A', enabled: true, sortOrder: 1 },
    { modelCode: 'E2E-B', modelName: '型号B', enabled: true, sortOrder: 2 },
    { modelCode: 'E2E-OFF', modelName: '已停用', enabled: false, sortOrder: 0 },
    { modelCode: 'E2E-OK', modelName: '可用型号', enabled: true, sortOrder: 0 },
    { modelCode: 'E2E-DISABLED', modelName: '停用型号', enabled: false, sortOrder: 0 },
  ];

  const createMutation = (input: Record<string, unknown>) =>
    postGql({
      app,
      query: CREATE_REPAIR_REQUEST_MUTATION,
      variables: { input },
      token: customerToken,
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
  }, 30000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'repair-request-flow.e2e afterAll',
          owned: ownership,
          residue: { accounts: residueAccounts, equipmentModels: residueModels },
        }),
      closeApp: app ? () => app.close() : null,
    });
  });

  beforeEach(async () => {
    // 每个用例只回收上一用例登记的真实 ID 与完整指纹残留，不再整表删除。
    await runGuardedSpecCleanup({
      dataSource,
      helper: 'repair-request-flow.e2e beforeEach',
      owned: ownership,
      residue: { accounts: residueAccounts, equipmentModels: residueModels },
    });
    ownership = createOwnedResourceLedger();
    await seedTestAccounts({
      dataSource,
      createAccountUsecase: app.get(CreateAccountUsecase),
      includeKeys: ['guestPrimary'],
      ownership,
    });
    customerToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
    customerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestPrimary.loginName,
    );
  });

  afterEach(async () => {
    await runGuardedSpecCleanup({
      dataSource,
      helper: 'repair-request-flow.e2e afterEach',
      owned: ownership,
      residue: { accounts: residueAccounts, equipmentModels: residueModels },
    });
    ownership = createOwnedResourceLedger();
  });

  const seedModels = async (
    rows: Array<Partial<EquipmentModelEntity>>,
  ): Promise<EquipmentModelEntity[]> => {
    const saved = await modelRepository.save(modelRepository.create(rows));
    for (const model of saved) {
      recordOwnedResource(ownership, 'equipmentModel', model.id, {
        modelCode: model.modelCode,
        modelName: model.modelName,
        // 未显式提供时按实体默认值登记（sort_order=0、enabled=true）。
        enabled: model.enabled ?? true,
        sortOrder: model.sortOrder ?? 0,
      });
    }
    return saved;
  };

  describe('equipmentModels 查询', () => {
    it('只返回启用型号并按 sortOrder 升序', async () => {
      const [modelB, modelA, modelOff] = await seedModels([
        { modelCode: 'E2E-B', modelName: '型号B', sortOrder: 2, enabled: true },
        { modelCode: 'E2E-A', modelName: '型号A', sortOrder: 1, enabled: true },
        { modelCode: 'E2E-OFF', modelName: '已停用', sortOrder: 0, enabled: false },
      ]);

      const response = await postGql({
        app,
        query: EQUIPMENT_MODELS_QUERY,
        token: customerToken,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      // 目标库允许保留非本规格的合法数据，故不能假设 equipment_model 只有本规格三行。
      // 仍以库内「启用集合」为准确认只返回启用型号，并校验返回顺序与 sort_order 非降序一致。
      const returned = response.body.data.equipmentModels as Array<{
        id: number;
        modelCode: string;
        modelName: string;
      }>;
      const enabledRows = await dataSource.query<Array<{ id: number; sort_order: number }>>(
        'SELECT id, sort_order FROM equipment_model WHERE enabled = 1',
      );
      expect(new Set(returned.map((row) => Number(row.id)))).toEqual(
        new Set(enabledRows.map((row) => Number(row.id))),
      );
      expect(returned.map((row) => row.id)).toEqual(expect.arrayContaining([modelA.id, modelB.id]));
      expect(returned.map((row) => row.id)).not.toContain(modelOff.id);

      const sortOrderById = new Map(
        enabledRows.map((row) => [Number(row.id), Number(row.sort_order)]),
      );
      const returnedOrders = returned.map((row) => sortOrderById.get(Number(row.id)) ?? -1);
      for (let index = 1; index < returnedOrders.length; index += 1) {
        expect(returnedOrders[index]).toBeGreaterThanOrEqual(returnedOrders[index - 1]);
      }
    });
  });

  describe('createRepairRequest 正路径', () => {
    it('创建成功且数据库记录与后端生成字段正确', async () => {
      const [model] = await seedModels([
        { modelCode: 'E2E-OK', modelName: '可用型号', enabled: true },
      ]);

      const response = await createMutation({
        equipmentModelId: model.id,
        errorCode: 'E-2001',
        faultDescription: '双工件台干涉仪报错',
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const result = response.body.data.createRepairRequest;
      recordOwnedResource(ownership, 'repairRequest', result.id, {
        requestNo: result.requestNo,
        customerAccountId,
        equipmentModelId: model.id,
        errorCode: 'E-2001',
        faultDescription: '双工件台干涉仪报错',
      });
      expect(result.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
      expect(result.equipmentModelId).toBe(model.id);
      expect(result.isAccepted).toBe(false);

      const row = await requestRepository.findOne({
        where: { requestNo: result.requestNo },
      });
      expect(row).not.toBeNull();
      expect(row!.customerAccountId).toBe(customerAccountId);
      expect(row!.isAccepted).toBe(false);
      expect(row!.deprecated).toBe(false);
      expect(row!.acceptedByEngineerAccountId).toBeNull();
      expect(row!.contentMd).toContain(result.requestNo);
      expect(row!.contentMd).toContain('E-2001');
    });

    it('边界长度（错误码恰 100 字符、故障描述恰 5000 字符）创建成功', async () => {
      const [model] = await seedModels([
        { modelCode: 'E2E-OK', modelName: '可用型号', enabled: true },
      ]);
      const boundaryErrorCode = 'E'.repeat(100);
      const boundaryFaultDescription = '长'.repeat(5000);

      const response = await createMutation({
        equipmentModelId: model.id,
        errorCode: boundaryErrorCode,
        faultDescription: boundaryFaultDescription,
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      const result = response.body.data.createRepairRequest;
      recordOwnedResource(ownership, 'repairRequest', result.id, {
        requestNo: result.requestNo,
        customerAccountId,
        equipmentModelId: model.id,
        errorCode: boundaryErrorCode,
        faultDescription: boundaryFaultDescription,
      });
      expect(result.errorCode).toBe(boundaryErrorCode);
      expect(result.faultDescription).toBe(boundaryFaultDescription);
    });
  });

  describe('createRepairRequest 错误路径', () => {
    it('型号不存在时拒绝且不落库', async () => {
      const response = await createMutation({
        equipmentModelId: 999999,
        errorCode: 'E-2001',
        faultDescription: '型号不存在场景',
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(response.body.errors[0].extensions.errorCode).toBe(
        'REPAIR_REQUEST_EQUIPMENT_MODEL_NOT_FOUND',
      );
      // 前端契约依赖点：业务消息只读 extensions.errorMessage（frontend/docs/project-convention/graphql-error-model.md）
      expect(typeof response.body.errors[0].extensions.errorMessage).toBe('string');
      expect(response.body.errors[0].extensions.errorMessage.length).toBeGreaterThan(0);
      expect(await requestRepository.count({ where: { customerAccountId } })).toBe(0);
    });

    it('型号已停用时拒绝且不落库', async () => {
      const [model] = await seedModels([
        { modelCode: 'E2E-DISABLED', modelName: '停用型号', enabled: false },
      ]);

      const response = await createMutation({
        equipmentModelId: model.id,
        errorCode: 'E-2001',
        faultDescription: '型号停用场景',
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].extensions.errorCode).toBe(
        'REPAIR_REQUEST_EQUIPMENT_MODEL_DISABLED',
      );
      expect(await requestRepository.count({ where: { customerAccountId } })).toBe(0);
    });

    it('错误码为空白时拒绝', async () => {
      const [model] = await seedModels([
        { modelCode: 'E2E-OK', modelName: '可用型号', enabled: true },
      ]);

      const response = await createMutation({
        equipmentModelId: model.id,
        errorCode: '   ',
        faultDescription: '空白错误码场景',
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].extensions.errorCode).toBe(
        'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
      );
      expect(await requestRepository.count({ where: { customerAccountId } })).toBe(0);
    });

    it('故障描述为空白时拒绝', async () => {
      const [model] = await seedModels([
        { modelCode: 'E2E-OK', modelName: '可用型号', enabled: true },
      ]);

      const response = await createMutation({
        equipmentModelId: model.id,
        errorCode: 'E-2001',
        faultDescription: '   ',
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].extensions.errorCode).toBe(
        'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
      );
      expect(await requestRepository.count({ where: { customerAccountId } })).toBe(0);
    });

    it('错误码超 100 字符在 DTO 层被拒', async () => {
      const response = await createMutation({
        equipmentModelId: 999999,
        errorCode: 'E'.repeat(101),
        faultDescription: '超长错误码场景',
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].message).toContain('错误码不能超过 100 个字符');
    });

    it('故障描述超 5000 字符在 DTO 层被拒（@ValidateInput 装配回归）', async () => {
      const response = await createMutation({
        equipmentModelId: 999999,
        errorCode: 'E-2001',
        faultDescription: '长'.repeat(5001),
      }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].message).toContain('故障描述不能超过 5000 个字符');
    });
  });
});
