// test/utils/owned-ledger-lifecycle.ts
//
// R04（登记台账生命周期）的共享实现：
// - 清理失败时保留台账与失败状态，下一用例失败关闭，禁止继续无保护造数；
// - 只有清理成功提交后才允许重置台账；
// - afterAll 使用同一保留台账做诊断与兜底回收。
//
// 实际规格（register.e2e-spec）与永久反例（cleanup-faults 子规格）必须调用同一实现，
// 不允许各自复制一份“测试专用正确算法”。

import type { DataSource } from 'typeorm';

import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from './e2e-scoped-cleanup';

export interface OwnedLedgerLifecycle {
  /** 最近一次 afterEach 清理失败（成功后清空）。 */
  readonly cleanupFailure: Error | null;
  /** 诊断字符串：保留台账中的真实 ID 与最近失败原因。 */
  diagnose(): string;
  /** afterEach：成功才重置台账；失败保留并原样抛出。 */
  afterTestCleanup(): Promise<void>;
  /** beforeEach：上一用例清理失败时失败关闭。 */
  assertReadyForNextTest(): void;
  /** afterAll：用保留台账兜底回收（失败仍然向 jest 传播）。 */
  cleanupRetainedForAfterAll(): Promise<void>;
}

export interface OwnedLedgerLifecycleHooks {
  /** 失败消息前缀，标明所属规格。 */
  readonly helper: string;
  readonly getDataSource: () => DataSource | null | undefined;
  readonly getOwned: () => OwnedResourceLedger;
  /** 仅在清理成功后重置台账（由调用方替换自己的 ledger 变量）。 */
  readonly resetOwned: () => void;
}

const ownedIdsOf = (ledger: OwnedResourceLedger): string[] =>
  Object.entries(ledger)
    .filter(([key]) => key !== 'facts')
    .flatMap(([key, ids]) => (ids as number[]).map((id) => `${key}:${id}`));

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const createOwnedLedgerLifecycle = (
  hooks: OwnedLedgerLifecycleHooks,
): OwnedLedgerLifecycle => {
  let failure: Error | null = null;

  const succeed = (): void => {
    failure = null;
    hooks.resetOwned();
  };

  const retainedIds = (): string[] => ownedIdsOf(hooks.getOwned());

  /**
   * N03：连接不可用且台账非空/存在未决失败时，必须保留台账与事实、记录失败并抛出。
   * 只有“空台账且无未决失败”才允许无连接空操作（例如用例未造数或已显式回收）。
   */
  const unavailableFailure = (stage: string, detail: string): Error => {
    const ids = retainedIds();
    const previous = failure ? `；此前未决失败仍保留且不得被覆盖：${failure.message}` : '';
    const error = new Error(
      `[${hooks.helper}] 阶段=${stage} 连接不可用（${detail}），` +
        `但台账非空或存在未决失败（保留 ${ids.length === 0 ? '无 ID、失败未清' : ids.join(', ')}）${previous}；` +
        '拒绝静默成功：保留 ID 与预期事实、记录失败、不重置台账。',
      failure ? { cause: failure } : undefined,
    );
    failure = error;
    return error;
  };

  const readDataSource = (stage: string): DataSource | null => {
    try {
      return hooks.getDataSource() ?? null;
    } catch (error) {
      throw unavailableFailure(stage, `获取 DataSource 抛错：${toError(error).message}`);
    }
  };

  return {
    get cleanupFailure(): Error | null {
      return failure;
    },
    diagnose(): string {
      const ids = retainedIds();
      const retained = ids.length === 0 ? '无' : ids.join(', ');
      const reason = failure ? failure.message : '最近清理未失败';
      return `[${hooks.helper}] 台账保留（${retained}）；${reason}`;
    },
    async afterTestCleanup(): Promise<void> {
      const dataSource = readDataSource('afterEach 精确回收');
      if (!dataSource?.isInitialized) {
        if (retainedIds().length === 0 && !failure) {
          succeed();
          return;
        }
        throw unavailableFailure('afterEach 精确回收', 'DataSource 不存在或未初始化');
      }
      try {
        await runGuardedSpecCleanup({
          dataSource,
          owned: hooks.getOwned(),
          helper: `${hooks.helper} afterEach 精确回收`,
        });
      } catch (error) {
        // R04：清理失败时不得重置台账，旧 ID 仍可能留在库中。
        failure = toError(error);
        throw error;
      }
      succeed();
    },
    assertReadyForNextTest(): void {
      if (!failure) {
        return;
      }
      throw new Error(
        `上一用例清理失败，台账保留（${JSON.stringify(hooks.getOwned().accountIds)}）；` +
          `拒绝在未恢复前继续造数：${failure.message}`,
        { cause: failure },
      );
    },
    async cleanupRetainedForAfterAll(): Promise<void> {
      const dataSource = readDataSource('afterAll 兜底回收');
      if (!dataSource?.isInitialized) {
        if (retainedIds().length === 0 && !failure) {
          return;
        }
        throw unavailableFailure('afterAll 兜底回收', 'DataSource 不存在或未初始化');
      }
      try {
        await runGuardedSpecCleanup({
          dataSource,
          owned: hooks.getOwned(),
          helper: `${hooks.helper} afterAll 兜底回收`,
        });
      } catch (error) {
        failure = toError(error);
        throw error;
      }
      succeed();
    },
  };
};

/** 供子规格使用：新一轮初始台账。 */
export const createFreshOwnedLedger = (): OwnedResourceLedger => createOwnedResourceLedger();
