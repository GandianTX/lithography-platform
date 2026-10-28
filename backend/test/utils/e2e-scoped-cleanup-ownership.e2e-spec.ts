// test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts
//
// PR0 独立终审 R02（spec §3.5）验收规格：清理归属与引用闭包的 C01–C10。
//
// 边界：
// - 真实隔离库（默认 lithography_e2e）+ 双门禁（清理许可 + 库名白名单）；
// - 每个用例只创建/清理自己明确记录的主键，不使用全局 TRUNCATE 或整表 DELETE；
// - 冲突场景必须断言 DELETE=0 且原始行逐字段不变；
// - C07 的失败注入只在测试侧用 Proxy 包装真实 DataSource，不在 src 增加钩子。
//
// 运行前置：显式设置 E2E_ALLOW_PHYSICAL_CLEANUP=1（缺许可时本 spec 的收尾会按设计失败关闭）。

import {
  AccountStatus,
  IdentityTypeEnum,
  ThirdPartyProviderEnum,
} from '@app-types/models/account.types';
import { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { EngineerResponseEntity } from '@src/modules/lithography/entities/engineer-response.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { ReferenceDocumentEntity } from '@src/modules/lithography/entities/reference-document.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { ThirdPartyAuthEntity } from '@src/modules/third-party-auth/third-party-auth.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { DataSource, EntityManager } from 'typeorm';

import { assertDataSourceOnAllowedE2eDatabase } from './e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from './e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from './e2e-teardown';
import { createTestAccount, type TestAccountConfig } from './test-accounts';

jest.setTimeout(60000);

/** 每次运行独立后缀：避免上一轮中断残留与本次唯一键碰撞（同轮内指纹断言仍确定）。 */
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();

const codeFor = (label: string): string => `E2E_OWN_${label}_${RUN_TAG}`.toUpperCase();
const loginFor = (label: string): string => `own${label.toLowerCase()}_${RUN_TAG}`;
const emailFor = (label: string): string => `own.${label.toLowerCase()}.${RUN_TAG}@example.com`;

const accountConfig = (
  label: string,
  accessGroup: IdentityTypeEnum[],
  identityType: IdentityTypeEnum,
): TestAccountConfig => ({
  loginName: loginFor(label),
  loginEmail: emailFor(label),
  loginPassword: `Own${label}@2024`,
  status: AccountStatus.ACTIVE,
  accessGroup,
  identityType,
});

// ---------------------------------------------------------------------------------------
// 夹具构造与快照（全部使用测试侧精确主键）
// ---------------------------------------------------------------------------------------

interface OrganizationFields {
  organizationCode: string;
  name: string;
  kind: string;
  status: string;
}

interface AccountFields {
  account: {
    loginName: string | null;
    loginEmail: string | null;
    status: AccountStatus;
    identityHint: string | null;
  };
  userInfo: {
    nickname: string;
    email: string | null;
    accessGroup: IdentityTypeEnum[];
    metaDigest: IdentityTypeEnum[] | null;
    userState: string;
  } | null;
}

interface MembershipFields {
  organizationId: number;
  accountId: number;
  memberRole: string;
  status: string;
  leftAt: Date | null;
}

interface DocumentFields {
  title: string;
  documentType: string;
  ownerOrganizationId: number;
  createdByAccountId: number;
  updatedByAccountId: number | null;
  sourceSubmissionId: number | null;
  sourceRevisionId: number | null;
  equipmentModelId: number | null;
}

interface EquipmentModelFields {
  modelCode: string;
  modelName: string;
  enabled: boolean;
  sortOrder: number;
}

const createOrganization = async (
  dataSource: DataSource,
  spec: {
    organizationCode: string;
    name: string;
    kind: 'CLIENT' | 'PEER';
    status?: 'ACTIVE' | 'DISABLED';
  },
): Promise<number> => {
  const repository = dataSource.getRepository(OrganizationEntity);
  const saved = await repository.save(
    repository.create({
      organizationCode: spec.organizationCode,
      name: spec.name,
      kind: spec.kind,
      status: spec.status ?? 'ACTIVE',
    }),
  );
  return saved.id;
};

const createAccount = async (
  dataSource: DataSource,
  createAccountUsecase: CreateAccountUsecase,
  config: TestAccountConfig,
): Promise<number> => {
  const { accountId } = await createTestAccount(dataSource, createAccountUsecase, config);
  return accountId;
};

const createMembership = async (
  dataSource: DataSource,
  organizationId: number,
  accountId: number,
): Promise<number> => {
  const repository = dataSource.getRepository(OrganizationMembershipEntity);
  const saved = await repository.save(
    repository.create({
      organizationId,
      accountId,
      memberRole: 'ENGINEER',
      status: 'ACTIVE',
      leftAt: null,
    }),
  );
  return saved.id;
};

const createDocument = async (
  dataSource: DataSource,
  params: {
    title: string;
    ownerOrganizationId: number;
    createdByAccountId: number;
  },
): Promise<number> => {
  const repository = dataSource.getRepository(ReferenceDocumentEntity);
  const saved = await repository.save(
    repository.create({
      title: params.title,
      documentType: 'E2E_OWNERSHIP',
      contentText: `# ${params.title}`,
      ownerOrganizationId: params.ownerOrganizationId,
      createdByAccountId: params.createdByAccountId,
      ingestMethod: 'ADMIN_DIRECT',
    }),
  );
  return saved.id;
};

const createEquipmentModel = async (
  dataSource: DataSource,
  spec: { modelCode: string; modelName: string },
): Promise<number> => {
  const repository = dataSource.getRepository(EquipmentModelEntity);
  const saved = await repository.save(
    repository.create({
      modelCode: spec.modelCode,
      modelName: spec.modelName,
      enabled: true,
      sortOrder: 1,
    }),
  );
  return saved.id;
};

const createThirdPartyBinding = async (
  dataSource: DataSource,
  params: {
    accountId: number;
    provider: ThirdPartyProviderEnum;
    providerUserId: string;
    unionId: string | null;
  },
): Promise<number> => {
  const repository = dataSource.getRepository(ThirdPartyAuthEntity);
  const saved = await repository.save(
    repository.create({
      accountId: params.accountId,
      provider: params.provider,
      providerUserId: params.providerUserId,
      unionId: params.unionId,
      accessToken: null,
    }),
  );
  return saved.id;
};

const createRepairRequest = async (
  dataSource: DataSource,
  params: {
    requestNo: string;
    customerAccountId: number;
    equipmentModelId: number;
    errorCode: string;
    faultDescription: string;
  },
): Promise<number> => {
  const repository = dataSource.getRepository(RepairRequestEntity);
  const saved = await repository.save(
    repository.create({
      requestNo: params.requestNo,
      customerAccountId: params.customerAccountId,
      equipmentModelId: params.equipmentModelId,
      errorCode: params.errorCode,
      faultDescription: params.faultDescription,
      contentMd: `# ${params.requestNo}`,
    }),
  );
  return saved.id;
};

const createEngineerResponse = async (
  dataSource: DataSource,
  params: {
    requestId: number;
    engineerAccountId: number;
    customerAccountId: number;
    responseText: string;
  },
): Promise<number> => {
  const repository = dataSource.getRepository(EngineerResponseEntity);
  const saved = await repository.save(
    repository.create({
      requestId: params.requestId,
      engineerAccountId: params.engineerAccountId,
      customerAccountId: params.customerAccountId,
      responseText: params.responseText,
      resolutionStatus: EngineerResolutionStatus.PENDING,
    }),
  );
  return saved.id;
};

// R02：本轮资源的登记必须同时携带最小预期事实。
// 以下 helper 只在受控造数完成后立即读取**本次创建结果**形成预期事实，
// 不参与清理阶段，也绝不把清理时的当前值回填为预期。
const ownOrganizationFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const row = await ds.getRepository(OrganizationEntity).findOneOrFail({ where: { id } });
  recordOwnedResource(ledger, 'organization', id, {
    organizationCode: row.organizationCode,
    name: row.name,
    kind: row.kind,
    status: row.status,
  });
};

const ownAccountFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const account = await ds.getRepository(AccountEntity).findOneOrFail({ where: { id } });
  const userInfo = await ds
    .getRepository(UserInfoEntity)
    .findOneOrFail({ where: { accountId: id } });
  recordOwnedResource(ledger, 'account', id, {
    loginName: account.loginName,
    loginEmail: account.loginEmail,
    status: account.status,
    identityHint: account.identityHint,
    accessGroup: userInfo.accessGroup,
    // N01：账号与用户资料分别登记，资料缺失会在清理预检中失败关闭。
    nickname: userInfo.nickname,
    userInfoEmail: userInfo.email ?? null,
    userState: userInfo.userState,
  });
};

const ownMembershipFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const row = await ds.getRepository(OrganizationMembershipEntity).findOneOrFail({ where: { id } });
  recordOwnedResource(ledger, 'membership', id, {
    organizationId: row.organizationId,
    accountId: row.accountId,
    memberRole: row.memberRole,
    status: row.status,
  });
};

const ownDocumentFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const row = await ds.getRepository(ReferenceDocumentEntity).findOneOrFail({ where: { id } });
  recordOwnedResource(ledger, 'document', id, {
    ownerOrganizationId: row.ownerOrganizationId,
    createdByAccountId: row.createdByAccountId,
    sourceSubmissionId: row.sourceSubmissionId ?? null,
    sourceRevisionId: row.sourceRevisionId ?? null,
    equipmentModelId: row.equipmentModelId ?? null,
  });
};

const ownEquipmentModelFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const row = await ds.getRepository(EquipmentModelEntity).findOneOrFail({ where: { id } });
  recordOwnedResource(ledger, 'equipmentModel', id, {
    modelCode: row.modelCode,
    modelName: row.modelName,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
  });
};

const ownThirdPartyAuthFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const row = await ds.getRepository(ThirdPartyAuthEntity).findOneOrFail({ where: { id } });
  recordOwnedResource(ledger, 'thirdPartyAuth', id, {
    accountId: row.accountId,
    provider: row.provider,
    providerUserId: row.providerUserId,
    unionId: row.unionId,
  });
};

const ownRepairRequestFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const row = await ds.getRepository(RepairRequestEntity).findOneOrFail({ where: { id } });
  recordOwnedResource(ledger, 'repairRequest', id, {
    requestNo: row.requestNo,
    customerAccountId: row.customerAccountId,
    equipmentModelId: row.equipmentModelId,
    errorCode: row.errorCode,
    faultDescription: row.faultDescription,
  });
};

const ownEngineerResponseFromDb = async (
  ds: DataSource,
  ledger: OwnedResourceLedger,
  id: number,
): Promise<void> => {
  const row = await ds.getRepository(EngineerResponseEntity).findOneOrFail({ where: { id } });
  recordOwnedResource(ledger, 'engineerResponse', id, {
    requestId: row.requestId,
    engineerAccountId: row.engineerAccountId,
    customerAccountId: row.customerAccountId,
    responseText: row.responseText,
    resolutionStatus: row.resolutionStatus,
  });
};

interface ThirdPartyBindingFields {
  accountId: number;
  provider: string;
  providerUserId: string;
  unionId: string | null;
}

const readThirdPartyBindingFields = async (
  dataSource: DataSource,
  id: number,
): Promise<ThirdPartyBindingFields | null> => {
  const row = await dataSource.getRepository(ThirdPartyAuthEntity).findOne({ where: { id } });
  return row
    ? {
        accountId: row.accountId,
        provider: row.provider,
        providerUserId: row.providerUserId,
        unionId: row.unionId,
      }
    : null;
};

interface RepairRequestFields {
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
}

const readRepairRequestFields = async (
  dataSource: DataSource,
  id: number,
): Promise<RepairRequestFields | null> => {
  const row = await dataSource.getRepository(RepairRequestEntity).findOne({ where: { id } });
  return row
    ? {
        requestNo: row.requestNo,
        customerAccountId: row.customerAccountId,
        equipmentModelId: row.equipmentModelId,
        errorCode: row.errorCode,
        faultDescription: row.faultDescription,
      }
    : null;
};

interface EngineerResponseFields {
  requestId: number;
  engineerAccountId: number;
  customerAccountId: number;
  responseText: string;
  resolutionStatus: string;
}

const readEngineerResponseFields = async (
  dataSource: DataSource,
  id: number,
): Promise<EngineerResponseFields | null> => {
  const row = await dataSource.getRepository(EngineerResponseEntity).findOne({ where: { id } });
  return row
    ? {
        requestId: row.requestId,
        engineerAccountId: row.engineerAccountId,
        customerAccountId: row.customerAccountId,
        responseText: row.responseText,
        resolutionStatus: row.resolutionStatus,
      }
    : null;
};

const readOrganizationFields = async (
  dataSource: DataSource,
  id: number,
): Promise<OrganizationFields | null> => {
  const row = await dataSource.getRepository(OrganizationEntity).findOne({ where: { id } });
  return row
    ? {
        organizationCode: row.organizationCode,
        name: row.name,
        kind: row.kind,
        status: row.status,
      }
    : null;
};

const readAccountFields = async (
  dataSource: DataSource,
  accountId: number,
): Promise<AccountFields | null> => {
  const account = await dataSource
    .getRepository(AccountEntity)
    .findOne({ where: { id: accountId } });
  if (!account) {
    return null;
  }
  const userInfo = await dataSource.getRepository(UserInfoEntity).findOne({ where: { accountId } });
  return {
    account: {
      loginName: account.loginName,
      loginEmail: account.loginEmail,
      status: account.status,
      identityHint: account.identityHint,
    },
    userInfo: userInfo
      ? {
          nickname: userInfo.nickname,
          email: userInfo.email,
          accessGroup: userInfo.accessGroup,
          metaDigest: userInfo.metaDigest,
          userState: userInfo.userState,
        }
      : null,
  };
};

const readMembershipFields = async (
  dataSource: DataSource,
  id: number,
): Promise<MembershipFields | null> => {
  const row = await dataSource
    .getRepository(OrganizationMembershipEntity)
    .findOne({ where: { id } });
  return row
    ? {
        organizationId: row.organizationId,
        accountId: row.accountId,
        memberRole: row.memberRole,
        status: row.status,
        leftAt: row.leftAt,
      }
    : null;
};

const readDocumentFields = async (
  dataSource: DataSource,
  id: number,
): Promise<DocumentFields | null> => {
  const row = await dataSource.getRepository(ReferenceDocumentEntity).findOne({ where: { id } });
  return row
    ? {
        title: row.title,
        documentType: row.documentType,
        ownerOrganizationId: row.ownerOrganizationId,
        createdByAccountId: row.createdByAccountId,
        updatedByAccountId: row.updatedByAccountId,
        sourceSubmissionId: row.sourceSubmissionId,
        sourceRevisionId: row.sourceRevisionId,
        equipmentModelId: row.equipmentModelId,
      }
    : null;
};

const readEquipmentModelFields = async (
  dataSource: DataSource,
  id: number,
): Promise<EquipmentModelFields | null> => {
  const row = await dataSource.getRepository(EquipmentModelEntity).findOne({ where: { id } });
  return row
    ? {
        modelCode: row.modelCode,
        modelName: row.modelName,
        enabled: row.enabled,
        sortOrder: row.sortOrder,
      }
    : null;
};

const ledgerHasAny = (ledger: OwnedResourceLedger): boolean =>
  Object.values(ledger).some((ids) => ids.length > 0);

// ---------------------------------------------------------------------------------------
// 计数/失败注入代理：只包装真实 DataSource 的事务 manager，不触碰 src
// ---------------------------------------------------------------------------------------

interface TransactionStats {
  transactionCount: number;
  deleteCount: number;
}

const isDeleteSql = (sql: string): boolean => /^\s*DELETE\b/i.test(sql);

const createDeleteCountingDataSource = (
  target: DataSource,
): { dataSource: DataSource; stats: TransactionStats } => {
  const stats: TransactionStats = { transactionCount: 0, deleteCount: 0 };
  const dataSource = new Proxy(target, {
    get: (object, property, receiver) => {
      if (property === 'transaction') {
        return (run: (manager: EntityManager) => Promise<unknown>) => {
          stats.transactionCount += 1;
          return target.transaction(async (manager) => {
            const wrappedManager = new Proxy(manager, {
              get: (managerTarget, managerProperty, managerReceiver) => {
                if (managerProperty === 'query') {
                  return (sql: string, params?: unknown[]) => {
                    if (isDeleteSql(sql)) {
                      stats.deleteCount += 1;
                    }
                    return manager.query(sql, params);
                  };
                }
                return Reflect.get(managerTarget, managerProperty, managerReceiver);
              },
            });
            return run(wrappedManager);
          });
        };
      }
      return Reflect.get(object, property, receiver);
    },
  });
  return { dataSource, stats };
};

/**
 * G03：只替换 expected 目标库来源，其余连接仍为真实实例（options 转发其余字段）。
 * 预期来自 DataSource 配置或调用契约，不能由当前 SELECT DATABASE() 回填。
 */
const withExpectedDatabase = (target: DataSource, database: string | undefined): DataSource =>
  new Proxy(target, {
    get: (object, property, receiver) =>
      property === 'options'
        ? { ...object.options, database }
        : Reflect.get(object, property, receiver),
  });

/**
 * F03：只记录真实事务内执行过的 DELETE 目标表，验证删除顺序满足外键约束。
 */
const createDeleteRecordingDataSource = (
  target: DataSource,
): { dataSource: DataSource; tables: string[] } => {
  const tables: string[] = [];
  const dataSource = new Proxy(target, {
    get: (object, property, receiver) => {
      if (property === 'transaction') {
        return (run: (manager: EntityManager) => Promise<unknown>) =>
          target.transaction(async (manager) => {
            const wrappedManager = new Proxy(manager, {
              get: (managerTarget, managerProperty, managerReceiver) => {
                if (managerProperty === 'query') {
                  return (sql: string, params?: unknown[]) => {
                    const matched = /^\s*DELETE\s+FROM\s+([a-z_]+)/i.exec(sql);
                    if (matched) {
                      tables.push(matched[1].toLowerCase());
                    }
                    return manager.query(sql, params);
                  };
                }
                return Reflect.get(managerTarget, managerProperty, managerReceiver);
              },
            });
            return run(wrappedManager);
          });
      }
      return Reflect.get(object, property, receiver);
    },
  });
  return { dataSource, tables };
};

