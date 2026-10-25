// test/utils/e2e-scoped-cleanup.e2e-spec.ts
//
// PR0-S8 全局复查 G4（F05/F06）验收规格：窄范围清理执行器与统一收尾器的行为契约。
//
// 覆盖计划 G4 验收原文：
// - 同库预放不属于本规格的组织/成员/账号/资料与目录：初始化、正常结束、异常结束后均不变；
// - 缺许可/目标错误时，在第一条删除语句之前拒绝（未触碰任何数据）；
// - 注入清理失败时规格确实失败（错误经 runE2eTeardown 向 jest 传播），不是 console.error 后仍绿色。
//
// 结构：
// - A 部分（纯函数）：runE2eTeardown 调用序与错误保真；临时目录只删精确目录；环境变量两态恢复；
// - B 部分（假 DataSource）：双门禁先于任何数据接触（失败时不得开启事务）；
//   owned 为空且无 residue 时纯 no-op；有 owned 时事务内先预检后按精确 ID 删除；
// - C 部分（真实隔离库 lithography_e2e）：预放异主（KEEP）与目标（MINE）数据，验证正常结束只清
//   本轮 owned、门禁拒绝与异常结束不触碰异主数据。
//
// 运行前置（与 06 组一致）：执行者须显式设置 E2E_ALLOW_PHYSICAL_CLEANUP=1
// （本 spec 的 afterAll 以真实收尾路径清理自身夹具，缺许可将按设计失败关闭）；
// 库名白名单默认为 lithography_e2e。

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { ReferenceDocumentEntity } from '@src/modules/lithography/entities/reference-document.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataSource } from 'typeorm';

