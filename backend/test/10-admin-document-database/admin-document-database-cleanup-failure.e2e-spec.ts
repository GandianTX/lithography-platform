// test/10-admin-document-database/admin-document-database-cleanup-failure.e2e-spec.ts
//
// PR3 负责人 review #1（R1）回归：夹具清理的失败路径。
//
// 设计要点：
// - 守卫语义保持真实（e2e-db-guard 的库名校验原样执行），只把 DataSource 替换为
//   可注入 mock——从而可在**不需要真实数据库**的情况下断言「守卫拒绝后写删为 0」；
// - 覆盖守卫拒绝后模拟 afterAll / DataSource 赋值前失败 / 直接调 cleanup 传入不允许目标 /
//   清理中途失败（错误不吞、app 仍关闭）。
// - 敌对式终审 F1 补充（0922）：production fixture 的
//   「错误库调用 seed/ensure helper → 守卫拒绝、写入与删除均为 0」、
//   「标记命中但归属不符 → 失败关闭、拒绝删除」、「空 ID 集合 no-op」与
//   「按本轮记录 ID 的精确删除顺序」。
// - 真实隔离库上的「半途失败仍精确回收、连续两次运行幂等、主键碰撞不影响外部数据」由
//   admin-document-database-production.e2e-spec.ts /
//   admin-document-database-production-ownership.e2e-spec.ts 在 lithography_e2e 上验证。

import type { DataSource } from 'typeorm';

import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import {
  cleanupAdminDocumentFixtureByIds,
  createAdminDocFixtureOwnership,
  runAdminDocFixtureTeardown,
  shouldRunAdminDocFixtureCleanup,
} from './admin-document-database-fixture';
import {
  PRODUCTION_FIXTURE_ACCOUNTS,
  PRODUCTION_FIXTURE_MODEL_SPEC,
  cleanupProductionFixtureByIds,
  cleanupProductionFixtureResidue,
  cleanupProductionSentinelChain,
  createProductionFixtureOwnership,
  ensureProductionSentinelChain,
  seedProductionFixtureAccounts,
  seedProductionFixtureBusiness,
  type ProductionFixtureOwnership,
} from './admin-document-database-production-fixture';

type MockState = {
  /** 每条 DELETE 的实体名与删除条件（用于断言「一次都没删」与删除顺序）。 */
  deleteCalls: Array<{ entityName: string; criteria: unknown }>;
  /** 真实落库写入（save / update）的调用记录：守卫拒绝时必须为 0。 */
  dbWriteCalls: Array<{ entityName: string; operation: string }>;
  /** 守卫 SELECT DATABASE() 的查询次数（守卫真实执行、非 mock）。 */
  guardQueryCalls: number;
};

/** 依据 where 条件（含 TypeORM In 操作符）在 mock 行集合中筛选 */
const matchWhere = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, expected]) => {
    const operatorValue = (expected as { value?: unknown[] } | undefined)?.value;
    if (Array.isArray(operatorValue)) {
      return operatorValue.includes(row[key]);
    }
    return row[key] === expected;
  });

/**
 * mock DataSource：query 返回指定库名（供真实守卫判定），getRepository 返回
 * 记录删除 / 写入调用、并按 where 条件返回预置行的仓库。守卫与 fixture 语义均为真实代码。
 */
