// src/adapters/api/graphql/repair-request/repair-request-rq.graphql.spec.ts

/**
 * PR #20 合并后（5f3f927 + 工作区 RQ 修复）定向验收：
 * - A 结单版本：真实 Resolver + 输入校验 + 真实 CloseRepairRequestUsecase；
 * - B 工程师姓名：真实 SaveRepairRequestMaintenanceUsecase + 真实 AccountQueryService，
 *   仅账号资料仓储为夹具替身；
 * - D 保存回执：回执（findRecord）必须在调用方事务内生成，事务失败不得返回“已保存”。
 *
 * 真实链路：Nest GraphQL schema → @ValidateInput ValidationPipe → RepairRequestResolver
 * → usecase → 模块服务替身（仓储/事务/外部依赖）。
 * 明确替身：RepairRequestService、RepairRequestMaintenanceService、
 * RepairRequestMaintenanceQueryService、RepairProcessEntryService、原件绑定用例、
 * 事务运行器，以及 AccountQueryService 的两处 Repository。
 * 不连接 MySQL / Redis / RAG。
 */

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { GqlExecutionContext, GraphQLModule } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import type { JwtPayload } from '@app-types/jwt.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { registerEnums } from '@src/adapters/api/graphql/schema/enum.registry';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
// eslint-disable-next-line local-architecture/no-adapter-to-infrastructure-imports -- 测试中注册真实运行时的全局异常过滤器以验证 GraphQL 大类码；生产 adapter 不依赖它
import { GqlAllExceptionsFilter } from '@src/infrastructure/graphql/filters/graphql-exception.filter';
// eslint-disable-next-line local-architecture/no-adapter-to-infrastructure-imports -- 测试中构造真实事务上下文（WeakMap 映射），不连接 DB
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
// eslint-disable-next-line local-architecture/no-adapter-to-queryservice-imports -- 测试中用真实 AccountQueryService，仅替换其 Repository；生产 adapter 不依赖 QueryService
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { RepairProcessEntryService } from '@src/modules/lithography/repair-process-entry.service';
import { RepairRequestMaintenanceService } from '@src/modules/lithography/repair-request-maintenance.service';
// eslint-disable-next-line local-architecture/no-adapter-to-queryservice-imports -- 测试中用真实 usecase，仅为其依赖提供替身；生产 adapter 不依赖 QueryService
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
// eslint-disable-next-line local-architecture/no-adapter-to-queryservice-imports -- 测试中用真实 usecase，仅为其依赖提供替身；生产 adapter 不依赖 QueryService
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { AcceptRepairRequestUsecase } from '@src/usecases/repair-request/accept-repair-request.usecase';
import { BindRepairProcessOriginalUsecase } from '@src/usecases/repair-request/bind-repair-process-original.usecase';
import { CloseRepairRequestUsecase } from '@src/usecases/repair-request/close-repair-request.usecase';
import { CreateEngineerResponseUsecase } from '@src/usecases/repair-request/create-engineer-response.usecase';
import { CreateRepairProcessEntryUsecase } from '@src/usecases/repair-request/create-repair-process-entry.usecase';
import { CreateRepairRequestUsecase } from '@src/usecases/repair-request/create-repair-request.usecase';
import { DeleteMyRepairRequestUsecase } from '@src/usecases/repair-request/delete-my-repair-request.usecase';
import { RetryIntakeAnalysisUsecase } from '@src/usecases/repair-request/retry-intake-analysis.usecase';
import { GetEngineerRepairRequestDetailUsecase } from '@src/usecases/repair-request/get-engineer-repair-request-detail.usecase';
import { GetEngineerRepairRequestRevisionDetailUsecase } from '@src/usecases/repair-request/get-engineer-repair-request-revision-detail.usecase';
import { GetEngineerRepairRequestRevisionHistoryUsecase } from '@src/usecases/repair-request/get-engineer-repair-request-revision-history.usecase';
import { GetMyRepairRequestDetailUsecase } from '@src/usecases/repair-request/get-my-repair-request-detail.usecase';
import { InterruptRepairRequestUsecase } from '@src/usecases/repair-request/interrupt-repair-request.usecase';
import { ListEngineerRepairRequestsUsecase } from '@src/usecases/repair-request/list-engineer-repair-requests.usecase';
import { ListMyRepairRequestsUsecase } from '@src/usecases/repair-request/list-my-repair-requests.usecase';
import { SaveRepairRequestMaintenanceUsecase } from '@src/usecases/repair-request/save-repair-request-maintenance.usecase';
import { SearchRepairServiceOrganizationsUsecase } from '@src/usecases/repair-request/search-repair-service-organizations.usecase';
import { UpdateRepairProcessEntryUsecase } from '@src/usecases/repair-request/update-repair-process-entry.usecase';
import { TRANSACTION_RUNNER } from '@src/usecases/common/ports/transaction-runner.contract';
import { RepairRequestResolver } from './repair-request.resolver';

