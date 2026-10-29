// test/utils/e2e-owned-fixture.e2e-spec.ts
//
// 清理保护失败路径回归：
// 1. 拒绝路径、调用顺序、账本外目标与统一收尾用 SQL 替身（无需真实库）；
// 2. 事务回滚、引用保护、合法预期变更与正常清理在隔离 MySQL 中验证。

import { DataSource, type QueryRunner } from 'typeorm';
import { loadExplicitEnvConfig } from '../../src/infrastructure/database/incremental-migration';
import { assertPhysicalCleanupConsent } from './e2e-db-guard';
import {
  assertFixtureIdsAvailable,
  assertRegisteredRowsAbsent,
  type ControlledFixtureTable,
  finalizeFixtureTeardown,
  type OwnedFixtureRow,
  OwnedFixtureLedger,
  prepareFixtureSetup,
  type ReferenceGuard,
  runOwnedFixtureCleanup,
  runTeardownSteps,
} from './e2e-owned-fixture';

jest.setTimeout(180_000);

const ENV_FILE = 'env/.env.e2e';
const ROUND_TAG = 'OWNED-FIXTURE-P4';
const CONSENT_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
const ALLOWED_ENV = 'E2E_ALLOWED_DB_NAMES';

// ---------------------------------------------------------------------------
// SQL 替身：记录调用顺序与参数，模拟行快照、引用计数与删除失败
// ---------------------------------------------------------------------------

interface FakeRow {
  readonly table: string;
  readonly values: Record<string, unknown>;
}

interface FakeConfig {
  readonly configuredDatabase?: string;
  readonly actualDatabase?: string;
  readonly rows?: FakeRow[];
  readonly failDeleteTable?: string;
  readonly referenceTotal?: number;
}

interface FakeHarness {
  readonly dataSource: DataSource;
  readonly calls: string[];
  readonly deleteCalls: Array<{ sql: string; params: unknown[] }>;
  readonly setRow: (table: string, values: Record<string, unknown>) => void;
}

const CONDITION_PATTERN = /`([a-z0-9_]+)` = \?/g;

const parseConditionColumns = (clause: string): string[] =>
  [...clause.matchAll(CONDITION_PATTERN)]
    .map((match) => match[1])
    .filter((column): column is string => typeof column === 'string');

const matchesConditions = (
  row: FakeRow,
  columns: readonly string[],
  parameters: readonly unknown[],
): boolean => columns.every((column, index) => row.values[column] === parameters[index]);

