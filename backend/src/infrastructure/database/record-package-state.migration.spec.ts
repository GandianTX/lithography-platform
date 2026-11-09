import type { QueryRunner } from 'typeorm';

import { AddRecordPackageCheckAndImportResultStatesForV131775501700000 } from './migrations/1775501700000-add-record-package-check-and-import-result-states-for-v13.migration';

const PACKAGE_TABLE = 'record_package_import';
const ITEM_TABLE = 'record_package_item';

interface FakeOptions {
  readonly tables?: readonly string[];
  /** 每表预检指标计数：数组下标对应 SQL 中的 metric_N。 */
  readonly metricCounts?: Readonly<Record<string, readonly number[]>>;
  readonly sampleLocators?: Readonly<Record<string, readonly string[]>>;
  readonly columns?: Readonly<Record<string, readonly string[]>>;
  readonly constraints?: Readonly<Record<string, readonly string[]>>;
  /** 第 N 条 ALTER（1 起）抛错，用于验证部分提交诊断。 */
  readonly failAlterAt?: number;
}

interface RecordedQuery {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

const asParamString = (value: unknown): string => (typeof value === 'string' ? value : '');

class FakeQueryRunner {
  readonly queries: RecordedQuery[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  query(sql: string, params?: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    const trimmed = sql.trim();

    if (sql.includes('information_schema.TABLES')) {
      return Promise.resolve(
        (this.options.tables ?? [PACKAGE_TABLE, ITEM_TABLE]).map((table) => ({
          table_name: table,
        })),
      );
    }
    if (sql.includes('information_schema.COLUMNS')) {
      const table = asParamString(params?.[0]);
      const column = asParamString(params?.[1]);
      return Promise.resolve(
        (this.options.columns?.[table] ?? []).includes(column) ? [{ column_name: column }] : [],
      );
    }
    if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
      const table = asParamString(params?.[0]);
      const constraint = asParamString(params?.[1]);
      return Promise.resolve(
        (this.options.constraints?.[table] ?? []).includes(constraint)
          ? [{ constraint_name: constraint }]
          : [],
      );
    }
    if (sql.includes('COUNT(*) AS total')) {
      const table = this.tableFromFromClause(sql);
      const metrics = this.options.metricCounts?.[table] ?? [];
      const row: Record<string, number> = { total: metrics.reduce((sum, value) => sum + value, 0) };
      metrics.forEach((value, index) => {
        row[`metric_${index}`] = value;
      });
      return Promise.resolve([row]);
    }
    if (sql.includes('AS locator')) {
      const table = this.tableFromFromClause(sql);
      return Promise.resolve(
        (this.options.sampleLocators?.[table] ?? []).map((locator) => ({ locator })),
      );
    }
    if (trimmed.startsWith('ALTER TABLE')) {
      const alterIndex = this.queries.filter((item) =>
        item.sql.trim().startsWith('ALTER TABLE'),
      ).length;
      if (this.options.failAlterAt === alterIndex) {
        throw new Error(`simulated ALTER failure at ${String(alterIndex)}`);
      }
      return Promise.resolve(undefined);
    }
    return Promise.resolve([]);
  }