const ENGINEER_ID = 900001;
const REQUEST_ID = 77;
const ORGANIZATION_ID = 10;

const ENGINEER_USER: JwtPayload = {
  sub: ENGINEER_ID,
  username: 'engineer',
  email: null,
  accessGroup: ['ENGINEER'],
  activeRole: IdentityTypeEnum.ENGINEER,
};

const CLOSE_MUTATION = `
  mutation CloseRepairRequest($input: CloseRepairRequestInput!) {
    closeRepairRequest(input: $input) {
      requestId
      closureStatus
      handlingStatus
    }
  }
`;

const SAVE_MUTATION = `
  mutation SaveRepairRequestMaintenance($input: SaveRepairRequestMaintenanceInput!) {
    saveRepairRequestMaintenance(input: $input) {
      maintenanceDate
      engineerName
      resetResult
      supplementaryNote
      versionNo
    }
  }
`;

const CREATE_PROCESS_MUTATION = `
  mutation CreateRepairProcessEntry($input: CreateRepairProcessEntryInput!) {
    createRepairProcessEntry(input: $input) {
      id
    }
  }
`;

const UPDATE_PROCESS_MUTATION = `
  mutation UpdateRepairProcessEntry($input: UpdateRepairProcessEntryInput!) {
    updateRepairProcessEntry(input: $input) {
      id
    }
  }
`;

const writeTarget = (overrides: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID,
  deprecated: false,
  serviceOrganizationId: ORGANIZATION_ID,
  isAccepted: true,
  acceptedByEngineerAccountId: ENGINEER_ID,
  closureStatus: null,
  handlingStatus: null,
  maintenanceVersionNo: 4,
  ...overrides,
});

const saveTarget = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  intakeId: 501,
  serviceOrganizationId: ORGANIZATION_ID,
  isAccepted: true,
  acceptedByEngineerAccountId: ENGINEER_ID,
  deprecated: false,
  handlingStatus: null,
  closureStatus: null,
  maintenanceAttachmentFileId: null,
  maintenanceVersionNo: 4,
  ...overrides,
});

function saveInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    expectedVersion: 4,
    maintenanceDate: '2026-11-18',
    steps: [],
    panels: [],
    ...overrides,
  };
}

