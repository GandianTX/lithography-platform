// S5 剩余裁决（Q11/Q13/Q16/Q17/Q18）的离线迁移行为规格。
//
// 不连接实库：用 FakeQueryRunner 记录迁移发出的 SQL，验证
//   1. 兼容性预检只拒绝真实冲突（sync_receipt 四列重复组），且发生在首次 DDL 前；
//   2. 旧行原地保留：不 DELETE、不伪造回填，新增事实列对历史行保持 NULL；
//   3. Q11 备份调度/自动上传组合、Q13 检查结论域与组合、Q16 仅本机目标外键、
//      Q17 兼容列与确认时间、Q18 故障生命周期与原始字段分离；
//   4. 部分 DDL 失败时的诊断边界（步骤名、已完成步骤、不声称整体回滚）；
//   5. 回退顺序：先删引用新列的约束/外键，再删列并恢复旧域。
import type { QueryRunner } from 'typeorm';

import { CloseS5StructuralGapsForV131775501900000 } from './migrations/1775501900000-close-s5-structural-gaps-for-v13.migration';

interface FakeOptions {
  readonly columns?: Readonly<Record<string, readonly string[]>>;
  readonly checks?: Readonly<Record<string, readonly string[]>>;
  readonly indexes?: Readonly<Record<string, readonly string[]>>;
  readonly duplicateGroups?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** 第 N 条 ALTER（1 起）抛错，用于验证部分 DDL 诊断。 */
  readonly failAtAlter?: number;
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

