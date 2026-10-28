// test/utils/owned-ledger-lifecycle.e2e-spec.ts
//
// N03 / G09 / G10：归属台账 lifecycle 在连接不可用时的失败关闭语义。
//
// 不变量：
// - 空台账且无未决失败：允许无连接空操作；
// - 台账非空或存在未决失败 + 连接不可用：保留 ID/事实、记录失败、不 reset、抛错；
// - afterAll 兜底回收不可用不静默成功，资源（closeApp）仍必须关闭，且最早错误不被覆盖。

import type { DataSource, EntityManager } from 'typeorm';

import {
  createOwnedResourceLedger,
  recordOwnedResource,
  type OwnedResourceLedger,
} from './e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from './e2e-teardown';
import { createOwnedLedgerLifecycle, type OwnedLedgerLifecycle } from './owned-ledger-lifecycle';

type Harness = {
  readonly lifecycle: OwnedLedgerLifecycle;
  readonly ledger: () => OwnedResourceLedger;
  readonly resetCount: () => number;
  readonly setDataSource: (dataSource: DataSource | undefined | Error) => void;
};

const accountFacts = {
  loginName: 'n03_probe',
  loginEmail: 'n03.probe@example.com',
  status: 'ACTIVE',
  identityHint: 'CUSTOMER',
  accessGroup: ['CUSTOMER'],
  nickname: 'n03_probe_nickname',
  userInfoEmail: 'n03.probe@example.com',
  userState: 'ACTIVE',
} as const;

const createHarness = (initial: DataSource | undefined | Error): Harness => {
  let ledger = createOwnedResourceLedger();
  let current: DataSource | undefined | Error = initial;
  let resets = 0;
  const lifecycle = createOwnedLedgerLifecycle({
    helper: 'n03-lifecycle',
    getDataSource: () => {
      if (current instanceof Error) {
        throw current;
      }
      return current;
    },
    getOwned: () => ledger,
    resetOwned: () => {
      resets += 1;
      ledger = createOwnedResourceLedger();
    },
  });
  return {
    lifecycle,
    ledger: () => ledger,
    resetCount: () => resets,
    setDataSource: (dataSource) => {
      current = dataSource;
    },
  };
};

const seedOwnedAccount = (harness: Harness, id = 301): void => {
  recordOwnedResource(harness.ledger(), 'account', id, accountFacts);
};

