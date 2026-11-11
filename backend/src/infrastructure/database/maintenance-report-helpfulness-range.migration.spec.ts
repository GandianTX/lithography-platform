import type { QueryRunner } from 'typeorm';

import { RestoreMaintenanceReportHelpfulnessRangeForV131775501800000 } from './migrations/1775501800000-restore-maintenance-report-helpfulness-range-for-v13.migration';

const CONSTRAINT = 'chk_maintenance_report_ai_helpfulness';

interface FakeOptions {
  readonly constraintPresent?: boolean;
  readonly failAlter?: boolean;
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
    const trimmed = sql.trim();
    if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
      const present = this.options.constraintPresent ?? true;
      return Promise.resolve(present ? [{ present: 1 }] : []);
    }
    if (trimmed.startsWith('ALTER TABLE')) {
      if (this.options.failAlter === true) {
        return Promise.reject(new Error('simulated ALTER failure'));
      }
      return Promise.resolve(undefined);
    }
    return Promise.resolve([]);
  }

  get alters(): ReadonlyArray<RecordedQuery> {
    return this.queries.filter((item) => item.sql.trim().startsWith('ALTER TABLE'));
  }
}

const runUp = async (options: FakeOptions = {}): Promise<FakeQueryRunner> => {
  const runner = new FakeQueryRunner(options);
  await new RestoreMaintenanceReportHelpfulnessRangeForV131775501800000().up(
    runner as unknown as QueryRunner,
  );
  return runner;
};

describe('恢复 ai_helpfulness 1—5 的追加修复迁移', () => {
  it('约束已存在时先 DROP 再 ADD，目标范围为 1—5', async () => {
    const runner = await runUp({ constraintPresent: true });

    expect(runner.alters).toHaveLength(1);
    const sql = runner.alters[0].sql;
    expect(sql).toContain(`DROP CONSTRAINT \`${CONSTRAINT}\``);
    expect(sql).toContain(`ADD CONSTRAINT \`${CONSTRAINT}\``);
    expect(sql).toMatch(/BETWEEN 1 AND 5/);
    expect(sql).not.toMatch(/BETWEEN 1 AND 4/);
  });

  it('约束缺失时只 ADD，便于部分失败后幂等续跑', async () => {
    const runner = await runUp({ constraintPresent: false });

    expect(runner.alters).toHaveLength(1);
    const sql = runner.alters[0].sql;
    expect(sql).not.toContain('DROP CONSTRAINT');
    expect(sql).toContain(`ADD CONSTRAINT \`${CONSTRAINT}\``);
    expect(sql).toMatch(/BETWEEN 1 AND 5/);
  });

  it('ALTER 失败时保留原始原因并说明续跑方式', async () => {
    await expect(runUp({ failAlter: true })).rejects.toThrow(
      /restore-ai-helpfulness-range[\s\S]*simulated ALTER failure/,
    );
  });

  it('down 有意不回退（不重新收紧为 1—4）', async () => {
    const runner = new FakeQueryRunner();
    await new RestoreMaintenanceReportHelpfulnessRangeForV131775501800000().down();

    expect(runner.queries).toHaveLength(0);
  });
});
