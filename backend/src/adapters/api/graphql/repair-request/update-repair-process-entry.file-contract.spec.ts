// src/adapters/api/graphql/repair-request/update-repair-process-entry.file-contract.spec.ts

/**
 * GraphQL 入口合同回归：
 * - 旧维修过程写入（含省略/显式 file 的旧更新）一律 PROCESS_READONLY，不进入事务；
 * - 结单版本号在 GraphQL 层为必填 Int!，0 合法，缺失/非法值不得穿透到 usecase。
 *
 * 真实链路：Nest GraphQL schema → @ValidateInput ValidationPipe → RepairRequestResolver。
 * 明确替身：数据库/事务/绑定服务全部替换为可控 mock（不连接真实 MySQL）。
 */

import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { GraphQLModule, GqlExecutionContext } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { IdentityTypeEnum } from '@app-types/models/account.types';
import { JwtPayload } from '@app-types/jwt.types';
import { registerEnums } from '@src/adapters/api/graphql/schema/enum.registry';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { RepairProcessEntryService } from '@src/modules/lithography/repair-process-entry.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
// eslint-disable-next-line local-architecture/no-adapter-to-queryservice-imports -- 测试中用真实 usecase，仅为其依赖提供替身；生产 adapter 不依赖 QueryService
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { BindRepairProcessOriginalUsecase } from '@src/usecases/repair-request/bind-repair-process-original.usecase';
import { AcceptRepairRequestUsecase } from '@src/usecases/repair-request/accept-repair-request.usecase';
import { CloseRepairRequestUsecase } from '@src/usecases/repair-request/close-repair-request.usecase';
import { CreateEngineerResponseUsecase } from '@src/usecases/repair-request/create-engineer-response.usecase';
import { CreateRepairProcessEntryUsecase } from '@src/usecases/repair-request/create-repair-process-entry.usecase';
import { CreateRepairRequestUsecase } from '@src/usecases/repair-request/create-repair-request.usecase';
import { DeleteMyRepairRequestUsecase } from '@src/usecases/repair-request/delete-my-repair-request.usecase';
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

const ENGINEER_USER: JwtPayload = {
  sub: 100,
  username: 'engineer',
  email: null,
  accessGroup: ['ENGINEER'],
  activeRole: IdentityTypeEnum.ENGINEER,
};

const UPDATE_MUTATION = `
  mutation UpdateRepairProcessEntry($input: UpdateRepairProcessEntryInput!) {
    updateRepairProcessEntry(input: $input) {
      id
    }
  }
`;

const CLOSE_MUTATION = `
  mutation CloseRepairRequest($input: CloseRepairRequestInput!) {
    closeRepairRequest(input: $input) {
      requestId
      closureStatus
      closedAt
      closureReason
      handlingResult
      handlingStatus
      handlingEndedAt
    }
  }
`;

const BASE_ENTRY = {
  id: '201',
  entryUuid: '6f0c5f6a-3333-4333-8333-333333333333',
  requestId: 77,
  authorAccountId: 100,
  operationText: '原操作',
  testResult: null,
  occurredAt: new Date('2026-11-14T03:00:00.000Z'),
  timeSource: 'SERVER' as const,
  fileId: null,
  versionNo: 3,
  createdAt: new Date('2026-11-14T03:00:00.000Z'),
};

function baseUpdateInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 77,
    entryId: '201',
    expectedVersion: 3,
    operationText: '编辑后的操作',
    ...overrides,
  };
}

function baseCloseInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 77,
    handlingResult: 'FIXED',
    ...overrides,
  };
}