  private tableFromFromClause(sql: string): string {
    const match = /FROM `([a-z_]+)`/.exec(sql);
    if (!match) {
      throw new Error(`无法从 SQL 解析表名：${sql}`);
    }
    return match[1];
  }
}

const asQueryRunner = (runner: FakeQueryRunner): QueryRunner => runner as unknown as QueryRunner;

const migration = new AddRecordPackageCheckAndImportResultStatesForV131775501700000();

const alterSqls = (runner: FakeQueryRunner): string[] =>
  runner.queries
    .filter((item) => item.sql.trim().startsWith('ALTER TABLE'))
    .map((item) => item.sql);

describe('第 39 条记录包检查/导入状态迁移（不连接实库）', () => {
  it('合法历史数据：先预检、再按表追加列与约束，且不统一回填为检查待处理', async () => {
    const runner = new FakeQueryRunner();

    await migration.up(asQueryRunner(runner));

    const alters = alterSqls(runner);
    expect(alters).toHaveLength(5);

    const firstAlterIndex = runner.queries.findIndex((item) =>
      item.sql.trim().startsWith('ALTER TABLE'),
    );
    const countIndexes = runner.queries
      .map((item, index) => (item.sql.includes('COUNT(*) AS total') ? index : -1))
      .filter((index) => index >= 0);
    expect(countIndexes).toHaveLength(2);
    expect(Math.max(...countIndexes)).toBeLessThan(firstAlterIndex);

    const packageAlter = alters.find((sql) => sql.includes('ADD COLUMN `check_status`'));
    expect(packageAlter).toBeDefined();
    expect(packageAlter).toContain("JSON_EXTRACT(`manifest_json`, '$.schema_version') IS NOT NULL");
    expect(packageAlter).toContain(
      "JSON_TYPE(JSON_EXTRACT(`manifest_json`, '$.schema_version')) <> 'NULL'",
    );

    const itemAlter = alters.find((sql) => sql.includes('ADD COLUMN `check_result`'));
    expect(itemAlter).toBeDefined();
    expect(itemAlter).toContain('MODIFY COLUMN `result` varchar(16) NULL');
    expect(itemAlter).toContain("'CONFLICT'");

    const updates = runner.queries
      .filter((item) => item.sql.trim().startsWith('UPDATE'))
      .map((item) => item.sql);
    expect(updates).toHaveLength(2);
    const packageUpdate = updates.find((sql) => sql.includes(PACKAGE_TABLE));
    const itemUpdate = updates.find((sql) => sql.includes(ITEM_TABLE));
    expect(packageUpdate).toBeDefined();
    expect(itemUpdate).toBeDefined();
    expect(packageUpdate as string).toContain("`status` IN ('RUNNING', 'SUCCEEDED', 'PARTIAL')");
    expect(itemUpdate as string).toContain("`result` = 'SUCCEEDED'");
    // 禁止把无法证明的历史行统一写成“检查待处理”。
    expect(updates.join('\n')).not.toMatch(/SET `check_status` = 'PENDING'/);
    expect(updates.join('\n')).not.toMatch(/SET `check_result` = 'PENDING'/);
  });

  it('JSON 缺键或 JSON null 的历史行在第一条 ALTER 前失败并给出定位 ID', async () => {
    const runner = new FakeQueryRunner({
      metricCounts: { [PACKAGE_TABLE]: [1, 0, 2] },
      sampleLocators: { [PACKAGE_TABLE]: ['pkg-missing', 'pkg-null'] },
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(/预检失败/);
    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(/pkg-missing/);
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('已存在检查列时按组合约束预检，非法组合在 ALTER 前失败', async () => {
    const runner = new FakeQueryRunner({
      columns: {
        [PACKAGE_TABLE]: ['check_status'],
        [ITEM_TABLE]: ['check_result'],
      },
      metricCounts: { [ITEM_TABLE]: [0, 0, 1] },
      sampleLocators: { [ITEM_TABLE]: ['item-1'] },
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(/item-1/);
    const countSql = runner.queries
      .filter((item) => item.sql.includes('COUNT(*) AS total'))
      .map((item) => item.sql)
      .find((sql) => sql.includes(ITEM_TABLE));
    expect(countSql).toContain('check_result');
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('部分 ALTER 失败时报告步骤、已完成部分与续跑方式，不宣称整体回滚', async () => {
    const runner = new FakeQueryRunner({ failAlterAt: 2 });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /步骤「record_package_import 增加检查\/导入组合约束」失败/,
    );
    await expect(
      migration.up(asQueryRunner(new FakeQueryRunner({ failAlterAt: 2 }))),
    ).rejects.toThrow(/跨表 DDL 已提交部分不能随本迁移整体回滚/);
  });

  it('已存在的列与约束被跳过，可直接重跑续跑', async () => {
    const runner = new FakeQueryRunner({
      columns: {
        [PACKAGE_TABLE]: ['check_status'],
        [ITEM_TABLE]: ['check_result'],
      },
      constraints: {
        [PACKAGE_TABLE]: [
          'chk_record_package_import_check_status',
          'chk_record_package_import_check_stage',
        ],
        [ITEM_TABLE]: ['chk_record_package_item_check_result'],
      },
    });

    await migration.up(asQueryRunner(runner));

    const alters = alterSqls(runner);
    expect(alters).toHaveLength(1);
    expect(alters[0]).toContain('chk_record_package_item_check_stage');
    expect(alters[0]).not.toContain('ADD COLUMN');
  });

  it('回退时存在未执行或冲突的导入结果则拒绝，未执行任何 ALTER', async () => {
    const runner = new FakeQueryRunner({
      columns: {
        [PACKAGE_TABLE]: ['check_status'],
        [ITEM_TABLE]: ['check_result'],
      },
      sampleLocators: { [ITEM_TABLE]: ['item-pending'] },
    });

    await expect(migration.down(asQueryRunner(runner))).rejects.toThrow(/item-pending/);
    const preflight = runner.queries.find((item) => item.sql.includes('AS locator'));
    expect(preflight?.sql).toContain("`result` = 'CONFLICT'");
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('回退先移除引用新列的约束，再删除列并恢复旧结果域', async () => {
    const runner = new FakeQueryRunner({
      columns: {
        [PACKAGE_TABLE]: ['check_status'],
        [ITEM_TABLE]: ['check_result'],
      },
      constraints: {
        [PACKAGE_TABLE]: [
          'chk_record_package_import_check_status',
          'chk_record_package_import_check_stage',
        ],
        [ITEM_TABLE]: [
          'chk_record_package_item_check_result',
          'chk_record_package_item_check_stage',
          'chk_record_package_item_result',
        ],
      },
    });

    await migration.down(asQueryRunner(runner));

    const alters = alterSqls(runner);
    expect(alters).toHaveLength(4);
    const itemDrop = alters.find((sql) =>
      sql.includes('DROP CONSTRAINT `chk_record_package_item_check_stage`'),
    );
    expect(itemDrop).toBeDefined();
    expect(itemDrop).not.toContain('DROP COLUMN');
    const itemRestore = alters.find((sql) => sql.includes('DROP COLUMN `check_result`'));
    expect(itemRestore).toContain('MODIFY COLUMN `result` varchar(16) NOT NULL');
    expect(itemRestore).toContain("'SUCCEEDED', 'FAILED', 'SKIPPED'");
    const packageRestore = alters.find((sql) => sql.includes('DROP COLUMN `check_status`'));
    expect(packageRestore).toContain(
      "JSON_EXTRACT(`manifest_json`, '$.schema_version') IS NOT NULL",
    );
    expect(packageRestore).not.toContain(
      "JSON_TYPE(JSON_EXTRACT(`manifest_json`, '$.schema_version')) <> 'NULL'",
    );
  });
});
