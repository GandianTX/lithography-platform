// test/06-repair-request/repair-request-auth.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';

import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { executeGql, login, postGql } from '../utils/e2e-graphql-utils';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { createOwnedResourceLedger, runGuardedSpecCleanup } from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

const EQUIPMENT_MODELS_QUERY = 'query { equipmentModels { id modelCode modelName } }';

const CREATE_REPAIR_REQUEST_MUTATION = `
  mutation CreateRepairRequest($input: CreateRepairRequestInput!) {
    createRepairRequest(input: $input) { id requestNo }
  }
`;

/**
 * 拒绝路径不会进入业务写入，型号只需满足 DTO 形状；
 * 刻意使用不存在的 ID，避免任何“固定小 ID 一定存在”的隐含依赖。
 */
const NON_EXISTENT_EQUIPMENT_MODEL_ID = 999999;

const CREATE_REPAIR_REQUEST_VARIABLES = {
  input: {
    equipmentModelId: NON_EXISTENT_EQUIPMENT_MODEL_ID,
    errorCode: 'E-2001',
    faultDescription: '端点鉴权 e2e',
  },
};

/**
 * 维修申请端点级鉴权回归（core 组）
 *
 * 守卫机制本身由 03-roles-guard 覆盖；本文件回归的是
 * equipmentModels / createRepairRequest 两个真实端点确实挂载了
 * JwtAuthGuard + RolesGuard(CUSTOMER)，防止后续迭代遗漏守卫或放宽角色。
 * 业务成功路径由单测与联调证据覆盖，此处不重复。
 */
describe('维修申请端点鉴权 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  let ownership = createOwnedResourceLedger();
  const residueAccounts = buildTestAccountResidue(['staff', 'admin', 'guestPrimary']);

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    createAccountUsecase = app.get(CreateAccountUsecase);

    await app.init();
  }, 30000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'repair-request-auth.e2e afterAll',
          owned: ownership,
          residue: { accounts: residueAccounts },
        }),
      closeApp: app ? () => app.close() : null,
    });
  });

  beforeEach(async () => {
    await runGuardedSpecCleanup({
      dataSource,
      helper: 'repair-request-auth.e2e beforeEach',
      owned: ownership,
      residue: { accounts: residueAccounts },
    });
    ownership = createOwnedResourceLedger();
  });

  afterEach(async () => {
    await runGuardedSpecCleanup({
      dataSource,
      helper: 'repair-request-auth.e2e afterEach',
      owned: ownership,
      residue: { accounts: residueAccounts },
    });
    ownership = createOwnedResourceLedger();
  });

  const expectForbidden = (error: unknown, expectedUserRoles: string[]): void => {
    const err = error as { message: string; extensions: Record<string, unknown> };
    expect(err.message).toContain('缺少所需角色');
    expect(err.extensions.code).toBe('FORBIDDEN');
    expect(err.extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
    expect(err.extensions.details).toMatchObject({
      requiredRoles: ['CUSTOMER'],
      userRoles: expectedUserRoles,
    });
  };

  const expectUnauthenticated = (error: unknown): void => {
    const err = error as { message: string; extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('UNAUTHENTICATED');
    expect(err.extensions.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
  };

  describe('未登录（无 Token）', () => {
    it('equipmentModels 应返回 UNAUTHENTICATED', async () => {
      const response = await executeGql({ app, query: EQUIPMENT_MODELS_QUERY }).expect(200);
      expect(response.body.errors).toHaveLength(1);
      expectUnauthenticated(response.body.errors[0]);
    });

    it('createRepairRequest 应返回 UNAUTHENTICATED', async () => {
      const response = await postGql({
        app,
        query: CREATE_REPAIR_REQUEST_MUTATION,
        variables: CREATE_REPAIR_REQUEST_VARIABLES,
      }).expect(200);
      expect(response.body.errors).toHaveLength(1);
      expectUnauthenticated(response.body.errors[0]);
    });
  });

  describe('非 CUSTOMER 角色', () => {
    let engineerToken: string;
    let adminToken: string;

    beforeEach(async () => {
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['staff', 'admin'],
        ownership,
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
    });

    // 角色演进（0907.docx 任务二）：equipmentModels 由仅 CUSTOMER 扩展为三角色可读
    //（AI 参考资料库超管表单/工程师筛选需要基础数据），原 FORBIDDEN 钉住用例同步翻转。
    it('ENGINEER 调用 equipmentModels 现已允许（0907 参考资料库型号筛选）', async () => {
      const response = await executeGql({
        app,
        query: EQUIPMENT_MODELS_QUERY,
        token: engineerToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(Array.isArray(response.body.data.equipmentModels)).toBe(true);
    });

    it('SUPER_ADMIN 调用 equipmentModels 现已允许（0907 参考资料库表单）', async () => {
      const response = await executeGql({
        app,
        query: EQUIPMENT_MODELS_QUERY,
        token: adminToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(Array.isArray(response.body.data.equipmentModels)).toBe(true);
    });

    it('ENGINEER 调用 createRepairRequest 应返回 FORBIDDEN', async () => {
      const response = await postGql({
        app,
        query: CREATE_REPAIR_REQUEST_MUTATION,
        variables: CREATE_REPAIR_REQUEST_VARIABLES,
        token: engineerToken,
      }).expect(200);
      expect(response.body.errors).toHaveLength(1);
      expectForbidden(response.body.errors[0], ['ENGINEER']);
    });

    it('SUPER_ADMIN 代客户调用 createRepairRequest 应返回 FORBIDDEN', async () => {
      const response = await postGql({
        app,
        query: CREATE_REPAIR_REQUEST_MUTATION,
        variables: CREATE_REPAIR_REQUEST_VARIABLES,
        token: adminToken,
      }).expect(200);
      expect(response.body.errors).toHaveLength(1);
      expectForbidden(response.body.errors[0], ['SUPER_ADMIN']);
    });
  });

  describe('CUSTOMER 角色通过守卫', () => {
    let customerToken: string;

    beforeEach(async () => {
      await seedTestAccounts({
        dataSource,
        createAccountUsecase,
        includeKeys: ['guestPrimary'],
        ownership,
      });
      customerToken = await login({
        app,
        loginName: testAccountsConfig.guestPrimary.loginName,
        loginPassword: testAccountsConfig.guestPrimary.loginPassword,
      });
    });

    it('CUSTOMER 查询 equipmentModels 通过鉴权（仅断言无鉴权错误，业务数据不在本用例范围）', async () => {
      const response = await executeGql({
        app,
        query: EQUIPMENT_MODELS_QUERY,
        token: customerToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(Array.isArray(response.body.data.equipmentModels)).toBe(true);
    });
  });
});