describe('RepairRequest GraphQL 入口合同（旧过程只读 / 结单版本必填）', () => {
  let app: INestApplication;
  const findForUpdate = jest.fn();
  const updateWithVersion = jest.fn();
  const findProcessWriteTargetForUpdate = jest.fn();
  const resolveForAccount = jest.fn();
  const runTransaction = jest.fn();
  const bindOriginal = jest.fn();
  const closeExecute = jest.fn();

  beforeAll(async () => {
    registerEnums();
    findForUpdate.mockResolvedValue(BASE_ENTRY);
    updateWithVersion.mockResolvedValue(1);
    findProcessWriteTargetForUpdate.mockResolvedValue({
      requestId: 77,
      deprecated: false,
      serviceOrganizationId: 10,
      isAccepted: true,
      acceptedByEngineerAccountId: 100,
      closureStatus: null,
      handlingStatus: null,
      maintenanceVersionNo: 3,
    });
    resolveForAccount.mockResolvedValue({ organizationId: 10 });
    runTransaction.mockImplementation(async (callback: (ctx: object) => Promise<unknown>) =>
      callback({}),
    );
    closeExecute.mockResolvedValue({
      requestId: 77,
      closureStatus: 'CLOSED',
      closedAt: new Date('2026-11-18T08:00:00.000Z'),
      closureReason: null,
      handlingResult: 'FIXED',
      handlingStatus: 'COMPLETED',
      handlingEndedAt: new Date('2026-11-18T08:00:00.000Z'),
    });

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
        UpdateRepairProcessEntryUsecase,
        {
          provide: RepairRequestService,
          useValue: { findProcessWriteTargetForUpdate },
        },
        {
          provide: RepairProcessEntryService,
          useValue: { findForUpdate, updateWithVersion },
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
          provide: TRANSACTION_RUNNER,
          useValue: { run: runTransaction },
        },
        {
          provide: CloseRepairRequestUsecase,
          useValue: { execute: closeExecute },
        },
        {
          provide: CreateRepairRequestUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: AcceptRepairRequestUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: CreateEngineerResponseUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: CreateRepairProcessEntryUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: InterruptRepairRequestUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: SaveRepairRequestMaintenanceUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: DeleteMyRepairRequestUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: ListMyRepairRequestsUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: ListEngineerRepairRequestsUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: GetMyRepairRequestDetailUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: GetEngineerRepairRequestDetailUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: GetEngineerRepairRequestRevisionHistoryUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: GetEngineerRepairRequestRevisionDetailUsecase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: SearchRepairServiceOrganizationsUsecase,
          useValue: { execute: jest.fn() },
        },
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
    findForUpdate.mockResolvedValue(BASE_ENTRY);
    updateWithVersion.mockResolvedValue(1);
    findProcessWriteTargetForUpdate.mockResolvedValue({
      requestId: 77,
      deprecated: false,
      serviceOrganizationId: 10,
      isAccepted: true,
      acceptedByEngineerAccountId: 100,
      closureStatus: null,
      handlingStatus: null,
      maintenanceVersionNo: 3,
    });
    resolveForAccount.mockResolvedValue({ organizationId: 10 });
    runTransaction.mockImplementation(async (callback: (ctx: object) => Promise<unknown>) =>
      callback({}),
    );
    closeExecute.mockResolvedValue({
      requestId: 77,
      closureStatus: 'CLOSED',
      closedAt: new Date('2026-11-18T08:00:00.000Z'),
      closureReason: null,
      handlingResult: 'FIXED',
      handlingStatus: 'COMPLETED',
      handlingEndedAt: new Date('2026-11-18T08:00:00.000Z'),
    });
  });

  it('旧更新省略 file：PROCESS_READONLY，不进入事务、不绑定、不写过程', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: UPDATE_MUTATION, variables: { input: baseUpdateInput() } })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].message).toContain('旧维修过程已只读');
    expect(runTransaction).not.toHaveBeenCalled();
    expect(findForUpdate).not.toHaveBeenCalled();
    expect(updateWithVersion).not.toHaveBeenCalled();
    expect(bindOriginal).not.toHaveBeenCalled();
  });

  it('旧更新显式 file:null：同样 PROCESS_READONLY，不进入事务', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: UPDATE_MUTATION,
        variables: { input: baseUpdateInput({ file: null }) },
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].message).toContain('旧维修过程已只读');
    expect(runTransaction).not.toHaveBeenCalled();
    expect(bindOriginal).not.toHaveBeenCalled();
    expect(updateWithVersion).not.toHaveBeenCalled();
  });

  it('旧改绑传新原件：拒绝替换，不绑定原件、不写过程', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: UPDATE_MUTATION,
        variables: {
          input: baseUpdateInput({
            file: {
              fileId: '7f0c5f6a-4444-4444-8444-444444444444',
              uploadContextId: '8f0c5f6a-5555-4555-8555-555555555555',
            },
          }),
        },
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].message).toContain('旧维修过程已只读');
    expect(runTransaction).not.toHaveBeenCalled();
    expect(bindOriginal).not.toHaveBeenCalled();
    expect(updateWithVersion).not.toHaveBeenCalled();
  });

  it('结单缺少 maintenanceVersionNo：GraphQL 必填校验拒绝，不调用 usecase', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: CLOSE_MUTATION, variables: { input: baseCloseInput() } })
      .expect(400);

    expect(response.body.errors).toHaveLength(1);
    expect(response.body.errors[0].message).toContain('maintenanceVersionNo');
    expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(closeExecute).not.toHaveBeenCalled();
  });

  it('结单负数版本被输入校验拒绝，不调用 usecase', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: CLOSE_MUTATION,
        variables: { input: baseCloseInput({ maintenanceVersionNo: -1 }) },
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors).toHaveLength(1);
    expect(response.body.errors[0].message).toContain('维修记录版本号');
    expect(closeExecute).not.toHaveBeenCalled();
  });

  it('结单非整数版本被 GraphQL Int 校验拒绝，不调用 usecase', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: CLOSE_MUTATION,
        variables: { input: baseCloseInput({ maintenanceVersionNo: 1.5 }) },
      })
      .expect(400);

    expect(response.body.errors).toHaveLength(1);
    expect(response.body.errors[0].message).toContain('Int cannot represent non-integer');
    expect(closeExecute).not.toHaveBeenCalled();
  });

  it('结单 maintenanceVersionNo=0：合法并原样传入 usecase', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: CLOSE_MUTATION,
        variables: { input: baseCloseInput({ maintenanceVersionNo: 0 }) },
      })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(closeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 77, maintenanceVersionNo: 0 }),
    );
    expect(response.body.data.closeRepairRequest.closureStatus).toBe('CLOSED');
    expect(response.body.data.closeRepairRequest.handlingStatus).toBe('COMPLETED');
  });
});