const createFakeDataSource = (config: FakeConfig): FakeHarness => {
  const calls: string[] = [];
  const deleteCalls: Array<{ sql: string; params: unknown[] }> = [];
  const rows = config.rows ?? [];

  const findRows = (table: string, clause: string, parameters: readonly unknown[]): FakeRow[] => {
    const columns = parseConditionColumns(clause);
    return rows.filter((row) => row.table === table && matchesConditions(row, columns, parameters));
  };

  const handler = (sql: string, parameters?: unknown[]): unknown => {
    const text = sql.trim().replace(/\s+/g, ' ');
    const params = parameters ?? [];
    calls.push(text);

    if (text.includes('SELECT DATABASE()')) {
      return [
        {
          current_database: config.actualDatabase ?? config.configuredDatabase ?? 'lithography_e2e',
        },
      ];
    }
    const available = /^SELECT id FROM `([a-z0-9_]+)` WHERE id IN \((.*)\)$/.exec(text);
    if (available) {
      const ids = params.map(Number);
      return rows
        .filter((row) => row.table === available[1] && ids.includes(Number(row.values.id)))
        .map((row) => ({ id: Number(row.values.id) }));
    }
    const selectAll =
      /^SELECT \* FROM `([a-z0-9_]+)` WHERE (.+?) FOR UPDATE$/.exec(text) ??
      /^SELECT \* FROM `([a-z0-9_]+)` WHERE (.+?) LIMIT 1$/.exec(text);
    if (selectAll) {
      const matched = findRows(selectAll[1], selectAll[2], params)[0];
      return matched ? [{ ...matched.values }] : [];
    }
    const reread = /^SELECT ((?!\*)[^,]+(?:, [^,]+)*) FROM `([a-z0-9_]+)` WHERE (.+) LIMIT 1$/.exec(
      text,
    );
    if (reread) {
      const matched = findRows(reread[2], reread[3], params)[0];
      if (!matched) return [];
      const columns = [...reread[1].matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1]);
      const projected: Record<string, unknown> = {};
      for (const column of columns) {
        projected[column] = matched.values[column];
      }
      return [projected];
    }
    const remove = /^DELETE FROM `([a-z0-9_]+)` WHERE (.+)$/.exec(text);
    if (remove) {
      if (config.failDeleteTable === remove[1]) {
        throw new Error(`注入故障：删除 ${remove[1]} 失败`);
      }
      deleteCalls.push({ sql: text, params: [...params] });
      return { affectedRows: findRows(remove[1], remove[2], params).length };
    }
    const count = /^SELECT COUNT\(\*\) AS total FROM `([a-z0-9_]+)` WHERE (.+)$/.exec(text);
    if (count) {
      if (text.includes(' IN (')) {
        return [{ total: config.referenceTotal ?? 0 }];
      }
      return [{ total: findRows(count[1], count[2], params).length }];
    }
    return [];
  };

  let transactionActive = false;
  const runner = {
    manager: { query: handler },
    connect: (): Promise<void> => Promise.resolve(),
    startTransaction: (): Promise<void> => {
      transactionActive = true;
      calls.push('START TRANSACTION');
      return Promise.resolve();
    },
    commitTransaction: (): Promise<void> => {
      transactionActive = false;
      calls.push('COMMIT');
      return Promise.resolve();
    },
    rollbackTransaction: (): Promise<void> => {
      transactionActive = false;
      calls.push('ROLLBACK');
      return Promise.resolve();
    },
    release: (): Promise<void> => {
      calls.push('RELEASE');
      return Promise.resolve();
    },
    get isTransactionActive(): boolean {
      return transactionActive;
    },
  };

  const setRow = (table: string, values: Record<string, unknown>): void => {
    const index = rows.findIndex((row) => row.table === table && row.values.id === values.id);
    if (index >= 0) {
      rows[index] = { table, values: { ...values } };
    } else {
      rows.push({ table, values: { ...values } });
    }
  };

  const dataSource = {
    options: { database: config.configuredDatabase ?? 'lithography_e2e' },
    query: handler,
    createQueryRunner: (): QueryRunner => runner as unknown as QueryRunner,
  } as unknown as DataSource;

  return { dataSource, calls, deleteCalls, setRow };
};

const fixtureRow = (
  table: ControlledFixtureTable,
  keyValue: number | Record<string, number>,
  values: Record<string, unknown>,
): OwnedFixtureRow => {
  const key = typeof keyValue === 'number' ? { id: keyValue } : keyValue;
  return { table, key, expected: { ...key, ...values } };
};

const singleRow = (
  table: ControlledFixtureTable,
  id: number,
  values: Record<string, unknown>,
): OwnedFixtureRow => fixtureRow(table, id, values);

// ---------------------------------------------------------------------------
// 真实 MySQL 夹具
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 9904991;
const SENTINEL_MODEL_ID = 9904993;

