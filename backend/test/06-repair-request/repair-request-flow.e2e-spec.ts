// test/06-repair-request/repair-request-flow.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { getAccountIdByLoginName, login, postGql, sleep } from '../utils/e2e-graphql-utils';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
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
 * 任务 02.4 起，新增报修要求客户已有可信公司归属（`base_user_info.customer_organization_id`）。
 * 本规格只验证维修申请主体流程，故在 beforeEach 内用补录 Mutation 手填一家公司把前置补齐，
 * 缺归属场景由 `customer-company-supplement.e2e-spec.ts` 与
 * `create-repair-request.usecase.spec.ts` 覆盖。
 */
const SUPPLEMENT_COMPANY_MUTATION = `
  mutation SupplementMyCustomerCompany($input: SupplementMyCustomerCompanyInput!) {
    supplementMyCustomerCompany(input: $input) { isUpdated }
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

const OFFSET_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };

const FLOW_CUSTOMER_COMPANY_NAME = 'E2E 报修流程客户公司';

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

  /**
   * 补齐客户公司归属：走本人补录 Mutation 手填公司名，随后按事务写入的真实行补登记
   * 公司 / 成员关系，并更新账号台账的归属预期，保证 afterEach 能精确回收。
   */
  const bindCustomerCompanyForRepair = async (): Promise<void> => {
    const response = await postGql({
      app,
      query: SUPPLEMENT_COMPANY_MUTATION,
      variables: { input: { organizationName: FLOW_CUSTOMER_COMPANY_NAME } },
      token: customerToken,
    }).expect(200);
    if (response.body.errors) {
      throw new Error(
        `报修流程夹具补录公司失败：${JSON.stringify(response.body.errors as unknown)}`,
      );
    }

    const userInfoRows = await dataSource.query<Array<{ customer_organization_id: number | null }>>(
      'SELECT customer_organization_id FROM base_user_info WHERE account_id = ?',
      [customerAccountId],
    );
    const organizationId = userInfoRows[0]?.customer_organization_id;
    if (!organizationId) {
      throw new Error('报修流程夹具补录后仍未写入客户公司归属');
    }

    const organizationRows = await dataSource.query<
      Array<{
        organization_code: string;
        name: string;
        kind: string;
        status: string;
        is_managed_company: number | boolean;
      }>
    >(
      `SELECT organization_code, name, kind, status, is_managed_company
         FROM organization WHERE id = ?`,
      [organizationId],
    );
    const organization = organizationRows[0];
    if (!organization) {
      throw new Error(`报修流程夹具公司行不存在：${organizationId}`);
    }
    recordOwnedResource(ownership, 'organization', organizationId, {
      organizationCode: organization.organization_code,
      name: organization.name,
      kind: organization.kind,
      status: organization.status,
      isManagedCompany: Number(organization.is_managed_company) === 1,
    });

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
      [customerAccountId],
    );
    for (const membership of memberships) {
      recordOwnedResource(ownership, 'membership', membership.id, {
        organizationId: membership.organization_id,
        accountId: membership.account_id,
        memberRole: membership.member_role,
        status: membership.status,
      });
    }

    updateOwnedExpectation(ownership, 'account', customerAccountId, {
      customerOrganizationId: organizationId,
    });
  };

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
    await bindCustomerCompanyForRepair();
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

  /**
   * 停用组织与新增报修的原子顺序（F2 回归）。
   *
   * 写前复核必须是当前锁定读：先持有组织行排他锁并停用（未提交）时，报修请求
   * 不能以旧快照判定为「仍有效」后落库；停用提交后，同一请求必须按最新提交版本
   * 判定为不可用并零落库。反向则验证有效性锁会阻塞停用写入。
   */
  describe('组织停用与新增报修的原子顺序', () => {
    let customerOrganizationId: number;

    const readOrganizationStatus = async (): Promise<string> => {
      const rows = await dataSource.query<Array<{ status: string }>>(
        'SELECT status FROM organization WHERE id = ?',
        [customerOrganizationId],
      );
      return String(rows[0]?.status ?? '');
    };

    const setOrganizationStatus = async (status: 'ACTIVE' | 'DISABLED'): Promise<void> => {
      await dataSource.query('UPDATE organization SET status = ? WHERE id = ?', [
        status,
        customerOrganizationId,
      ]);
    };

    const countCustomerRequests = (): Promise<number> =>
      requestRepository.count({ where: { customerAccountId } });

    const seedUsableModel = async (): Promise<EquipmentModelEntity> => {
      const [model] = await seedModels([
        { modelCode: 'E2E-OK', modelName: '可用型号', enabled: true },
      ]);
      return model;
    };

    beforeEach(async () => {
      const rows = await dataSource.query<Array<{ customer_organization_id: number | null }>>(
        'SELECT customer_organization_id FROM base_user_info WHERE account_id = ?',
        [customerAccountId],
      );
      customerOrganizationId = Number(rows[0]?.customer_organization_id);
      if (!Number.isInteger(customerOrganizationId) || customerOrganizationId <= 0) {
        throw new Error('并发顺序用例缺少客户公司归属夹具');
      }
    });

    afterEach(async () => {
      // 用例内可能停用组织：先恢复为清理台账登记的 ACTIVE 预期，再由外层收尾
      await dataSource.query("UPDATE organization SET status = 'ACTIVE' WHERE id = ?", [
        customerOrganizationId,
      ]);
    });

    it('停用提交在先：报修等待组织行锁，停用提交后 FORBIDDEN 且零新增', async () => {
      const model = await seedUsableModel();
      const blocker = dataSource.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      try {
        await blocker.query('SELECT id FROM organization WHERE id = ? FOR UPDATE', [
          customerOrganizationId,
        ]);
        await blocker.query("UPDATE organization SET status = 'DISABLED' WHERE id = ?", [
          customerOrganizationId,
        ]);

        const pending = postGql({
          app,
          query: CREATE_REPAIR_REQUEST_MUTATION,
          variables: {
            input: {
              equipmentModelId: model.id,
              errorCode: 'E2E-F2-1',
              faultDescription: '停用提交在先的并发报修',
            },
          },
          token: customerToken,
        });
        const settled = pending.then(
          (value) => ({ kind: 'settled' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

        // 停用事务仍持有组织行排他锁：报修必须阻塞在写前复核，不能提前返回成功
        const early = await Promise.race([
          settled,
          sleep(500).then(() => ({ kind: 'pending' as const })),
        ]);
        expect(early.kind).toBe('pending');
        expect(await countCustomerRequests()).toBe(0);

        await blocker.commitTransaction();

        const outcome = await settled;
        expect(outcome.kind).toBe('settled');
        if (outcome.kind !== 'settled') {
          throw new Error('停用提交后报修请求仍未返回');
        }
        const response = outcome.value;
        expect(response.status).toBe(200);
        expect(response.body.errors).toHaveLength(1);
        const extensions = response.body.errors[0].extensions as Record<string, unknown>;
        expect(extensions.code).toBe('FORBIDDEN');
        expect(extensions.errorCode).toBe('REPAIR_REQUEST_CUSTOMER_COMPANY_UNAVAILABLE');
        expect(response.body.data).toBeNull();
        expect(await readOrganizationStatus()).toBe('DISABLED');
        expect(await countCustomerRequests()).toBe(0);
      } finally {
        if (blocker.isTransactionActive) {
          await blocker.rollbackTransaction();
        }
        await blocker.release();
      }
    });

    it('报修先完成：有效未受管公司可报修，随后停用使后续报修 FORBIDDEN 且零新增', async () => {
      const model = await seedUsableModel();
      const organizationRows = await dataSource.query<
        Array<{ is_managed_company: number | boolean }>
      >('SELECT is_managed_company FROM organization WHERE id = ?', [customerOrganizationId]);
      // 补录后的自由创建公司：有效但不在受管名单（与注册候选口径不同）
      expect(Number(organizationRows[0]?.is_managed_company)).toBe(0);

      const first = await createMutation({
        equipmentModelId: model.id,
        errorCode: 'E2E-F2-2',
        faultDescription: '组织仍有效时的报修',
      }).expect(200);
      expect(first.body.errors).toBeUndefined();
      const created = first.body.data.createRepairRequest as { id: number; requestNo: string };
      recordOwnedResource(ownership, 'repairRequest', created.id, {
        requestNo: created.requestNo,
        customerAccountId,
        equipmentModelId: model.id,
        errorCode: 'E2E-F2-2',
        faultDescription: '组织仍有效时的报修',
      });
      const saved = await requestRepository.findOne({ where: { id: created.id } });
      expect(saved?.ownerOrganizationId).toBe(customerOrganizationId);

      await setOrganizationStatus('DISABLED');
      expect(await readOrganizationStatus()).toBe('DISABLED');

      const second = await createMutation({
        equipmentModelId: model.id,
        errorCode: 'E2E-F2-3',
        faultDescription: '停用后的报修',
      }).expect(200);
      expect(second.body.errors).toHaveLength(1);
      const extensions = second.body.errors[0].extensions as Record<string, unknown>;
      expect(extensions.code).toBe('FORBIDDEN');
      expect(extensions.errorCode).toBe('REPAIR_REQUEST_CUSTOMER_COMPANY_UNAVAILABLE');
      expect(second.body.data).toBeNull();
      expect(await countCustomerRequests()).toBe(1);
    });

    it('报修先持有有效性锁：停用更新等待该锁，持有方提交后才生效', async () => {
      const holder = dataSource.createQueryRunner();
      const writer = dataSource.createQueryRunner();
      await holder.connect();
      await writer.connect();
      await holder.startTransaction();
      await writer.startTransaction();
      try {
        // 与 CreateRepairRequestUsecase 写前复核相同的锁口径（当前读 + 共享行锁）
        await holder.query('SELECT id FROM organization WHERE id = ? AND status = ? FOR SHARE', [
          customerOrganizationId,
          'ACTIVE',
        ]);

        const update = writer.query("UPDATE organization SET status = 'DISABLED' WHERE id = ?", [
          customerOrganizationId,
        ]);
        const settled = update.then(
          (value) => ({ kind: 'settled' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );
        const early = await Promise.race([
          settled,
          sleep(500).then(() => ({ kind: 'blocked' as const })),
        ]);
        expect(early.kind).toBe('blocked');

        await holder.commitTransaction();
        const outcome = await settled;
        expect(outcome.kind).toBe('settled');
        await writer.commitTransaction();
        expect(await readOrganizationStatus()).toBe('DISABLED');
      } finally {
        if (holder.isTransactionActive) {
          await holder.rollbackTransaction();
        }
        if (writer.isTransactionActive) {
          await writer.rollbackTransaction();
        }
        await holder.release();
        await writer.release();
      }
    });

    it('无归属存量仍可读取本人历史申请，且写入口径仍失败关闭', async () => {
      const model = await seedUsableModel();
      const createdResponse = await createMutation({
        equipmentModelId: model.id,
        errorCode: 'E2E-F2-4',
        faultDescription: '产生历史申请',
      }).expect(200);
      expect(createdResponse.body.errors).toBeUndefined();
      const created = createdResponse.body.data.createRepairRequest as {
        id: number;
        requestNo: string;
      };
      recordOwnedResource(ownership, 'repairRequest', created.id, {
        requestNo: created.requestNo,
        customerAccountId,
        equipmentModelId: model.id,
        errorCode: 'E2E-F2-4',
        faultDescription: '产生历史申请',
      });

      await dataSource.query(
        'UPDATE base_user_info SET customer_organization_id = NULL WHERE account_id = ?',
        [customerAccountId],
      );
      updateOwnedExpectation(ownership, 'account', customerAccountId, {
        customerOrganizationId: null,
      });
      try {
        const read = await postGql({
          app,
          query: MY_REPAIR_REQUESTS_QUERY,
          variables: { pagination: OFFSET_PAGINATION },
          token: customerToken,
        }).expect(200);
        expect(read.body.errors).toBeUndefined();
        const ids = (read.body.data.myRepairRequests.items as Array<{ id: number }>).map(
          (item) => item.id,
        );
        expect(ids).toContain(created.id);

        const denied = await createMutation({
          equipmentModelId: model.id,
          errorCode: 'E2E-F2-5',
          faultDescription: '无归属时的新报修',
        }).expect(200);
        expect(denied.body.errors).toHaveLength(1);
        const extensions = denied.body.errors[0].extensions as Record<string, unknown>;
        expect(extensions.code).toBe('FORBIDDEN');
        expect(extensions.errorCode).toBe('REPAIR_REQUEST_CUSTOMER_COMPANY_REQUIRED');
        expect(denied.body.data).toBeNull();
        expect(await countCustomerRequests()).toBe(1);
      } finally {
        await dataSource.query(
          'UPDATE base_user_info SET customer_organization_id = ? WHERE account_id = ?',
          [customerOrganizationId, customerAccountId],
        );
        updateOwnedExpectation(ownership, 'account', customerAccountId, {
          customerOrganizationId,
        });
      }
    });
  });
});
