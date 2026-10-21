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

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { ReferenceDocumentEntity } from '@src/modules/lithography/entities/reference-document.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { DataSource, EntityManager } from 'typeorm';

import { assertDataSourceOnAllowedE2eDatabase } from './e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
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
 * V01：真实事务内让 user_info 写入失败，验证回落账号造数整体回滚；
 * 只包装测试侧 manager，不改 src。
 */
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
    recordOwnedResource(testLedger, 'organization', organizationId);

    const targetLedger = createOwnedResourceLedger();
    recordOwnedResource(targetLedger, 'organization', organizationId);

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
    recordOwnedResource(testLedger, 'account', sentinelAccountId);

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
    recordOwnedResource(testLedger, 'organization', sentinelOrganizationId);

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
      recordOwnedResource(testLedger, 'equipmentModel', 43);
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
    recordOwnedResource(testLedger, 'equipmentModel', roundModelId);
    expect(roundModelId).not.toBe(43);

    const roundLedger = createOwnedResourceLedger();
    recordOwnedResource(roundLedger, 'equipmentModel', roundModelId);

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
    recordOwnedResource(testLedger, 'organization', organizationId);

    const externalAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C05EXT', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    recordOwnedResource(testLedger, 'account', externalAccountId);
    const membershipId = await createMembership(dataSource, organizationId, externalAccountId);
    recordOwnedResource(testLedger, 'membership', membershipId);

    const organizationBefore = await readOrganizationFields(dataSource, organizationId);
    const membershipBefore = await readMembershipFields(dataSource, membershipId);
    expect(organizationBefore).not.toBeNull();
    expect(membershipBefore).not.toBeNull();

    // 本轮只登记组织：外部账号与成员关系都不在 owned 集合内
    const targetLedger = createOwnedResourceLedger();
    recordOwnedResource(targetLedger, 'organization', organizationId);

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
    recordOwnedResource(testLedger, 'organization', ownedOrganizationId);

    const externalOrganizationId = await createOrganization(dataSource, {
      organizationCode: codeFor('C05B_EXT_ORG'),
      name: 'C05B 外部组织',
      kind: 'PEER',
    });
    recordOwnedResource(testLedger, 'organization', externalOrganizationId);

    const ownedAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C05BOWN', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    recordOwnedResource(testLedger, 'account', ownedAccountId);

    const ownedMembershipId = await createMembership(
      dataSource,
      ownedOrganizationId,
      ownedAccountId,
    );
    recordOwnedResource(testLedger, 'membership', ownedMembershipId);
    const externalMembershipId = await createMembership(
      dataSource,
      externalOrganizationId,
      ownedAccountId,
    );
    recordOwnedResource(testLedger, 'membership', externalMembershipId);

    const organizationBefore = await readOrganizationFields(dataSource, ownedOrganizationId);
    const accountBefore = await readAccountFields(dataSource, ownedAccountId);
    const ownedMembershipBefore = await readMembershipFields(dataSource, ownedMembershipId);
    const externalMembershipBefore = await readMembershipFields(dataSource, externalMembershipId);

    // 本轮只登记 owned 组织与 owned 账号：账号在外部组织的成员关系不在范围内
    const targetLedger = createOwnedResourceLedger();
    recordOwnedResource(targetLedger, 'organization', ownedOrganizationId);
    recordOwnedResource(targetLedger, 'account', ownedAccountId);

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
    recordOwnedResource(testLedger, 'organization', organizationId);

    const ownedAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C06OWN', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    recordOwnedResource(testLedger, 'account', ownedAccountId);

    const externalAccountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C06EXT', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    recordOwnedResource(testLedger, 'account', externalAccountId);

    const documentId = await createDocument(dataSource, {
      title: 'C06 后阶段冲突资料',
      ownerOrganizationId: organizationId,
      createdByAccountId: externalAccountId,
    });
    recordOwnedResource(testLedger, 'document', documentId);

    const organizationBefore = await readOrganizationFields(dataSource, organizationId);
    const documentBefore = await readDocumentFields(dataSource, documentId);

    const targetLedger = createOwnedResourceLedger();
    recordOwnedResource(targetLedger, 'organization', organizationId);
    recordOwnedResource(targetLedger, 'account', ownedAccountId);

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
    recordOwnedResource(testLedger, 'organization', organizationId);

    const accountId = await createAccount(
      dataSource,
      createAccountUsecase,
      accountConfig('C07', [IdentityTypeEnum.ENGINEER], IdentityTypeEnum.ENGINEER),
    );
    recordOwnedResource(testLedger, 'account', accountId);

    const membershipId = await createMembership(dataSource, organizationId, accountId);
    recordOwnedResource(testLedger, 'membership', membershipId);

    const documentId = await createDocument(dataSource, {
      title: 'C07 回滚资料',
      ownerOrganizationId: organizationId,
      createdByAccountId: accountId,
    });
    recordOwnedResource(testLedger, 'document', documentId);

    const before = {
      organization: await readOrganizationFields(dataSource, organizationId),
      account: await readAccountFields(dataSource, accountId),
      membership: await readMembershipFields(dataSource, membershipId),
      document: await readDocumentFields(dataSource, documentId),
    };

    const targetLedger = createOwnedResourceLedger();
    recordOwnedResource(targetLedger, 'organization', organizationId);
    recordOwnedResource(targetLedger, 'account', accountId);
    recordOwnedResource(targetLedger, 'membership', membershipId);
    recordOwnedResource(targetLedger, 'document', documentId);

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
      recordOwnedResource(partialLedger, 'organization', registeredOrganizationId);
      recordOwnedResource(testLedger, 'organization', registeredOrganizationId);

      // 已创建但尚未登记：模拟 beforeAll 在这之后失败
      unregisteredOrganizationId = await createOrganization(dataSource, {
        organizationCode: codeFor('C08_UNREGISTERED'),
        name: 'C08 未登记组织',
        kind: 'CLIENT',
      });
      recordOwnedResource(testLedger, 'organization', unregisteredOrganizationId);

      externalOrganizationId = await createOrganization(dataSource, {
        organizationCode: codeFor('C08_EXTERNAL'),
        name: 'C08 异主组织',
        kind: 'PEER',
      });
      recordOwnedResource(testLedger, 'organization', externalOrganizationId);

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
    recordOwnedResource(testLedger, 'organization', residueOrganizationId);

    const sameNameOtherCodeId = await createOrganization(dataSource, {
      organizationCode: `${residueCode}_OTHER`,
      name: residueName,
      kind: 'CLIENT',
    });
    recordOwnedResource(testLedger, 'organization', sameNameOtherCodeId);

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
});