const createFailNthDeleteDataSource = (
  target: DataSource,
  failAt: number,
): { dataSource: DataSource; stats: TransactionStats; injectedError: Error } => {
  const stats: TransactionStats = { transactionCount: 0, deleteCount: 0 };
  const injectedError = new Error(`注入：第 ${failAt} 次 DELETE 失败`);
  const dataSource = new Proxy(target, {
    get: (object, property, receiver) => {
      if (property === 'transaction') {
        return (run: (manager: EntityManager) => Promise<unknown>) => {
          stats.transactionCount += 1;
          return target.transaction(async (manager) => {
            const wrappedManager = new Proxy(manager, {
              get: (managerTarget, managerProperty, managerReceiver) => {
                if (managerProperty === 'query') {
                  return (sql: string, params?: unknown[]) => {
                    if (isDeleteSql(sql)) {
                      stats.deleteCount += 1;
                      if (stats.deleteCount === failAt) {
                        return Promise.reject(injectedError);
                      }
                    }
                    return manager.query(sql, params);
                  };
                }
                return Reflect.get(managerTarget, managerProperty, managerReceiver);
              },
            });
            return run(wrappedManager);
          });
        };
      }
      return Reflect.get(object, property, receiver);
    },
  });
  return { dataSource, stats, injectedError };
};

/**
 * D2 负对照：同样的“第 N 次 DELETE 注错”，但把 transaction 换成直接使用
 * 自动提交的 manager（没有 BEGIN/ROLLBACK）。用于证明快照恢复断言确实能区分
 * “真实事务回滚”与“无事务的部分删除”，而不是两条断言都恰好通过。
 */
const createFailNthDeleteNoTransactionDataSource = (
  target: DataSource,
  failAt: number,
): { dataSource: DataSource; stats: TransactionStats; injectedError: Error } => {
  const stats: TransactionStats = { transactionCount: 0, deleteCount: 0 };
  const injectedError = new Error(`注入：第 ${failAt} 次 DELETE 失败`);
  const autoCommitManager: Pick<EntityManager, 'query'> = {
    query: ((sql: string, params?: unknown[]) => {
      if (isDeleteSql(sql)) {
        stats.deleteCount += 1;
        if (stats.deleteCount === failAt) {
          return Promise.reject(injectedError);
        }
      }
      return target.query(sql, params);
    }) as EntityManager['query'],
  };
  const dataSource = new Proxy(target, {
    get: (object, property, receiver) => {
      if (property === 'transaction') {
        return (run: (manager: EntityManager) => Promise<unknown>) => {
          stats.transactionCount += 1;
          return run(autoCommitManager as EntityManager);
        };
      }
      return Reflect.get(object, property, receiver);
    },
  });
  return { dataSource, stats, injectedError };
};
const createFailUserInfoDataSource = (target: DataSource): DataSource =>
  new Proxy(target, {
    get: (object, property, receiver) => {
      if (property === 'transaction') {
        return (run: (manager: EntityManager) => Promise<unknown>) =>
          target.transaction(async (manager) => {
            const wrappedManager = new Proxy(manager, {
              get: (managerTarget, managerProperty, managerReceiver) => {
                if (managerProperty === 'getRepository') {
                  return (entity: unknown) => {
                    if (entity !== UserInfoEntity) {
                      return manager.getRepository(
                        entity as Parameters<EntityManager['getRepository']>[0],
                      );
                    }
                    return {
                      create: (data: Partial<UserInfoEntity>) =>
                        manager.getRepository(UserInfoEntity).create(data),
                      save: (): Promise<never> =>
                        Promise.reject(new Error('注入失败：user_info 写入')),
                    };
                  };
                }
                return Reflect.get(managerTarget, managerProperty, managerReceiver);
              },
            });
            return run(wrappedManager);
          });
      }
      return Reflect.get(object, property, receiver);
    },
  });

// ---------------------------------------------------------------------------------------
// C01–C10
// ---------------------------------------------------------------------------------------