describe('自有夹具登记与受保护清理（失败路径回归）', () => {
  let dataSource: DataSource;
  let database = '';
  let setupAllowed = false;
  let consentOriginal: string | undefined;
  const master = new OwnedFixtureLedger(ROUND_TAG);

  const query = async <T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> => dataSource.query(sql, parameters);

  const register = async (table: ControlledFixtureTable, id: number): Promise<void> => {
    await master.registerById(query, table, id);
  };

  const rowsOf = (ids: readonly number[]): OwnedFixtureRow[] =>
    master.list().filter((row) => ids.includes(Number(row.key.id)));

  const cleanup = async (ids: readonly number[], guards: ReferenceGuard[] = []): Promise<void> => {
    await runOwnedFixtureCleanup({
      dataSource,
      expectedDatabase: database,
      rows: rowsOf(ids),
      referenceGuards: guards,
    });
  };

  const rowExists = async (row: OwnedFixtureRow): Promise<boolean> => {
    const columns = Object.keys(row.key);
    const conditions = columns.map((column) => `\`${column}\` = ?`).join(' AND ');
    const result = await query<{ total: number | string }>(
      `SELECT COUNT(*) AS total FROM \`${row.table}\` WHERE ${conditions}`,
      columns.map((column) => row.key[column]),
    );
    return Number(result[0]?.total ?? 0) > 0;
  };

  beforeAll(async () => {
    consentOriginal = process.env[CONSENT_ENV];
    assertPhysicalCleanupConsent();
    const config = loadExplicitEnvConfig(ENV_FILE, 'lithography_e2e');
    dataSource = new DataSource({
      type: 'mysql',
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      timezone: config.timezone,
      charset: config.charset,
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    const gate = await prepareFixtureSetup(dataSource, ROUND_TAG, config.database);
    database = gate.database;
    setupAllowed = true;

    // 保活资源：本轮清理不得触及，用于验证「其他数据不变」
    await assertFixtureIdsAvailable(dataSource, 'base_user_account', [ACCOUNT_ID], ROUND_TAG);
    await assertFixtureIdsAvailable(dataSource, 'equipment_model', [SENTINEL_MODEL_ID], ROUND_TAG);
    await query(
      `INSERT INTO base_user_account (id, login_name, login_password, status)
       VALUES (${ACCOUNT_ID}, 'p4_owned_fixture_9904991', 'p4-fixture', 'ACTIVE')`,
    );
    await register('base_user_account', ACCOUNT_ID);
    await query(
      `INSERT INTO equipment_model (id, model_code, model_name, enabled)
       VALUES (${SENTINEL_MODEL_ID}, 'P4-SENTINEL', 'P4 保活机型', 1)`,
    );
    await register('equipment_model', SENTINEL_MODEL_ID);
  });

  afterAll(async () => {
    try {
      await finalizeFixtureTeardown({
        steps: [
          {
            label: `清理夹具（目标库 ${database || '(未确认)'}）`,
            run: async () => {
              if (!setupAllowed) return;
              // 只清理仍存在的登记行；未登记的残留一律不推测删除
              const existing: OwnedFixtureRow[] = [];
              for (const row of master.list()) {
                if (await rowExists(row)) existing.push(row);
              }
              await runOwnedFixtureCleanup({
                dataSource,
                expectedDatabase: database,
                rows: existing,
              });
            },
          },
          {
            label: '核对夹具残留',
            run: async () => {
              if (!setupAllowed) return;
              const residue = await assertRegisteredRowsAbsent(dataSource, master.list());
              if (residue.length > 0) {
                throw new Error(`本轮登记资源仍存在：${residue.join('；')}`);
              }
            },
          },
          {
            label: '关闭数据库连接',
            run: async () => {
              if (dataSource?.isInitialized) {
                await dataSource.destroy();
              }
            },
          },
        ],
      });
    } finally {
      if (consentOriginal === undefined) {
        delete process.env[CONSENT_ENV];
      } else {
        process.env[CONSENT_ENV] = consentOriginal;
      }
    }
  });

  describe('拒绝路径与调用顺序（SQL 替身）', () => {
    it('缺少显式许可：清理入口自身拒绝，零 DELETE', async () => {
      process.env[CONSENT_ENV] = '';
      const harness = createFakeDataSource({
        rows: [{ table: 'equipment_model', values: { id: 1, model_name: 'x', enabled: 1 } }],
      });
      try {
        await expect(
          prepareFixtureSetup(harness.dataSource, ROUND_TAG, 'lithography_e2e'),
        ).rejects.toThrow(new RegExp(CONSENT_ENV));
        await expect(
          runOwnedFixtureCleanup({
            dataSource: harness.dataSource,
            rows: [singleRow('equipment_model', 1, { model_name: 'x', enabled: 1 })],
          }),
        ).rejects.toThrow(new RegExp(CONSENT_ENV));
        expect(harness.deleteCalls).toHaveLength(0);
        expect(harness.calls.some((sql) => sql.startsWith('DELETE'))).toBe(false);
      } finally {
        process.env[CONSENT_ENV] = '1';
      }
    });

    it('非白名单库：拒绝，零 DELETE', async () => {
      const harness = createFakeDataSource({
        configuredDatabase: 'lithography_drill',
        actualDatabase: 'lithography_drill',
        rows: [{ table: 'equipment_model', values: { id: 1, model_name: 'x', enabled: 1 } }],
      });
      await expect(
        prepareFixtureSetup(harness.dataSource, ROUND_TAG, 'lithography_drill'),
      ).rejects.toThrow(/不在允许的 E2E 库白名单/);
      await expect(
        runOwnedFixtureCleanup({
          dataSource: harness.dataSource,
          rows: [singleRow('equipment_model', 1, { model_name: 'x', enabled: 1 })],
        }),
      ).rejects.toThrow(/不在允许的 E2E 库白名单/);
      expect(harness.deleteCalls).toHaveLength(0);
    });

    it('声明库与实际库不一致：拒绝，零 DELETE', async () => {
      const allowedOriginal = process.env[ALLOWED_ENV];
      process.env[ALLOWED_ENV] = 'lithography_e2e,lithography_e2e_shadow';
      const harness = createFakeDataSource({
        configuredDatabase: 'lithography_e2e',
        actualDatabase: 'lithography_e2e_shadow',
        rows: [{ table: 'equipment_model', values: { id: 1, model_name: 'x', enabled: 1 } }],
      });
      try {
        await expect(
          runOwnedFixtureCleanup({
            dataSource: harness.dataSource,
            expectedDatabase: 'lithography_e2e',
            rows: [singleRow('equipment_model', 1, { model_name: 'x', enabled: 1 })],
          }),
        ).rejects.toThrow(/不一致/);
        expect(harness.deleteCalls).toHaveLength(0);
      } finally {
        if (allowedOriginal === undefined) {
          delete process.env[ALLOWED_ENV];
        } else {
          process.env[ALLOWED_ENV] = allowedOriginal;
        }
      }
    });

    it('删除连接自身核验 DATABASE() 且发生在任何 DELETE 之前', async () => {
      const harness = createFakeDataSource({
        configuredDatabase: 'lithography_e2e',
        actualDatabase: 'lithography_e2e',
        rows: [{ table: 'equipment_model', values: { id: 1, model_name: 'x', enabled: 1 } }],
      });
      await runOwnedFixtureCleanup({
        dataSource: harness.dataSource,
        rows: [singleRow('equipment_model', 1, { model_name: 'x', enabled: 1 })],
      });
      const deleteIndex = harness.calls.findIndex((sql) => sql.startsWith('DELETE'));
      const databaseIndexes = harness.calls
        .map((sql, index) => (sql.includes('SELECT DATABASE()') ? index : -1))
        .filter((index) => index >= 0);
      expect(deleteIndex).toBeGreaterThan(-1);
      expect(databaseIndexes.length).toBeGreaterThanOrEqual(1);
      expect(Math.max(...databaseIndexes)).toBeLessThan(deleteIndex);
      expect(harness.calls[deleteIndex]).toContain('`equipment_model`');
    });

    it('空账本：不产生任何 DELETE', async () => {
      const harness = createFakeDataSource({
        rows: [{ table: 'equipment_model', values: { id: 30, model_name: 'keep', enabled: 1 } }],
      });
      const result = await runOwnedFixtureCleanup({
        dataSource: harness.dataSource,
        rows: [],
      });
      expect(result).toEqual({ performed: false, deletedRows: 0 });
      expect(harness.deleteCalls).toHaveLength(0);
      expect(harness.calls.some((sql) => sql.startsWith('DELETE'))).toBe(false);
    });

    it('账本外目标不可登记；未登记同行不删除', async () => {
      const harness = createFakeDataSource({
        rows: [
          { table: 'equipment_model', values: { id: 11, model_name: 'mine', enabled: 1 } },
          { table: 'equipment_model', values: { id: 22, model_name: 'other', enabled: 1 } },
        ],
      });
      const ledger = new OwnedFixtureLedger(ROUND_TAG);
      expect(() =>
        ledger.register({
          table: 'p4_unknown_table' as ControlledFixtureTable,
          key: { id: 1 },
          expected: { id: 1 },
        }),
      ).toThrow(/未受控/);
      expect(() =>
        ledger.register({
          table: 'maintenance_report_version_attachment',
          key: { version_id: 5 },
          expected: { version_id: 5, attachment_id: 9 },
        }),
      ).toThrow(/主键结构不匹配/);

      await ledger.registerById(harness.dataSource.query, 'equipment_model', 11);
      await runOwnedFixtureCleanup({
        dataSource: harness.dataSource,
        rows: ledger.list(),
      });
      expect(harness.deleteCalls).toHaveLength(1);
      expect(harness.deleteCalls[0].params).toEqual([11]);
      expect(harness.deleteCalls.some((call) => call.params.includes(22))).toBe(false);
    });

    it('未登记复合主键子记录：引用闭包拒绝，零 DELETE', async () => {
      const harness = createFakeDataSource({
        rows: [
          {
            table: 'maintenance_report_version',
            values: { id: 501, report_id: 400, version_no: 1 },
          },
          {
            table: 'maintenance_report_version_attachment',
            values: { version_id: 501, attachment_id: 601, report_id: 400 },
          },
        ],
        referenceTotal: 1,
      });
      // 只登记版本行，不登记复合主键的版本附件
      const row = fixtureRow('maintenance_report_version', 501, {
        report_id: 400,
        version_no: 1,
      });
      await expect(
        runOwnedFixtureCleanup({
          dataSource: harness.dataSource,
          rows: [row],
          referenceGuards: [
            {
              table: 'maintenance_report_version_attachment',
              column: 'version_id',
              ids: [501],
              label: '未登记版本附件',
            },
          ],
        }),
      ).rejects.toThrow(/账本外记录/);
      expect(harness.deleteCalls).toHaveLength(0);
    });

    it('固定 ID 碰撞：创建前拒绝并保留原数据', async () => {
      const harness = createFakeDataSource({
        rows: [{ table: 'equipment_model', values: { id: 7, model_name: 'existing', enabled: 1 } }],
      });
      await expect(
        assertFixtureIdsAvailable(harness.dataSource, 'equipment_model', [7], ROUND_TAG),
      ).rejects.toThrow(/固定 ID 已被占用/);
      expect(harness.calls.some((sql) => sql.startsWith('DELETE'))).toBe(false);
    });

    it('字段变化与 NULL 不匹配：整批零删除', async () => {
      const cases: Array<{
        label: string;
        expected: Record<string, unknown>;
        actual: Record<string, unknown>;
      }> = [
        {
          label: '字段变化',
          expected: { id: 1, model_name: 'x', note: null },
          actual: { id: 1, model_name: 'changed', note: null },
        },
        {
          label: '非 NULL 变为 NULL',
          expected: { id: 1, model_name: 'x', note: 'kept' },
          actual: { id: 1, model_name: 'x', note: null },
        },
        {
          label: 'NULL 变为非 NULL',
          expected: { id: 1, model_name: 'x', note: null },
          actual: { id: 1, model_name: 'x', note: 'leak' },
        },
      ];
      for (const item of cases) {
        const harness = createFakeDataSource({
          rows: [{ table: 'equipment_model', values: item.actual }],
        });
        await expect(
          runOwnedFixtureCleanup({
            dataSource: harness.dataSource,
            rows: [{ table: 'equipment_model', key: { id: 1 }, expected: item.expected }],
          }),
        ).rejects.toThrow(/字段不符/);
        expect(harness.deleteCalls).toHaveLength(0);
      }
    });

    it('额外外部引用：整批零删除', async () => {
      const harness = createFakeDataSource({
        rows: [{ table: 'equipment_model', values: { id: 1, model_name: 'x', enabled: 1 } }],
        referenceTotal: 1,
      });
      await expect(
        runOwnedFixtureCleanup({
          dataSource: harness.dataSource,
          rows: [singleRow('equipment_model', 1, { model_name: 'x', enabled: 1 })],
          referenceGuards: [
            { table: 'repair_request', column: 'equipment_model_id', ids: [1], label: '外部引用' },
          ],
        }),
      ).rejects.toThrow(/账本外记录/);
      expect(harness.deleteCalls).toHaveLength(0);
    });

    it('合法字段变化：按明确预期变更后可清理；所有权字段不可改写', async () => {
      const harness = createFakeDataSource({
        rows: [
          {
            table: 'equipment_model',
            values: {
              id: 2,
              model_name: 'm',
              enabled: 1,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      });
      const ledger = new OwnedFixtureLedger(ROUND_TAG);
      await ledger.registerById(harness.dataSource.query, 'equipment_model', 2);

      // 所有权字段必须保持原始预期
      await expect(
        ledger.applyExpectedChange(harness.dataSource.query, 'equipment_model', 2, {
          created_at: '2026-02-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(/所有权字段/);
      await expect(
        ledger.applyExpectedChange(harness.dataSource.query, 'equipment_model', 2, {
          owner_organization_id: 9,
        }),
      ).rejects.toThrow(/不在登记预期内/);
      await expect(
        ledger.applyExpectedChange(harness.dataSource.query, 'equipment_model', 2, {
          id: 3,
        }),
      ).rejects.toThrow(/主键列/);

      // 业务合法停用该机型，只登记该操作确实影响的字段
      harness.setRow('equipment_model', {
        id: 2,
        model_name: 'm',
        enabled: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      });
      await ledger.applyExpectedChange(harness.dataSource.query, 'equipment_model', 2, {
        enabled: 0,
      });
      await runOwnedFixtureCleanup({
        dataSource: harness.dataSource,
        rows: ledger.list(),
      });
      expect(harness.deleteCalls).toHaveLength(1);
    });

    it('统一收尾：残留查询、清理与关闭同时失败时全部尝试并保留错误', async () => {
      const attempted: string[] = [];
      const errors = await runTeardownSteps([
        {
          label: '清理夹具',
          run: () => {
            attempted.push('cleanup');
            throw new Error('注入清理失败');
          },
        },
        {
          label: '核对残留',
          run: () => {
            attempted.push('residue');
            throw new Error('注入残留查询失败');
          },
        },
        {
          label: '关闭观测连接',
          run: () => {
            attempted.push('close-observer');
            throw new Error('注入观测连接关闭失败');
          },
        },
        {
          label: '关闭测试模块',
          run: () => {
            attempted.push('close-module');
            throw new Error('注入测试模块关闭失败');
          },
        },
      ]);
      expect(attempted).toEqual(['cleanup', 'residue', 'close-observer', 'close-module']);
      expect(errors).toHaveLength(4);
      await expect(
        finalizeFixtureTeardown({
          primaryError: new Error('主断言失败'),
          steps: [
            { label: '清理夹具', run: () => Promise.reject(new Error('注入清理失败')) },
            { label: '关闭测试模块', run: () => Promise.reject(new Error('注入关闭失败')) },
          ],
        }),
      ).rejects.toThrow(/主断言失败/);
      await expect(
        finalizeFixtureTeardown({
          primaryError: new Error('主断言失败'),
          steps: [
            { label: '清理夹具', run: () => Promise.reject(new Error('注入清理失败')) },
            { label: '关闭测试模块', run: () => Promise.reject(new Error('注入关闭失败')) },
          ],
        }),
      ).rejects.toThrow(/注入清理失败/);
    });
  });

  describe('真实 MySQL 事务与引用保护', () => {
    it('并发部分成功且后续断言失败：成功资源已登记并完成受保护清理，错误同时保留', async () => {
      const modelId = 9905013;
      await assertFixtureIdsAvailable(dataSource, 'equipment_model', [modelId], ROUND_TAG);
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${modelId}, 'P4-PARTIAL', 'P4 部分成功机型', 1)`,
      );
      await register('equipment_model', modelId);

      // 成功分支已登记；另一分支失败；随后断言失败。统一收尾必须清理成功资源并保留全部错误
      let teardownMessage = '';
      try {
        await finalizeFixtureTeardown({
          primaryError: new Error('并发另一分支失败：注入'),
          steps: [
            {
              label: '清理夹具',
              run: () => cleanup([modelId]),
            },
            {
              label: '核对残留',
              run: () => {
                throw new Error('注入残留查询失败');
              },
            },
            {
              label: '关闭观测连接',
              run: () => {
                throw new Error('注入观测连接关闭失败');
              },
            },
          ],
        });
      } catch (error) {
        teardownMessage = (error as Error).message;
      }
      expect(teardownMessage).toContain('并发另一分支失败');
      expect(teardownMessage).toContain('注入残留查询失败');
      expect(teardownMessage).toContain('注入观测连接关闭失败');
      expect(await query('SELECT id FROM equipment_model WHERE id = ?', [modelId])).toHaveLength(0);
    });

    it('正常清理与空账本：本轮资源零残留，保活数据不变', async () => {
      const modelId = 9904992;
      await assertFixtureIdsAvailable(dataSource, 'equipment_model', [modelId], ROUND_TAG);
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${modelId}, 'P4-NORMAL', 'P4 正常清理机型', 1)`,
      );
      await register('equipment_model', modelId);

      const sentinelBefore = await query('SELECT * FROM equipment_model WHERE id = ?', [
        SENTINEL_MODEL_ID,
      ]);

      await cleanup([modelId]);
      const residue = await query('SELECT id FROM equipment_model WHERE id = ?', [modelId]);
      expect(residue).toHaveLength(0);

      // 空账本直接 no-op，不产生任何删除
      const emptyResult = await runOwnedFixtureCleanup({
        dataSource,
        expectedDatabase: database,
        rows: [],
      });
      expect(emptyResult).toEqual({ performed: false, deletedRows: 0 });

      const sentinelAfter = await query('SELECT * FROM equipment_model WHERE id = ?', [
        SENTINEL_MODEL_ID,
      ]);
      expect(sentinelAfter).toEqual(sentinelBefore);
    });

    it('外部改写账号、组织归属或机型：拒绝清理且原数据保留', async () => {
      const modelId = 9905002;
      await assertFixtureIdsAvailable(dataSource, 'equipment_model', [modelId], ROUND_TAG);
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${modelId}, 'P4-CHANGED', 'P4 原始名称', 1)`,
      );
      await register('equipment_model', modelId);

      await query('UPDATE equipment_model SET model_name = ? WHERE id = ?', [
        'P4 外部改写',
        modelId,
      ]);
      await expect(cleanup([modelId])).rejects.toThrow(/字段不符/);
      expect(
        await query('SELECT model_name FROM equipment_model WHERE id = ?', [modelId]),
      ).toHaveLength(1);

      await query('UPDATE equipment_model SET model_name = ? WHERE id = ?', [
        'P4 原始名称',
        modelId,
      ]);
      await cleanup([modelId]);
      expect(await query('SELECT id FROM equipment_model WHERE id = ?', [modelId])).toHaveLength(0);
    });

    it('合法业务字段变化：按明确预期正常清理', async () => {
      const modelId = 9905014;
      await assertFixtureIdsAvailable(dataSource, 'equipment_model', [modelId], ROUND_TAG);
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${modelId}, 'P4-LEGIT', 'P4 合法变更机型', 1)`,
      );
      await register('equipment_model', modelId);

      await query('UPDATE equipment_model SET enabled = 0 WHERE id = ?', [modelId]);
      await master.applyExpectedChange(query, 'equipment_model', modelId, { enabled: 0 });
      await cleanup([modelId]);
      expect(await query('SELECT id FROM equipment_model WHERE id = ?', [modelId])).toHaveLength(0);
    });

    it('外部引用：整批零删除；解除引用后方可清理', async () => {
      const modelId = 9905003;
      const requestId = 9905004;
      await assertFixtureIdsAvailable(dataSource, 'equipment_model', [modelId], ROUND_TAG);
      await assertFixtureIdsAvailable(dataSource, 'repair_request', [requestId], ROUND_TAG);
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${modelId}, 'P4-REF', 'P4 引用机型', 1)`,
      );
      await register('equipment_model', modelId);
      await query(
        `INSERT INTO repair_request
           (id, request_no, customer_account_id, equipment_model_id, error_code,
            fault_description, content_md)
         VALUES (${requestId}, 'P4_REF_REQUEST', ${ACCOUNT_ID}, ${modelId}, 'E-P4',
                 'P4 外部引用', '# P4 外部引用')`,
      );
      await register('repair_request', requestId);

      // 本次清理批次只包含机型：引用它的申请行不在删除目标内，属账本外记录，整批拒绝
      await expect(
        cleanup(
          [modelId],
          [
            {
              table: 'repair_request',
              column: 'equipment_model_id',
              ids: [modelId],
              label: '引用闭包',
            },
          ],
        ),
      ).rejects.toThrow(/账本外记录/);
      expect(await query('SELECT id FROM equipment_model WHERE id = ?', [modelId])).toHaveLength(1);
      expect(await query('SELECT id FROM repair_request WHERE id = ?', [requestId])).toHaveLength(
        1,
      );

      // 把引用行一并纳入清理目标后，闭包内无账本外记录，可正常删除
      await cleanup([requestId, modelId]);
      expect(await query('SELECT id FROM equipment_model WHERE id = ?', [modelId])).toHaveLength(0);
      expect(await query('SELECT id FROM repair_request WHERE id = ?', [requestId])).toHaveLength(
        0,
      );
    });

    it('第二条删除失败：此前删除全部回滚，目标行仍在', async () => {
      const firstModelId = 9905010;
      const secondModelId = 9905011;
      const requestId = 9905012;
      for (const modelId of [firstModelId, secondModelId]) {
        await assertFixtureIdsAvailable(dataSource, 'equipment_model', [modelId], ROUND_TAG);
      }
      await assertFixtureIdsAvailable(dataSource, 'repair_request', [requestId], ROUND_TAG);
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${firstModelId}, 'P4-ROLLBACK-A', 'P4 回滚机型 A', 1)`,
      );
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${secondModelId}, 'P4-ROLLBACK-B', 'P4 回滚机型 B', 1)`,
      );
      await register('equipment_model', firstModelId);
      await register('equipment_model', secondModelId);
      // 未登记的外部引用使第二笔机型删除触发外键失败；引用行单独登记以便收尾
      await query(
        `INSERT INTO repair_request
           (id, request_no, customer_account_id, equipment_model_id, error_code,
            fault_description, content_md)
         VALUES (${requestId}, 'P4_ROLLBACK_REQUEST', ${ACCOUNT_ID}, ${secondModelId}, 'E-P4',
                 'P4 回滚引用', '# P4 回滚引用')`,
      );
      await register('repair_request', requestId);

      await expect(cleanup([firstModelId, secondModelId])).rejects.toThrow(/清理失败/);
      expect(
        await query('SELECT id FROM equipment_model WHERE id = ?', [firstModelId]),
      ).toHaveLength(1);
      expect(
        await query('SELECT id FROM equipment_model WHERE id = ?', [secondModelId]),
      ).toHaveLength(1);

      await cleanup([requestId]);
      await cleanup([firstModelId, secondModelId]);
      expect(
        await query('SELECT id FROM equipment_model WHERE id = ?', [firstModelId]),
      ).toHaveLength(0);
      expect(
        await query('SELECT id FROM equipment_model WHERE id = ?', [secondModelId]),
      ).toHaveLength(0);
    });

    it('真实固定 ID 碰撞：拒绝创建并保留原数据', async () => {
      const modelId = 9905006;
      await query(
        `INSERT INTO equipment_model (id, model_code, model_name, enabled)
         VALUES (${modelId}, 'P4-COLLISION', 'P4 碰撞机型', 1)`,
      );
      await register('equipment_model', modelId);
      await expect(
        assertFixtureIdsAvailable(dataSource, 'equipment_model', [modelId], ROUND_TAG),
      ).rejects.toThrow(/固定 ID 已被占用/);
      expect(await query('SELECT id FROM equipment_model WHERE id = ?', [modelId])).toHaveLength(1);
      await cleanup([modelId]);
    });
  });
});
