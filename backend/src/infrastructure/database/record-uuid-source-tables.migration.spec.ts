import type { QueryRunner } from 'typeorm';

import { AddRecordUuidToSourceTablesForV131775502800000 } from './migrations/1775502800000-add-record-uuid-to-source-tables.migration';

interface FakeOptions {
  readonly existingColumn?: string;
  readonly missingTable?: string;
  readonly failOn?: string;
}

class FakeQueryRunner {
  readonly queries: string[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  hasTable(table: string): Promise<boolean> {
    return Promise.resolve(table !== this.options.missingTable);
  }

  hasColumn(_table: string, column: string): Promise<boolean> {
    return Promise.resolve(column === this.options.existingColumn);
  }

  query(sql: string): Promise<unknown> {
    if (this.options.failOn !== undefined && sql.includes(this.options.failOn)) {
      return Promise.reject(new Error('simulated DDL failure'));
    }
    this.queries.push(sql);
    return Promise.resolve(undefined);
  }
}

const runUp = async (options: FakeOptions = {}): Promise<FakeQueryRunner> => {
  const runner = new FakeQueryRunner(options);
  await new AddRecordUuidToSourceTablesForV131775502800000().up(runner as unknown as QueryRunner);
  return runner;
};

describe('第 50 条业务源表稳定身份迁移', () => {
  it('三张源表各追加可空 record_uuid 与唯一索引，且不新建表', async () => {
    const runner = await runUp();

    expect(runner.queries).toHaveLength(3);
    const cases = [
      { table: 'repair_request', index: 'uk_repair_request_record_uuid' },
      { table: 'reference_document', index: 'uk_reference_document_record_uuid' },
      { table: 'maintenance_report', index: 'uk_maintenance_report_record_uuid' },
    ] as const;

    for (const [position, item] of cases.entries()) {
      const alter = runner.queries[position];
      expect(alter).toMatch(new RegExp(`ALTER TABLE \`${item.table}\``));
      expect(alter).toContain(
        'ADD COLUMN `record_uuid` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL',
      );
      expect(alter).toContain(`ADD UNIQUE KEY \`${item.index}\` (\`record_uuid\`)`);
      // 历史行保持 NULL：不回填、不改写既有派生 UUID 事实
      expect(alter).not.toMatch(/UPDATE/);
      expect(alter).not.toMatch(/CREATE TABLE/);
    }
  });

  it('目标列已存在时在任何 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({ existingColumn: 'record_uuid' });

    await expect(
      new AddRecordUuidToSourceTablesForV131775502800000().up(runner as unknown as QueryRunner),
    ).rejects.toThrow(/半迁移状态：repair_request\.record_uuid 已存在/);
    expect(runner.queries).toHaveLength(0);
  });

  it('前置表缺失时在任何 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({ missingTable: 'maintenance_report' });

    await expect(
      new AddRecordUuidToSourceTablesForV131775502800000().up(runner as unknown as QueryRunner),
    ).rejects.toThrow(/迁移前置表缺失：maintenance_report/);
    expect(runner.queries).toHaveLength(0);
  });

  it('DDL 失败时补充步骤与续跑提示，并保留原始原因', async () => {
    await expect(
      runUp({ failOn: 'ADD UNIQUE KEY `uk_repair_request_record_uuid`' }),
    ).rejects.toThrow(
      /第 50 条迁移失败于「repair_request 追加稳定身份列与唯一索引」[\s\S]*simulated DDL failure/,
    );
  });

  it('down 先删唯一索引，再删列', async () => {
    const runner = new FakeQueryRunner();
    await new AddRecordUuidToSourceTablesForV131775502800000().down(
      runner as unknown as QueryRunner,
    );

    expect(runner.queries).toHaveLength(6);
    expect(runner.queries[0]).toContain('DROP INDEX `uk_repair_request_record_uuid`');
    expect(runner.queries[1]).toContain('DROP COLUMN `record_uuid`');
    expect(runner.queries[4]).toContain('DROP INDEX `uk_maintenance_report_record_uuid`');
    expect(runner.queries[5]).toContain('DROP COLUMN `record_uuid`');
  });
});