describe('清理归属与引用闭包 C01–C10（真实隔离库）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  /** 当前用例创建的全部真实主键：afterEach 只按这些精确 ID 回收 */
  let testLedger: OwnedResourceLedger;

  beforeAll(async () => {
    const [{ initGraphQLSchema }, { ApiModule: apiModule }] = await Promise.all([
      import('../../src/adapters/api/graphql/schema/schema.init'),
      import('../../src/bootstraps/api/api.module'),
    ]);
    initGraphQLSchema();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [apiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    // 任何造数/删除之前先确认实际连接库属于 E2E 白名单
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    createAccountUsecase = app.get(CreateAccountUsecase);
  });

  beforeEach(() => {
    testLedger = createOwnedResourceLedger();
  });

  afterEach(async () => {
    if (dataSource?.isInitialized && ledgerHasAny(testLedger)) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: testLedger,
        helper: 'e2e-scoped-cleanup-ownership.e2e-spec afterEach 精确回收',
      });
    }
  });

  afterAll(async () => {
    await runE2eTeardown({
      closeApp: app
        ? async () => {
            await app.close();
          }
        : null,
    });
  });

  it('C01 缺许可/错库：计数代理下 DELETE=0，E2E_SKIP_DB_CLEANUP 不能绕过清理许可门禁', async () => {
    const organizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('C01_ORG'),
      name: 'C01 目标组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, organizationId);

    const targetLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, targetLedger, organizationId);

    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    const skipOriginal = captureEnvValue('E2E_SKIP_DB_CLEANUP');
    const allowedOriginal = captureEnvValue('E2E_ALLOWED_DB_NAMES');
    try {
      // 缺许可：即使全局清理被 skip 掉，清理许可门禁仍必须失败关闭
      process.env.E2E_SKIP_DB_CLEANUP = 'true';
      delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
      const denied = createDeleteCountingDataSource(dataSource);
      await expect(
        runGuardedSpecCleanup({
          dataSource: denied.dataSource,
          owned: targetLedger,
          helper: 'C01 缺许可',
        }),
      ).rejects.toThrow(/\[C01 缺许可\] 阶段=清理许可门禁[\s\S]*E2E_ALLOW_PHYSICAL_CLEANUP=1/);
      expect(denied.stats.transactionCount).toBe(0);
      expect(denied.stats.deleteCount).toBe(0);

      // 错库：许可已给足，库名白名单仍必须独立拒绝
      process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
      process.env.E2E_ALLOWED_DB_NAMES = 'lithography_ownership_not_allowed';
      const wrongDb = createDeleteCountingDataSource(dataSource);
      await expect(
        runGuardedSpecCleanup({
          dataSource: wrongDb.dataSource,
          owned: targetLedger,
          helper: 'C01 错库',
        }),
      ).rejects.toThrow(/不在允许的 E2E 库白名单/);
      expect(wrongDb.stats.transactionCount).toBe(0);
      expect(wrongDb.stats.deleteCount).toBe(0);
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
      restoreEnvValue('E2E_SKIP_DB_CLEANUP', skipOriginal);
      restoreEnvValue('E2E_ALLOWED_DB_NAMES', allowedOriginal);
    }

    // 两条拒绝路径均未触碰数据
    expect(await readOrganizationFields(dataSource, organizationId)).not.toBeNull();
  });

  it('C02 同登录名/邮箱但异指纹：冲突、DELETE=0、原行逐字段不变', async () => {
    const sentinelConfig = accountConfig(
      'C02',
      [IdentityTypeEnum.CUSTOMER],
      IdentityTypeEnum.CUSTOMER,
    );
    const sentinelAccountId = await createAccount(dataSource, createAccountUsecase, sentinelConfig);
    await ownAccountFromDb(dataSource, testLedger, sentinelAccountId);

    const before = await readAccountFields(dataSource, sentinelAccountId);
    expect(before).not.toBeNull();

    // 自然键相同，但期望指纹为 ENGINEER：与哨兵的真实身份/角色不符
    const residueFingerprint = {
      ...toResidueAccountFingerprint(sentinelConfig),
      identityHint: IdentityTypeEnum.ENGINEER,
      accessGroup: [IdentityTypeEnum.ENGINEER],
    };

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        residue: { accounts: [residueFingerprint] },
        helper: 'C02 异指纹账号',
      }),
    ).rejects.toThrow(/\[C02 异指纹账号\] 阶段=归属预检 拒绝删除：account .*指纹不符/);

    expect(counted.stats.transactionCount).toBe(1);
    expect(counted.stats.deleteCount).toBe(0);
    expect(await readAccountFields(dataSource, sentinelAccountId)).toEqual(before);
  });

  it('C03 同组织编码但异名/类别：冲突、DELETE=0、原行逐字段不变', async () => {
    const organizationCode = codeFor('C03_ORG');
    const sentinelOrganizationId = await createOrganization(dataSource, {
      organizationCode,
      name: 'C03 异主名称',
      kind: 'PEER',
    });
    await ownOrganizationFromDb(dataSource, testLedger, sentinelOrganizationId);

    const before = await readOrganizationFields(dataSource, sentinelOrganizationId);
    expect(before).not.toBeNull();

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        residue: {
          organizations: [{ organizationCode, name: 'C03 期望名称', kind: 'CLIENT' }],
        },
        helper: 'C03 异主组织',
      }),
    ).rejects.toThrow(/\[C03 异主组织\] 阶段=归属预检 拒绝删除：organization/);

    expect(counted.stats.transactionCount).toBe(1);
    expect(counted.stats.deleteCount).toBe(0);
    expect(await readOrganizationFields(dataSource, sentinelOrganizationId)).toEqual(before);
  });

  it('C04 外部 id=43 机型不被删除；本轮自增机型仅删它自己', async () => {
    const externalBefore = await readEquipmentModelFields(dataSource, 43);
    const externalModelCreatedByUs = externalBefore === null;
    if (externalModelCreatedByUs) {
      const repository = dataSource.getRepository(EquipmentModelEntity);
      await repository.insert({
        id: 43,
        modelCode: codeFor('EXT43_MODEL'),
        modelName: 'C04 外部固定 43 机型',
        enabled: true,
        sortOrder: 999,
      });
      // 本用例创建的外部哨兵：测试结束后由 afterEach 精确删除
      await ownEquipmentModelFromDb(dataSource, testLedger, 43);
    }
    const externalSnapshot = await readEquipmentModelFields(dataSource, 43);
    expect(externalSnapshot).not.toBeNull();

    const repository = dataSource.getRepository(EquipmentModelEntity);
    const savedRoundModel = await repository.save(
      repository.create({
        modelCode: codeFor('C04_ROUND_MODEL'),
        modelName: 'C04 本轮自增机型',
        enabled: true,
        sortOrder: 1,
      }),
    );
    const roundModelId = savedRoundModel.id;
    await ownEquipmentModelFromDb(dataSource, testLedger, roundModelId);
    expect(roundModelId).not.toBe(43);

    const roundLedger = createOwnedResourceLedger();
    await ownEquipmentModelFromDb(dataSource, roundLedger, roundModelId);

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: roundLedger,
        helper: 'C04 本轮机型',
      }),
    ).resolves.toBeUndefined();

    expect(counted.stats.deleteCount).toBe(1);
    expect(await readEquipmentModelFields(dataSource, roundModelId)).toBeNull();
    expect(await readEquipmentModelFields(dataSource, 43)).toEqual(externalSnapshot);
  });

  it('C05 外部成员引用本轮 owned 组织：预检拒绝，组织与成员均不变', async () => {
    const organizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('C05_ORG'),
      name: 'C05 本轮组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, organizationId);

    const externalAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C05EXT', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, externalAccountId);
    const membershipId = await createMembership(dataSource, organizationId, externalAccountId);
    await ownMembershipFromDb(dataSource, testLedger, membershipId);

    const organizationBefore = await readOrganizationFields(dataSource, organizationId);
    const membershipBefore = await readMembershipFields(dataSource, membershipId);
    expect(organizationBefore).not.toBeNull();
    expect(membershipBefore).not.toBeNull();

    // 本轮只登记组织：外部账号与成员关系都不在 owned 集合内
    const targetLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, targetLedger, organizationId);

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: targetLedger,
        helper: 'C05 外部成员',
      }),
    ).rejects.toThrow(/\[C05 外部成员\] 阶段=归属预检 拒绝删除：membership/);

    expect(counted.stats.deleteCount).toBe(0);
    expect(await readOrganizationFields(dataSource, organizationId)).toEqual(organizationBefore);
    expect(await readMembershipFields(dataSource, membershipId)).toEqual(membershipBefore);
  });

  it('C05B owned 账号在外部组织仍有成员关系：预检拒绝，DELETE=0 且两端不变', async () => {
    const ownedOrganizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('C05B_ORG'),
      name: 'C05B 本轮组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, ownedOrganizationId);

    const externalOrganizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('C05B_EXT_ORG'),
      name: 'C05B 外部组织',
      kind: 'PEER',
    });
    await ownOrganizationFromDb(dataSource, testLedger, externalOrganizationId);

    const ownedAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C05BOWN', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, ownedAccountId);

    const ownedMembershipId = await createMembership(
      dataSource,
      ownedOrganizationId,
      ownedAccountId,
    );
    await ownMembershipFromDb(dataSource, testLedger, ownedMembershipId);
    const externalMembershipId = await createMembership(
      dataSource,
      externalOrganizationId,
      ownedAccountId,
    );
    await ownMembershipFromDb(dataSource, testLedger, externalMembershipId);

    const organizationBefore = await readOrganizationFields(dataSource, ownedOrganizationId);
    const accountBefore = await readAccountFields(dataSource, ownedAccountId);
    const ownedMembershipBefore = await readMembershipFields(dataSource, ownedMembershipId);
    const externalMembershipBefore = await readMembershipFields(dataSource, externalMembershipId);

    // 本轮只登记 owned 组织与 owned 账号：账号在外部组织的成员关系不在范围内
    const targetLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, targetLedger, ownedOrganizationId);
    await ownAccountFromDb(dataSource, targetLedger, ownedAccountId);

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: targetLedger,
        helper: 'C05B 账号外部成员',
      }),
    ).rejects.toThrow(/\[C05B 账号外部成员\] 阶段=归属预检 拒绝删除：membership/);

    expect(counted.stats.deleteCount).toBe(0);
    expect(await readOrganizationFields(dataSource, ownedOrganizationId)).toEqual(
      organizationBefore,
    );
    expect(await readAccountFields(dataSource, ownedAccountId)).toEqual(accountBefore);
    expect(await readMembershipFields(dataSource, ownedMembershipId)).toEqual(
      ownedMembershipBefore,
    );
    expect(await readMembershipFields(dataSource, externalMembershipId)).toEqual(
      externalMembershipBefore,
    );
  });

  it('C06 后阶段冲突：第一阶段的组织同样未被删除（单事务回滚）', async () => {
    const organizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('C06_ORG'),
      name: 'C06 本轮组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, organizationId);

    const ownedAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C06OWN', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, ownedAccountId);

    const externalAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C06EXT', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, externalAccountId);

    const documentId = await createDocument(dataSource, {
      title: 'C06 后阶段冲突资料',
      ownerOrganizationId: organizationId,
      createdByAccountId: externalAccountId,
    });
    await ownDocumentFromDb(dataSource, testLedger, documentId);

    const organizationBefore = await readOrganizationFields(dataSource, organizationId);
    const documentBefore = await readDocumentFields(dataSource, documentId);

    const targetLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, targetLedger, organizationId);
    await ownAccountFromDb(dataSource, targetLedger, ownedAccountId);

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: targetLedger,
        helper: 'C06 后阶段冲突',
      }),
    ).rejects.toThrow(
      /\[C06 后阶段冲突\] 阶段=归属预检 拒绝删除：document .*创建人账号不在本轮范围/,
    );

    // 冲突发生在预检的后一阶段：第一条 DELETE 之前，组织同样必须原样保留
    expect(counted.stats.transactionCount).toBe(1);
    expect(counted.stats.deleteCount).toBe(0);
    expect(await readOrganizationFields(dataSource, organizationId)).toEqual(organizationBefore);
    expect(await readDocumentFields(dataSource, documentId)).toEqual(documentBefore);
  });

  it('C07 第 N 次 delete 失败：真实事务回滚、错误传播、finalize/closeApp 仍执行', async () => {
    const organizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('C07_ORG'),
      name: 'C07 本轮组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, organizationId);

    const accountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C07', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, accountId);

    const membershipId = await createMembership(dataSource, organizationId, accountId);
    await ownMembershipFromDb(dataSource, testLedger, membershipId);

    const documentId = await createDocument(dataSource, {
      title: 'C07 回滚资料',
      ownerOrganizationId: organizationId,
      createdByAccountId: accountId,
    });
    await ownDocumentFromDb(dataSource, testLedger, documentId);

    const before = {
      organization: await readOrganizationFields(dataSource, organizationId),
      account: await readAccountFields(dataSource, accountId),
      membership: await readMembershipFields(dataSource, membershipId),
      document: await readDocumentFields(dataSource, documentId),
    };

    const targetLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, targetLedger, organizationId);
    await ownAccountFromDb(dataSource, targetLedger, accountId);
    await ownMembershipFromDb(dataSource, targetLedger, membershipId);
    await ownDocumentFromDb(dataSource, targetLedger, documentId);

    // 删除顺序：document(1) → membership(2) → organization(3 失败)
    const failing = createFailNthDeleteDataSource(dataSource, 3);
    const calls: string[] = [];
    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    try {
      await expect(
        runE2eTeardown({
          cleanup: async () => {
            calls.push('cleanup');
            await runGuardedSpecCleanup({
              dataSource: failing.dataSource,
              owned: targetLedger,
              helper: 'C07 第 3 次删除失败',
            });
          },
          finalize: () => {
            calls.push('finalize');
          },
          closeApp: () => {
            calls.push('closeApp');
            return Promise.resolve();
          },
        }),
      ).rejects.toBe(failing.injectedError);
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
    }

    expect(calls).toEqual(['cleanup', 'finalize', 'closeApp']);
    expect(failing.stats.transactionCount).toBe(1);
    expect(failing.stats.deleteCount).toBe(3);
    // 前两次 DELETE 已执行但随真实事务回滚：所有行逐字段仍是失败前状态
    expect(await readOrganizationFields(dataSource, organizationId)).toEqual(before.organization);
    expect(await readAccountFields(dataSource, accountId)).toEqual(before.account);
    expect(await readMembershipFields(dataSource, membershipId)).toEqual(before.membership);
    expect(await readDocumentFields(dataSource, documentId)).toEqual(before.document);
  });

  it('C08 beforeAll 中途失败：只回收已登记 ID，未登记/异主资源不变，afterAll 仍真实执行', async () => {
    const partialLedger = createOwnedResourceLedger();
    let registeredOrganizationId = 0;
    let unregisteredOrganizationId = 0;
    let externalOrganizationId = 0;

    const failingBeforeAll = async (): Promise<void> => {
      registeredOrganizationId = await createOrganization(dataSource, {
        organizationCode: codeFor('C08_REGISTERED'),
        name: 'C08 已登记组织',
        kind: 'CLIENT',
      });
      await ownOrganizationFromDb(dataSource, partialLedger, registeredOrganizationId);
      await ownOrganizationFromDb(dataSource, testLedger, registeredOrganizationId);

      // 已创建但尚未登记：模拟 beforeAll 在这之后失败
      unregisteredOrganizationId = await createOrganization(dataSource, {
        organizationCode: codeFor('C08_UNREGISTERED'),
        name: 'C08 未登记组织',
        kind: 'CLIENT',
      });
      await ownOrganizationFromDb(dataSource, testLedger, unregisteredOrganizationId);

      externalOrganizationId = await createOrganization(dataSource, {
        organizationCode: codeFor('C08_EXTERNAL'),
        name: 'C08 异主组织',
        kind: 'PEER',
      });
      await ownOrganizationFromDb(dataSource, testLedger, externalOrganizationId);

      throw new Error('模拟 beforeAll 中途失败');
    };

    await expect(failingBeforeAll()).rejects.toThrow('模拟 beforeAll 中途失败');

    const unregisteredBefore = await readOrganizationFields(dataSource, unregisteredOrganizationId);
    const externalBefore = await readOrganizationFields(dataSource, externalOrganizationId);

    const calls: string[] = [];
    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    try {
      await expect(
        runE2eTeardown({
          cleanup: async () => {
            calls.push('cleanup');
            // afterAll 仍真实执行：只按已登记 ID 回收
            await runGuardedSpecCleanup({
              dataSource,
              owned: partialLedger,
              helper: 'C08 afterAll 回收已登记',
            });
          },
          finalize: () => {
            calls.push('finalize');
          },
          closeApp: () => {
            calls.push('closeApp');
            return Promise.resolve();
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
    }

    expect(calls).toEqual(['cleanup', 'finalize', 'closeApp']);
    expect(await readOrganizationFields(dataSource, registeredOrganizationId)).toBeNull();
    expect(await readOrganizationFields(dataSource, unregisteredOrganizationId)).toEqual(
      unregisteredBefore,
    );
    expect(await readOrganizationFields(dataSource, externalOrganizationId)).toEqual(
      externalBefore,
    );
  });

  it('C09 完整指纹残留被回收；同名但异编码行不动', async () => {
    const residueCode = codeFor('C09_RESIDUE');
    const residueName = 'C09 完整指纹组织';

    const residueOrganizationId = await createOrganization(dataSource, {
      organizationCode: residueCode,
      name: residueName,
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, residueOrganizationId);

    const sameNameOtherCodeId = await createOrganization(dataSource, {
      organizationCode: `${residueCode}_OTHER`,
      name: residueName,
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, sameNameOtherCodeId);

    const sameNameBefore = await readOrganizationFields(dataSource, sameNameOtherCodeId);
    expect(sameNameBefore).not.toBeNull();

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        residue: {
          organizations: [{ organizationCode: residueCode, name: residueName, kind: 'CLIENT' }],
        },
        helper: 'C09 完整指纹残留',
      }),
    ).resolves.toBeUndefined();

    expect(counted.stats.deleteCount).toBe(1);
    expect(await readOrganizationFields(dataSource, residueOrganizationId)).toBeNull();
    // 同名但异编码行没有被自然键连带删除
    expect(await readOrganizationFields(dataSource, sameNameOtherCodeId)).toEqual(sameNameBefore);
  });

  it('C10 回落账号 user_info 写入失败：整体回滚，同邮箱重跑可恢复', async () => {
    const config = accountConfig(
      'C10ATOMIC',
      [IdentityTypeEnum.ENGINEER],
      IdentityTypeEnum.ENGINEER,
    );

    await expect(
      createTestAccount(createFailUserInfoDataSource(dataSource), null, config),
    ).rejects.toThrow('注入失败：user_info 写入');

    // 事务回滚：账号与 user_info 均不存在，未留下半账号
    const accountRepository = dataSource.getRepository(AccountEntity);
    expect(
      await accountRepository.findOne({ where: { loginEmail: config.loginEmail } }),
    ).toBeNull();
    expect(
      await dataSource
        .getRepository(UserInfoEntity)
        .findOne({ where: { email: config.loginEmail } }),
    ).toBeNull();

    // 同一邮箱可立即重建，并登记给 afterEach 精确回收
    const created = await createTestAccount(dataSource, null, config, testLedger);
    expect(await accountRepository.findOne({ where: { id: created.accountId } })).not.toBeNull();
    expect(
      await dataSource
        .getRepository(UserInfoEntity)
        .findOne({ where: { accountId: created.accountId } }),
    ).not.toBeNull();
  });

  it('C11 R25-01 retained-only：组织链不生成空 WHERE，相邻账号回收真实执行', async () => {
    const config = accountConfig(
      'C11RETAINED',
      [IdentityTypeEnum.ENGINEER],
      IdentityTypeEnum.ENGINEER,
    );
    // 账号先于组织链创建（模拟 10 组 beforeAll 顺序），暂不登记为本轮 owned
    const { accountId } = await createTestAccount(dataSource, createAccountUsecase, config);
    await ownAccountFromDb(dataSource, testLedger, accountId);
    const accountBefore = await readAccountFields(dataSource, accountId);
    expect(accountBefore).not.toBeNull();

    const counting = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counting.dataSource,
        helper: 'C11 R25-01 组织链 retained-only',
        retainedAccounts: [toResidueAccountFingerprint(config)],
      }),
    ).resolves.toBeUndefined();

    expect(counting.stats.transactionCount).toBe(1);
    expect(counting.stats.deleteCount).toBe(0);
    expect(await readAccountFields(dataSource, accountId)).toEqual(accountBefore);

    // 组织链空操作成功后，相邻 fixture owner 的精确回收仍执行
    await runGuardedSpecCleanup({
      dataSource,
      owned: testLedger,
      helper: 'C11 R25-01 相邻账号回收',
    });
    expect(await readAccountFields(dataSource, accountId)).toBeNull();
  });

  it('C12 R25-01 上轮仅残留账号：预清理不再卡空 WHERE，下一轮完整回收', async () => {
    const config = accountConfig(
      'C12RESIDUAL',
      [IdentityTypeEnum.ENGINEER],
      IdentityTypeEnum.ENGINEER,
    );
    // 模拟上轮中断：账号存在但本轮没有组织 owned 记录
    const { accountId } = await createTestAccount(dataSource, createAccountUsecase, config);
    await ownAccountFromDb(dataSource, testLedger, accountId);
    const fingerprint = toResidueAccountFingerprint(config);

    const counting = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counting.dataSource,
        helper: 'C12 R25-01 预清理残留账号',
        residue: { accounts: [fingerprint] },
        retainedAccounts: [fingerprint],
      }),
    ).resolves.toBeUndefined();
    expect(counting.stats.deleteCount).toBe(0);
    expect(await readAccountFields(dataSource, accountId)).not.toBeNull();

    // 下一轮以 owned 账本精确回收，证明残留不会持续阻塞
    await runGuardedSpecCleanup({
      dataSource,
      owned: testLedger,
      helper: 'C12 R25-01 下一轮回收',
    });
    expect(await readAccountFields(dataSource, accountId)).toBeNull();
  });

  // -------------------------------------------------------------------------------------
  // F01–F12：R01–R05 的永久反例（真实库/真实事务；F07–F09 见 cleanup-faults 子规格）
  // -------------------------------------------------------------------------------------

  it('F01 R01-A 账号下未登记的第三方绑定：首删前拒绝，DELETE=0 且绑定/账号不变', async () => {
    const accountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F01OWN', [IdentityTypeEnum.CUSTOMER], IdentityTypeEnum.CUSTOMER),
    );
    await ownAccountFromDb(dataSource, testLedger, accountId);

    const bindingId = await createThirdPartyBinding(dataSource, {
      accountId,
      provider: ThirdPartyProviderEnum.GITHUB,
      providerUserId: `f01-github-${RUN_TAG}`,
      unionId: null,
    });
    await ownThirdPartyAuthFromDb(dataSource, testLedger, bindingId);

    const accountBefore = await readAccountFields(dataSource, accountId);
    const bindingBefore = await readThirdPartyBindingFields(dataSource, bindingId);

    // 本轮只登记账号：绑定的关联关系不构成删除授权
    const targetLedger = createOwnedResourceLedger();
    await ownAccountFromDb(dataSource, targetLedger, accountId);

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: targetLedger,
        helper: 'F01 未登记绑定',
      }),
    ).rejects.toThrow(/\[F01 未登记绑定\] 阶段=归属预检 拒绝删除：thirdPartyAuth .*未登记归属证据/);

    expect(counted.stats.transactionCount).toBe(1);
    expect(counted.stats.deleteCount).toBe(0);
    expect(await readAccountFields(dataSource, accountId)).toEqual(accountBefore);
    expect(await readThirdPartyBindingFields(dataSource, bindingId)).toEqual(bindingBefore);
  });

  it('F02 R01-B 本轮申请下未登记的工程师回复：首删前拒绝，DELETE=0 且回复/申请不变', async () => {
    const customerAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F02CUST', [IdentityTypeEnum.CUSTOMER], IdentityTypeEnum.CUSTOMER),
    );
    await ownAccountFromDb(dataSource, testLedger, customerAccountId);
    const engineerAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F02ENG', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, engineerAccountId);

    const modelId = await createEquipmentModel(dataSource, {
      modelCode: codeFor('F02_MODEL'),
      modelName: 'F02 型号',
    });
    await ownEquipmentModelFromDb(dataSource, testLedger, modelId);

    const requestId = await createRepairRequest(dataSource, {
      requestNo: codeFor('F02_REQ'),
      customerAccountId,
      equipmentModelId: modelId,
      errorCode: 'E-F02',
      faultDescription: 'F02 未登记回复反例',
    });
    await ownRepairRequestFromDb(dataSource, testLedger, requestId);

    const responseId = await createEngineerResponse(dataSource, {
      requestId,
      engineerAccountId,
      customerAccountId,
      responseText: 'F02 未登记的回复',
    });
    await ownEngineerResponseFromDb(dataSource, testLedger, responseId);

    const responseBefore = await readEngineerResponseFields(dataSource, responseId);
    const requestBefore = await readRepairRequestFields(dataSource, requestId);
    const customerBefore = await readAccountFields(dataSource, customerAccountId);
    const engineerBefore = await readAccountFields(dataSource, engineerAccountId);
    const modelBefore = await readEquipmentModelFields(dataSource, modelId);

    // 本轮登记账号/型号/申请，但不登记回复：回复关联不是删除授权
    const targetLedger = createOwnedResourceLedger();
    await ownAccountFromDb(dataSource, targetLedger, customerAccountId);
    await ownAccountFromDb(dataSource, targetLedger, engineerAccountId);
    await ownEquipmentModelFromDb(dataSource, targetLedger, modelId);
    await ownRepairRequestFromDb(dataSource, targetLedger, requestId);

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: targetLedger,
        helper: 'F02 未登记回复',
      }),
    ).rejects.toThrow(
      /\[F02 未登记回复\] 阶段=归属预检 拒绝删除：engineerResponse .*未登记的工程师回复/,
    );

    expect(counted.stats.transactionCount).toBe(1);
    expect(counted.stats.deleteCount).toBe(0);
    expect(await readEngineerResponseFields(dataSource, responseId)).toEqual(responseBefore);
    expect(await readRepairRequestFields(dataSource, requestId)).toEqual(requestBefore);
    expect(await readAccountFields(dataSource, customerAccountId)).toEqual(customerBefore);
    expect(await readAccountFields(dataSource, engineerAccountId)).toEqual(engineerBefore);
    expect(await readEquipmentModelFields(dataSource, modelId)).toEqual(modelBefore);
  });

  it('F03 先登记绑定与回复再删：成功且删除顺序满足外键（回复→申请→绑定→账号）', async () => {
    const customerAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F03CUST', [IdentityTypeEnum.CUSTOMER], IdentityTypeEnum.CUSTOMER),
    );
    await ownAccountFromDb(dataSource, testLedger, customerAccountId);
    const engineerAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F03ENG', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, engineerAccountId);

    const modelId = await createEquipmentModel(dataSource, {
      modelCode: codeFor('F03_MODEL'),
      modelName: 'F03 型号',
    });
    await ownEquipmentModelFromDb(dataSource, testLedger, modelId);

    const requestId = await createRepairRequest(dataSource, {
      requestNo: codeFor('F03_REQ'),
      customerAccountId,
      equipmentModelId: modelId,
      errorCode: 'E-F03',
      faultDescription: 'F03 已登记回复',
    });
    await ownRepairRequestFromDb(dataSource, testLedger, requestId);

    const responseId = await createEngineerResponse(dataSource, {
      requestId,
      engineerAccountId,
      customerAccountId,
      responseText: 'F03 已登记的回复',
    });
    await ownEngineerResponseFromDb(dataSource, testLedger, responseId);

    const bindingId = await createThirdPartyBinding(dataSource, {
      accountId: customerAccountId,
      provider: ThirdPartyProviderEnum.GITHUB,
      providerUserId: `f03-github-${RUN_TAG}`,
      unionId: null,
    });
    await ownThirdPartyAuthFromDb(dataSource, testLedger, bindingId);

    // 全部显式登记后才能删除
    const targetLedger = createOwnedResourceLedger();
    await ownAccountFromDb(dataSource, targetLedger, customerAccountId);
    await ownAccountFromDb(dataSource, targetLedger, engineerAccountId);
    await ownEquipmentModelFromDb(dataSource, targetLedger, modelId);
    await ownRepairRequestFromDb(dataSource, targetLedger, requestId);
    await ownEngineerResponseFromDb(dataSource, targetLedger, responseId);
    await ownThirdPartyAuthFromDb(dataSource, targetLedger, bindingId);

    const recorded = createDeleteRecordingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: recorded.dataSource,
        owned: targetLedger,
        helper: 'F03 先登记再删',
      }),
    ).resolves.toBeUndefined();

    expect(await readEngineerResponseFields(dataSource, responseId)).toBeNull();
    expect(await readRepairRequestFields(dataSource, requestId)).toBeNull();
    expect(await readThirdPartyBindingFields(dataSource, bindingId)).toBeNull();
    expect(await readAccountFields(dataSource, customerAccountId)).toBeNull();
    expect(await readEquipmentModelFields(dataSource, modelId)).toBeNull();

    const tables = recorded.tables;
    expect(tables.indexOf('engineer_response')).toBeGreaterThanOrEqual(0);
    expect(tables.indexOf('engineer_response')).toBeLessThan(tables.indexOf('repair_request'));
    expect(tables.indexOf('repair_request')).toBeLessThan(tables.indexOf('base_third_party_auth'));
    expect(tables.indexOf('base_third_party_auth')).toBeLessThan(
      tables.indexOf('base_user_account'),
    );
    expect(tables.indexOf('base_user_info')).toBeLessThan(tables.indexOf('base_user_account'));
  });

  it('F04 账号/型号预期事实漂移：首删前逐类拒绝，DELETE=0，恢复后仍可回收', async () => {
    const driftedAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F04ACC', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, driftedAccountId);

    const driftedModelId = await createEquipmentModel(dataSource, {
      modelCode: codeFor('F04_MODEL'),
      modelName: 'F04 漂移型号',
    });
    await ownEquipmentModelFromDb(dataSource, testLedger, driftedModelId);

    const targetLedger = createOwnedResourceLedger();
    await ownAccountFromDb(dataSource, targetLedger, driftedAccountId);
    await ownEquipmentModelFromDb(dataSource, targetLedger, driftedModelId);

    const originalLoginName = (
      await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { id: driftedAccountId } })
    ).loginName;

    // 模拟非受控漂移（未调用 updateOwnedExpectation）
    await dataSource
      .getRepository(AccountEntity)
      .update({ id: driftedAccountId }, { loginName: `drifted_${RUN_TAG}` });
    await dataSource
      .getRepository(EquipmentModelEntity)
      .update({ id: driftedModelId }, { modelName: '漂移后的型号名' });

    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: targetLedger,
        helper: 'F04 账号漂移',
      }),
    ).rejects.toThrow(/\[F04 账号漂移\] 阶段=归属预检 拒绝删除：account .*事实漂移（login_name）/);
    expect(counted.stats.deleteCount).toBe(0);

    // 型号漂移同样拒绝（账号已漂移，但错误信息须指向型号）
    await dataSource
      .getRepository(AccountEntity)
      .update({ id: driftedAccountId }, { loginName: originalLoginName });
    const countedModel = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: countedModel.dataSource,
        owned: targetLedger,
        helper: 'F04 型号漂移',
      }),
    ).rejects.toThrow(
      /\[F04 型号漂移\] 阶段=归属预检 拒绝删除：equipmentModel .*事实漂移（model_name）/,
    );
    expect(countedModel.stats.deleteCount).toBe(0);
    expect(await readAccountFields(dataSource, driftedAccountId)).not.toBeNull();
    expect(await readEquipmentModelFields(dataSource, driftedModelId)).not.toBeNull();

    // 恢复受控事实后（测试侧清理漂移）仍可正常回收
    await dataSource
      .getRepository(EquipmentModelEntity)
      .update({ id: driftedModelId }, { modelName: 'F04 漂移型号' });

    // enabled 未声明变化同样触发漂移（不因同一 ID 已登记而跳过）
    await dataSource
      .getRepository(EquipmentModelEntity)
      .update({ id: driftedModelId }, { enabled: false });
    await expect(
      runGuardedSpecCleanup({
        dataSource,
        owned: targetLedger,
        helper: 'F04 enabled 漂移',
      }),
    ).rejects.toThrow(
      /\[F04 enabled 漂移\] 阶段=归属预检 拒绝删除：equipmentModel .*事实漂移（enabled）/,
    );
    await dataSource
      .getRepository(EquipmentModelEntity)
      .update({ id: driftedModelId }, { enabled: true });

    await runGuardedSpecCleanup({
      dataSource,
      owned: targetLedger,
      helper: 'F04 恢复后回收',
    });
    expect(await readAccountFields(dataSource, driftedAccountId)).toBeNull();
    expect(await readEquipmentModelFields(dataSource, driftedModelId)).toBeNull();
  });

  it('F05 合法受控变更后显式更新预期：可清理；未更新预期时拒绝', async () => {
    const accountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F05ACC', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, accountId);

    // 先按受控创建结果登记预期，再做受控变更（不会被自动回填）
    const staleLedger = createOwnedResourceLedger();
    await ownAccountFromDb(dataSource, staleLedger, accountId);

    // 受控变更：把账号置为 SUSPENDED（直接写库模拟受控写入成功）
    await dataSource
      .getRepository(AccountEntity)
      .update({ id: accountId }, { status: AccountStatus.SUSPENDED });

    // 未更新预期：首删前拒绝
    const counted = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: counted.dataSource,
        owned: staleLedger,
        helper: 'F05 未更新预期',
      }),
    ).rejects.toThrow(/\[F05 未更新预期\] 阶段=归属预检 拒绝删除：account .*事实漂移（status）/);
    expect(counted.stats.deleteCount).toBe(0);
    expect(await readAccountFields(dataSource, accountId)).not.toBeNull();

    // 显式更新预期后成功回收
    updateOwnedExpectation(staleLedger, 'account', accountId, { status: AccountStatus.SUSPENDED });
    await runGuardedSpecCleanup({
      dataSource,
      owned: staleLedger,
      helper: 'F05 更新预期后回收',
    });
    expect(await readAccountFields(dataSource, accountId)).toBeNull();

    // 对照：失败写入不得更新预期（写库报错后台账仍保留原事实，仍可安全回收）
    const failedWriteAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F05FAIL', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, failedWriteAccountId);

    const failedWriteLedger = createOwnedResourceLedger();
    await ownAccountFromDb(dataSource, failedWriteLedger, failedWriteAccountId);
    await expect(
      dataSource.query('UPDATE base_user_account SET status = ? WHERE id = ?', [
        'NOT_A_REAL_STATUS',
        failedWriteAccountId,
      ]),
    ).rejects.toThrow();
    expect(failedWriteLedger.facts.account.get(failedWriteAccountId)?.status).toBe(
      AccountStatus.ACTIVE,
    );

    await runGuardedSpecCleanup({
      dataSource,
      owned: failedWriteLedger,
      helper: 'F05 失败写入后回收',
    });
    expect(await readAccountFields(dataSource, failedWriteAccountId)).toBeNull();
  });

  it('F06 缺事实/空目标/部分行已不存在/批量冲突：分别失败关闭且不部分删除', async () => {
    const orgId = await createOrganization(dataSource, {
      organizationCode: codeFor('F06_ORG'),
      name: 'F06 组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, orgId);

    const missingRowAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F06MISS', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, missingRowAccountId);

    const conflictAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F06CONF', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, conflictAccountId);

    // (a) 缺事实：拒绝仅按 ID 删除
    const incomplete = createOwnedResourceLedger();
    (
      recordOwnedResource as unknown as (
        ledger: OwnedResourceLedger,
        category: string,
        id: number,
      ) => number
    )(incomplete, 'account', conflictAccountId);
    const countedIncomplete = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: countedIncomplete.dataSource,
        owned: incomplete,
        helper: 'F06 缺事实',
      }),
    ).rejects.toThrow(/\[F06 缺事实\] 阶段=归属预检 拒绝删除：account .*缺少必要预期事实/);
    expect(countedIncomplete.stats.transactionCount).toBe(0);
    expect(countedIncomplete.stats.deleteCount).toBe(0);

    // (b) 空目标：纯 no-op，不开启事务
    const countedEmpty = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: countedEmpty.dataSource,
        owned: createOwnedResourceLedger(),
        helper: 'F06 空目标',
      }),
    ).resolves.toBeUndefined();
    expect(countedEmpty.stats.transactionCount).toBe(0);
    expect(countedEmpty.stats.deleteCount).toBe(0);

    // (c) 部分行已不存在：幂等回收剩余行（事实取自已登记台账，不从数据库回读）
    const preDeleted = createOwnedResourceLedger();
    await ownAccountFromDb(dataSource, preDeleted, missingRowAccountId);
    await runGuardedSpecCleanup({
      dataSource,
      owned: preDeleted,
      helper: 'F06 预先删除一行',
    });
    expect(await readAccountFields(dataSource, missingRowAccountId)).toBeNull();

    const missingFacts = testLedger.facts.account.get(missingRowAccountId);
    expect(missingFacts).toBeDefined();
    const batch = createOwnedResourceLedger();
    recordOwnedResource(batch, 'account', missingRowAccountId, missingFacts!);
    await ownOrganizationFromDb(dataSource, batch, orgId);
    await expect(
      runGuardedSpecCleanup({
        dataSource,
        owned: batch,
        helper: 'F06 部分行已不存在',
      }),
    ).resolves.toBeUndefined();
    expect(await readOrganizationFields(dataSource, orgId)).toBeNull();

    // (d) 批量中一个漂移：整批拒绝，未漂移的组织不被部分删除
    const conflictOrgId = await createOrganization(dataSource, {
      organizationCode: codeFor('F06_ORG_D'),
      name: 'F06 未漂移组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, conflictOrgId);

    // 先按当前受控事实登记，再模拟非受控漂移（登记后漂移才会被检出）
    const conflictBatch = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, conflictBatch, conflictOrgId);
    await ownAccountFromDb(dataSource, conflictBatch, conflictAccountId);

    await dataSource
      .getRepository(AccountEntity)
      .update({ id: conflictAccountId }, { loginName: `f06_conflict_${RUN_TAG}` });

    const countedConflict = createDeleteCountingDataSource(dataSource);
    await expect(
      runGuardedSpecCleanup({
        dataSource: countedConflict.dataSource,
        owned: conflictBatch,
        helper: 'F06 批量冲突',
      }),
    ).rejects.toThrow(/\[F06 批量冲突\] 阶段=归属预检 拒绝删除：account .*事实漂移（login_name）/);
    expect(countedConflict.stats.deleteCount).toBe(0);
    expect(await readOrganizationFields(dataSource, conflictOrgId)).not.toBeNull();

    // 恢复账号事实，交由 afterEach 精确回收
    await dataSource
      .getRepository(AccountEntity)
      .update({ id: conflictAccountId }, { loginName: loginFor('F06CONF') });
  });

  it('F10 第 N 次 DELETE + finalize + closeApp 同时失败：主因保真、其余错误并入、事务回滚', async () => {
    const orgId = await createOrganization(dataSource, {
      organizationCode: codeFor('F10_ORG'),
      name: 'F10 组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, orgId);

    const accountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('F10ACC', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, accountId);

    const targetLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, targetLedger, orgId);
    await ownAccountFromDb(dataSource, targetLedger, accountId);

    const orgBefore = await readOrganizationFields(dataSource, orgId);
    const accountBefore = await readAccountFields(dataSource, accountId);

    // 删除顺序：organization(1) → base_user_info(2) → base_user_account(3)
    const failing = createFailNthDeleteDataSource(dataSource, 3);
    const finalizeError = new Error('F10 finalize 失败');
    const closeError = new Error('F10 closeApp 失败');
    const calls: string[] = [];
    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    let caught: unknown;
    try {
      await runE2eTeardown({
        cleanup: async () => {
          calls.push('cleanup');
          await runGuardedSpecCleanup({
            dataSource: failing.dataSource,
            owned: targetLedger,
            helper: 'F10 多重收尾失败',
          });
        },
        finalize: () => {
          calls.push('finalize');
          throw finalizeError;
        },
        closeApp: () => {
          calls.push('closeApp');
          return Promise.reject(closeError);
        },
      }).catch((error: unknown) => {
        caught = error;
      });
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
    }

    expect(calls).toEqual(['cleanup', 'finalize', 'closeApp']);
    expect(caught).toBeInstanceOf(Error);
    const aggregate = caught as Error;
    expect(aggregate.cause).toBe(failing.injectedError);
    expect(aggregate.message).toContain(failing.injectedError.message);
    expect(aggregate.message).toContain(finalizeError.message);
    expect(aggregate.message).toContain(closeError.message);
    expect(aggregate.message.indexOf(failing.injectedError.message)).toBeLessThan(
      aggregate.message.indexOf(finalizeError.message),
    );

    expect(failing.stats.transactionCount).toBe(1);
    expect(failing.stats.deleteCount).toBe(3);
    // 真实事务回滚：组织与账号逐字段不变
    expect(await readOrganizationFields(dataSource, orgId)).toEqual(orgBefore);
    expect(await readAccountFields(dataSource, accountId)).toEqual(accountBefore);
    // 台账保留：失败后仍持有同一批真实 ID 与预期事实，供 afterAll 诊断/回收
    expect(targetLedger.organizationIds).toEqual([orgId]);
    expect(targetLedger.accountIds).toEqual([accountId]);
  });

  it('G03 门禁组合：预期缺失/预期不允许/实际不允许/两库均允许但不一致分别拒绝，均零 DELETE', async () => {
    const orgId = await createOrganization(dataSource, {
      organizationCode: codeFor('F11_ORG'),
      name: 'F11 组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, orgId);
    const before = await readOrganizationFields(dataSource, orgId);

    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    const skipCleanupOriginal = captureEnvValue('E2E_SKIP_DB_CLEANUP');
    const skipInfraOriginal = captureEnvValue('E2E_SKIP_INFRA_CHECKS');
    const allowedOriginal = captureEnvValue('E2E_ALLOWED_DB_NAMES');
    try {
      // (a) 缺许可：即使跳过全局清理与基础设施检查也拒绝
      process.env.E2E_SKIP_DB_CLEANUP = 'true';
      process.env.E2E_SKIP_INFRA_CHECKS = '1';
      delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
      const noConsent = createDeleteCountingDataSource(dataSource);
      await expect(
        runGuardedSpecCleanup({
          dataSource: noConsent.dataSource,
          owned: testLedger,
          helper: 'F11 缺许可',
        }),
      ).rejects.toThrow(/\[F11 缺许可\] 阶段=清理许可门禁 拒绝执行删除/);
      expect(noConsent.stats.deleteCount).toBe(0);

      // 以下所有子项：已有许可，但预期/实际库名各自失败关闭
      process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
      process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';

      // (b) 预期缺失：既无显式 expectedDatabase，DataSource.options.database 也为空
      const expectedMissing = createDeleteCountingDataSource(
        withExpectedDatabase(dataSource, undefined),
      );
      await expect(
        runGuardedSpecCleanup({
          dataSource: expectedMissing.dataSource,
          owned: testLedger,
          helper: 'G03 预期缺失',
        }),
      ).rejects.toThrow(/无法确定预期目标库/);
      expect(expectedMissing.stats.deleteCount).toBe(0);

      // (c) 预期库不在白名单（实际库仍允许）：两个白名单各自独立，不能由实际库替预期背书
      const expectedNotAllowed = createDeleteCountingDataSource(
        withExpectedDatabase(dataSource, 'lithography_f11_expected_other'),
      );
      await expect(
        runGuardedSpecCleanup({
          dataSource: expectedNotAllowed.dataSource,
          owned: testLedger,
          helper: 'G03 预期不允许',
        }),
      ).rejects.toThrow(/预期目标库 .* 不在允许的 E2E 库白名单/);
      expect(expectedNotAllowed.stats.deleteCount).toBe(0);

      // (d) 预期库允许，但实际连接库不在白名单
      process.env.E2E_ALLOWED_DB_NAMES = 'lithography_f11_expected_other';
      const actualNotAllowed = createDeleteCountingDataSource(
        withExpectedDatabase(dataSource, 'lithography_f11_expected_other'),
      );
      await expect(
        runGuardedSpecCleanup({
          dataSource: actualNotAllowed.dataSource,
          owned: testLedger,
          helper: 'G03 实际不允许',
        }),
      ).rejects.toThrow(/实际连接库 .* 不在允许的 E2E 库白名单/);
      expect(actualNotAllowed.stats.deleteCount).toBe(0);

      // (e) 预期与实际都属于白名单，但两者不是同一个库：仍拒绝
      process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e,lithography_f11_actual_other';
      const targetMismatch = createDeleteCountingDataSource(
        withExpectedDatabase(dataSource, 'lithography_f11_actual_other'),
      );
      await expect(
        runGuardedSpecCleanup({
          dataSource: targetMismatch.dataSource,
          owned: testLedger,
          helper: 'G03 两库不一致',
        }),
      ).rejects.toThrow(/预期目标库 .* 与实际连接库 .* 不一致/);
      expect(targetMismatch.stats.deleteCount).toBe(0);

      // (f) 正对照：预期=实际且均允许，空台账纯 no-op 可以通过且零 DELETE
      process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
      const consistent = createDeleteCountingDataSource(dataSource);
      await expect(
        runGuardedSpecCleanup({
          dataSource: consistent.dataSource,
          owned: createOwnedResourceLedger(),
          helper: 'G03 预期与实际一致',
        }),
      ).resolves.toBeUndefined();
      expect(consistent.stats.deleteCount).toBe(0);

      expect(await readOrganizationFields(dataSource, orgId)).toEqual(before);
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
      restoreEnvValue('E2E_SKIP_DB_CLEANUP', skipCleanupOriginal);
      restoreEnvValue('E2E_SKIP_INFRA_CHECKS', skipInfraOriginal);
      restoreEnvValue('E2E_ALLOWED_DB_NAMES', allowedOriginal);
    }

    // 恢复门禁后仍能真实回收
    await runGuardedSpecCleanup({
      dataSource,
      owned: testLedger,
      helper: 'F11 门禁恢复后回收',
    });
    expect(await readOrganizationFields(dataSource, orgId)).toBeNull();
  });

  it('G12/D2 同一第 3 次 DELETE 注错：真实事务恢复快照，无事务变体在快照断言处为红', async () => {
    // 两套完全独立的组织 + 账号夹具：一套跑真实事务，一套跑“去掉事务”的负对照。
    const txOrganizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('G12_TX_ORG'),
      name: 'G12 正常事务组织',
      kind: 'CLIENT',
    });
    await ownOrganizationFromDb(dataSource, testLedger, txOrganizationId);
    const txAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('G12TX', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    await ownAccountFromDb(dataSource, testLedger, txAccountId);

    const noTxOrganizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('G12_NOTX_ORG'),
      name: 'G12 无事务变体组织',
      kind: 'CLIENT',
    });
    const noTxAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('G12NOTX', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );

    const txLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, txLedger, txOrganizationId);
    await ownAccountFromDb(dataSource, txLedger, txAccountId);

    const noTxLedger = createOwnedResourceLedger();
    await ownOrganizationFromDb(dataSource, noTxLedger, noTxOrganizationId);
    await ownAccountFromDb(dataSource, noTxLedger, noTxAccountId);

    const txBefore = {
      organization: await readOrganizationFields(dataSource, txOrganizationId),
      account: await readAccountFields(dataSource, txAccountId),
    };
    const noTxBefore = {
      organization: await readOrganizationFields(dataSource, noTxOrganizationId),
      account: await readAccountFields(dataSource, noTxAccountId),
    };

    /** 两个变体共用同一条“快照已恢复”断言，避免结论来自两套不同口径。 */
    const expectSnapshotRestored = (before: typeof txBefore, after: typeof txBefore): void => {
      expect(after.organization).toEqual(before.organization);
      expect(after.account).toEqual(before.account);
    };

    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    try {
      // ---- 正常变体：真实事务，第 3 次 DELETE（base_user_account）注错 ----
      const failingTx = createFailNthDeleteDataSource(dataSource, 3);
      const txCalls: string[] = [];
      let txCaught: unknown;
      await runE2eTeardown({
        cleanup: async () => {
          txCalls.push('cleanup');
          await runGuardedSpecCleanup({
            dataSource: failingTx.dataSource,
            owned: txLedger,
            helper: 'G12 正常事务第 3 次删除失败',
          });
        },
        finalize: () => {
          txCalls.push('finalize');
        },
        closeApp: () => {
          txCalls.push('closeApp');
          return Promise.resolve();
        },
      }).catch((error: unknown) => {
        txCaught = error;
      });

      // 主因断言先通过：注入错误原样传播，且收尾步骤一步不落
      expect(txCalls).toEqual(['cleanup', 'finalize', 'closeApp']);
      expect(txCaught).toBe(failingTx.injectedError);
      expect(failingTx.stats.transactionCount).toBe(1);
      expect(failingTx.stats.deleteCount).toBe(3);

      const txAfter = {
        organization: await readOrganizationFields(dataSource, txOrganizationId),
        account: await readAccountFields(dataSource, txAccountId),
      };
      expectSnapshotRestored(txBefore, txAfter);

      // ---- 无事务变体：完全相同的“第 3 次 DELETE 注错”，但没有 BEGIN/ROLLBACK ----
      const failingNoTx = createFailNthDeleteNoTransactionDataSource(dataSource, 3);
      const noTxCalls: string[] = [];
      let noTxCaught: unknown;
      await runE2eTeardown({
        cleanup: async () => {
          noTxCalls.push('cleanup');
          await runGuardedSpecCleanup({
            dataSource: failingNoTx.dataSource,
            owned: noTxLedger,
            helper: 'G12 无事务变体第 3 次删除失败',
          });
        },
        finalize: () => {
          noTxCalls.push('finalize');
        },
        closeApp: () => {
          noTxCalls.push('closeApp');
          return Promise.resolve();
        },
      }).catch((error: unknown) => {
        noTxCaught = error;
      });

      // 主因断言同样先通过：两变体失败在同一个注入点、同一条消息
      expect(noTxCalls).toEqual(['cleanup', 'finalize', 'closeApp']);
      expect(noTxCaught).toBe(failingNoTx.injectedError);
      expect(failingNoTx.injectedError.message).toBe(failingTx.injectedError.message);
      expect(failingNoTx.stats.transactionCount).toBe(1);
      expect(failingNoTx.stats.deleteCount).toBe(3);

      const noTxAfter = {
        organization: await readOrganizationFields(dataSource, noTxOrganizationId),
        account: await readAccountFields(dataSource, noTxAccountId),
      };
      // 无事务变体下前两次 DELETE 已自动提交：组织与 user_info 消失、账号本体残留
      expect(noTxAfter.organization).toBeNull();
      expect(noTxAfter.account).not.toBeNull();
      expect(noTxAfter.account?.userInfo).toBeNull();
      expect(noTxAfter.account?.account).toEqual(noTxBefore.account?.account);
      // 同一个快照断言在无事务变体下必须为红；若这里通过，说明反例没有区分力
      expect(() => expectSnapshotRestored(noTxBefore, noTxAfter)).toThrow();
    } finally {
      try {
        // 正常变体：事务已回滚，按台账精确回收
        await runGuardedSpecCleanup({
          dataSource,
          owned: txLedger,
          helper: 'G12 回收正常事务变体',
        });
        // 无事务变体：organization 与 user_info 已被自动提交删除，只剩账号本体，按精确主键收尾
        await dataSource.getRepository(AccountEntity).delete({ id: noTxAccountId });
      } finally {
        restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
      }
    }

    expect(await readOrganizationFields(dataSource, noTxOrganizationId)).toBeNull();
    expect(await readAccountFields(dataSource, noTxAccountId)).toBeNull();
  });
});