const createMockDataSource = (options: {
  database: string;
  accountIds?: number[];
  failOnDeleteCall?: number;
  /** 按实体名预置可被 find / findOne 命中的行（默认按 accountIds 造 {id} 行） */
  rowsByEntity?: Record<string, Array<Record<string, unknown>>>;
}): { dataSource: DataSource; state: MockState } => {
  const state: MockState = { deleteCalls: [], dbWriteCalls: [], guardQueryCalls: 0 };

  const createRepository = (entity: unknown) => {
    const entityName = (entity as { name: string }).name;
    // 显式预置行（按 where 过滤）与「按 accountIds 造 {id} 行」的回落路径。
    // 回落路径刻意不按 where 过滤：兼容「只给出账号 ID 即代表命中」的既有断言写法。
    const explicitRows = options.rowsByEntity?.[entityName];
    const rowsOf = (): Array<Record<string, unknown>> =>
      explicitRows ?? (options.accountIds ?? []).map((id) => ({ id }));

    const findOptionsWith = (findOptions?: {
      where?: Record<string, unknown> | Array<Record<string, unknown>>;
    }): Record<string, unknown> | Array<Record<string, unknown>> | undefined => findOptions?.where;

    /** 支持单条件与 OR 条件数组（TypeORM 的 `where: [a, b]` 形式） */
    const selectRows = (
      where: Record<string, unknown> | Array<Record<string, unknown>> | undefined,
    ): Array<Record<string, unknown>> => {
      const rows = rowsOf();
      if (!explicitRows || !where) {
        return rows;
      }
      const conditions = Array.isArray(where) ? where : [where];
      return rows.filter((row) => conditions.some((condition) => matchWhere(row, condition)));
    };

    return {
      delete: (criteria: unknown): Promise<void> => {
        state.deleteCalls.push({ entityName, criteria });
        if (
          options.failOnDeleteCall !== undefined &&
          state.deleteCalls.length === options.failOnDeleteCall
        ) {
          return Promise.reject(new Error('模拟清理中途失败'));
        }
        return Promise.resolve();
      },
      find: (findOptions?: {
        where?: Record<string, unknown> | Array<Record<string, unknown>>;
      }): Promise<unknown[]> => Promise.resolve(selectRows(findOptionsWith(findOptions))),
      findOne: (findOptions?: {
        where?: Record<string, unknown> | Array<Record<string, unknown>>;
      }): Promise<unknown> => Promise.resolve(selectRows(findOptionsWith(findOptions))[0] ?? null),
      save: (value: unknown): Promise<unknown> => {
        state.dbWriteCalls.push({ entityName, operation: 'save' });
        return Promise.resolve(value);
      },
      create: (value: unknown): unknown => value,
      update: (): Promise<void> => {
        state.dbWriteCalls.push({ entityName, operation: 'update' });
        return Promise.resolve();
      },
    };
  };

  const dataSource = {
    isInitialized: true,
    // N04：fake DataSource 必须像真实 DataSource 一样显式给出预期库，
    // 不允许以「没有配置」为由跳过预期目标库解析。
    options: { database: options.database },
    query: (): Promise<Array<{ current_database: string }>> => {
      state.guardQueryCalls += 1;
      return Promise.resolve([{ current_database: options.database }]);
    },
    getRepository: (entity: unknown) => createRepository(entity),
  } as unknown as DataSource;

  return { dataSource, state };
};

const createMockApp = (): {
  app: { close: () => Promise<void> };
  appState: { closeCalls: number };
} => {
  const appState = { closeCalls: 0 };
  const app = {
    close: (): Promise<void> => {
      appState.closeCalls += 1;
      return Promise.resolve();
    },
  };
  return { app, appState };
};

/** 从 FindOperator（In）提取集合值：用于断言精确删除范围（不依赖 SQL 生成） */
const extractInValues = (criteria: unknown, key: string): number[] | undefined => {
  const operator = (criteria as Record<string, { value?: number[] } | undefined>)[key];
  return Array.isArray(operator?.value) ? operator.value : undefined;
};

/** 构造本轮所有权上下文（只记录「本轮实际创建成功并拿到 ID」的行） */
const ownershipWith = (ids: {
  repairRequestIds?: number[];
  equipmentModelIds?: number[];
  accountIds?: number[];
}): ProductionFixtureOwnership => {
  const ownership = createProductionFixtureOwnership();
  ownership.createdRepairRequestIds.push(...(ids.repairRequestIds ?? []));
  ownership.createdEquipmentModelIds.push(...(ids.equipmentModelIds ?? []));
  ownership.createdAccountIds.push(...(ids.accountIds ?? []));
  return ownership;
};

