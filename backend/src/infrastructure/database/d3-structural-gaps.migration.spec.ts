import type { QueryRunner } from 'typeorm';

import { CloseD3StructuralGapsForV131775502000000 } from './migrations/1775502000000-close-d3-structural-gaps-for-v13.migration';

interface FakeOptions {
  readonly auditOperations?: ReadonlyArray<{ operation: string; total: number }>;
  readonly repairInvalid?: number;
  readonly checks?: Readonly<Record<string, readonly string[]>>;
  readonly checkClauses?: Readonly<Record<string, string>>;
  readonly syncColumns?: ReadonlyArray<Record<string, unknown>>;
  /** 第 N 条 ALTER（1 起）抛错，用于验证部分 DDL 诊断。 */
  readonly failAtAlter?: number;
}

interface RecordedQuery {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

const asParamString = (value: unknown): string => (typeof value === 'string' ? value : '');

const columnNameOf = (row: Record<string, unknown>): string => {
  const value = row.columnName;
  return typeof value === 'string' ? value : '';
};

const AUDIT_CHECK_KEY = 'management_audit_event.chk_management_audit_operation';

class FakeQueryRunner {
  readonly queries: RecordedQuery[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  query(sql: string, params?: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    const trimmed = sql.trim();

    if (sql.includes('FROM `management_audit_event`') && sql.includes('GROUP BY')) {
      return Promise.resolve(this.options.auditOperations ?? []);
    }
    if (sql.includes('FROM `repair_request`') && sql.includes('COUNT(*)')) {
      return Promise.resolve([{ total: this.options.repairInvalid ?? 0 }]);
    }
    if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS')) {
      const table = asParamString(params?.[0]);
      const constraint = asParamString(params?.[1]);
      return Promise.resolve(
        (this.options.checks?.[table] ?? []).includes(constraint) ? [{ exists: 1 }] : [],
      );
    }
    if (sql.includes('FROM information_schema.CHECK_CONSTRAINTS')) {
      const table = asParamString(params?.[0]);
      const constraint = asParamString(params?.[1]);
      const clause = this.options.checkClauses?.[`${table}.${constraint}`];
      return Promise.resolve(clause === undefined ? [] : [{ checkClause: clause }]);
    }
    if (sql.includes('FROM information_schema.COLUMNS')) {
      const requested = new Set((params ?? []).map((value) => String(value)));
      return Promise.resolve(
        (this.options.syncColumns ?? []).filter((row) => requested.has(columnNameOf(row))),
      );
    }
    if (trimmed.startsWith('ALTER TABLE')) {
      const alterIndex = this.queries.filter((item) =>
        item.sql.trim().startsWith('ALTER TABLE'),
      ).length;
      if (this.options.failAtAlter === alterIndex) {
        throw new Error(`simulated ALTER failure at ${String(alterIndex)}`);
      }
      return Promise.resolve(undefined);
    }
    return Promise.resolve([]);
  }
}

const asQueryRunner = (runner: FakeQueryRunner): QueryRunner => runner as unknown as QueryRunner;

const alterSqls = (runner: FakeQueryRunner): string[] =>
  runner.queries
    .filter((item) => item.sql.trim().startsWith('ALTER TABLE'))
    .map((item) => item.sql);

const migration = new CloseD3StructuralGapsForV131775502000000();

const BASE: FakeOptions = {
  auditOperations: [{ operation: 'ADMIN_DELETE_DOCUMENT', total: 2 }],
  repairInvalid: 0,
  checks: {
    management_audit_event: ['chk_management_audit_operation'],
    repair_request: ['chk_repair_request_closure'],
    sync_conflict: [],
  },
  checkClauses: {
    [AUDIT_CHECK_KEY]: "(`operation` in ('MANAGE_ACCOUNT','MANAGE_COMPANY','ASSIGN_RESOURCE'))",
  },
  syncColumns: [],
};

describe('D3 结构缺口迁移（不连接实库）', () => {
  it('旧审计操作无法映射时在首次 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({
      ...BASE,
      auditOperations: [
        { operation: 'ADMIN_DELETE_DOCUMENT', total: 1 },
        { operation: 'MANAGE_COMPANY', total: 3 },
      ],
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /无法自动映射的旧审计操作.*MANAGE_COMPANY\(3\)/,
    );
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('结单单边 NULL 或非法状态在首次 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({ ...BASE, repairInvalid: 2 });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /存在 2 条无法安全收口的结单数据/,
    );
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('审计与结单约束替换各用单条 ALTER，同时包含 DROP CHECK 与 ADD CONSTRAINT', async () => {
    const runner = new FakeQueryRunner(BASE);

    await migration.up(asQueryRunner(runner));

    const auditAlter = alterSqls(runner).find((sql) => sql.includes('`management_audit_event`'));
    expect(auditAlter).toBeDefined();
    expect(auditAlter).toContain('DROP CHECK `chk_management_audit_operation`');
    expect(auditAlter).toContain('ADD CONSTRAINT `chk_management_audit_operation`');
    expect(auditAlter).toContain("'RESTORE_LOCAL_BUSINESS'");
    expect(auditAlter).not.toContain("'MANAGE_COMPANY'");

    const repairAlter = alterSqls(runner).find((sql) => sql.includes('`repair_request`'));
    expect(repairAlter).toBeDefined();
    expect(repairAlter).toContain('DROP CHECK `chk_repair_request_closure`');
    expect(repairAlter).toContain('ADD CONSTRAINT `chk_repair_request_closure`');
    expect(repairAlter).toContain('CASE WHEN `closure_status` IS NULL');
    expect(repairAlter).toContain('ELSE FALSE END) = TRUE');
  });

  it('同步冲突字段先以 NULL 补齐，仅给后续 INSERT 设置 PENDING 默认值', async () => {
    const runner = new FakeQueryRunner(BASE);

    await migration.up(asQueryRunner(runner));

    const addColumns = alterSqls(runner).find((sql) => sql.includes('ADD COLUMN `local_version`'));
    expect(addColumns).toBeDefined();
    expect(addColumns).toContain('ADD COLUMN `local_version` int unsigned NULL DEFAULT NULL');
    expect(addColumns).toContain('ADD COLUMN `decision` varchar(24) NULL DEFAULT NULL');
    expect(addColumns).not.toContain("DEFAULT 'PENDING'");
    expect(
      runner.queries.some((item) =>
        item.sql.includes("ALTER COLUMN `decision` SET DEFAULT 'PENDING'"),
      ),
    ).toBe(true);
    expect(runner.queries.some((item) => /^UPDATE\b/i.test(item.sql.trim()))).toBe(false);

    const checks = alterSqls(runner).find((sql) => sql.includes('chk_sync_conflict_versions'));
    expect(checks).toBeDefined();
    expect(checks).toContain('ADD CONSTRAINT `chk_sync_conflict_versions`');
    expect(checks).toContain('ADD CONSTRAINT `chk_sync_conflict_decision`');
  });

  it('同步冲突同名字段定义不符时拒绝复用且不执行该表 ALTER', async () => {
    const runner = new FakeQueryRunner({
      ...BASE,
      syncColumns: [
        {
          columnName: 'local_version',
          columnType: 'int',
          isNullable: 'YES',
          columnDefault: null,
          extra: '',
          generationExpression: '',
        },
      ],
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(/同步冲突字段只存在部分列/);
    expect(alterSqls(runner).some((sql) => sql.includes('`sync_conflict`'))).toBe(false);
  });

  it('部分 DDL 失败时保留失败步骤与已完成步骤，不声称整体回滚', async () => {
    const runner = new FakeQueryRunner({ ...BASE, failAtAlter: 2 });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(
      /D3 结构缺口迁移失败；已完成 \[旧审计操作扫描、旧结单数据扫描、审计操作约束替换\]/,
    );
  });
});