    if (sql.includes('information_schema.columns')) {
      const table = asParamString(params?.[0]);
      const column = asParamString(params?.[1]);
      return Promise.resolve(
        (this.options.columns?.[table] ?? []).includes(column) ? [{ exists: 1 }] : [],
      );
    }
    if (sql.includes('information_schema.table_constraints')) {
      const table = asParamString(params?.[0]);
      const constraint = asParamString(params?.[1]);
      return Promise.resolve(
        (this.options.checks?.[table] ?? []).includes(constraint) ? [{ exists: 1 }] : [],
      );
    }
    if (sql.includes('information_schema.statistics')) {
      const table = asParamString(params?.[0]);
      const index = asParamString(params?.[1]);
      return Promise.resolve(
        (this.options.indexes?.[table] ?? []).includes(index) ? [{ exists: 1 }] : [],
      );
    }
    if (sql.includes('HAVING COUNT(*) > 1')) {
      return Promise.resolve(this.options.duplicateGroups ?? []);
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

const migration = new CloseS5StructuralGapsForV131775501900000();

/** 已执行旧版增量、repair_request 已带 is_historical 的库。 */
const EXISTING_SCHEMA: FakeOptions = {
  columns: { repair_request: ['is_historical'] },
  checks: {
    sync_receipt: ['chk_sync_receipt_confirmed'],
    backup_restore_run: [
      'chk_backup_restore_run_status',
      'chk_backup_restore_run_finish',
      'chk_backup_restore_run_protection',
    ],
    maintenance_report_fault: [
      'chk_maintenance_report_fault_status',
      'chk_maintenance_report_fault_source',
    ],
  },
  indexes: { sync_receipt: ['uk_sync_receipt_scope'] },
};

describe('S5 剩余裁决迁移（不连接实库）', () => {
  it('四列重复组在首次 DDL 前拒绝，并给出样本与处置约束', async () => {
    const runner = new FakeQueryRunner({
      ...EXISTING_SCHEMA,
      duplicateGroups: [
        { organization_id: 7, resource_type: 'REPAIR', record_uuid: 'dup-uuid', version_no: 3 },
      ],
    });

    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(/四列唯一键存在重复组/);
    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(/dup-uuid/);
    await expect(migration.up(asQueryRunner(runner))).rejects.toThrow(/未执行任何 ALTER/);
    expect(alterSqls(runner)).toHaveLength(0);
  });

  it('旧行原地保留：不删除、不为四表伪造回填，仅回填可证明的初始化时间', async () => {
    const runner = new FakeQueryRunner(EXISTING_SCHEMA);

    await migration.up(asQueryRunner(runner));

    const statements = runner.queries.map((item) => item.sql.trim());
    expect(statements.some((sql) => /^DELETE\b/i.test(sql))).toBe(false);
    const updates = statements.filter((sql) => sql.startsWith('UPDATE'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('`local_company_setting`');
    expect(updates[0]).toContain('`initialized_at` = `created_at`');
    expect(updates.join('\n')).not.toMatch(/INSERT INTO/i);
  });

  it('Q11：旧行默认关闭备份/自动上传，且启用备份必须有下一次执行时间', async () => {
    const runner = new FakeQueryRunner(EXISTING_SCHEMA);

    await migration.up(asQueryRunner(runner));

    const alter = alterSqls(runner).find((sql) => sql.includes('`backup_interval_hours`'));
    expect(alter).toBeDefined();
    expect(alter).toContain("`backup_enabled` tinyint(1) NOT NULL DEFAULT '0'");
    expect(alter).toContain('`next_backup_at` timestamp(3) NULL DEFAULT NULL');
    expect(alter).toContain("`auto_upload_enabled` tinyint(1) NOT NULL DEFAULT '0'");
    const checks = alterSqls(runner)
      .filter((sql) => sql.includes('chk_local_company_setting'))
      .join('\n');
    expect(checks).toContain('CHECK (`backup_enabled` = 0 OR `next_backup_at` IS NOT NULL)');
    expect(checks).toContain('CHECK (`auto_upload_enabled` = 0 OR `backup_enabled` = 1)');
    const update = runner.queries
      .map((item) => item.sql)
      .find((sql) => sql.includes('SET `initialized_at` = `created_at`'));
    expect(update).toContain('`next_backup_at` = NULL');
    expect(update).not.toMatch(/`backup_enabled` = 1/);
  });

  it('Q17：source_system 退出四列唯一键，确认时间兼容旧值且不强制双写', async () => {
    const runner = new FakeQueryRunner(EXISTING_SCHEMA);

    await migration.up(asQueryRunner(runner));

    const swap = alterSqls(runner).find((sql) => sql.includes('`uk_sync_receipt_scope_v13`'));
    expect(swap).toBeDefined();
    expect(swap).toContain('DROP INDEX `uk_sync_receipt_scope`');
    expect(swap).toContain(
      'ADD UNIQUE KEY `uk_sync_receipt_scope_v13`\n          ' +
        '(`organization_id`, `resource_type`, `record_uuid`, `version_no`)',
    );
    const uniqueKey = (swap as string).slice((swap as string).indexOf('uk_sync_receipt_scope_v13'));
    expect(uniqueKey).not.toContain('source_system');
    expect(swap).toContain('ADD COLUMN `source_installation_id` char(36) NULL DEFAULT NULL');
    expect(swap).toContain('ADD COLUMN `received_at` timestamp(3) NULL DEFAULT NULL');

    expect(
      alterSqls(runner).some((sql) => sql.includes('DROP CHECK `chk_sync_receipt_confirmed`')),
    ).toBe(true);
    const confirmTime = alterSqls(runner).find((sql) =>
      sql.includes('`chk_sync_receipt_confirm_time`'),
    );
    expect(confirmTime).toBeDefined();
    expect(confirmTime).toContain('`received_at` IS NOT NULL');
    expect(confirmTime).toContain('`confirmed_at` IS NOT NULL');
  });

  it('Q18：备份事实列对历史行保持 NULL，且不伪造清单/云端引用', async () => {
    const runner = new FakeQueryRunner(EXISTING_SCHEMA);

    await migration.up(asQueryRunner(runner));

    const alter = alterSqls(runner).find((sql) => sql.includes('ADD COLUMN `installation_id`'));
    expect(alter).toBeDefined();
    for (const column of [
      'installation_id',
      'format_version',
      'data_version',
      'manifest_checksum',
      'local_reference',
      'cloud_reference',
      'encryption_key_id',
      'verified_at',
      'retention_until',
      'deleted_at',
    ]) {
      expect(alter).toContain(`ADD COLUMN \`${column}\``);
    }
    expect(alter).toContain('NULL DEFAULT NULL');
    expect(alter).toContain(
      'CHECK (`manifest_checksum` IS NULL OR CHAR_LENGTH(`manifest_checksum`) = 64)',
    );
    expect(alter).toContain('CHECK (`format_version` IS NULL OR `format_version` >= 1)');
    // 旧 CLEANED 行无法证明 deleted_at，不能要求非空。
    expect(alter).toContain("(`local_status` = 'CLEANED' AND `local_reference` IS NULL)");
    // Q16：installation_id 语义可能为远端来源机器，本轮不建外键。
    expect(alter).not.toContain('FOREIGN KEY (`installation_id`)');
  });

  it('Q13/Q16：恢复检查结论 NULL 为历史未知，非法组合被约束；仅目标安装建外键', async () => {
    const runner = new FakeQueryRunner(EXISTING_SCHEMA);

    await migration.up(asQueryRunner(runner));

    const addColumns = alterSqls(runner).find((sql) =>
      sql.includes('ADD COLUMN `target_installation_id`'),
    );
    expect(addColumns).toBeDefined();
    expect(addColumns).toContain('ADD COLUMN `check_status` varchar(16) NULL DEFAULT NULL');
    expect(addColumns).toContain('ADD COLUMN `confirmation` json NULL DEFAULT NULL');
    expect(addColumns).toContain(
      'FOREIGN KEY (`target_installation_id`) REFERENCES `local_installation` (`installation_id`)',
    );

    const guards = alterSqls(runner).find((sql) =>
      sql.includes('`chk_backup_restore_run_execution_guard`'),
    );
    expect(guards).toBeDefined();
    // 历史行无确认原文，执行阶段不得强制 confirmation。
    expect(guards).not.toMatch(/status` IN \('RUNNING'[\s\S]*`confirmation` IS NOT NULL/);

    const checkStatus = alterSqls(runner).find((sql) =>
      sql.includes('`chk_backup_restore_run_check_status`'),
    );
    expect(checkStatus).toContain("'PENDING', 'PASSED', 'FAILED'");
    expect(checkStatus).toContain('`check_status` IS NULL');

    const outcome = alterSqls(runner).find((sql) =>
      sql.includes('`chk_backup_restore_run_check_outcome`'),
    );
    expect(outcome).toContain('`check_status` IS NULL');
    expect(outcome).toContain("`check_status` <> 'PASSED'");
  });

  it('Q18：故障生命周期改名保留旧义，原始八字段与 phase_code 单独可空，不互相转换', async () => {
    const runner = new FakeQueryRunner(EXISTING_SCHEMA);

    await migration.up(asQueryRunner(runner));

    const rename = alterSqls(runner).find((sql) =>
      sql.includes('CHANGE COLUMN `status` `lifecycle_status`'),
    );
    expect(rename).toBeDefined();
    expect(rename).toContain('CHANGE COLUMN `source` `lifecycle_source`');
    expect(rename).not.toContain('`main_error`');

    const raw = alterSqls(runner).find((sql) => sql.includes('ADD COLUMN `main_error`'));
    expect(raw).toBeDefined();
    for (const column of [
      'main_error',
      'unit_error',
      'error_type',
      'gpib_status',
      'status',
      'source',
    ]) {
      expect(raw).toContain(`ADD COLUMN \`${column}\``);
    }
    expect(raw).toContain('ADD COLUMN `phase_code` varchar(32) NULL DEFAULT NULL');
    expect(raw).toContain('ADD COLUMN `is_active` tinyint(1) NULL DEFAULT NULL');
    // 不得从生命周期字段派生原始八字段。
    expect(raw).not.toMatch(/UPDATE/i);

    const checks = alterSqls(runner).find((sql) =>
      sql.includes('`chk_maintenance_report_fault_phase_code`'),
    );
    expect(checks).toContain("'PHASE_01'");
    expect(checks).toContain("'PHASE_10'");
    expect(checks).toContain('`phase_code` IS NULL');
    expect(checks).toContain('`is_active` IS NULL OR `is_active` IN (0, 1)');
  });

  it('部分 DDL 失败：报告失败步骤、已完成步骤与不整体回滚的诊断边界', async () => {
    const runner = new FakeQueryRunner({ ...EXISTING_SCHEMA, failAtAlter: 3 });

    let captured: Error | null = null;
    try {
      await migration.up(asQueryRunner(runner));
    } catch (error) {
      captured = error as Error;
    }

    expect(captured).not.toBeNull();
    expect((captured as Error).message).toMatch(/步骤「/);
    expect((captured as Error).message).toMatch(/已完成 DDL 步骤：/);
    expect((captured as Error).message).toMatch(/不声称整体回滚/);
    expect(alterSqls(runner)).toHaveLength(3);
  });

  it('回退：先删约束/外键再删列，并恢复旧检查与旧唯一键', async () => {
    const runner = new FakeQueryRunner({
      columns: {
        repair_request: ['is_historical'],
        sync_receipt: ['received_at', 'remote_resource_id', 'source_installation_id'],
        backup_asset: ['installation_id'],
        backup_restore_run: ['target_installation_id'],
        maintenance_report_fault: ['phase_code'],
        local_account_authorization: ['signed_claims'],
        local_company_setting: ['backup_enabled'],
      },
      checks: {
        sync_receipt: ['chk_sync_receipt_confirm_time'],
        backup_asset: [
          'chk_backup_asset_local_cleanup',
          'chk_backup_asset_format_version',
          'chk_backup_asset_manifest',
        ],
        backup_restore_run: [
          'chk_backup_restore_run_check_outcome',
          'chk_backup_restore_run_check_status',
          'chk_backup_restore_run_execution_guard',
        ],
        maintenance_report_fault: [
          'chk_maintenance_report_fault_active',
          'chk_maintenance_report_fault_phase_code',
        ],
      },
      indexes: { sync_receipt: ['uk_sync_receipt_scope_v13'] },
    });

    await migration.down(asQueryRunner(runner));

    const statements = runner.queries.map((item) => item.sql.trim());
    const dropConfirm = statements.findIndex((sql) =>
      sql.includes('DROP CHECK `chk_sync_receipt_confirm_time`'),
    );
    const dropReceived = statements.findIndex((sql) => sql.includes('DROP COLUMN `received_at`'));
    expect(dropConfirm).toBeGreaterThanOrEqual(0);
    expect(dropConfirm).toBeLessThan(dropReceived);

    const dropTargetFk = statements.findIndex((sql) =>
      sql.includes('DROP FOREIGN KEY `fk_backup_restore_run_target`'),
    );
    const dropTargetColumn = statements.findIndex((sql) =>
      sql.includes('DROP COLUMN `target_installation_id`'),
    );
    expect(dropTargetFk).toBeGreaterThanOrEqual(0);
    expect(dropTargetFk).toBeLessThan(dropTargetColumn);

    const restoreSync = statements.find((sql) =>
      sql.includes('ADD CONSTRAINT `chk_sync_receipt_confirmed`'),
    );
    expect(restoreSync).toContain('ADD UNIQUE KEY `uk_sync_receipt_scope`');
    expect(restoreSync).toContain('`source_system`');
  });
});