describe('PR#20 RQ 定向验收：GraphQL Resolver + 真实业务用例（仓储替身）', () => {
  let app: INestApplication;

  const findProcessWriteTargetForUpdate = jest.fn();
  const closeRequest = jest.fn();
  const findTarget = jest.fn();
  const findTargetForUpdate = jest.fn();
  const attachMaintenanceFile = jest.fn();
  const saveMaintenance = jest.fn();
  const findRecord = jest.fn();
  const listSteps = jest.fn();
  const listFaultPanels = jest.fn();
  const findProcessEntryForUpdate = jest.fn();
  const updateProcessEntryWithVersion = jest.fn();
  const createProcessEntry = jest.fn();
  const resolveForAccount = jest.fn();
  const bindOriginal = jest.fn();
  const runTransaction = jest.fn();
  const userInfoFindOne = jest.fn();

  let inTransaction = false;
  let transactionContext: PersistenceTransactionContext;
  let accountQueryService: AccountQueryService;

  const savedEngineerNames: string[] = [];

  beforeAll(async () => {
    registerEnums();

    const fakeManager = {
      getRepository: () => ({ findOne: userInfoFindOne }),
    };
    // 用真实事务上下文工具创建 WeakMap 上下文；仓储替身由 fakeManager 返回。
    transactionContext = createTypeOrmPersistenceTransactionContext(fakeManager as never);
    accountQueryService = new AccountQueryService(
      { findOne: jest.fn() } as never,
      { findOne: userInfoFindOne } as never,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          context: ({ req }: { req: { user?: JwtPayload } }) => ({ req }),
        }),
      ],
      providers: [
        RepairRequestResolver,
        CloseRepairRequestUsecase,
        SaveRepairRequestMaintenanceUsecase,
        CreateRepairProcessEntryUsecase,
        UpdateRepairProcessEntryUsecase,
        {
          provide: GqlAllExceptionsFilter,
          useFactory: () =>
            new GqlAllExceptionsFilter({ get: () => 'test' } as unknown as ConfigService),
        },
        { provide: APP_FILTER, useExisting: GqlAllExceptionsFilter },
        { provide: AccountQueryService, useValue: accountQueryService },
        {
          provide: RepairRequestService,
          useValue: {
            findProcessWriteTargetForUpdate,
            closeRequest,
            findTarget,
          },
        },
        {
          provide: RepairRequestMaintenanceService,
          useValue: { findTarget, findTargetForUpdate, attachMaintenanceFile, saveMaintenance },
        },
        {
          provide: RepairRequestMaintenanceQueryService,
          useValue: { findRecord, listSteps, listFaultPanels },
        },
        {
          provide: RepairProcessEntryService,
          useValue: {
            findForUpdate: findProcessEntryForUpdate,
            updateWithVersion: updateProcessEntryWithVersion,
            insert: createProcessEntry,
          },
        },
        {
          provide: BindRepairProcessOriginalUsecase,
          useValue: { executeInTransaction: bindOriginal },
        },
        {
          provide: TrustedOrganizationContextQueryService,
          useValue: { resolveForAccount },
        },
        {
          provide: LocalWriteHoldService,
          useValue: {
            assertBusinessWritable: () => Promise.resolve(),
            assertBusinessWritableInTransaction: () => Promise.resolve(),
            assertCompanyWritable: () => Promise.resolve(),
            assertCompanyWritableInTransaction: () => Promise.resolve(),
            assertWritable: () => Promise.resolve(),
          },
        },
        {
          provide: TRANSACTION_RUNNER,
          useValue: { run: runTransaction },
        },
        { provide: CreateRepairRequestUsecase, useValue: { execute: jest.fn() } },
        { provide: AcceptRepairRequestUsecase, useValue: { execute: jest.fn() } },
        { provide: CreateEngineerResponseUsecase, useValue: { execute: jest.fn() } },
        { provide: InterruptRepairRequestUsecase, useValue: { execute: jest.fn() } },
        { provide: DeleteMyRepairRequestUsecase, useValue: { execute: jest.fn() } },
        { provide: RetryIntakeAnalysisUsecase, useValue: { execute: jest.fn() } },
        { provide: ListMyRepairRequestsUsecase, useValue: { execute: jest.fn() } },
        { provide: ListEngineerRepairRequestsUsecase, useValue: { execute: jest.fn() } },
        { provide: GetMyRepairRequestDetailUsecase, useValue: { execute: jest.fn() } },
        { provide: GetEngineerRepairRequestDetailUsecase, useValue: { execute: jest.fn() } },
        {
          provide: GetEngineerRepairRequestRevisionHistoryUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: GetEngineerRepairRequestRevisionDetailUsecase,
          useValue: { execute: jest.fn() },
        },
        { provide: SearchRepairServiceOrganizationsUsecase, useValue: { execute: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const gqlContext = GqlExecutionContext.create(context).getContext<{
            req: { user?: JwtPayload };
          }>();
          gqlContext.req.user = ENGINEER_USER;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    savedEngineerNames.length = 0;
    inTransaction = false;

    findProcessWriteTargetForUpdate.mockResolvedValue(writeTarget());
    closeRequest.mockResolvedValue(1);
    findTarget.mockResolvedValue(saveTarget());
    findTargetForUpdate.mockResolvedValue(saveTarget());
    attachMaintenanceFile.mockResolvedValue(undefined);
    saveMaintenance.mockImplementation((data: { engineerName: string }) => {
      savedEngineerNames.push(data.engineerName);
      return Promise.resolve(undefined);
    });
    findRecord.mockImplementation(() =>
      Promise.resolve({
        maintenanceDate: '2026-11-18',
        engineerName: savedEngineerNames[savedEngineerNames.length - 1] ?? null,
        resetResult: null,
        supplementaryNote: null,
        versionNo: 5,
        attachment: null,
      }),
    );
    listSteps.mockResolvedValue([]);
    listFaultPanels.mockResolvedValue([]);
    resolveForAccount.mockResolvedValue({ organizationId: ORGANIZATION_ID });
    bindOriginal.mockResolvedValue({});
    userInfoFindOne.mockResolvedValue({ id: 1, realName: '李工' });
    runTransaction.mockImplementation(
      async (callback: (context: PersistenceTransactionContext) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await callback(transactionContext);
        } finally {
          inTransaction = false;
        }
      },
    );
  });

  const post = (query: string, variables: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/graphql').send({ query, variables });

  /* ------------------------------ A 结单版本 ------------------------------ */

  describe('A 结单版本', () => {
    it('当前版本 4、提交 3：CONFLICT，结单写方法 0 次', async () => {
      const response = await post(CLOSE_MUTATION, {
        input: { requestId: REQUEST_ID, handlingResult: 'FIXED', maintenanceVersionNo: 3 },
      }).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(response.body.errors[0].message).toContain('维修记录已更新');
      expect(closeRequest).not.toHaveBeenCalled();
    });

    it('当前版本 4、提交 4：成功写入且只写一次', async () => {
      const response = await post(CLOSE_MUTATION, {
        input: { requestId: REQUEST_ID, handlingResult: 'FIXED', maintenanceVersionNo: 4 },
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.closeRepairRequest).toMatchObject({
        requestId: REQUEST_ID,
        closureStatus: 'CLOSED',
        handlingStatus: 'COMPLETED',
      });
      expect(closeRequest).toHaveBeenCalledTimes(1);
    });

    it('独立 v0 夹具：当前版本 0、提交 0 可结单', async () => {
      findProcessWriteTargetForUpdate.mockResolvedValue(writeTarget({ maintenanceVersionNo: 0 }));

      const response = await post(CLOSE_MUTATION, {
        input: { requestId: REQUEST_ID, handlingResult: 'PART_PURCHASED', maintenanceVersionNo: 0 },
      }).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.closeRepairRequest.closureStatus).toBe('CLOSED');
      expect(closeRequest).toHaveBeenCalledTimes(1);
    });

    it('版本字段缺失：GraphQL 必填校验拒绝，不进入 usecase', async () => {
      const response = await post(CLOSE_MUTATION, {
        input: { requestId: REQUEST_ID, handlingResult: 'FIXED' },
      });

      expect(response.status).toBe(400);
      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(closeRequest).not.toHaveBeenCalled();
    });

    it('非法版本（负数 / 非整数）：输入校验或 GraphQL Int 校验拒绝', async () => {
      const negative = await post(CLOSE_MUTATION, {
        input: { requestId: REQUEST_ID, handlingResult: 'FIXED', maintenanceVersionNo: -1 },
      }).expect(200);
      expect(negative.body.data).toBeNull();
      expect(negative.body.errors[0].message).toContain('维修记录版本号');
      expect(closeRequest).not.toHaveBeenCalled();

      const fractional = await post(CLOSE_MUTATION, {
        input: { requestId: REQUEST_ID, handlingResult: 'FIXED', maintenanceVersionNo: 1.5 },
      });
      expect(fractional.status).toBe(400);
      expect(fractional.body.errors[0].message).toContain('Int cannot represent non-integer');
      expect(closeRequest).not.toHaveBeenCalled();
    });
  });

  /* --------------------------- B 维修工程师姓名 --------------------------- */

  describe('B 维修工程师姓名（真实 AccountQueryService + 资料仓储夹具）', () => {
    it('首存：落库姓名取接单人可信资料', async () => {
      userInfoFindOne.mockResolvedValue({ id: 1, realName: '李工' });

      const response = await post(SAVE_MUTATION, { input: saveInput() }).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(saveMaintenance).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: REQUEST_ID, engineerName: '李工' }),
        transactionContext,
      );
      expect(savedEngineerNames).toEqual(['李工']);
    });

    it('续存：再次保存仍按当前可信资料写入，不沿用页面旧值', async () => {
      userInfoFindOne.mockResolvedValue({ id: 1, realName: '李工' });
      await post(SAVE_MUTATION, { input: saveInput() }).expect(200);

      userInfoFindOne.mockResolvedValue({ id: 1, realName: '李工（已更名）' });
      await post(SAVE_MUTATION, {
        input: saveInput({ expectedVersion: 4 }),
      }).expect(200);

      expect(savedEngineerNames).toEqual(['李工', '李工（已更名）']);
    });

    it.each([null, '', '客户端伪造姓名'])(
      '客户端传 %p 被忽略，持久化仍使用可信姓名',
      async (engineerName) => {
        userInfoFindOne.mockResolvedValue({ id: 1, realName: '李工' });

        const response = await post(SAVE_MUTATION, {
          input: saveInput({ engineerName }),
        }).expect(200);

        expect(response.body.errors).toBeUndefined();
        expect(saveMaintenance).toHaveBeenCalledWith(
          expect.objectContaining({ engineerName: '李工' }),
          transactionContext,
        );
      },
    );

    it.each([
      ['资料行缺失', null],
      ['姓名为空', { id: 1, realName: '' }],
      ['姓名为空白', { id: 1, realName: '   ' }],
    ])('可信资料%s：BAD_USER_INPUT，不写维修字段也不返回回执', async (_label, row) => {
      userInfoFindOne.mockResolvedValue(row);

      const response = await post(SAVE_MUTATION, { input: saveInput() }).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].message).toContain('接单工程师资料缺少真实姓名');
      expect(saveMaintenance).not.toHaveBeenCalled();
      expect(attachMaintenanceFile).not.toHaveBeenCalled();
      expect(findRecord).not.toHaveBeenCalled();
    });
  });

  /* ------------------------- C 旧维修过程只读入口 ------------------------- */

  describe('C 旧维修过程只读', () => {
    it('旧新增（无原件）：CONFLICT，不进入事务、不写过程行', async () => {
      const response = await post(CREATE_PROCESS_MUTATION, {
        input: { requestId: REQUEST_ID, operationText: '旧入口新增' },
      }).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(response.body.errors[0].message).toContain('旧维修过程已只读');
      expect(runTransaction).not.toHaveBeenCalled();
      expect(createProcessEntry).not.toHaveBeenCalled();
      expect(bindOriginal).not.toHaveBeenCalled();
    });

    it('旧新增携带原件（改绑）：同样拒绝，不绑定也不写过程行', async () => {
      const response = await post(CREATE_PROCESS_MUTATION, {
        input: {
          requestId: REQUEST_ID,
          operationText: '旧入口新增并绑原件',
          file: {
            fileId: '11111111-1111-4111-8111-111111111111',
            uploadContextId: '22222222-2222-4222-8222-222222222222',
          },
        },
      }).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(bindOriginal).not.toHaveBeenCalled();
      expect(createProcessEntry).not.toHaveBeenCalled();
    });

    it('旧更新：拒绝且不打开事务、不改绑、不写过程行', async () => {
      const response = await post(UPDATE_PROCESS_MUTATION, {
        input: {
          requestId: REQUEST_ID,
          entryId: '201',
          expectedVersion: 3,
          operationText: '旧入口编辑',
        },
      }).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(response.body.errors[0].message).toContain('旧维修过程已只读');
      expect(runTransaction).not.toHaveBeenCalled();
      expect(findProcessEntryForUpdate).not.toHaveBeenCalled();
      expect(updateProcessEntryWithVersion).not.toHaveBeenCalled();
      expect(bindOriginal).not.toHaveBeenCalled();
    });
  });

  /* ------------------- D 保存成功但详情读回失败的边界 ------------------- */

  describe('D 保存回执与事务边界', () => {
    it('回执在事务内读取，提交成功后才返回', async () => {
      let readWhileInsideTransaction = false;
      findRecord.mockImplementation(() => {
        readWhileInsideTransaction = inTransaction;
        return Promise.resolve({
          maintenanceDate: '2026-11-18',
          engineerName: '李工',
          resetResult: null,
          supplementaryNote: null,
          versionNo: 5,
          attachment: null,
        });
      });

      const response = await post(SAVE_MUTATION, { input: saveInput() }).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(saveMaintenance).toHaveBeenCalledTimes(1);
      expect(findRecord).toHaveBeenCalledWith(REQUEST_ID, transactionContext);
      expect(readWhileInsideTransaction).toBe(true);
      expect(response.body.data.saveRepairRequestMaintenance.versionNo).toBe(5);
    });

    it('事务提交失败：向上抛错，不返回“已保存”回执', async () => {
      runTransaction.mockImplementation(
        async (callback: (context: PersistenceTransactionContext) => Promise<unknown>) => {
          inTransaction = true;
          try {
            await callback(transactionContext);
          } finally {
            inTransaction = false;
          }
          throw new Error('commit failed');
        },
      );

      const response = await post(SAVE_MUTATION, { input: saveInput() }).expect(200);

      expect(saveMaintenance).toHaveBeenCalledTimes(1);
      expect(findRecord).toHaveBeenCalledTimes(1);
      expect(response.body.data).toBeNull();
      expect(response.body.errors).toBeDefined();
    });

    it('事务内写失败：不读取回执，客户端得到错误而不是成功', async () => {
      saveMaintenance.mockRejectedValue(new Error('write failed'));

      const response = await post(SAVE_MUTATION, { input: saveInput() }).expect(200);

      expect(findRecord).not.toHaveBeenCalled();
      expect(response.body.data).toBeNull();
      expect(response.body.errors).toBeDefined();
    });
  });
});