describe('N03 归属台账 lifecycle 连接不可用语义', () => {
  it('G09 空台账且无未决失败：允许无连接空操作，不误报失败', async () => {
    const harness = createHarness(undefined);
    await expect(harness.lifecycle.afterTestCleanup()).resolves.toBeUndefined();
    expect(harness.lifecycle.cleanupFailure).toBeNull();
    expect(harness.ledger().accountIds).toEqual([]);

    await expect(harness.lifecycle.cleanupRetainedForAfterAll()).resolves.toBeUndefined();
  });

  it('G09b 非空台账 + DataSource 未初始化：保留 ID/事实、记录失败、不 reset、抛错', async () => {
    const unavailable = { isInitialized: false } as unknown as DataSource;
    const harness = createHarness(unavailable);
    seedOwnedAccount(harness);

    await expect(harness.lifecycle.afterTestCleanup()).rejects.toThrow(
      /阶段=afterEach 精确回收 连接不可用/,
    );
    expect(harness.resetCount()).toBe(0);
    expect(harness.ledger().accountIds).toEqual([301]);
    expect(harness.ledger().facts.account.get(301)).toEqual(accountFacts);
    expect(harness.lifecycle.cleanupFailure).toBeInstanceOf(Error);
    expect(harness.lifecycle.diagnose()).toContain('accountIds:301');
    expect(harness.lifecycle.diagnose()).toContain('拒绝静默成功');
    expect(() => harness.lifecycle.assertReadyForNextTest()).toThrow(/上一用例清理失败/);
  });

  it('G09c 非空台账 + 获取 DataSource 抛错：同样失败关闭并保留事实', async () => {
    const harness = createHarness(new Error('取连接失败'));
    seedOwnedAccount(harness, 302);

    await expect(harness.lifecycle.afterTestCleanup()).rejects.toThrow(
      /获取 DataSource 抛错：取连接失败/,
    );
    expect(harness.resetCount()).toBe(0);
    expect(harness.ledger().accountIds).toEqual([302]);
    expect(harness.ledger().facts.account.get(302)).toEqual(accountFacts);
    expect(harness.lifecycle.cleanupFailure?.message).toContain('取连接失败');
  });

  it('G10 afterAll 不可用不静默成功：资源仍关闭、最早错误为主因、台账保留', async () => {
    const unavailable = { isInitialized: false } as unknown as DataSource;
    const harness = createHarness(unavailable);
    seedOwnedAccount(harness, 303);

    const closeError = new Error('G10 closeApp 失败');
    let closed = false;
    let caught: unknown;
    try {
      await runE2eTeardown({
        cleanup: () => harness.lifecycle.cleanupRetainedForAfterAll(),
        closeApp: () => {
          closed = true;
          return Promise.reject(closeError);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(closed).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    const aggregate = caught as Error;
    expect(String((aggregate.cause as Error | undefined)?.message)).toMatch(
      /阶段=afterAll 兜底回收 连接不可用/,
    );
    expect(aggregate.message).toContain('阶段=afterAll 兜底回收 连接不可用');
    expect(aggregate.message).toContain(closeError.message);
    expect(harness.resetCount()).toBe(0);
    expect(harness.ledger().accountIds).toEqual([303]);
    expect(harness.ledger().facts.account.get(303)).toEqual(accountFacts);
  });

  it('G10b 再次不可用不覆盖此前失败：新错误保留原失败信息', async () => {
    const unavailable = { isInitialized: false } as unknown as DataSource;
    const harness = createHarness(unavailable);
    seedOwnedAccount(harness, 304);

    const first = await harness.lifecycle.afterTestCleanup().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    const firstMessage = (first as Error).message;

    const second = await harness.lifecycle
      .cleanupRetainedForAfterAll()
      .catch((error: unknown) => error);
    expect(second).toBeInstanceOf(Error);
    const secondError = second as Error;
    expect(secondError.message).toContain(firstMessage);
    expect(secondError.cause).toBe(first);
    expect(harness.ledger().accountIds).toEqual([304]);
    expect(harness.resetCount()).toBe(0);
  });

  it('G10c 正常连接下清理成功后 reset；回收失败时保留台账且不 reset', async () => {
    const injected = new Error('注入：DELETE 失败');
    let failDeletes = true;
    const manager: Pick<EntityManager, 'query'> = {
      query: ((sql: string) => {
        const normalized = sql.trim();
        if (/^SELECT\s+DATABASE\(\)/i.test(normalized)) {
          return Promise.resolve([{ current_database: 'lithography_e2e' }]);
        }
        if (/FROM base_user_account a\b/i.test(normalized)) {
          return Promise.resolve([
            {
              id: 305,
              login_name: accountFacts.loginName,
              login_email: accountFacts.loginEmail,
              status: accountFacts.status,
              identity_hint: accountFacts.identityHint,
              user_info_id: 305,
              nickname: accountFacts.nickname,
              user_info_email: accountFacts.userInfoEmail,
              access_group: accountFacts.accessGroup,
              meta_digest: null,
              user_state: accountFacts.userState,
            },
          ]);
        }
        if (/^DELETE\b/i.test(normalized)) {
          return failDeletes ? Promise.reject(injected) : Promise.resolve([]);
        }
        return Promise.resolve([]);
      }) as EntityManager['query'],
    };
    const dataSource = {
      isInitialized: true,
      options: { database: 'lithography_e2e' },
      query: (sql: string) => manager.query(sql),
      transaction: (run: (manager: EntityManager) => Promise<unknown>) =>
        run(manager as EntityManager),
    } as unknown as DataSource;
    const harness = createHarness(dataSource);
    seedOwnedAccount(harness, 305);

    const consentOriginal = captureEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP');
    const allowedOriginal = captureEnvValue('E2E_ALLOWED_DB_NAMES');
    try {
      process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
      process.env.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';

      await expect(harness.lifecycle.afterTestCleanup()).rejects.toThrow(/注入：DELETE 失败/);
      expect(harness.resetCount()).toBe(0);
      expect(harness.ledger().accountIds).toEqual([305]);
      expect(harness.lifecycle.cleanupFailure).toBe(injected);

      // N03 验收：明确恢复可用连接并安全清理成功后才允许重置台账、清除失败状态。
      failDeletes = false;
      await expect(harness.lifecycle.afterTestCleanup()).resolves.toBeUndefined();
      expect(harness.resetCount()).toBe(1);
      expect(harness.ledger().accountIds).toEqual([]);
      expect(harness.lifecycle.cleanupFailure).toBeNull();
      expect(harness.lifecycle.diagnose()).toContain('最近清理未失败');
    } finally {
      restoreEnvValue('E2E_ALLOW_PHYSICAL_CLEANUP', consentOriginal);
      restoreEnvValue('E2E_ALLOWED_DB_NAMES', allowedOriginal);
    }
  });
});
