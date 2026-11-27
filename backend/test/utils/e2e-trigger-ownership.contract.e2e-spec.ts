// test/utils/e2e-trigger-ownership.contract.spec.ts

/**
 * e2e-trigger-ownership 共享 helper 的隔离契约回归。
 * 用替身 DataSource 只执行 helper 的真实 CREATE/回读/DISPOSE 路径，不触碰任何数据库；
 * 显式覆盖默认 BEFORE DELETE、AFTER INSERT、回读失败、同名替换与重复收尾。
 */

import type { DataSource } from 'typeorm';

import {
  createOwnedTrigger,
  createTriggerOwnershipTracker,
  disposeOwnedTriggerRecord,
} from './e2e-trigger-ownership';

const DATABASE = 'lithography_task09_trigger_contract_test';

const BODY_BEFORE = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'contract before'";
const BODY_AFTER = 'INSERT INTO task09_probe (receipt_id) VALUES (NEW.receipt_id)';

type StubOptions = {
  readonly metadataResponses: readonly unknown[];
  readonly dropFails?: boolean;
};

const createStub = (options: StubOptions): { dataSource: DataSource; calls: string[] } => {
  const calls: string[] = [];
  let index = 0;
  const dataSource = {
    options: { database: DATABASE },
    query: (sql: string): Promise<unknown> => {
      calls.push(sql);
      if (sql.startsWith('SELECT DATABASE()')) {
        return Promise.resolve([{ current_database: DATABASE }]);
      }
      if (sql.includes('information_schema.TRIGGERS')) {
        const response = options.metadataResponses[index];
        index += 1;
        if (response instanceof Error) return Promise.reject(response);
        return Promise.resolve(response ?? []);
      }
      if (sql.startsWith('DROP TRIGGER')) {
        return options.dropFails === true
          ? Promise.reject(new Error('注入故障：触发器 DROP 失败'))
          : Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
  } as unknown as DataSource;
  return { dataSource, calls };
};

const fact = (
  name: string,
  tableName: string,
  definition: string,
  timing: 'BEFORE' | 'AFTER' = 'BEFORE',
  event: 'DELETE' | 'INSERT' = 'DELETE',
) => ({ name, tableName, timing, event, definition });

describe('e2e-trigger-ownership 共享 helper 契约替身回归', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['E2E_ALLOWED_DB_NAMES', 'E2E_REAL_DB_NAME', 'E2E_ALLOW_PHYSICAL_CLEANUP'];

  beforeAll(() => {
    for (const key of keys) saved[key] = process.env[key];
    process.env.E2E_ALLOWED_DB_NAMES = DATABASE;
    process.env.E2E_REAL_DB_NAME = DATABASE;
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
  });

  afterAll(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('默认 BEFORE DELETE：创建/回读/收尾均使用既有语义', async () => {
    const name = 'contract_before_delete';
    const tracker = createTriggerOwnershipTracker();
    const stub = createStub({
      metadataResponses: [[], [fact(name, 'base_user_info', BODY_BEFORE)]],
    });
    await createOwnedTrigger({
      dataSource: stub.dataSource,
      name,
      tableName: 'base_user_info',
      body: BODY_BEFORE,
      tracker,
    });
    expect(stub.calls.some((sql) => sql.includes('BEFORE DELETE ON'))).toBe(true);
    await disposeOwnedTriggerRecord(stub.dataSource, tracker.remaining()[0], tracker);
    expect(stub.calls.filter((sql) => sql.startsWith('DROP TRIGGER'))).toHaveLength(1);
    expect(tracker.remaining()).toEqual([]);
  });

  it('AFTER INSERT：SQL、回读事实与收尾核验包含 timing/event', async () => {
    const name = 'contract_after_insert';
    const tracker = createTriggerOwnershipTracker();
    const stub = createStub({
      metadataResponses: [
        [],
        [fact(name, 'sync_receipt', BODY_AFTER, 'AFTER', 'INSERT')],
        [fact(name, 'sync_receipt', BODY_AFTER, 'AFTER', 'INSERT')],
      ],
    });
    await createOwnedTrigger({
      dataSource: stub.dataSource,
      name,
      tableName: 'sync_receipt',
      body: BODY_AFTER,
      timing: 'AFTER',
      event: 'INSERT',
      tracker,
    });
    expect(stub.calls.some((sql) => sql.includes('AFTER INSERT ON'))).toBe(true);
    await disposeOwnedTriggerRecord(stub.dataSource, tracker.remaining()[0], tracker);
    expect(stub.calls.filter((sql) => sql.startsWith('DROP TRIGGER'))).toHaveLength(1);
  });

  it('创建后回读失败：保留待核验登记，恢复后仍按登记事实收尾', async () => {
    const name = 'contract_readback_fail';
    const tracker = createTriggerOwnershipTracker();
    const createStubInstance = createStub({
      metadataResponses: [[], new Error('注入回读失败')],
    });
    await expect(
      createOwnedTrigger({
        dataSource: createStubInstance.dataSource,
        name,
        tableName: 'base_user_info',
        body: BODY_BEFORE,
        tracker,
      }),
    ).rejects.toThrow('注入回读失败');
    expect(tracker.remaining().map((record) => record.name)).toEqual([name]);
    expect(tracker.records()[0].fact).toBeNull();

    const disposeStub = createStub({
      metadataResponses: [[fact(name, 'base_user_info', BODY_BEFORE)]],
    });
    await disposeOwnedTriggerRecord(disposeStub.dataSource, tracker.remaining()[0], tracker);
    expect(disposeStub.calls.some((sql) => sql.startsWith('DROP TRIGGER'))).toBe(true);
  });

  it('同名替换：timing/event 相同但定义不同也拒绝 DROP，且保留待收尾记录', async () => {
    const name = 'contract_replaced';
    const tracker = createTriggerOwnershipTracker();
    await expect(
      createOwnedTrigger({
        dataSource: createStub({ metadataResponses: [[], new Error('注入回读失败')] }).dataSource,
        name,
        tableName: 'base_user_info',
        body: BODY_BEFORE,
        tracker,
      }),
    ).rejects.toThrow('注入回读失败');

    const stub = createStub({
      metadataResponses: [
        [fact(name, 'base_user_info', "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'replaced'")],
      ],
    });
    await expect(
      disposeOwnedTriggerRecord(stub.dataSource, tracker.remaining()[0], tracker),
    ).rejects.toThrow(/归属校验/);
    expect(stub.calls.some((sql) => sql.startsWith('DROP TRIGGER'))).toBe(false);
    expect(tracker.remaining().map((record) => record.name)).toEqual([name]);
  });

  it('重复收尾：第二次在 DROP 前拒绝，不重复删除', async () => {
    const name = 'contract_repeat_dispose';
    const tracker = createTriggerOwnershipTracker();
    const stub = createStub({
      metadataResponses: [[], [fact(name, 'base_user_info', BODY_BEFORE)]],
    });
    await createOwnedTrigger({
      dataSource: stub.dataSource,
      name,
      tableName: 'base_user_info',
      body: BODY_BEFORE,
      tracker,
    });
    const record = tracker.remaining()[0];
    await disposeOwnedTriggerRecord(stub.dataSource, record, tracker);
    await expect(disposeOwnedTriggerRecord(stub.dataSource, record, tracker)).rejects.toThrow(
      /归属校验|不在本轮待收尾台账/,
    );
    expect(stub.calls.filter((sql) => sql.startsWith('DROP TRIGGER'))).toHaveLength(1);
  });
});
