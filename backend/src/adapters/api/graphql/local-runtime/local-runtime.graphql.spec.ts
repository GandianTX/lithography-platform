// src/adapters/api/graphql/local-runtime/local-runtime.graphql.spec.ts

/**
 * 本地运行域 GraphQL 入口单测（任务 09 S1／S3／S4）。
 *
 * 覆盖两层契约：
 * 1. **入口准入**：未登录（无 JWT 会话）必须以 `UNAUTHENTICATED` 大类码拒绝，
 *    且不得进入 usecase；已登录但角色不足按 `FORBIDDEN` 拒绝（恢复预检为管理员专属）。
 *    这里走真实 `JwtAuthGuard.handleRequest` 的未登录分支与真实 `RolesGuard`，
 *    只把 passport 策略替身化（未在本用例内连接数据库与真实令牌签发）。
 * 2. **生成契约**：用 Nest code-first 在进程内生成 schema（与运行时
 *    `autoSchemaFile` 产物同源），断言任务 09 本地运行域的入口名、参数可空性与
 *    返回字段与契约一致——契约漂移（改名、改可空性、删字段）会直接让本用例失败。
 *
 * 明确替身：本地运行域的 usecase（只提供本层关心的返回值）。
 * 不连接 MySQL / Redis / 真实鉴权服务。
 */

import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { GqlExecutionContext, GraphQLModule, GraphQLSchemaHost } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { GraphQLObjectType, type GraphQLArgument } from 'graphql';
import request from 'supertest';

import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { registerEnums } from '@src/adapters/api/graphql/schema/enum.registry';
// eslint-disable-next-line local-architecture/no-adapter-to-infrastructure-imports -- 测试中注册真实运行时的全局异常过滤器以验证 GraphQL 大类码；生产 adapter 不依赖它
import { GqlAllExceptionsFilter } from '@src/infrastructure/graphql/filters/graphql-exception.filter';
import { CleanupLocalBackupPackagesUsecase } from '@src/usecases/local-runtime/cleanup-local-backup-packages.usecase';
import { GetLocalBackupRecordUsecase } from '@src/usecases/local-runtime/get-local-backup-record.usecase';
import { GetLocalBackupSettingsUsecase } from '@src/usecases/local-runtime/get-local-backup-settings.usecase';
import { GetLocalRestoreCapabilityUsecase } from '@src/usecases/local-runtime/get-local-restore-capability.usecase';
import { GetLocalRuntimeStatusUsecase } from '@src/usecases/local-runtime/get-local-runtime-status.usecase';
import { ListLocalBackupRecordsUsecase } from '@src/usecases/local-runtime/list-local-backup-records.usecase';
import { PrecheckLocalRestoreUsecase } from '@src/usecases/local-runtime/precheck-local-restore.usecase';
import { StartManualLocalBackupUsecase } from '@src/usecases/local-runtime/start-manual-local-backup.usecase';
import { LocalBackupResolver } from './local-backup.resolver';
import { LocalRuntimeResolver } from './local-runtime.resolver';

const ADMIN_USER = {
  sub: 900101,
  accountId: 900101,
  username: 'admin',
  email: null,
  accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
  restriction: 'NONE',
  adminLevel: 1,
  adminOrganizationId: 5,
  customerOrganizationId: null,
  engineerOrganizationId: null,
  registrationOrganizationId: null,
} as unknown as AuthenticatedSessionUser;

const ENGINEER_USER = {
  ...ADMIN_USER,
  sub: 900102,
  accountId: 900102,
  username: 'engineer',
  accessGroup: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
  adminLevel: null,
  adminOrganizationId: null,
} as unknown as AuthenticatedSessionUser;

const STATUS_VIEW = {
  installationId: 'inst-local-1',
  localSiteName: '苏州客户现场',
  mappedOrganizationId: 4,
  mappedOrganizationCode: 'ORG-004',
  viewerRole: 'ADMIN_LEVEL_1',
  scopeOrganizationId: null,
  service: {
    apiStatus: 'UP',
    databaseStatus: 'UP',
    taskFactSource: 'SQL',
    taskRecovery: 'ON_RESTART',
  },
  storage: {
    businessFileDirectory: '/data/business-files',
    businessFileDirectoryWritable: true,
    backupDirectory: '/data/backup-packages',
    backupDirectoryWritable: false,
  },
  tasks: {
    pendingUploadCount: 1,
    uploadingUploadCount: 0,
    failedUploadCount: 0,
    succeededUploadCount: 2,
    runningBackupCount: 0,
    lastBackupStartedAt: null,
    lastBackupFinishedAt: null,
  },
  companies: [],
  authorizations: [],
  generatedAt: new Date('2026-11-22T00:00:00.000Z'),
};

