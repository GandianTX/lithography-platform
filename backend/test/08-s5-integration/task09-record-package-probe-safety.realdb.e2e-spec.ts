// test/08-s5-integration/task09-record-package-probe-safety.realdb.e2e-spec.ts

/**
 * 任务 09 · 回执插入探针的启动/收尾安全反例（一次性专用库）。
 *
 * 只验证测试入口自己的对象归属与门禁，不替换正式业务路径：
 * - 缺许可/无一次性声明/错库/错服务器在首条 CREATE/DROP/DELETE 前失败关闭；
 * - 同名非本轮对象不被覆盖，两个所有者互不删除；
 * - 部分创建、替换、消失、收尾失败各自保留错误，不伪报零残留；
 * - 事务内探针证据回滚后不被独立连接认领。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DataSource } from 'typeorm';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';

import {
  createOwnedTrigger,
  createTriggerOwnershipTracker,
  disposeOwnedTriggerRecord,
  readOwnedTriggerFact,
  type TriggerOwnershipTracker,
} from '../utils/e2e-trigger-ownership';
import {
  ALTERED_PROBE_COLUMN_TYPE,
  assertChainProbePreflight,
  assertChainProbeTarget,
  buildReceiptProbeTriggerBody,
  CHAIN_DISPOSABLE_ENV,
  CHAIN_RUN_ID_ENV,
  createOwnedReceiptProbeTable,
  createReceiptProbeTableTracker,
  disposeOwnedReceiptProbeTable,
  EXTERNAL_PROBE_TRIGGER_MARKER,
  INJECT_PROBE_TABLE_DISPOSAL_FAILURE_ENV,
  INJECT_PROBE_TRIGGER_DISPOSAL_FAILURE_ENV,
  readReceiptProbeRows,
  type ChainProbeRunScope,
  type OwnedReceiptProbeTableFact,
  type ReceiptProbeTableTracker,
} from '../utils/task09-record-package-probe-safety';

jest.setTimeout(180_000);

const ENABLED = process.env.TASK09_RECORD_PACKAGE_PROBE_SAFETY === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const BACKEND_ROOT = resolve(__dirname, '../..');
const JEST_BIN = join(BACKEND_ROOT, 'node_modules/jest/bin/jest.js');
const CHAIN_SPEC = join(__dirname, 'task09-record-package-chain.realdb.e2e-spec.ts');

type OwnedPair = {
  readonly scope: ChainProbeRunScope;
  readonly tableFact: OwnedReceiptProbeTableFact;
  readonly tableTracker: ReceiptProbeTableTracker;
  readonly triggerTracker: TriggerOwnershipTracker;
};

describeIntegration('记录包探针对象归属与启动门禁反例（一次性专用库）', () => {
  let dataSource: DataSource;
  let baseScope: ChainProbeRunScope;
  const pairs: OwnedPair[] = [];
  const foreignObjects: Array<{ table: string; trigger: string | null }> = [];

  const scopeFor = (runId: string): ChainProbeRunScope =>
    assertChainProbePreflight({ ...process.env, [CHAIN_RUN_ID_ENV]: runId });

  const createOwnedPair = async (runId: string): Promise<OwnedPair> => {
    const scope = scopeFor(runId);
    await assertChainProbeTarget(dataSource, scope);
    const tableTracker = createReceiptProbeTableTracker();
    const triggerTracker = createTriggerOwnershipTracker();
    const tableFact = await createOwnedReceiptProbeTable({
      dataSource,
      scope,
      tracker: tableTracker,
    });
    await createOwnedTrigger({
      dataSource,
      name: scope.probeTrigger,
      tableName: 'sync_receipt',
      body: buildReceiptProbeTriggerBody(tableFact.tableName),
      timing: 'AFTER',
      event: 'INSERT',
      tracker: triggerTracker,
    });
    const pair = { scope, tableFact, tableTracker, triggerTracker };
    pairs.push(pair);
    return pair;
  };

  const disposePair = async (pair: OwnedPair): Promise<void> => {
    for (const record of [...pair.triggerTracker.remaining()]) {
      await disposeOwnedTriggerRecord(dataSource, record, pair.triggerTracker);
    }
    await disposeOwnedReceiptProbeTable({
      dataSource,
      fact: pair.tableFact,
      tracker: pair.tableTracker,
    });
    const index = pairs.indexOf(pair);
    if (index >= 0) pairs.splice(index, 1);
  };

  const createForeignProbe = async (scope: ChainProbeRunScope): Promise<void> => {
    await dataSource.query(`
      CREATE TABLE \`${scope.probeTable}\` (
        id INT NOT NULL PRIMARY KEY,
        marker VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await dataSource.query(
      `INSERT INTO \`${scope.probeTable}\` (id, marker) VALUES (1, 'foreign')`,
    );
    await dataSource.query(`
      CREATE TRIGGER \`${scope.probeTrigger}\`
      AFTER INSERT ON sync_receipt FOR EACH ROW
      INSERT INTO \`${scope.probeTable}\` (id, marker) VALUES (2, 'foreign')
    `);
    foreignObjects.push({ table: scope.probeTable, trigger: scope.probeTrigger });
  };

  const dropForeignProbe = async (scope: ChainProbeRunScope): Promise<void> => {
    await dataSource.query(`DROP TRIGGER IF EXISTS \`${scope.probeTrigger}\``);
    await dataSource.query(`DROP TABLE IF EXISTS \`${scope.probeTable}\``);
    foreignObjects.splice(
      foreignObjects.findIndex((entry) => entry.table === scope.probeTable),
      1,
    );
  };

  const runChainSpec = (
    env: NodeJS.ProcessEnv,
    testNamePattern?: string,
  ): { status: number | null; output: string } => {
    const args = [
      JEST_BIN,
      '--testPathIgnorePatterns',
      '/node_modules/',
      '/dist/',
      '--runTestsByPath',
      CHAIN_SPEC,
      '--runInBand',
    ];
    if (testNamePattern !== undefined) args.push('-t', testNamePattern);
    const result = spawnSync(process.execPath, args, {
      cwd: BACKEND_ROOT,
      env,
      encoding: 'utf8',
      timeout: 150_000,
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    };
  };

  const chainFileEntries = (): string[] => {
    const base = resolve(process.env.TASK09_RECORD_PACKAGE_FILE_ROOT ?? join('.local', 'task09'));
    try {
      return readdirSync(base).filter((name) => name.startsWith('task09-chain-'));
    } catch {
      return [];
    }
  };

  const cleanupPreservedChainScene = async (scope: ChainProbeRunScope): Promise<void> => {
    await dataSource.query(`DROP TRIGGER IF EXISTS \`${scope.probeTrigger}\``);
    await dataSource.query(`DROP TABLE IF EXISTS \`${scope.probeTable}\``);
    await dataSource.query('DELETE FROM record_package_item');
    await dataSource.query('DELETE FROM record_package_import');
    await dataSource.query('DELETE FROM sync_receipt WHERE organization_id = 1');
    const base = resolve(process.env.TASK09_RECORD_PACKAGE_FILE_ROOT ?? join('.local', 'task09'));
    for (const entry of chainFileEntries()) {
      rmSync(join(base, entry), { recursive: true, force: true });
    }
  };

  beforeAll(async () => {
    baseScope = assertChainProbePreflight();
    const config = loadExplicitEnvConfig(baseScope.envFile, baseScope.database);
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
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
    });
    await dataSource.initialize();
    await assertChainProbeTarget(dataSource, baseScope);
  });

  afterAll(async () => {
    const errors: Array<{ stage: string; error: unknown }> = [];
    for (const pair of [...pairs].reverse()) {
      try {
        await disposePair(pair);
      } catch (error) {
        errors.push({ stage: `本轮对象 ${pair.scope.runId}`, error });
      }
    }
    for (const entry of [...foreignObjects].reverse()) {
      try {
        if (entry.trigger !== null) {
          await dataSource.query(`DROP TRIGGER IF EXISTS \`${entry.trigger}\``);
        }
        await dataSource.query(`DROP TABLE IF EXISTS \`${entry.table}\``);
      } catch (error) {
        errors.push({ stage: `外部夹具 ${entry.table}`, error });
      }
    }
    try {
      await dataSource?.destroy();
    } catch (error) {
      errors.push({ stage: '连接关闭', error });
    }
    if (errors.length > 0) {
      throw new Error(
        '探针安全规格收尾失败：' +
          errors
            .map(
              ({ stage, error }) =>
                `[${stage}] ${error instanceof Error ? error.message : String(error)}`,
            )
            .join(' | '),
        { cause: errors },
      );
    }
  });

  it('缺物理清理许可：真实规格启动链在首条 DDL 前失败，零对象创建', async () => {
    const childScope = scopeFor('safetynoconsent');
    const childEnv: NodeJS.ProcessEnv = { ...process.env, [CHAIN_RUN_ID_ENV]: 'safetynoconsent' };
    delete childEnv.E2E_ALLOW_PHYSICAL_CLEANUP;
    const result = runChainSpec(childEnv);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/清理许可|E2E_ALLOW_PHYSICAL_CLEANUP/);
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [childScope.probeTable],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it('无可丢弃专库声明/错误服务器/错误库：全部在 DDL 前拒绝', async () => {
    const env = { ...process.env };
    delete env[CHAIN_DISPOSABLE_ENV];
    expect(() => assertChainProbePreflight(env)).toThrow(/可丢弃专库声明/);

    await expect(
      assertChainProbeTarget(dataSource, {
        ...baseScope,
        serverUuid: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(/服务器/);
    await expect(
      assertChainProbeTarget(dataSource, { ...baseScope, database: 'lithography_task09_test_e2e' }),
    ).rejects.toThrow(/白名单|不一致/);
  });

  it('同名非本轮对象：真实规格启动链拒绝创建，夹具逐字段不变', async () => {
    const childScope = scopeFor('safetycollision');
    await createForeignProbe(childScope);
    const before = await dataSource.query(
      'SELECT id, marker FROM `task09_receipt_probe_safetycollision` ORDER BY id',
    );
    const result = runChainSpec({
      ...process.env,
      [CHAIN_RUN_ID_ENV]: 'safetycollision',
    });
    const after = await dataSource.query(
      'SELECT id, marker FROM `task09_receipt_probe_safetycollision` ORDER BY id',
    );
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/同名预检|归属不明确/);
    expect(after).toEqual(before);
    expect(before).toEqual([{ id: 1, marker: 'foreign' }]);
    await dropForeignProbe(childScope);
  });

  it('两个本轮所有者互不覆盖：各自对象独立创建与回收', async () => {
    const ownerA = await createOwnedPair('safetyowner1');
    const ownerB = await createOwnedPair('safetyowner2');
    await dataSource.query(
      `INSERT INTO \`${ownerA.tableFact.tableName}\` (receipt_id, connection_id, organization_id, record_uuid, version_no, source_installation_id) VALUES (?, 1, 1, ?, 1, ?)`,
      ['owner-a', 'owner-a', 'owner-a'],
    );
    await dataSource.query(
      `INSERT INTO \`${ownerB.tableFact.tableName}\` (receipt_id, connection_id, organization_id, record_uuid, version_no, source_installation_id) VALUES (?, 1, 1, ?, 1, ?)`,
      ['owner-b', 'owner-b', 'owner-b'],
    );

    await disposePair(ownerA);
    const bRows = await readReceiptProbeRows(dataSource, ownerB.tableFact.tableName, 'owner-b');
    expect(bRows).toHaveLength(1);
    const bTrigger = await readOwnedTriggerFact(dataSource, ownerB.scope.probeTrigger);
    expect(bTrigger?.name).toBe(ownerB.scope.probeTrigger);
    await disposePair(ownerB);
  });

  it('创建表后触发器创建失败：表仍登记并单独回收，不留半初始化', async () => {
    const scope = scopeFor('safetypartial');
    await assertChainProbeTarget(dataSource, scope);
    const tableTracker = createReceiptProbeTableTracker();
    const tableFact = await createOwnedReceiptProbeTable({
      dataSource,
      scope,
      tracker: tableTracker,
    });
    await expect(
      createOwnedTrigger({
        dataSource,
        name: scope.probeTrigger,
        tableName: 'task09_missing_table_for_probe_safety',
        body: buildReceiptProbeTriggerBody(tableFact.tableName),
        timing: 'AFTER',
        event: 'INSERT',
        tracker: createTriggerOwnershipTracker(),
      }),
    ).rejects.toThrow();
    await disposeOwnedReceiptProbeTable({ dataSource, fact: tableFact, tracker: tableTracker });
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [scope.probeTable],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it('触发器被替换或消失：拒绝删除非本轮定义并保留各阶段错误', async () => {
    const pair = await createOwnedPair('safetyreplaced');
    const originalBody = buildReceiptProbeTriggerBody(pair.tableFact.tableName);
    await dataSource.query(`DROP TRIGGER IF EXISTS \`${pair.scope.probeTrigger}\``);
    await dataSource.query(`
      CREATE TRIGGER \`${pair.scope.probeTrigger}\`
      AFTER INSERT ON sync_receipt FOR EACH ROW SET @task09_replaced = 1
    `);
    const record = pair.triggerTracker.remaining()[0];
    expect(record).toBeDefined();
    await expect(
      disposeOwnedTriggerRecord(dataSource, record, pair.triggerTracker),
    ).rejects.toThrow(/拒绝删除|不一致/);
    await dataSource.query(`DROP TRIGGER IF EXISTS \`${pair.scope.probeTrigger}\``);
    await dataSource.query(`
      CREATE TRIGGER \`${pair.scope.probeTrigger}\`
      AFTER INSERT ON sync_receipt FOR EACH ROW ${originalBody}
    `);
    await disposePair(pair);

    const missing = await createOwnedPair('safetymissing');
    await dataSource.query(`DROP TABLE \`${missing.tableFact.tableName}\``);
    for (const triggerRecord of [...missing.triggerTracker.remaining()]) {
      await disposeOwnedTriggerRecord(dataSource, triggerRecord, missing.triggerTracker);
    }
    await expect(
      disposeOwnedReceiptProbeTable({
        dataSource,
        fact: missing.tableFact,
        tracker: missing.tableTracker,
      }),
    ).rejects.toThrow(/缺失/);
    const missingIndex = pairs.indexOf(missing);
    if (missingIndex >= 0) pairs.splice(missingIndex, 1);
  });

  it('事务回滚的探针证据不被独立连接认领', async () => {
    const pair = await createOwnedPair('safetyrollback');
    const receiptId = 'rollback-receipt';
    await expect(
      dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO \`${pair.tableFact.tableName}\` (receipt_id, connection_id, organization_id, record_uuid, version_no, source_installation_id) VALUES (?, 7, 1, ?, 1, ?)`,
          [receiptId, receiptId, receiptId],
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect(
      await readReceiptProbeRows(dataSource, pair.tableFact.tableName, receiptId),
    ).toHaveLength(0);
    await disposePair(pair);
  });

  it('真实主规格 afterAll：触发器收尾失败时保留其表、数据、业务行与文件现场', async () => {
    const scope = scopeFor('tdtrigger');
    const result = runChainSpec(
      {
        ...process.env,
        [CHAIN_RUN_ID_ENV]: 'tdtrigger',
        [INJECT_PROBE_TRIGGER_DISPOSAL_FAILURE_ENV]: '1',
      },
      '全新包',
    );
    let assertionError: unknown;
    try {
      const triggers = await dataSource.query(
        'SELECT ACTION_STATEMENT AS definition FROM information_schema.TRIGGERS ' +
          'WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
        [scope.probeTrigger],
      );
      const tableRows = await dataSource.query(
        'SELECT COUNT(*) AS n FROM information_schema.TABLES ' +
          'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [scope.probeTable],
      );
      const batches = await dataSource.query('SELECT COUNT(*) AS n FROM record_package_import');
      const items = await dataSource.query('SELECT COUNT(*) AS n FROM record_package_item');
      const receipts = await dataSource.query(
        'SELECT COUNT(*) AS n FROM sync_receipt WHERE organization_id = 1',
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/拒绝删除|现场保留/);
      expect(String(triggers[0]?.definition ?? '')).toContain(EXTERNAL_PROBE_TRIGGER_MARKER);
      expect(Number(tableRows[0]?.n ?? 0)).toBeGreaterThan(0);
      expect(Number(batches[0]?.n ?? 0)).toBeGreaterThan(0);
      expect(Number(items[0]?.n ?? 0)).toBeGreaterThan(0);
      expect(Number(receipts[0]?.n ?? 0)).toBeGreaterThan(0);
      expect(chainFileEntries().length).toBeGreaterThan(0);
    } catch (error) {
      assertionError = error;
    } finally {
      await cleanupPreservedChainScene(scope);
    }
    if (assertionError instanceof Error) throw assertionError;
    if (assertionError !== undefined) {
      throw new Error('保留现场断言失败', { cause: assertionError });
    }
  });

  it('真实主规格 afterAll：表定义被替换时拒绝删表且保留业务与文件现场', async () => {
    const scope = scopeFor('tdtable');
    const result = runChainSpec(
      {
        ...process.env,
        [CHAIN_RUN_ID_ENV]: 'tdtable',
        [INJECT_PROBE_TABLE_DISPOSAL_FAILURE_ENV]: '1',
      },
      '全新包',
    );
    let assertionError: unknown;
    try {
      const triggers = await dataSource.query(
        'SELECT COUNT(*) AS n FROM information_schema.TRIGGERS ' +
          'WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
        [scope.probeTrigger],
      );
      const columns = await dataSource.query(
        'SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS ' +
          'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [scope.probeTable, 'source_installation_id'],
      );
      const batches = await dataSource.query('SELECT COUNT(*) AS n FROM record_package_import');
      const receipts = await dataSource.query(
        'SELECT COUNT(*) AS n FROM sync_receipt WHERE organization_id = 1',
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/定义已被替换|现场保留/);
      expect(Number(triggers[0]?.n ?? 0)).toBe(0);
      expect(String(columns[0]?.columnType ?? '').toLowerCase()).toContain(
        ALTERED_PROBE_COLUMN_TYPE,
      );
      expect(Number(batches[0]?.n ?? 0)).toBeGreaterThan(0);
      expect(Number(receipts[0]?.n ?? 0)).toBeGreaterThan(0);
      expect(chainFileEntries().length).toBeGreaterThan(0);
    } catch (error) {
      assertionError = error;
    } finally {
      await cleanupPreservedChainScene(scope);
    }
    if (assertionError instanceof Error) throw assertionError;
    if (assertionError !== undefined) {
      throw new Error('保留现场断言失败', { cause: assertionError });
    }
  });
});