import { assertDataSourceOnAllowedE2eDatabase } from './e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedScopedCleanup,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
  type OwnedResourceLedger,
} from './e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from './e2e-teardown';
import { createTestAccount, type TestAccountConfig } from './test-accounts';
import {
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from './test-organizations';

// ---------------------------------------------------------------------------------------
// A 部分：runE2eTeardown 统一收尾语义（纯函数，不需要数据库）
// ---------------------------------------------------------------------------------------

describe('runE2eTeardown 统一收尾语义（纯函数）', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('正常顺序：cleanup → finalize → closeApp 依序执行，全部成功时 resolve', async () => {
    const calls: string[] = [];

    await expect(
      runE2eTeardown({
        cleanup: () => {
          calls.push('cleanup');
          return Promise.resolve();
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

    expect(calls).toEqual(['cleanup', 'finalize', 'closeApp']);
  });

  it('清理失败：错误原样向 jest 传播（规格确实失败），finalize 与 closeApp 仍执行', async () => {
    const calls: string[] = [];
    const injected = new Error('注入清理失败（不得 console.error 后仍绿色）');

    await expect(
      runE2eTeardown({
        cleanup: () => {
          calls.push('cleanup');
          return Promise.reject(injected);
        },
        finalize: () => {
          calls.push('finalize');
        },
        closeApp: () => {
          calls.push('closeApp');
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(injected);

    // 资源关闭不被清理失败阻断
    expect(calls).toEqual(['cleanup', 'finalize', 'closeApp']);
  });

  it('多步同时失败：抛最初错误为主因，其余错误按序并入消息（不无声覆盖）', async () => {
    const first = new Error('最初错误：清理失败');
    const second = new Error('第二个错误：finalize 失败');
    const third = new Error('第三个错误：closeApp 失败');
    const calls: string[] = [];

    let caught: unknown;
    try {
      await runE2eTeardown({
        cleanup: () => {
          calls.push('cleanup');
          return Promise.reject(first);
        },
        finalize: () => {
          calls.push('finalize');
          throw second;
        },
        closeApp: () => {
          calls.push('closeApp');
          return Promise.reject(third);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(calls).toEqual(['cleanup', 'finalize', 'closeApp']);
    expect(caught).toBeInstanceOf(Error);
    const aggregate = caught as Error;
    expect(aggregate.cause).toBe(first);
    expect(aggregate.message).toContain(first.message);
    expect(aggregate.message).toContain(second.message);
    expect(aggregate.message).toContain(third.message);
    // 最初错误出现在其余错误之前（不无声覆盖最初的错误）
    expect(aggregate.message.indexOf(first.message)).toBeLessThan(
      aggregate.message.indexOf(second.message),
    );
  });

  it('closeApp 单独失败：错误直接传播，不被吞掉', async () => {
    const closeError = new Error('模拟关闭失败');

    await expect(runE2eTeardown({ closeApp: () => Promise.reject(closeError) })).rejects.toBe(
      closeError,
    );
  });

  it('临时存储目录：finalize 只删除本测试精确目录，异目录不被触碰', async () => {
    const mineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-scopeclean-mine-'));
    const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-scopeclean-keep-'));
    const envName = 'E2E_SCOPECLEAN_STORAGE_DIR';
    const absentName = 'E2E_SCOPECLEAN_RESTORE_ABSENT_PROBE';

    try {
      fs.writeFileSync(path.join(mineDir, 'mine.txt'), 'mine');
      fs.writeFileSync(path.join(keepDir, 'keep.txt'), 'keep');

      // 捕获原值后再写入临时值；环境变量恢复不假定原值不存在
      const originalStorageDir = captureEnvValue(envName);
      const originalAbsent = captureEnvValue(absentName);
      expect(originalAbsent).toBeUndefined();
      process.env[envName] = mineDir;
      process.env[absentName] = '测试期间临时值';

      await runE2eTeardown({
        finalize: () => {
          fs.rmSync(mineDir, { recursive: true, force: true });
          restoreEnvValue(envName, originalStorageDir);
          restoreEnvValue(absentName, originalAbsent);
        },
      });

      expect(fs.existsSync(mineDir)).toBe(false);
      expect(fs.existsSync(path.join(keepDir, 'keep.txt'))).toBe(true);
      expect(captureEnvValue(envName)).toBe(originalStorageDir);
      expect(captureEnvValue(absentName)).toBe(originalAbsent);
    } finally {
      fs.rmSync(mineDir, { recursive: true, force: true });
      fs.rmSync(keepDir, { recursive: true, force: true });
    }
  });

  it('captureEnvValue/restoreEnvValue：原值存在写回原值，原值不存在才删除', () => {
    const name = 'E2E_SCOPECLEAN_ENV_RESTORE_PROBE';

    // 原值不存在：恢复时删除，而不是写回占位值
    delete process.env[name];
    const capturedAbsent = captureEnvValue(name);
    expect(capturedAbsent).toBeUndefined();
    process.env[name] = '测试期间临时值';
    restoreEnvValue(name, capturedAbsent);
    expect(name in process.env).toBe(false);

    // 原值存在：恢复时写回原值，而不是一律删除
    process.env[name] = '原始值';
    const capturedPresent = captureEnvValue(name);
    process.env[name] = '测试期间临时值';
    restoreEnvValue(name, capturedPresent);
    expect(process.env[name]).toBe('原始值');

    delete process.env[name];
  });
});

// ---------------------------------------------------------------------------------------
// B 部分：runGuardedScopedCleanup 双门禁与调用序（假 DataSource，不需要真实数据库）
// ---------------------------------------------------------------------------------------

type GuardedCleanupOp =
  | { readonly kind: 'queryBuilderDelete'; readonly table: string }
  | { readonly kind: 'repositoryDelete'; readonly entity: string; readonly criteria: unknown };

/**
 * 记录式假 DataSource：守卫真实执行（query 返回指定库名），
 * 清理回调所用的 createQueryBuilder 与 getRepository 全部落入调用记录。
 */
const createRecordingDataSource = (options: {
  readonly accountRowIds: readonly number[];
}): {
  dataSource: DataSource;
  ops: GuardedCleanupOp[];
  queryProbe: jest.Mock;
} => {
  const ops: GuardedCleanupOp[] = [];
  const queryProbe = jest.fn(() => Promise.resolve([{ current_database: 'lithography_e2e' }]));

  const createQueryBuilderChain = (): Record<string, unknown> => {
    let table = '';
    const chain: Record<string, unknown> = {};
    chain.delete = () => chain;
    chain.from = (name: string) => {
      table = name;
      return chain;
    };
    chain.where = () => chain;
    chain.execute = () => {
      ops.push({ kind: 'queryBuilderDelete', table });
      return Promise.resolve();
    };
    return chain;
  };

  const getRepository = (entity: unknown) => {
    const entityName = (entity as { name: string }).name;
    return {
      find: () => Promise.resolve(options.accountRowIds.map((id) => ({ id }))),
      delete: (criteria: unknown) => {
        ops.push({ kind: 'repositoryDelete', entity: entityName, criteria });
        return Promise.resolve();
      },
    };
  };

  const dataSource = {
    isInitialized: true,
    query: queryProbe,
    createQueryBuilder: createQueryBuilderChain,
    getRepository,
  } as unknown as DataSource;

  return { dataSource, ops, queryProbe };
};

type SpecCleanupSqlRecord = {
  readonly kind: 'select' | 'delete';
  readonly sql: string;
  readonly params: unknown;
};

/**
 * 事务型假 DataSource：门禁仍走真实守卫（query 返回库名），
 * `transaction` 直接把假 manager 交给清理器；manager.query 记录真实 SQL，
 * 并按 helper 实际访问的表一律返回空行（不制造归属/引用冲突）。
 */
const createFakeTransactionalDataSource = (
  options: {
    respond?: (sql: string, params?: unknown) => unknown[] | undefined;
  } = {},
): {
  dataSource: DataSource;
  records: SpecCleanupSqlRecord[];
  transaction: jest.Mock;
  queryProbe: jest.Mock;
} => {
  const records: SpecCleanupSqlRecord[] = [];
  const manager = {
    query: (sql: string, params?: unknown) => {
      const normalized = sql.trim();
      records.push({
        kind: /^DELETE\b/i.test(normalized) ? 'delete' : 'select',
        sql: normalized,
        params,
      });
      return Promise.resolve(options.respond?.(normalized, params) ?? []);
    },
  };
  const transaction = jest.fn((run: (manager: unknown) => Promise<unknown>) => run(manager));
  const queryProbe = jest.fn(() => Promise.resolve([{ current_database: 'lithography_e2e' }]));
  const dataSource = {
    isInitialized: true,
    query: queryProbe,
    transaction,
  } as unknown as DataSource;

  return { dataSource, records, transaction, queryProbe };
};

describe('runGuardedScopedCleanup / runGuardedSpecCleanup 双门禁与调用序（假 DataSource）', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('缺许可：在读取实际库名之前失败关闭，清理回调完全不被调用', async () => {
    delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    const queryProbe = jest.fn(() => Promise.resolve([{ current_database: 'lithography_e2e' }]));
    const dataSource = { isInitialized: true, query: queryProbe } as unknown as DataSource;
    const cleanup = jest.fn((): Promise<void> => Promise.resolve());

    await expect(
      runGuardedScopedCleanup({ dataSource, cleanup, helper: '验收用 helper' }),
    ).rejects.toThrow(
      /\[验收用 helper\] 阶段=清理许可门禁 拒绝执行删除：[\s\S]*E2E_ALLOW_PHYSICAL_CLEANUP=1/,
    );

    // 许可门禁先于任何数据接触：库名查询与清理回调都未发生
    expect(queryProbe).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('白名单不符：许可已给足仍失败关闭（许可不能替代库名校验），第一条删除前拒绝', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_drill';
    const queryProbe = jest.fn(() => Promise.resolve([{ current_database: 'lithography_e2e' }]));
    const dataSource = { isInitialized: true, query: queryProbe } as unknown as DataSource;
    const cleanup = jest.fn((): Promise<void> => Promise.resolve());

    await expect(
      runGuardedScopedCleanup({ dataSource, cleanup, helper: '验收用 helper' }),
    ).rejects.toThrow(/不在允许的 E2E 库白名单/);

    expect(queryProbe).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('双门禁通过：清理回调收到同一 DataSource 且恰执行一次', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const { dataSource, ops, queryProbe } = createRecordingDataSource({ accountRowIds: [] });
    const cleanup = jest.fn((): Promise<void> => Promise.resolve());

    await expect(
      runGuardedScopedCleanup({ dataSource, cleanup, helper: '验收用 helper' }),
    ).resolves.toBeUndefined();

    expect(queryProbe).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(dataSource);
    expect(ops).toEqual([]);
  });

  it('清理回调自身抛错：错误向外传播，不被吞并', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const { dataSource } = createRecordingDataSource({ accountRowIds: [] });
    const boom = new Error('回调内部失败');

    await expect(
      runGuardedScopedCleanup({
        dataSource,
        cleanup: () => Promise.reject(boom),
        helper: '验收用 helper',
      }),
    ).rejects.toBe(boom);
  });

  it('双门禁先于任何数据接触：缺许可或库名不符时 transaction 与 DELETE 均未发生', async () => {
    const owned = createOwnedResourceLedger();
    recordOwnedResource(owned, 'organization', 101);

    delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    const denied = createFakeTransactionalDataSource();
    await expect(
      runGuardedSpecCleanup({ dataSource: denied.dataSource, owned, helper: '假 DS 缺许可' }),
    ).rejects.toThrow(/阶段=清理许可门禁/);
    expect(denied.queryProbe).not.toHaveBeenCalled();
    expect(denied.transaction).not.toHaveBeenCalled();
    expect(denied.records).toEqual([]);

    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_drill';
    const wrongDb = createFakeTransactionalDataSource();
    await expect(
      runGuardedSpecCleanup({ dataSource: wrongDb.dataSource, owned, helper: '假 DS 错库' }),
    ).rejects.toThrow(/不在允许的 E2E 库白名单/);
    expect(wrongDb.queryProbe).toHaveBeenCalledTimes(1);
    expect(wrongDb.transaction).not.toHaveBeenCalled();
    expect(wrongDb.records).toEqual([]);
  });

  it('owned 为空且无 residue：纯 no-op（不开启事务、不执行 DELETE）', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const { dataSource, records, transaction, queryProbe } = createFakeTransactionalDataSource();

    await expect(
      runGuardedSpecCleanup({
        dataSource,
        owned: createOwnedResourceLedger(),
        helper: '假 DS 空集合',
      }),
    ).resolves.toBeUndefined();
    await expect(
      runGuardedSpecCleanup({ dataSource, helper: '假 DS 无入参' }),
    ).resolves.toBeUndefined();

    // 仅两道门禁各读取一次库名；事务与清理语句都未发生
    expect(queryProbe).toHaveBeenCalledTimes(2);
    expect(transaction).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('有 owned：单事务内先加锁预检、后按精确 ID 删除', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const owned = createOwnedResourceLedger();
    recordOwnedResource(owned, 'organization', 101);
    recordOwnedResource(owned, 'account', 201);
    const { dataSource, records, transaction } = createFakeTransactionalDataSource();

    await expect(
      runGuardedSpecCleanup({ dataSource, owned, helper: '假 DS 有 owned' }),
    ).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(1);
    const firstDeleteIndex = records.findIndex((record) => record.kind === 'delete');
    expect(firstDeleteIndex).toBeGreaterThan(0);
    // 预检（加锁读 + 引用闭包）全部发生在第一条 DELETE 之前
    expect(records.slice(0, firstDeleteIndex).every((record) => record.kind === 'select')).toBe(
      true,
    );
    expect(records.slice(firstDeleteIndex).every((record) => record.kind === 'delete')).toBe(true);
    expect(
      records.some(
        (record) =>
          record.kind === 'select' && /FROM organization\b[\s\S]*FOR UPDATE/i.test(record.sql),
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.kind === 'select' && /FROM base_user_account\b[\s\S]*FOR UPDATE/i.test(record.sql),
      ),
    ).toBe(true);
    // 精确 ID 删除，不做自然键或整表删除
    expect(records.filter((record) => record.kind === 'delete')).toEqual([
      { kind: 'delete', sql: 'DELETE FROM organization WHERE id IN (?)', params: [101] },
      { kind: 'delete', sql: 'DELETE FROM base_user_info WHERE account_id IN (?)', params: [201] },
      { kind: 'delete', sql: 'DELETE FROM base_user_account WHERE id IN (?)', params: [201] },
    ]);
  });

  // R25-01：retained-only 时组织/账号可删集合为空，任何子图查询都不得生成空 WHERE。
  const retainedFingerprint = {
    loginName: 'retained_r25_01',
    loginEmail: 'retained.r25.01@example.com',
    status: AccountStatus.ACTIVE,
    identityHint: IdentityTypeEnum.CUSTOMER,
    nickname: 'retained_r25_01_nickname',
    accessGroup: [IdentityTypeEnum.CUSTOMER],
  };
  const retainedAccountRow = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: 900,
    login_name: retainedFingerprint.loginName,
    login_email: retainedFingerprint.loginEmail,
    status: retainedFingerprint.status,
    identity_hint: retainedFingerprint.identityHint,
    nickname: retainedFingerprint.nickname,
    user_info_email: retainedFingerprint.loginEmail,
    access_group: retainedFingerprint.accessGroup,
    meta_digest: 'encrypted-digest',
    user_state: 'ACTIVE',
    ...overrides,
  });
  const emptyConditionSql = (records: SpecCleanupSqlRecord[]): string[] =>
    records.filter((record) => /WHERE\s+FOR UPDATE/i.test(record.sql)).map((record) => record.sql);
  const deletes = (records: SpecCleanupSqlRecord[]): SpecCleanupSqlRecord[] =>
    records.filter((record) => record.kind === 'delete');

  it('R25-01 C01：保留账号命中且组织/账号集合为空，不生成空 WHERE、不删除保留账号', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const { dataSource, records, transaction } = createFakeTransactionalDataSource({
      respond: (sql) =>
        /FROM base_user_account a\b/i.test(sql) ? [retainedAccountRow()] : undefined,
    });

    await expect(
      runGuardedSpecCleanup({
        dataSource,
        helper: 'R25-01 C01',
        retainedAccounts: [retainedFingerprint],
      }),
    ).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(1);
    // 保留账号指纹确实被查询并命中
    expect(records.some((record) => /FROM base_user_account a\b/i.test(record.sql))).toBe(true);
    expect(emptyConditionSql(records)).toEqual([]);
    expect(records.some((record) => /FROM content_submission\b/i.test(record.sql))).toBe(false);
    expect(deletes(records)).toEqual([]);
  });

  it('R25-01 C02：保留账号不存在，安全空操作且无非法 SQL、无 DELETE', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const { dataSource, records, transaction } = createFakeTransactionalDataSource();

    await expect(
      runGuardedSpecCleanup({
        dataSource,
        helper: 'R25-01 C02',
        retainedAccounts: [retainedFingerprint],
      }),
    ).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(emptyConditionSql(records)).toEqual([]);
    expect(deletes(records)).toEqual([]);
  });

  it('R25-01 C03：保留账号存在但指纹不符，第一条 DELETE 前拒绝', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const { dataSource, records } = createFakeTransactionalDataSource({
      respond: (sql) =>
        /FROM base_user_account a\b/i.test(sql)
          ? [retainedAccountRow({ nickname: 'foreign_nickname' })]
          : undefined,
    });

    await expect(
      runGuardedSpecCleanup({
        dataSource,
        helper: 'R25-01 C03',
        retainedAccounts: [retainedFingerprint],
      }),
    ).rejects.toThrow(/账号\/用户信息指纹不符/);
    expect(deletes(records)).toEqual([]);
  });

  it('R25-01 C04：组织与对应保留账号并存时正常清理组织/成员，账号留给相邻 owner', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const owned = createOwnedResourceLedger();
    recordOwnedResource(owned, 'organization', 101);
    const { dataSource, records } = createFakeTransactionalDataSource({
      respond: (sql) => {
        if (/FROM organization\b[\s\S]*WHERE id IN/i.test(sql)) return [{ id: 101 }];
        if (/FROM organization_membership\b/i.test(sql)) {
          return [{ id: 800, organization_id: 101, account_id: 900 }];
        }
        if (/FROM base_user_account a\b/i.test(sql)) return [retainedAccountRow()];
        return undefined;
      },
    });

    await expect(
      runGuardedSpecCleanup({
        dataSource,
        helper: 'R25-01 C04',
        owned,
        retainedAccounts: [retainedFingerprint],
      }),
    ).resolves.toBeUndefined();

    expect(emptyConditionSql(records)).toEqual([]);
    expect(
      records.some(
        (record) =>
          /FROM content_submission\b/i.test(record.sql) &&
          /owner_organization_id IN/i.test(record.sql),
      ),
    ).toBe(true);
    const statements = deletes(records).map((record) => record.sql);
    expect(statements).toContain('DELETE FROM organization_membership WHERE id IN (?)');
    expect(statements).toContain('DELETE FROM organization WHERE id IN (?)');
    expect(statements.some((sql) => /DELETE FROM base_user_account/i.test(sql))).toBe(false);
  });

  it('R25-01 C09：无组织/账号但账本含可独立核验资源时，其余图收集仍执行', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const owned = createOwnedResourceLedger();
    recordOwnedResource(owned, 'equipmentModel', 700);
    const { dataSource, records } = createFakeTransactionalDataSource({
      respond: (sql) => {
        if (/FROM equipment_model\b[\s\S]*WHERE id IN/i.test(sql)) return [{ id: 700 }];
        if (/FROM base_user_account a\b/i.test(sql)) return [retainedAccountRow()];
        return undefined;
      },
    });

    await expect(
      runGuardedSpecCleanup({
        dataSource,
        helper: 'R25-01 C09',
        owned,
        retainedAccounts: [retainedFingerprint],
      }),
    ).resolves.toBeUndefined();

    expect(emptyConditionSql(records)).toEqual([]);
    expect(
      records.some(
        (record) =>
          record.kind === 'select' && /FROM equipment_model\b[\s\S]*WHERE id IN/i.test(record.sql),
      ),
    ).toBe(true);
    expect(deletes(records).map((record) => record.sql)).toContain(
      'DELETE FROM equipment_model WHERE id IN (?)',
    );
    // 根行锁发生在 collectOwnedGraph 前半段，不能证明后半段引用闭包执行过。
    const closureQueries = records.filter((record) =>
      /WHERE equipment_model_id IN/i.test(record.sql),
    );
    expect(closureQueries).toHaveLength(4);
    for (const record of closureQueries) {
      expect(record.params).toEqual([700]);
    }
    expect(closureQueries.map((record) => record.sql.match(/FROM (\w+)/i)?.[1])).toEqual([
      'material_submission_detail',
      'fault_case_submission_detail',
      'reference_document',
      'repair_request',
    ]);
  });

  it('R25-01 C09B：retained-only 加机型遇到外部业务引用时拒绝，DELETE=0', async () => {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    const owned = createOwnedResourceLedger();
    recordOwnedResource(owned, 'equipmentModel', 700);
    const { dataSource, records } = createFakeTransactionalDataSource({
      respond: (sql) => {
        if (/FROM equipment_model\b[\s\S]*WHERE id IN/i.test(sql)) return [{ id: 700 }];
        if (/FROM base_user_account a\b/i.test(sql)) return [retainedAccountRow()];
        if (/FROM repair_request WHERE equipment_model_id IN/i.test(sql)) return [{ id: 701 }];
        return undefined;
      },
    });

    await expect(
      runGuardedSpecCleanup({
        dataSource,
        helper: 'R25-01 C09B',
        owned,
        retainedAccounts: [retainedFingerprint],
      }),
    ).rejects.toThrow(/repair_request.equipment_model_id.*范围外记录引用了本轮机型/);
    expect(emptyConditionSql(records)).toEqual([]);
    expect(deletes(records)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// C 部分：真实隔离库验收（lithography_e2e）
// ---------------------------------------------------------------------------------------

const SCOPECLEAN = {
  keepOrganizationCode: 'E2E_SCOPECLEAN_KEEP_PRIMARY',
  mineOrganizationCode: 'E2E_SCOPECLEAN_MINE_PRIMARY',
  keepLoginName: 'e2escopecleankeep',
  mineLoginName: 'e2escopecleanmine',
  keepDocumentTitle: 'E2E-SCOPECLEAN-KEEP-DOC（异主资料，任何路径均不得删除）',
  mineDocumentTitle: 'E2E-SCOPECLEAN-MINE-DOC（本规格目标资料）',
} as const;

const KEEP_ACCOUNT: TestAccountConfig = {
  loginName: SCOPECLEAN.keepLoginName,
  loginEmail: 'scope.clean.keep@example.com',
  loginPassword: 'ScopeCleanKeep@2024',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  identityType: IdentityTypeEnum.ENGINEER,
};

const MINE_ACCOUNT: TestAccountConfig = {
  loginName: SCOPECLEAN.mineLoginName,
  loginEmail: 'scope.clean.mine@example.com',
  loginPassword: 'ScopeCleanMine@2024',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  identityType: IdentityTypeEnum.ENGINEER,
};

const SNAPSHOT_KEYS = ['organization', 'membership', 'account', 'userInfo', 'document'] as const;

type ScopecleanSnapshot = Record<(typeof SNAPSHOT_KEYS)[number], unknown>;

type ScopecleanIds = {
  readonly organizationId: number;
  readonly accountId: number;
  readonly membershipId: number;
  readonly documentId: number;
};

/** 按组织编码/登录名/资料标题读取夹具五行；缺失即 null（用同一真源覆盖正反两类断言） */
const readScopecleanSnapshot = async (params: {
  readonly dataSource: DataSource;
  readonly organizationCode: string;
  readonly loginName: string;
  readonly documentTitle: string;
}): Promise<ScopecleanSnapshot> => {
  const { dataSource, organizationCode, loginName, documentTitle } = params;
  const organization = await dataSource
    .getRepository(OrganizationEntity)
    .findOne({ where: { organizationCode } });
  const account = await dataSource.getRepository(AccountEntity).findOne({ where: { loginName } });
  const membership =
    organization && account
      ? await dataSource
          .getRepository(OrganizationMembershipEntity)
          .findOne({ where: { organizationId: organization.id, accountId: account.id } })
      : null;
  const userInfo = account
    ? await dataSource.getRepository(UserInfoEntity).findOne({ where: { accountId: account.id } })
    : null;
  const document = await dataSource
    .getRepository(ReferenceDocumentEntity)
    .findOne({ where: { title: documentTitle } });
  return { organization, membership, account, userInfo, document };
};

/** 按首次快照捕获的固定 ID 读取（第二次读取不受删除影响，无法用条件回落掩盖残留行） */
const readSnapshotByIds = async (
  dataSource: DataSource,
  ids: ScopecleanIds,
): Promise<ScopecleanSnapshot> => ({
  organization: await dataSource
    .getRepository(OrganizationEntity)
    .findOne({ where: { id: ids.organizationId } }),
  membership: await dataSource
    .getRepository(OrganizationMembershipEntity)
    .findOne({ where: { id: ids.membershipId } }),
  account: await dataSource.getRepository(AccountEntity).findOne({ where: { id: ids.accountId } }),
  userInfo: await dataSource
    .getRepository(UserInfoEntity)
    .findOne({ where: { accountId: ids.accountId } }),
  document: await dataSource
    .getRepository(ReferenceDocumentEntity)
    .findOne({ where: { id: ids.documentId } }),
});

const assertScopecleanFixtureComplete = (label: string, snapshot: ScopecleanSnapshot): void => {
  const missing = SNAPSHOT_KEYS.filter(
    (key) => snapshot[key] === null || snapshot[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `S8 G4 验收夹具初始化失败：${label} 缺失 ${missing.join('、')}，拒绝在不完整状态下继续`,
    );
  }
};

const requireScopecleanIds = (label: string, snapshot: ScopecleanSnapshot): ScopecleanIds => {
  assertScopecleanFixtureComplete(label, snapshot);
  return {
    organizationId: (snapshot.organization as { id: number }).id,
    accountId: (snapshot.account as { id: number }).id,
    membershipId: (snapshot.membership as { id: number }).id,
    documentId: (snapshot.document as { id: number }).id,
  };
};

/** 组织夹具规格：建立与残留核验共用同一指纹，避免两处漂移 */
const scopecleanOrganizationSpec = (organizationCode: string) => ({
  organizationCode,
  name: `S8 G4 验收组织 ${organizationCode}`,
  kind: 'CLIENT' as const,
});

/** 组织按编码幂等建立/复用（只建立传入编码，不触碰其他组织） */
const ensureScopecleanOrganization = async (
  dataSource: DataSource,
  organizationCode: string,
  ownership?: OwnedResourceLedger,
): Promise<number> => {
  const idsByCode = await seedTestOrganizations({
    dataSource,
    organizations: [scopecleanOrganizationSpec(organizationCode)],
    ownership,
  });
  return requireOrganizationId(idsByCode, organizationCode);
};

/** 账号按登录名幂等建立/复用（存在残留则复用其主键，不重复穿越唯一键） */
const ensureScopecleanAccount = async (params: {
  readonly dataSource: DataSource;
  readonly createAccountUsecase: CreateAccountUsecase;
  readonly config: TestAccountConfig;
  readonly ownership?: OwnedResourceLedger;
}): Promise<number> => {
  const { dataSource, createAccountUsecase, config, ownership } = params;
  const existing = await dataSource
    .getRepository(AccountEntity)
    .findOne({ where: { loginName: config.loginName } });
  if (existing) {
    if (ownership) {
      recordOwnedResource(ownership, 'account', existing.id);
    }
    return existing.id;
  }
  const { accountId } = await createTestAccount(dataSource, createAccountUsecase, config);
  if (ownership) {
    recordOwnedResource(ownership, 'account', accountId);
  }
  return accountId;
};

/** 资料按标题幂等建立/复用（数据来源为 ADMIN_DIRECT，显式满足内容来源检查） */
const ensureScopecleanDocument = async (params: {
  readonly dataSource: DataSource;
  readonly title: string;
  readonly ownerOrganizationId: number;
  readonly createdByAccountId: number;
  readonly ownership?: OwnedResourceLedger;
}): Promise<number> => {
  const { dataSource, title, ownerOrganizationId, createdByAccountId, ownership } = params;
  const repository = dataSource.getRepository(ReferenceDocumentEntity);
  const existing = await repository.findOne({ where: { title } });
  if (existing) {
    if (ownership) {
      recordOwnedResource(ownership, 'document', existing.id);
    }
    return existing.id;
  }
  const saved = await repository.save(
    repository.create({
      title,
      documentType: 'E2E_SCOPECLEAN',
      contentText: `# ${title}`,
      createdByAccountId,
      ownerOrganizationId,
      ingestMethod: 'ADMIN_DIRECT',
    }),
  );
  if (ownership) {
    recordOwnedResource(ownership, 'document', saved.id);
  }
  return saved.id;
};

/** 建立（或复用）一条完整的组织+账号+成员+资料夹具；成员关系缺失即失败关闭 */
const ensureScopecleanFixture = async (params: {
  readonly dataSource: DataSource;
  readonly createAccountUsecase: CreateAccountUsecase;
  readonly organizationCode: string;
  readonly accountConfig: TestAccountConfig;
  readonly documentTitle: string;
  readonly ownership?: OwnedResourceLedger;
}): Promise<void> => {
  const {
    dataSource,
    createAccountUsecase,
    organizationCode,
    accountConfig,
    documentTitle,
    ownership,
  } = params;
  const organizationId = await ensureScopecleanOrganization(
    dataSource,
    organizationCode,
    ownership,
  );
  const accountId = await ensureScopecleanAccount({
    dataSource,
    createAccountUsecase,
    config: accountConfig,
    ownership,
  });
  await seedTestMemberships({
    dataSource,
    memberships: [
      {
        accountLoginName: accountConfig.loginName,
        organizationCode,
        memberRole: 'ENGINEER',
      },
    ],
    organizationIdsByCode: new Map([[organizationCode, organizationId]]),
    ownership,
  });
  await ensureScopecleanDocument({
    dataSource,
    title: documentTitle,
    ownerOrganizationId: organizationId,
    createdByAccountId: accountId,
    ownership,
  });
};

describe('窄清理真实隔离库验收：异主不变 / 门禁拒绝 / 异常结束必红（lithography_e2e）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  /** 异主（KEEP）夹具：初始化后在整个规格生命周期内均不得被本规格的目标清理触碰 */
  let keepIds: ScopecleanIds;
  let baselineKeepSnapshot: ScopecleanSnapshot;
  /** 整个规格登记的 real ID（KEEP + 各用例 MINE），afterAll 只按这些精确 ID 收尾 */
  const suiteOwnership = createOwnedResourceLedger();
  /** 当前用例的 MINE 台账：正常/门禁拒绝/异常用例都只针对本轮资源 */
  let mineOwnership: OwnedResourceLedger = createOwnedResourceLedger();
  const originalEnv = { ...process.env };

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
    // 目标库硬性校验：任何造数/删除之前先确认实际连接库属于 E2E 白名单
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    createAccountUsecase = app.get(CreateAccountUsecase);

    // 预放异主夹具并取其基线快照（初始化后不变的第一条证据）；真实 ID 登记进本轮台账
    await ensureScopecleanFixture({
      dataSource,
      createAccountUsecase,
      organizationCode: SCOPECLEAN.keepOrganizationCode,
      accountConfig: KEEP_ACCOUNT,
      documentTitle: SCOPECLEAN.keepDocumentTitle,
      ownership: suiteOwnership,
    });
    baselineKeepSnapshot = await readScopecleanSnapshot({
      dataSource,
      organizationCode: SCOPECLEAN.keepOrganizationCode,
      loginName: SCOPECLEAN.keepLoginName,
      documentTitle: SCOPECLEAN.keepDocumentTitle,
    });
    // 基线必须完整：任何一项缺失即初始化失败，直接阻断状态不明的后续测试
    keepIds = requireScopecleanIds('KEEP', baselineKeepSnapshot);
  });

  beforeEach(async () => {
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    // 上一轮中断可能残留同指纹目标：只按完整指纹回收既定残留，不接管异主行
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [scopecleanOrganizationSpec(SCOPECLEAN.mineOrganizationCode)],
        accounts: [toResidueAccountFingerprint(MINE_ACCOUNT)],
      },
      helper: 'e2e-scoped-cleanup.e2e-spec beforeEach 回收目标残留',
    });
    // 目标（MINE）夹具每个用例重新确保，并以本轮 created/reused ID 表达归属
    mineOwnership = createOwnedResourceLedger();
    await ensureScopecleanFixture({
      dataSource,
      createAccountUsecase,
      organizationCode: SCOPECLEAN.mineOrganizationCode,
      accountConfig: MINE_ACCOUNT,
      documentTitle: SCOPECLEAN.mineDocumentTitle,
      ownership: mineOwnership,
    });
    // 同一批真实 ID 也并入规格台账，供 afterAll 兜底收尾
    for (const key of Object.keys(suiteOwnership) as Array<keyof OwnedResourceLedger>) {
      for (const id of mineOwnership[key]) {
        if (!suiteOwnership[key].includes(id)) {
          suiteOwnership[key].push(id);
        }
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (dataSource?.isInitialized) {
          // 本规格自己的收尾同样走窄范围路径：只删除本轮登记过的精确 ID
          await runGuardedSpecCleanup({
            dataSource,
            owned: suiteOwnership,
            helper: 'e2e-scoped-cleanup.e2e-spec afterAll 收尾',
          });
        }
      },
      closeApp: app
        ? async () => {
            await app.close();
          }
        : null,
    });
  });

  it('正常结束：只清理本规格目标；异主组织/成员/账号/资料原样保留', async () => {
    const mineBefore = await readScopecleanSnapshot({
      dataSource,
      organizationCode: SCOPECLEAN.mineOrganizationCode,
      loginName: SCOPECLEAN.mineLoginName,
      documentTitle: SCOPECLEAN.mineDocumentTitle,
    });
    const mineIds = requireScopecleanIds('MINE', mineBefore);

    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    try {
      await runGuardedSpecCleanup({
        dataSource,
        owned: mineOwnership,
        helper: 'scopeclean 验收：正常结束',
      });
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
    }

    // 目标五行（按清理前捕获的固定 ID 复查，无法被“条件回落”掩盖残留）全部消失
    expect(await readSnapshotByIds(dataSource, mineIds)).toEqual({
      organization: null,
      membership: null,
      account: null,
      userInfo: null,
      document: null,
    });
    // 异主数据逐字段与基线一致
    expect(await readSnapshotByIds(dataSource, keepIds)).toEqual(baselineKeepSnapshot);
  });

  it('缺许可：第一条删除语句之前拒绝，目标与异主数据均逐字段不变', async () => {
    const mineBefore = await readScopecleanSnapshot({
      dataSource,
      organizationCode: SCOPECLEAN.mineOrganizationCode,
      loginName: SCOPECLEAN.mineLoginName,
      documentTitle: SCOPECLEAN.mineDocumentTitle,
    });
    const mineIds = requireScopecleanIds('MINE', mineBefore);

    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    try {
      await expect(
        runGuardedSpecCleanup({
          dataSource,
          owned: mineOwnership,
          helper: 'scopeclean 验收：缺许可',
        }),
      ).rejects.toThrow(/阶段=清理许可门禁[\s\S]*E2E_ALLOW_PHYSICAL_CLEANUP=1/);
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
    }

    // 不是“删到一半才发现缺许可”：目标五行逐字段与拒绝前一致
    expect(await readSnapshotByIds(dataSource, mineIds)).toEqual(mineBefore);
    expect(await readSnapshotByIds(dataSource, keepIds)).toEqual(baselineKeepSnapshot);
  });

  it('目标库白名单不符：第一条删除语句之前拒绝，目标与异主数据均逐字段不变', async () => {
    const mineBefore = await readScopecleanSnapshot({
      dataSource,
      organizationCode: SCOPECLEAN.mineOrganizationCode,
      loginName: SCOPECLEAN.mineLoginName,
      documentTitle: SCOPECLEAN.mineDocumentTitle,
    });
    const mineIds = requireScopecleanIds('MINE', mineBefore);

    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    const allowedOriginal = captureEnvValue('E2E_ALLOWED_DB_NAMES');
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'lithography_drill';
    try {
      await expect(
        runGuardedSpecCleanup({
          dataSource,
          owned: mineOwnership,
          helper: 'scopeclean 验收：目标错误',
        }),
      ).rejects.toThrow(/不在允许的 E2E 库白名单/);
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
      restoreEnvValue('E2E_ALLOWED_DB_NAMES', allowedOriginal);
    }

    // 全局 setup 已确认库名不能替代本次删除前的独立校验；拒绝同样发生在第一条删除之前
    expect(await readSnapshotByIds(dataSource, mineIds)).toEqual(mineBefore);
    expect(await readSnapshotByIds(dataSource, keepIds)).toEqual(baselineKeepSnapshot);
  });

  it('异常结束：注入清理失败经 runE2eTeardown 必红传播（finalize/closeApp 仍执行），目标与异主数据不变', async () => {
    const mineBefore = await readScopecleanSnapshot({
      dataSource,
      organizationCode: SCOPECLEAN.mineOrganizationCode,
      loginName: SCOPECLEAN.mineLoginName,
      documentTitle: SCOPECLEAN.mineDocumentTitle,
    });
    const mineIds = requireScopecleanIds('MINE', mineBefore);

    const calls: string[] = [];
    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    try {
      // 测试侧 Proxy：门禁仍读真实库名，事务入口失败即模拟清理中断（不在 src 加钩子）
      const failingDataSource = new Proxy(dataSource, {
        get: (target, property, receiver) => {
          if (property === 'transaction') {
            return () => Promise.reject(new Error('模拟注入的专属资源清理失败'));
          }
          return Reflect.get(target, property, receiver);
        },
      });

      await expect(
        runE2eTeardown({
          cleanup: async () => {
            calls.push('cleanup');
            await runGuardedSpecCleanup({
              dataSource: failingDataSource,
              owned: mineOwnership,
              helper: 'scopeclean 验收：异常结束',
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
      ).rejects.toThrow('模拟注入的专属资源清理失败');
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
    }

    // 错误已向 jest 传播：真实规格 afterAll 中发生同样情况时规格确实失败，不会 console.error 后仍绿色
    expect(calls).toEqual(['cleanup', 'finalize', 'closeApp']);
    // 清理在事务入口即失败：目标与异主数据均逐字段不变
    expect(await readSnapshotByIds(dataSource, mineIds)).toEqual(mineBefore);
    expect(await readSnapshotByIds(dataSource, keepIds)).toEqual(baselineKeepSnapshot);
  });
});
