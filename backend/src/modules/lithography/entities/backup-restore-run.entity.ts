import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('backup_restore_run', { comment: '备份恢复运行表' })
@Index('idx_backup_restore_run_organization', ['organizationId', 'startedAt'])
@ForeignKey('BackupAssetEntity', ['backupId'], ['backupId'], {
  name: 'fk_backup_restore_run_backup',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('BackupAssetEntity', ['protectionBackupId'], ['backupId'], {
  name: 'fk_backup_restore_run_protection',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_backup_restore_run_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['startedByAccountId'], ['id'], {
  name: 'fk_backup_restore_run_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('LocalInstallationEntity', ['targetInstallationId'], ['installationId'], {
  name: 'fk_backup_restore_run_target',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_backup_restore_run_schema',
  [
    'JSON_VALID(`check_snapshot`)',
    "JSON_EXTRACT(`check_snapshot`, '$.schema_version') IS NOT NULL",
    "JSON_TYPE(JSON_EXTRACT(`check_snapshot`, '$.schema_version')) <> 'NULL'",
  ].join(' AND '),
)
@Check(
  'chk_backup_restore_run_status',
  "`status` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')",
)
@Check(
  'chk_backup_restore_run_finish',
  "((`status` = 'PENDING' AND `started_at` IS NULL AND `finished_at` IS NULL) OR (`status` = 'RUNNING' AND `started_at` IS NOT NULL AND `finished_at` IS NULL) OR (`status` IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED') AND `finished_at` IS NOT NULL))",
)
@Check(
  'chk_backup_restore_run_protection',
  '`protection_backup_id` IS NULL OR `protection_backup_id` <> `backup_id`',
)
@Check(
  'chk_backup_restore_run_execution_guard',
  "(CASE WHEN `status` = 'PENDING' THEN `protection_backup_id` IS NULL AND `confirmation` IS NULL WHEN `status` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED') THEN `started_at` IS NOT NULL AND `protection_backup_id` IS NOT NULL ELSE FALSE END)",
)
@Check(
  'chk_backup_restore_run_check_status',
  "`check_status` IS NULL OR `check_status` IN ('PENDING', 'PASSED', 'FAILED')",
)
@Check(
  'chk_backup_restore_run_check_outcome',
  "((`check_status` IS NULL OR (`status` = 'SUCCEEDED' AND `check_status` <> 'FAILED') OR (`status` NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED'))) AND (`check_status` IS NULL OR `status` NOT IN ('FAILED', 'INTERRUPTED') OR `check_status` <> 'PASSED'))",
)
export class BackupRestoreRunEntity {
  @PrimaryColumn({ name: 'restore_id', type: 'char', length: 36, comment: '恢复运行ID' })
  restoreId!: string;

  @Column({ name: 'backup_id', type: 'char', length: 36, comment: '被恢复的备份资产ID' })
  backupId!: string;

  @Column({
    name: 'protection_backup_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '保护备份ID；预检阶段可空，执行阶段必须非空',
  })
  protectionBackupId!: string | null;

  @Column({
    name: 'target_installation_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '实际恢复目标安装标识；历史未知为 NULL',
  })
  targetInstallationId!: string | null;

  @Column({
    name: 'check_status',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '恢复前检查结论：PENDING/PASSED/FAILED；历史未知为 NULL',
  })
  checkStatus!: string | null;

  @Column({
    name: 'confirmation',
    type: 'json',
    nullable: true,
    comment: '执行前确认原文；执行阶段必须非空',
  })
  confirmation!: unknown;

  @Column({ name: 'organization_id', type: 'int', comment: '恢复目标公司数据区' })
  organizationId!: number;

  @Column({ name: 'started_by_account_id', type: 'int', comment: '实际发起人账号ID' })
  startedByAccountId!: number;

  @Column({ type: 'varchar', length: 16, comment: '恢复状态' })
  status!: string;

  @Column({ name: 'check_snapshot', type: 'longtext', comment: '恢复前核对结果 JSON' })
  checkSnapshot!: string;

  @Column({ name: 'restored_scope', type: 'text', nullable: true, comment: '恢复范围' })
  restoredScope!: string | null;

  @Column({ name: 'result_summary', type: 'text', nullable: true, comment: '结果摘要' })
  resultSummary!: string | null;

  @Column({
    name: 'started_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '实际开始时间；预检阶段为空',
  })
  startedAt!: Date | null;

  @Column({
    name: 'finished_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '结束时间',
  })
  finishedAt!: Date | null;
}