const guardedNoopCleanup = async (dataSource: DataSource): Promise<void> => {
  await assertDataSourceOnAllowedE2eDatabase(dataSource);
};

describe('admin-document-database 夹具清理失败路径（R1 回归）', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 白名单显式固定为与默认值一致，消除环境串扰
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('守卫拒绝后模拟 afterAll：DELETE 为 0、app.close 恰一次、不产生第二个删除错误', async () => {
    const { dataSource, state } = createMockDataSource({ database: 'lithography_drill' });
    const mockApp = createMockApp();

    // 模拟 beforeAll：真实守卫在同一 DataSource 上拒绝（lithography_drill 不在白名单）
    await expect(assertDataSourceOnAllowedE2eDatabase(dataSource)).rejects.toThrow(/白名单/);
    expect(state.guardQueryCalls).toBe(1);

    // 守卫拒绝 → targetValidated 保持 false（规格：仅「验证通过且写夹具前」才置位）
    await expect(
      runAdminDocFixtureTeardown({
        app: mockApp.app,
        dataSource,
        targetValidated: false,
        cleanup: guardedNoopCleanup,
      }),
    ).resolves.toBeUndefined();

    expect(state.deleteCalls).toHaveLength(0);
    // 清理函数根本未被调用：守卫查询次数不增加
    expect(state.guardQueryCalls).toBe(1);
    expect(mockApp.appState.closeCalls).toBe(1);
  });

  it('DataSource 赋值前失败：无 DELETE、无二次 undefined 错误、app.close 仍执行', async () => {
    const mockApp = createMockApp();

    await expect(
      runAdminDocFixtureTeardown({
        app: mockApp.app,
        dataSource: undefined,
        targetValidated: true,
        cleanup: guardedNoopCleanup,
      }),
    ).resolves.toBeUndefined();

    expect(mockApp.appState.closeCalls).toBe(1);
  });

  it('未验证目标：即使 DataSource 已初始化也跳过清理（只关闭 app）', async () => {
    const { dataSource, state } = createMockDataSource({ database: 'lithography_e2e' });
    const mockApp = createMockApp();

    await runAdminDocFixtureTeardown({
      app: mockApp.app,
      dataSource,
      targetValidated: false,
      cleanup: guardedNoopCleanup,
    });

    expect(state.deleteCalls).toHaveLength(0);
    expect(state.guardQueryCalls).toBe(0); // 清理函数未被调用
    expect(mockApp.appState.closeCalls).toBe(1);
  });

  it('直接调用 cleanup 且目标库不在白名单：第一条 DELETE 之前即被拒绝', async () => {
    const { dataSource, state } = createMockDataSource({ database: 'lithography_drill' });

    const ownership = createAdminDocFixtureOwnership();
    ownership.accountIds.push(901);
    await expect(cleanupAdminDocumentFixtureByIds(dataSource, ownership)).rejects.toThrow(/白名单/);

    expect(state.guardQueryCalls).toBe(1);
    expect(state.deleteCalls).toHaveLength(0);
  });

  it('清理失败：错误不被吞掉，app.close 仍执行（try/finally）', async () => {
    const { dataSource } = createMockDataSource({ database: 'lithography_e2e' });
    const mockApp = createMockApp();

    await expect(
      runAdminDocFixtureTeardown({
        app: mockApp.app,
        dataSource,
        targetValidated: true,
        cleanup: () => Promise.reject(new Error('模拟清理中途失败')),
      }),
    ).rejects.toThrow('模拟清理中途失败');

    expect(mockApp.appState.closeCalls).toBe(1);
  });

  it('app.close 自身失败且无清理错误：关闭错误向上抛出，不被吞掉', async () => {
    const app = {
      close: (): Promise<void> => Promise.reject(new Error('模拟关闭失败')),
    };

    await expect(
      runAdminDocFixtureTeardown({
        app,
        dataSource: undefined,
        targetValidated: false,
        cleanup: guardedNoopCleanup,
      }),
    ).rejects.toThrow('模拟关闭失败');
  });

  it('shouldRunAdminDocFixtureCleanup 判定矩阵：仅「已验证 + 连接已初始化」为真', () => {
    const { dataSource } = createMockDataSource({ database: 'lithography_e2e' });
    const notInitialized = { ...dataSource, isInitialized: false } as unknown as DataSource;

    expect(shouldRunAdminDocFixtureCleanup({ dataSource, targetValidated: true })).toBe(true);
    expect(shouldRunAdminDocFixtureCleanup({ dataSource, targetValidated: false })).toBe(false);
    expect(
      shouldRunAdminDocFixtureCleanup({ dataSource: notInitialized, targetValidated: true }),
    ).toBe(false);
    expect(shouldRunAdminDocFixtureCleanup({ dataSource: undefined, targetValidated: true })).toBe(
      false,
    );
  });

  describe('R5 production 专属夹具失败路径（按记录 ID 精确回收 + helper 自守卫）', () => {
    it('守卫拒绝：cleanupProductionFixtureResidue 在非白名单库第一条 DELETE 之前即被拒绝', async () => {
      const { dataSource, state } = createMockDataSource({ database: 'lithography_drill' });

      await expect(cleanupProductionFixtureResidue(dataSource)).rejects.toThrow(/白名单/);

      expect(state.guardQueryCalls).toBe(1);
      expect(state.deleteCalls).toHaveLength(0);
    });

    it('错误目标库：seed / ensure / cleanup helper 一律守卫拒绝，写入与删除均为 0', async () => {
      const { dataSource, state } = createMockDataSource({ database: 'lithography_drill' });
      const ownership = createProductionFixtureOwnership();

      await expect(seedProductionFixtureAccounts({ dataSource, ownership })).rejects.toThrow(
        /白名单/,
      );
      await expect(
        seedProductionFixtureBusiness({
          dataSource,
          ownership,
          customerAccountId: 701,
          engineerAccountId: 702,
        }),
      ).rejects.toThrow(/白名单/);
      await expect(ensureProductionSentinelChain({ dataSource, ownership })).rejects.toThrow(
        /白名单/,
      );
      await expect(
        cleanupProductionSentinelChain(dataSource, {
          accountId: 701,
          equipmentModelId: 702,
          repairRequestId: 703,
        }),
      ).rejects.toThrow(/白名单/);

      expect(state.deleteCalls).toHaveLength(0);
      expect(state.dbWriteCalls).toHaveLength(0);
      // 每个 helper 各自执行一次真实白名单校验（不把调用方已守卫当作永久授权）
      expect(state.guardQueryCalls).toBe(4);
      // 守卫拒绝时不得记录任何「创建成功」的 ID
      expect(ownership.createdAccountIds).toEqual([]);
      expect(ownership.createdEquipmentModelIds).toEqual([]);
    });

    it('归属校验失败关闭：标记命中但归属不符的残留 → 拒绝删除且写删均为 0', async () => {
      const customerConfig = PRODUCTION_FIXTURE_ACCOUNTS.customer;
      const { dataSource, state } = createMockDataSource({
        database: 'lithography_e2e',
        // 以 [实体名, 行集合] 元组构造：实体名不是对象字面量属性，规避命名格式规则
        // 账号与型号字段**完全匹配**（自然标记 + 全字段），以确认拒绝来自「申请归属」而非字段校验
        rowsByEntity: Object.fromEntries([
          [
            'AccountEntity',
            [
              {
                id: 701,
                loginName: customerConfig.loginName,
                loginEmail: customerConfig.loginEmail,
                status: customerConfig.status,
                identityHint: customerConfig.identityType,
              },
            ],
          ],
          ['EquipmentModelEntity', [{ id: 702, ...PRODUCTION_FIXTURE_MODEL_SPEC }]],
          [
            'RepairRequestEntity',
            [
              {
                id: 703,
                requestNo: 'E2E-ADM-DOCDB-PROD-OPEN',
                customerAccountId: 999999, // 不属于本 spec
                equipmentModelId: 702,
                acceptedByEngineerAccountId: null,
              },
            ],
          ],
        ] as Array<[string, Array<Record<string, unknown>>]>),
      });

      await expect(cleanupProductionFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);

      expect(state.guardQueryCalls).toBe(1);
      expect(state.deleteCalls).toHaveLength(0);
      expect(state.dbWriteCalls).toHaveLength(0);
    });

    it('DataSource 赋值前失败：production 收尾无 DELETE、无二次错误、app.close 仍执行', async () => {
      const mockApp = createMockApp();

      await expect(
        runAdminDocFixtureTeardown({
          app: mockApp.app,
          dataSource: undefined,
          targetValidated: true,
          cleanup: (ds) => cleanupProductionFixtureByIds(ds, ownershipWith({ accountIds: [701] })),
        }),
      ).resolves.toBeUndefined();

      expect(mockApp.appState.closeCalls).toBe(1);
    });

    it('允许的隔离库：守卫先行，按「申请 → 型号 → user_info → account」精确删除', async () => {
      const { dataSource, state } = createMockDataSource({
        database: 'lithography_e2e',
        // 账号引用的申请：必须在已验证所有权集合内（本轮记录的申请）
        rowsByEntity: Object.fromEntries([
          [
            'RepairRequestEntity',
            [
              { id: 501, customerAccountId: 701, acceptedByEngineerAccountId: null },
              { id: 502, customerAccountId: 701, acceptedByEngineerAccountId: null },
            ],
          ],
        ] as Array<[string, Array<Record<string, unknown>>]>),
      });

      await cleanupProductionFixtureByIds(
        dataSource,
        ownershipWith({
          repairRequestIds: [501, 502],
          equipmentModelIds: [601],
          accountIds: [701],
        }),
      );

      expect(state.guardQueryCalls).toBe(1);
      expect(state.deleteCalls.map((call) => call.entityName)).toEqual([
        'RepairRequestEntity',
        'EquipmentModelEntity',
        'UserInfoEntity',
        'AccountEntity',
      ]);
      // 全部为本轮**实际记录**的 ID（不含任何固定主键，也不按账号 ID 批量兜底）
      expect(extractInValues(state.deleteCalls[0].criteria, 'id')).toEqual([501, 502]);
      expect(extractInValues(state.deleteCalls[1].criteria, 'id')).toEqual([601]);
      expect(extractInValues(state.deleteCalls[2].criteria, 'accountId')).toEqual([701]);
      expect(extractInValues(state.deleteCalls[3].criteria, 'id')).toEqual([701]);
    });

    it('账号被归属不明的申请引用：失败关闭，账号与外部申请均不删除', async () => {
      const { dataSource, state } = createMockDataSource({
        database: 'lithography_e2e',
        // 外部（非本轮记录）申请引用了本轮账号：不得按账号 ID 批量兜底删除
        rowsByEntity: Object.fromEntries([
          [
            'RepairRequestEntity',
            [{ id: 901, customerAccountId: 701, acceptedByEngineerAccountId: null }],
          ],
        ] as Array<[string, Array<Record<string, unknown>>]>),
      });

      await expect(
        cleanupProductionFixtureByIds(dataSource, ownershipWith({ accountIds: [701] })),
      ).rejects.toThrow(/账号引用申请/);

      expect(state.guardQueryCalls).toBe(1);
      expect(state.deleteCalls).toHaveLength(0);
      expect(state.dbWriteCalls).toHaveLength(0);
    });

    it('哨兵链：允许的隔离库按调用方持有的 ID 精确回收（先子后父）', async () => {
      const { dataSource, state } = createMockDataSource({
        database: 'lithography_e2e',
        rowsByEntity: Object.fromEntries([
          [
            'RepairRequestEntity',
            [{ id: 803, customerAccountId: 801, acceptedByEngineerAccountId: null }],
          ],
        ] as Array<[string, Array<Record<string, unknown>>]>),
      });

      await cleanupProductionSentinelChain(dataSource, {
        accountId: 801,
        equipmentModelId: 802,
        repairRequestId: 803,
      });

      expect(state.deleteCalls.map((call) => call.entityName)).toEqual([
        'RepairRequestEntity',
        'EquipmentModelEntity',
        'UserInfoEntity',
        'AccountEntity',
      ]);
      expect(extractInValues(state.deleteCalls[0].criteria, 'id')).toEqual([803]);
      expect(extractInValues(state.deleteCalls[1].criteria, 'id')).toEqual([802]);
      expect(extractInValues(state.deleteCalls[3].criteria, 'id')).toEqual([801]);
    });

    it('空 ID 集合为 no-op：不执行守卫查询、不产生任何写删', async () => {
      const { dataSource, state } = createMockDataSource({ database: 'lithography_e2e' });

      await cleanupProductionFixtureByIds(dataSource, createProductionFixtureOwnership());
      await cleanupProductionSentinelChain(dataSource, {});

      expect(state.guardQueryCalls).toBe(0);
      expect(state.deleteCalls).toHaveLength(0);
      expect(state.dbWriteCalls).toHaveLength(0);
    });

    it('清理中途失败：错误不被吞掉，失败后不再继续删除', async () => {
      const { dataSource, state } = createMockDataSource({
        database: 'lithography_e2e',
        failOnDeleteCall: 2,
      });

      await expect(
        cleanupProductionFixtureByIds(
          dataSource,
          ownershipWith({ repairRequestIds: [501, 502], equipmentModelIds: [601] }),
        ),
      ).rejects.toThrow('模拟清理中途失败');

      expect(state.deleteCalls).toHaveLength(2); // 第 2 条失败后不再继续
    });

    it('部分账号创建失败：如实返回 created / failures，仅按已记录的成功 ID 回收', async () => {
      const { dataSource, state } = createMockDataSource({
        database: 'lithography_e2e',
        // 库中不存在引用这些账号的申请（有的话即归属不明，必须失败关闭）
        rowsByEntity: Object.fromEntries([['RepairRequestEntity', []]] as Array<
          [string, Array<Record<string, unknown>>]
        >),
      });
      const ownership = createProductionFixtureOwnership();

      const execute = jest
        .fn()
        .mockResolvedValueOnce({ id: 601 })
        .mockRejectedValueOnce(new Error('模拟 engineer 创建失败'))
        .mockResolvedValueOnce({ id: 603 });
      const createAccountUsecase = { execute } as unknown as CreateAccountUsecase;

      const { created, failures } = await seedProductionFixtureAccounts({
        dataSource,
        ownership,
        createAccountUsecase,
      });

      expect(created.map((seed) => [seed.key, seed.accountId])).toEqual([
        ['admin', 601],
        ['customer', 603],
      ]);
      expect(failures.map((failure) => failure.key)).toEqual(['engineer']);
      expect(ownership.createdAccountIds).toEqual([601, 603]);

      // 调用方按已记录 ID 回收：仅 601/603 进入删除条件，创建失败的 engineer 不出现
      await cleanupProductionFixtureByIds(dataSource, ownership);

      // 账号引用申请枚举完成（无归属不明者）→ 按本轮记录 ID 回收 user_info → account
      expect(state.deleteCalls.map((call) => call.entityName)).toEqual([
        'UserInfoEntity',
        'AccountEntity',
      ]);
      expect(extractInValues(state.deleteCalls[0].criteria, 'accountId')).toEqual([601, 603]);
      expect(extractInValues(state.deleteCalls[1].criteria, 'id')).toEqual([601, 603]);
    });
  });
});
