import type { QueryRunner } from 'typeorm';

import { FixJsonSnapshotVersionChecksForV131775501600000 } from './migrations/1775501600000-fix-json-snapshot-version-checks-for-v13.migration';

const AFFECTED_TABLES = [
  'repair_request_revision',
  'reference_document_revision',
  'sync_conflict',
  'backup_restore_run',
] as const;

interface CountRow {
  readonly total?: number;
  readonly invalid_json_rows?: number;
  readonly missing_key_rows?: number;
  readonly json_null_rows?: number;
  readonly mismatch_rows?: number;
  readonly version_below_one_rows?: number;
}

interface FakeOptions {
  readonly tables?: readonly string[];
  readonly countsByTable?: Readonly<Record<string, CountRow>>;
  readonly samplesByTable?: Readonly<Record<string, readonly number[]>>;
  readonly constraintPresent?: Readonly<Record<string, boolean>>;
  /** 第 N 条 ALTER（1 起）抛错，用于验证部分提交诊断。 */
  readonly failAlterAt?: number;
}

interface RecordedQuery {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

class FakeQueryRunner {
  readonly queries: RecordedQuery[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  query(sql: string, params?: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });

    if (sql.includes('information_schema.TABLES')) {
      return Promise.resolve(
        (this.options.tables ?? AFFECTED_TABLES).map((table) => ({ table_name: table })),
      );
    }
    if (sql.includes('COUNT(*) AS total')) {
      const table = this.tableFromFromClause(sql);
      const count = this.options.countsByTable?.[table] ?? {};
      return Promise.resolve([
        {
          total: count.total ?? 0,
          invalid_json_rows: count.invalid_json_rows ?? 0,
          missing_key_rows: count.missing_key_rows ?? 0,
          json_null_rows: count.json_null_rows ?? 0,
          mismatch_rows: count.mismatch_rows ?? 0,
          version_below_one_rows: count.version_below_one_rows ?? 0,
        },
      ]);
    }
    if (sql.includes('AS locator')) {
      const table = this.tableFromFromClause(sql);
      return Promise.resolve(
        (this.options.samplesByTable?.[table] ?? []).map((locator) => ({ locator })),
      );
    }
    if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
      const firstParam = params?.[0];
      const table = typeof firstParam === 'string' ? firstParam : '';
      const present = this.options.constraintPresent?.[table] ?? true;
      return Promise.resolve(present ? [{ present: 1 }] : []);
    }
    if (sql.startsWith('ALTER TABLE')) {
      const alterIndex = this.queries.filter((item) => item.sql.startsWith('ALTER TABLE')).length;
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

const migration = new FixJsonSnapshotVersionChecksForV131775501600000();

const alterSqls = (runner: FakeQueryRunner): string[] =>
  runner.queries.filter((item) => item.sql.startsWith('ALTER TABLE')).map((item) => item.sql);

describe('JSON 版本必填约束修复迁移（不连接实库）', () => {
  it('全部表合法时，预检完成后按四表重建约束', async () => {
    const runner = new FakeQueryRunner();

    await migration.up(asQueryRunner(runner));

    const alters = alterSqls(runner);
    expect(alters).toHaveLength(4);

    const repairAlter = alters.find((sql) => sql.includes('repair_request_revision'));
    expect(repairAlter).toBeDefined();
    expect(repairAlter).toContain(
      "JSON_EXTRACT(`before_snapshot`, '$.schema_version') IS NOT NULL",
    );
    expect(repairAlter).toContain(
      "JSON_TYPE(JSON_EXTRACT(`before_snapshot`, '$.schema_version')) <> 'NULL'",
    );
    expect(repairAlter).toContain("JSON_EXTRACT(`after_snapshot`, '$.schema_version') IS NOT NULL");
    expect(repairAlter).toContain(
      "JSON_TYPE(JSON_EXTRACT(`after_snapshot`, '$.schema_version')) <> 'NULL'",
    );
    expect(repairAlter).toContain(
      "JSON_EXTRACT(`before_snapshot`, '$.schema_version') = `schema_version`",
    );
    expect(repairAlter).toContain(
      "JSON_EXTRACT(`after_snapshot`, '$.schema_version') = `schema_version`",
    );

    const referenceAlter = alters.find((sql) => sql.includes('reference_document_revision'));
    expect(referenceAlter).toContain(
      "JSON_EXTRACT(`before_snapshot`, '$.schema_version') IS NOT NULL",
    );
    expect(referenceAlter).toContain(
      "JSON_TYPE(JSON_EXTRACT(`after_snapshot`, '$.schema_version')) <> 'NULL'",
    );

    const syncAlter = alters.find((sql) => sql.includes('sync_conflict'));
    expect(syncAlter).toContain("JSON_EXTRACT(`local_snapshot`, '$.schema_version') IS NOT NULL");
    expect(syncAlter).toContain(
      "JSON_TYPE(JSON_EXTRACT(`cloud_snapshot`, '$.schema_version')) <> 'NULL'",
    );

    const backupAlter = alters.find((sql) => sql.includes('backup_restore_run'));
    expect(backupAlter).toContain("JSON_EXTRACT(`check_snapshot`, '$.schema_version') IS NOT NULL");
    expect(backupAlter).toContain(
      "JSON_TYPE(JSON_EXTRACT(`check_snapshot`, '$.schema_version')) <> 'NULL'",
    );

    // 不增加尚未确定的整数类型/范围限制。
    expect(alters.join('\n')).not.toMatch(/JSON_TYPE\([^)]*\) IN \(/);
    expect(alters.join('\n')).not.toMatch(/schema_version.*>= 2/);

    // 预检全部发生在第一条 ALTER 之前。
    const firstAlterIndex = runner.queries.findIndex((item) => item.sql.startsWith('ALTER TABLE'));
    const countIndexes = runner.queries
      .map((item, index) => (item.sql.includes('COUNT(*) AS total') ? index : -1))
      .filter((index) => index >= 0);
    expect(countIndexes).toHaveLength(4);
    expect(Math.max(...countIndexes)).toBeLessThan(firstAlterIndex);

    // before/after 与 local/cloud 两侧都进入预检条件。
    const countSqls = runner.queries
      .filter((item) => item.sql.includes('COUNT(*) AS total'))
      .map((item) => item.sql);
    for (const column of ['before_snapshot', 'after_snapshot']) {
      const repairCount = countSqls.find((sql) => sql.includes('repair_request_revision'));
      expect(repairCount).toContain(`\`${column}\``);
    }
    const referenceCount = countSqls.find((sql) => sql.includes('reference_document_revision'));
    expect(referenceCount).toContain('`before_snapshot`');
    expect(referenceCount).toContain('`after_snapshot`');
    const syncCount = countSqls.find((sql) => sql.includes('sync_conflict'));
    expect(syncCount).toContain('`local_snapshot`');
    expect(syncCount).toContain('`cloud_snapshot`');

    // 独立版本列 < 1 是 repair 目标约束的一部分，预检必须覆盖；其他表无独立版本列。
    const repairCount = countSqls.find((sql) => sql.includes('repair_request_revision'));
    expect(repairCount).toContain('AS version_below_one_rows');
    expect(referenceCount).not.toContain('version_below_one_rows');
    expect(syncCount).not.toContain('version_below_one_rows');
  });

  it('缺键行会让迁移在任何 ALTER 前失败关闭，并报告计数与定位 ID', async () => {
    const runner = new FakeQueryRunner({
      countsByTable: {
        repair_request_revision: {
          total: 2,
          missing_key_rows: 1,
          json_null_rows: 1,
        },
      },
      samplesByTable: { repair_request_revision: [7, 8] },
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /预检失败[\s\S]*repair_request_revision: 违规 2 行[\s\S]*缺键 1[\s\S]*JSON null 1[\s\S]*7, 8/,
    );
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('独立版本列 < 1 的行同样在任何 ALTER 前失败关闭', async () => {
    const runner = new FakeQueryRunner({
      countsByTable: {
        repair_request_revision: { total: 1, version_below_one_rows: 1 },
      },
      samplesByTable: { repair_request_revision: [11] },
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /预检失败[\s\S]*repair_request_revision: 违规 1 行[\s\S]*独立列版本<1 1[\s\S]*11/,
    );
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('JSON null 会让迁移在任何 ALTER 前失败关闭（reference_document_revision）', async () => {
    const runner = new FakeQueryRunner({
      countsByTable: {
        reference_document_revision: { total: 1, json_null_rows: 1 },
      },
      samplesByTable: { reference_document_revision: [9] },
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /预检失败[\s\S]*reference_document_revision: 违规 1 行[\s\S]*JSON null 1[\s\S]*9/,
    );
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('sync_conflict 任一侧缺键同样在任何 ALTER 前失败关闭', async () => {
    const runner = new FakeQueryRunner({
      countsByTable: {
        sync_conflict: { total: 1, missing_key_rows: 1 },
      },
      samplesByTable: { sync_conflict: [21] },
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /预检失败[\s\S]*sync_conflict: 违规 1 行[\s\S]*缺键 1[\s\S]*21/,
    );
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('缺少受影响表时在扫描前失败关闭，不执行 ALTER', async () => {
    const runner = new FakeQueryRunner({
      tables: ['repair_request_revision', 'reference_document_revision', 'sync_conflict'],
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /缺少受影响表 backup_restore_run；未执行任何 ALTER/,
    );
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('多表 ALTER 部分失败时准确报告已完成/失败/未执行，不声称整体回滚', async () => {
    const runner = new FakeQueryRunner({ failAlterAt: 2 });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /已完成 repair_request_revision；失败表 reference_document_revision[\s\S]*不能随本迁移整体回滚[\s\S]*可直接重新执行本迁移/,
    );
    expect(alterSqls(runner)).toHaveLength(2);
  });

  it('约束已缺失时只 ADD，便于部分失败后续跑', async () => {
    const runner = new FakeQueryRunner({
      constraintPresent: { repair_request_revision: false },
    });

    await migration.up(asQueryRunner(runner));

    const repairAlter = alterSqls(runner).find((sql) => sql.includes('repair_request_revision'));
    expect(repairAlter).toBeDefined();
    expect(repairAlter).not.toContain('DROP CONSTRAINT');
    const referenceAlter = alterSqls(runner).find((sql) =>
      sql.includes('reference_document_revision'),
    );
    expect(referenceAlter).toContain('DROP CONSTRAINT');
  });

  it('down 恢复修复前的较弱表达式，不引入新限制', async () => {
    const runner = new FakeQueryRunner();

    await migration.down(asQueryRunner(runner));

    const alters = alterSqls(runner);
    expect(alters).toHaveLength(4);
    expect(alters.join('\n')).not.toContain("<> 'NULL'");
    expect(alters.join('\n')).toContain(
      "JSON_EXTRACT(`check_snapshot`, '$.schema_version') IS NOT NULL",
    );
    expect(alters.join('\n')).toContain(
      "JSON_EXTRACT(`before_snapshot`, '$.schema_version') = `schema_version`",
    );
  });
});
