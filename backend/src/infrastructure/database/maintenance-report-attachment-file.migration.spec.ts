import type { QueryRunner } from 'typeorm';

import { AddMaintenanceReportAttachmentFileForV131775502700000 } from './migrations/1775502700000-add-maintenance-report-attachment-file-for-v13.migration';

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
  await new AddMaintenanceReportAttachmentFileForV131775502700000().up(
    runner as unknown as QueryRunner,
  );
  return runner;
};

describe('第 49 条报告附件关联原件迁移', () => {
  it('单条 ALTER 追加可空 file_id、索引与 RESTRICT 原件外键', async () => {
    const runner = await runUp();

    expect(runner.queries).toHaveLength(1);
    const [alter] = runner.queries;
    expect(alter).toMatch(/ALTER TABLE `maintenance_report_attachment`/);
    expect(alter).toContain(
      'ADD COLUMN `file_id` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL',
    );
    expect(alter).toContain('ADD KEY `idx_maintenance_report_attachment_file` (`file_id`)');
    expect(alter).toContain(
      'ADD CONSTRAINT `fk_maintenance_report_attachment_file` FOREIGN KEY (`file_id`) REFERENCES `stored_file` (`file_id`) ON DELETE RESTRICT ON UPDATE RESTRICT',
    );
    // 不新建表，也不改写冻结版本附件表。
    expect(alter).not.toMatch(/CREATE TABLE/);
    expect(alter).not.toContain('maintenance_report_version_attachment');
  });

  it('目标列已存在时在任何 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({ existingColumn: 'file_id' });

    await expect(
      new AddMaintenanceReportAttachmentFileForV131775502700000().up(
        runner as unknown as QueryRunner,
      ),
    ).rejects.toThrow(/半迁移状态：maintenance_report_attachment\.file_id 已存在/);
    expect(runner.queries).toHaveLength(0);
  });

  it('前置表缺失时在任何 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({ missingTable: 'stored_file' });

    await expect(
      new AddMaintenanceReportAttachmentFileForV131775502700000().up(
        runner as unknown as QueryRunner,
      ),
    ).rejects.toThrow(/迁移前置表缺失：stored_file/);
    expect(runner.queries).toHaveLength(0);
  });

  it('DDL 失败时补充步骤与续跑提示，并保留原始原因', async () => {
    await expect(
      runUp({ failOn: 'ADD CONSTRAINT `fk_maintenance_report_attachment_file`' }),
    ).rejects.toThrow(
      /第 49 条迁移失败于「maintenance_report_attachment 追加原件列与关联约束」[\s\S]*simulated DDL failure/,
    );
  });

  it('down 先删外键，再删索引，最后删列', async () => {
    const runner = new FakeQueryRunner();
    await new AddMaintenanceReportAttachmentFileForV131775502700000().down(
      runner as unknown as QueryRunner,
    );

    expect(runner.queries).toHaveLength(3);
    expect(runner.queries[0]).toContain('DROP FOREIGN KEY `fk_maintenance_report_attachment_file`');
    expect(runner.queries[1]).toContain('DROP INDEX `idx_maintenance_report_attachment_file`');
    expect(runner.queries[2]).toContain('DROP COLUMN `file_id`');
  });
});
