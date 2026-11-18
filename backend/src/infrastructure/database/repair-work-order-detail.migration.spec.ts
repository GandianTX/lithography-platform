import type { QueryRunner } from 'typeorm';

import { AddRepairWorkOrderDetailForV131775502600000 } from './migrations/1775502600000-add-repair-work-order-detail-for-v13.migration';

const NEW_TABLES = ['repair_request_diagnostic_step', 'repair_request_fault_panel'];

interface FakeOptions {
  readonly existingColumn?: string;
  readonly existingTable?: string;
  readonly failOn?: string;
}

class FakeQueryRunner {
  readonly queries: string[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  hasTable(table: string): Promise<boolean> {
    if (table === this.options.existingTable) {
      return Promise.resolve(true);
    }
    return Promise.resolve(!NEW_TABLES.includes(table));
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
  await new AddRepairWorkOrderDetailForV131775502600000().up(runner as unknown as QueryRunner);
  return runner;
};

describe('第 48 条工单维修事实迁移', () => {
  it('按工单列 → 步骤表 → 面板表顺序执行，并落地唯一槽与复合外键', async () => {
    const runner = await runUp();

    expect(runner.queries).toHaveLength(3);
    const [requestAlter, stepCreate, panelCreate] = runner.queries;
    expect(requestAlter).toMatch(/ALTER TABLE `repair_request`/);
    for (const column of [
      'maintenance_date',
      'maintenance_engineer_name_snapshot',
      'reset_result',
      'supplementary_note',
      'maintenance_attachment_file_id',
      'maintenance_version_no',
    ]) {
      expect(requestAlter).toContain(`ADD COLUMN \`${column}\``);
    }
    expect(requestAlter).toContain('ADD UNIQUE KEY `uk_repair_request_maintenance_attachment`');
    expect(requestAlter).toContain(
      'FOREIGN KEY (`maintenance_attachment_file_id`) REFERENCES `stored_file` (`file_id`)',
    );

    expect(stepCreate).toMatch(/CREATE TABLE `repair_request_diagnostic_step`/);
    expect(stepCreate).toContain('UNIQUE KEY `uk_repair_request_diagnostic_step_id`');

    expect(panelCreate).toMatch(/CREATE TABLE `repair_request_fault_panel`/);
    expect(panelCreate).toContain(
      "GENERATED ALWAYS AS (IF(`panel_type` = 'INITIAL', `request_id`, NULL)) STORED",
    );
    expect(panelCreate).toContain(
      "GENERATED ALWAYS AS (IF(`panel_type` = 'RESET_NEW_FAULT', `request_id`, NULL)) STORED",
    );
    expect(panelCreate).toContain(
      'FOREIGN KEY (`request_id`, `step_id`) REFERENCES `repair_request_diagnostic_step` (`request_id`, `id`)',
    );
  });

  it('目标列已存在时在任何 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({ existingColumn: 'maintenance_date' });

    await expect(
      new AddRepairWorkOrderDetailForV131775502600000().up(runner as unknown as QueryRunner),
    ).rejects.toThrow(/半迁移状态：repair_request\.maintenance_date 已存在/);
    expect(runner.queries).toHaveLength(0);
  });

  it('目标表已存在时在任何 DDL 前失败关闭', async () => {
    const runner = new FakeQueryRunner({ existingTable: 'repair_request_fault_panel' });

    await expect(
      new AddRepairWorkOrderDetailForV131775502600000().up(runner as unknown as QueryRunner),
    ).rejects.toThrow(/半迁移状态：repair_request_fault_panel 已存在/);
    expect(runner.queries).toHaveLength(0);
  });

  it('DDL 失败时补充步骤与续跑提示，并保留原始原因', async () => {
    await expect(runUp({ failOn: 'CREATE TABLE `repair_request_fault_panel`' })).rejects.toThrow(
      /第 48 条迁移失败于「创建 repair_request_fault_panel」[\s\S]*simulated DDL failure/,
    );
  });

  it('down 先删面板和步骤，再移除工单列与附件约束', async () => {
    const runner = new FakeQueryRunner();
    await new AddRepairWorkOrderDetailForV131775502600000().down(runner as unknown as QueryRunner);

    expect(runner.queries[0]).toContain('DROP TABLE IF EXISTS `repair_request_fault_panel`');
    expect(runner.queries[1]).toContain('DROP TABLE IF EXISTS `repair_request_diagnostic_step`');
    expect(runner.queries[2]).toContain(
      'DROP FOREIGN KEY `fk_repair_request_maintenance_attachment`',
    );
    expect(runner.queries[2]).toContain('DROP COLUMN `maintenance_date`');
  });
});