const PRECHECK_RESULT = {
  restoreId: 'restore-1',
  outcome: 'FAILED',
  snapshot: {
    schema_version: 1,
    checked_at: '2026-11-22T00:10:00.000Z',
    target: {
      backupId: 'backup-1',
      organizationId: 4,
      installationId: 'inst-local-1',
      manifestChecksum: null,
    },
    package: { readable: true, fileCount: 1, originalCount: 0, verifiedFileCount: 1 },
    protection: { backupId: 'protection-1', created: true },
    findings: [{ code: 'LOCAL_PACKAGE_MISSING', message: 'LOCAL_RESTORE_LOCAL_PACKAGE_MISSING' }],
  },
};

describe('本地运行域 GraphQL 入口（本地设置 + 备份与恢复）', () => {
  let app: INestApplication;

  const authState = { mode: 'anonymous' as 'anonymous' | 'admin' | 'engineer' };

  const getLocalRuntimeStatusUsecase = { execute: jest.fn() };
  const listLocalBackupRecordsUsecase = { execute: jest.fn() };
  const getLocalBackupRecordUsecase = { execute: jest.fn() };
  const getLocalBackupSettingsUsecase = { execute: jest.fn() };
  const startManualLocalBackupUsecase = { execute: jest.fn() };
  const precheckLocalRestoreUsecase = { execute: jest.fn() };
  const cleanupLocalBackupPackagesUsecase = { execute: jest.fn() };
  const getLocalRestoreCapabilityUsecase = { execute: jest.fn() };

  beforeAll(async () => {
    registerEnums();

    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          context: ({ req }: { req: { user?: AuthenticatedSessionUser } }) => ({ req }),
        }),
      ],
      providers: [
        LocalRuntimeResolver,
        LocalBackupResolver,
        { provide: GetLocalRuntimeStatusUsecase, useValue: getLocalRuntimeStatusUsecase },
        { provide: ListLocalBackupRecordsUsecase, useValue: listLocalBackupRecordsUsecase },
        { provide: GetLocalBackupRecordUsecase, useValue: getLocalBackupRecordUsecase },
        { provide: GetLocalBackupSettingsUsecase, useValue: getLocalBackupSettingsUsecase },
        { provide: StartManualLocalBackupUsecase, useValue: startManualLocalBackupUsecase },
        { provide: PrecheckLocalRestoreUsecase, useValue: precheckLocalRestoreUsecase },
        { provide: CleanupLocalBackupPackagesUsecase, useValue: cleanupLocalBackupPackagesUsecase },
        { provide: GetLocalRestoreCapabilityUsecase, useValue: getLocalRestoreCapabilityUsecase },
        {
          provide: GqlAllExceptionsFilter,
          useFactory: () =>
            new GqlAllExceptionsFilter({ get: () => 'test' } as unknown as ConfigService),
        },
        { provide: APP_FILTER, useExisting: GqlAllExceptionsFilter },
      ],
    })
      // 只替身化 passport 策略层：未登录分支走真实 JwtAuthGuard.handleRequest，
      // 角色判定走真实 RolesGuard（未 override）。
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const realGuard = new JwtAuthGuard();

          if (authState.mode === 'anonymous') {
            // 真实守卫的未登录分支：无用户 → 抛 AUTHENTICATION_FAILED
            return realGuard.handleRequest(null, false, undefined, context);
          }

          const gqlContext = GqlExecutionContext.create(context).getContext<{
            req: { user?: AuthenticatedSessionUser };
          }>();
          gqlContext.req.user = authState.mode === 'admin' ? ADMIN_USER : ENGINEER_USER;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authState.mode = 'anonymous';

    getLocalRuntimeStatusUsecase.execute.mockResolvedValue(STATUS_VIEW);
    listLocalBackupRecordsUsecase.execute.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    precheckLocalRestoreUsecase.execute.mockResolvedValue(PRECHECK_RESULT);
  });

  const post = (query: string, variables: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post('/graphql').send({ query, variables });

  const RUNTIME_STATUS_QUERY = `
    query LocalRuntimeStatus {
      localRuntimeStatus {
        installationId
        localSiteName
        viewerRole
        service {
          apiStatus
          databaseStatus
        }
        storage {
          businessFileDirectory
          businessFileDirectoryWritable
          backupDirectory
          backupDirectoryWritable
        }
        tasks {
          pendingUploadCount
        }
        generatedAt
      }
    }
  `;

  const BACKUP_RECORDS_QUERY = `
    query LocalBackupRecords {
      localBackupRecords {
        items {
          backupId
          organizationId
          localStatus
          cloudStatus
        }
        total
        page
        pageSize
      }
    }
  `;

  const PRECHECK_MUTATION = `
    mutation PrecheckLocalRestore($backupId: String!) {
      precheckLocalRestore(backupId: $backupId) {
        restoreId
        outcome
        checkedAt
        targetBackupId
        protectionBackupId
        protectionCreated
        findings {
          code
          message
        }
      }
    }
  `;

  describe('入口准入：未登录 → UNAUTHENTICATED', () => {
    it('未登录读取本机状态：UNAUTHENTICATED，且不进入 usecase', async () => {
      const response = await post(RUNTIME_STATUS_QUERY).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
      expect(getLocalRuntimeStatusUsecase.execute).not.toHaveBeenCalled();
    });

    it('未登录读取备份记录：UNAUTHENTICATED，且不进入 usecase', async () => {
      const response = await post(BACKUP_RECORDS_QUERY).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
      expect(listLocalBackupRecordsUsecase.execute).not.toHaveBeenCalled();
    });

    it('未登录发起恢复预检：UNAUTHENTICATED，且不进入 usecase', async () => {
      const response = await post(PRECHECK_MUTATION, { backupId: 'backup-1' }).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
      expect(precheckLocalRestoreUsecase.execute).not.toHaveBeenCalled();
    });
  });

  describe('入口准入：已登录但角色不足 → FORBIDDEN', () => {
    it('工程师调用管理员专属的恢复预检：FORBIDDEN，且不进入 usecase', async () => {
      authState.mode = 'engineer';

      const response = await post(PRECHECK_MUTATION, { backupId: 'backup-1' }).expect(200);

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(precheckLocalRestoreUsecase.execute).not.toHaveBeenCalled();
    });
  });

  describe('已登录：入口按 Session 裁决并如实返回服务端事实', () => {
    it('管理员读取本机状态：返回视图字段，范围与角色由服务端给出', async () => {
      authState.mode = 'admin';

      const response = await post(RUNTIME_STATUS_QUERY).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.localRuntimeStatus).toMatchObject({
        installationId: 'inst-local-1',
        localSiteName: '苏州客户现场',
        viewerRole: 'ADMIN_LEVEL_1',
        service: { apiStatus: 'UP', databaseStatus: 'UP' },
        storage: {
          businessFileDirectory: '/data/business-files',
          businessFileDirectoryWritable: true,
          backupDirectory: '/data/backup-packages',
          backupDirectoryWritable: false,
        },
      });
      expect(getLocalRuntimeStatusUsecase.execute).toHaveBeenCalledTimes(1);
    });

    it('管理员发起恢复预检：如实返回结论、保护副本事实与受控发现项', async () => {
      authState.mode = 'admin';

      const response = await post(PRECHECK_MUTATION, { backupId: 'backup-1' }).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.precheckLocalRestore).toMatchObject({
        restoreId: 'restore-1',
        outcome: 'FAILED',
        targetBackupId: 'backup-1',
        protectionBackupId: 'protection-1',
        protectionCreated: true,
        findings: [
          { code: 'LOCAL_PACKAGE_MISSING', message: 'LOCAL_RESTORE_LOCAL_PACKAGE_MISSING' },
        ],
      });
    });
  });

  describe('生成契约：进程内 schema 与任务 09 本地运行域契约一致', () => {
    const schema = () => app.get(GraphQLSchemaHost).schema;

    const queryField = (name: string) => schema().getQueryType()?.getFields()[name];
    const mutationField = (name: string) => schema().getMutationType()?.getFields()[name];
    const objectField = (typeName: string, fieldName: string) => {
      const type = schema().getType(typeName);

      if (!(type instanceof GraphQLObjectType)) {
        throw new Error(`生成契约中缺少对象类型 ${typeName}`);
      }

      return type.getFields()[fieldName];
    };
    const argType = (
      field: { args: readonly GraphQLArgument[] } | undefined,
      argName: string,
    ): string => {
      const arg = field?.args.find((candidate) => candidate.name === argName);

      if (!arg) {
        throw new Error(`生成契约中缺少参数 ${argName}`);
      }

      return arg.type.toString();
    };

    it('查询入口名、参数可空性与返回类型符合契约', () => {
      expect(queryField('localRuntimeStatus')?.type.toString()).toBe('LocalRuntimeStatus!');
      expect(queryField('localBackupRecords')?.type.toString()).toBe('LocalBackupRecordPage!');
      expect(argType(queryField('localBackupRecords'), 'pagination')).toBe(
        'LocalBackupRecordPaginationInput',
      );
      expect(queryField('localBackupRecord')?.type.toString()).toBe('LocalBackupRecordDetail!');
      expect(argType(queryField('localBackupRecord'), 'backupId')).toBe('String!');
      expect(queryField('localBackupSettings')?.type.toString()).toBe('[LocalBackupSetting!]!');
      expect(queryField('localRestoreCapability')?.type.toString()).toBe('LocalRestoreCapability!');
    });

    it('变更入口名、参数可空性与返回类型符合契约', () => {
      expect(mutationField('startManualLocalBackup')?.type.toString()).toBe(
        'StartManualLocalBackupResult!',
      );
      expect(argType(mutationField('startManualLocalBackup'), 'organizationId')).toBe('Int');
      expect(mutationField('precheckLocalRestore')?.type.toString()).toBe(
        'LocalRestorePrecheckResult!',
      );
      expect(argType(mutationField('precheckLocalRestore'), 'backupId')).toBe('String!');
      expect(mutationField('cleanupLocalBackupPackages')?.type.toString()).toBe(
        'LocalBackupCleanupResult!',
      );
      // 清理方式必填（MANUAL / RETENTION），公司参数可空（缺省按当前会话范围）
      expect(argType(mutationField('cleanupLocalBackupPackages'), 'mode')).toBe(
        'LocalBackupCleanupMode!',
      );
      expect(argType(mutationField('cleanupLocalBackupPackages'), 'organizationId')).toBe('Int');
    });

    it('恢复执行能力与恢复预检结果的字段可空性符合契约', () => {
      // 能力状态：可用性与原因码都是必填（前端按码映射文案，不接受空原因）
      expect(objectField('LocalRestoreCapability', 'executionAvailable').type.toString()).toBe(
        'Boolean!',
      );
      expect(objectField('LocalRestoreCapability', 'reason').type.toString()).toBe('String!');
      // 预检结论：结论与发现项列表必填；保护副本 ID 可空（未生成保护副本时为 null）
      expect(objectField('LocalRestorePrecheckResult', 'outcome').type.toString()).toBe('String!');
      expect(objectField('LocalRestorePrecheckResult', 'findings').type.toString()).toBe(
        '[LocalRestoreCheckFinding!]!',
      );
      expect(objectField('LocalRestorePrecheckResult', 'protectionBackupId').type.toString()).toBe(
        'String',
      );
    });

    it('本机运行状态的可空字段与视图口径一致（任务计数仅一级管理员可见）', () => {
      // 任务计数可空：二级管理员与工程师为 null（不跨公司暴露数量）
      expect(objectField('LocalRuntimeStatus', 'tasks').type.toString()).toBe(
        'LocalRuntimeTaskStatus',
      );
      expect(objectField('LocalRuntimeStatus', 'companies').type.toString()).toBe(
        '[LocalRuntimeCompanySetting!]!',
      );
      expect(objectField('LocalRuntimeStatus', 'authorizations').type.toString()).toBe(
        '[LocalRuntimeAuthorizationSummary!]!',
      );
      // 授权事实只含计数与校验时间：凭据材料永不进入契约
      expect(
        objectField('LocalRuntimeAuthorizationSummary', 'credentialPurpose').type.toString(),
      ).toBe('String!');
    });
  });
});
