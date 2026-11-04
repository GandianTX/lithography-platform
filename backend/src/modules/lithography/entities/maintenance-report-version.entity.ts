import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('maintenance_report_version', { comment: '维修报告冻结版本表' })
@Index('uk_maintenance_report_version_no', ['reportId', 'versionNo'], { unique: true })
@Index('uk_maintenance_report_version_id_report', ['id', 'reportId'], { unique: true })
@Index('idx_maintenance_report_version_submitted', ['reportId', 'submittedAt'])
@ForeignKey('MaintenanceReportEntity', ['reportId'], ['id'], {
  name: 'fk_maintenance_report_version_report',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['submittedByAccountId'], ['id'], {
  name: 'fk_maintenance_report_version_submitted_by',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_maintenance_report_version_no', '`version_no` >= 1')
@Check(
  'chk_maintenance_report_version_change_kind',
  "`change_kind` IN ('SUBMIT', 'FORMAL_CORRECTION')",
)
@Check(
  'chk_maintenance_report_version_correction_reason',
  "`change_kind` = 'SUBMIT' OR `change_reason` IS NOT NULL",
)
@Check('chk_maintenance_report_version_payload', 'JSON_VALID(`payload_snapshot`)')
@Check('chk_maintenance_report_version_schema', '`schema_version` >= 2')
export class MaintenanceReportVersionEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '冻结版本主键ID' })
  id!: number;

  @Column({ name: 'report_id', type: 'int', comment: '所属报告ID' })
  reportId!: number;

  @Column({ name: 'version_no', type: 'int', unsigned: true, comment: '版本号；从 1 递增' })
  versionNo!: number;

  @Column({
    name: 'change_kind',
    type: 'varchar',
    length: 24,
    default: 'SUBMIT',
    comment: 'SUBMIT/FORMAL_CORRECTION',
  })
  changeKind!: string;

  @Column({
    name: 'change_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '更正原因；正式更正必填',
  })
  changeReason!: string | null;

  @Column({
    name: 'schema_version',
    type: 'smallint',
    unsigned: true,
    default: 2,
    comment: '快照严格 schema 版本',
  })
  schemaVersion!: number;

  @Column({ name: 'payload_snapshot', type: 'json', comment: '冻结内容完整快照' })
  payloadSnapshot!: Record<string, unknown>;

  @Column({ name: 'submitted_by_account_id', type: 'int', comment: '提交人账号ID' })
  submittedByAccountId!: number;

  @Column({
    name: 'submitted_at',
    type: 'timestamp',
    precision: 3,
    comment: '冻结事件时间',
  })
  submittedAt!: Date;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '创建时间',
  })
  createdAt!: Date;
}
