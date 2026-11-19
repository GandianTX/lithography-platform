// src/adapters/api/graphql/repair-request/update-repair-process-entry.file-contract.spec.ts

/**
 * GraphQL 入口合同回归：编辑过程时 `file` 的「省略」与「显式 null」必须可区分。
 *
 * 真实链路：Nest GraphQL schema → @ValidateInput ValidationPipe → RepairRequestResolver
 *          → UpdateRepairProcessEntryUsecase 规范化/usecase 边界。
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
      entryUuid
      requestId
      operationText
      testResult
      occurredAt
      timeSource
      fileId
      versionNo
      createdAt
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

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 77,
    entryId: '201',
    expectedVersion: 3,
    operationText: '编辑后的操作',
    ...overrides,
  };
}

describe('UpdateRepairProcessEntryInput file 省略/null GraphQL 入口合同', () => {
  let app: INestApplication;
  const findForUpdate = jest.fn();
  const updateWithVersion = jest.fn();
  const findProcessWriteTargetForUpdate = jest.fn();
  const resolveForAccount = jest.fn();
  const runTransaction = jest.fn();
  const bindOriginal = jest.fn();

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
    });
    resolveForAccount.mockResolvedValue({ organizationId: 10 });
    runTransaction.mockImplementation(async (callback: (ctx: object) => Promise<unknown>) =>
      callback({}),
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
          provide: CloseRepairRequestUsecase,
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
    });
    resolveForAccount.mockResolvedValue({ organizationId: 10 });
    runTransaction.mockImplementation(async (callback: (ctx: object) => Promise<unknown>) =>
      callback({}),
    );
  });

  it('省略 file：schema/pipe/resolver 传 undefined，保持原有件绑定且不触发绑定用例', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: UPDATE_MUTATION, variables: { input: baseInput() } })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(findForUpdate).toHaveBeenCalledTimes(1);
    expect(updateWithVersion).toHaveBeenCalledTimes(1);
    expect(updateWithVersion.mock.calls[0][0]).not.toHaveProperty('fileId');
    expect(bindOriginal).not.toHaveBeenCalled();
    expect(response.body.data.updateRepairProcessEntry.fileId).toBeNull();
  });

  it('显式 file:null：schema/pipe 保留 null，usecase 按非法移除拒绝，不进入事务', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: UPDATE_MUTATION,
        variables: { input: baseInput({ file: null }) },
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors).toHaveLength(1);
    expect(response.body.errors[0].message).toContain('编辑不支持移除或清空原件');
    expect(runTransaction).not.toHaveBeenCalled();
    expect(findForUpdate).not.toHaveBeenCalled();
    expect(updateWithVersion).not.toHaveBeenCalled();
    expect(bindOriginal).not.toHaveBeenCalled();
  });

  it('已有原件时传新文件：仍由 usecase 拒绝替换，不静默覆盖', async () => {
    findForUpdate.mockResolvedValue({ ...BASE_ENTRY, fileId: 'file-existing' });

    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: UPDATE_MUTATION,
        variables: {
          input: baseInput({
            file: {
              fileId: '7f0c5f6a-4444-4444-8444-444444444444',
              uploadContextId: '8f0c5f6a-5555-4555-8555-555555555555',
            },
          }),
        },
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].message).toContain('编辑不能替换或移除');
    expect(bindOriginal).toHaveBeenCalledTimes(1);
    expect(updateWithVersion).not.toHaveBeenCalled();
  });
});
