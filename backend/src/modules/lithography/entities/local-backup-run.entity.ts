import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 本地备份运行清单实体。
 *
 * 数据库另有生成列 `active_installation_id`（RUNNING 时为 installation_id，否则 NULL）
 * 与其唯一键，用于保证「同一安装同时只有一个 RUNNING 备份」的库级约束。
 * 按项目既定规则，生成列以只读列声明，保证 Entity 与迁移结构一致。
 * 结构真源见迁移 1775401400000-create-local-installation-upload-backup。
 */
@Entity('local_backup_run', { comment: '本地备份运行清单表' })
@Index('uk_local_backup_run_active', ['activeInstallationId'], { unique: true })
@Index('idx_local_backup_run_started', ['startedAt'])
@ForeignKey('LocalInstallationEntity', ['installationId'], ['installationId'], {
  name: 'fk_local_backup_run_installation',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_local_backup_run_trigger', "`trigger_type` IN ('SCHEDULED', 'MANUAL', 'USB_EXPORT')")
@Check(
  'chk_local_backup_run_status',
  "`status` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')",
)
@Check(
  'chk_local_backup_run_finish',
  "((`status` = 'RUNNING' AND `finished_at` IS NULL) OR (`status` <> 'RUNNING' AND `finished_at` IS NOT NULL))",
)
export class LocalBackupRunEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '备份运行主键ID' })
  id!: number;

  @Column({ name: 'installation_id', type: 'char', length: 36, comment: '本地安装标识' })
  installationId!: string;

  @Column({
    name: 'active_installation_id',
    type: 'char',
    length: 36,
    nullable: true,
    insert: false,
    update: false,
    asExpression: "IF(`status` = 'RUNNING', `installation_id`, NULL)",
    generatedType: 'STORED',
    comment: '生成列：RUNNING 时为安装标识，否则为 NULL（只读）',
  })
  activeInstallationId!: string | null;

  @Column({
    name: 'trigger_type',
    type: 'varchar',
    length: 16,
    comment: 'SCHEDULED/MANUAL/USB_EXPORT',
  })
  triggerType!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'RUNNING',
    comment: 'RUNNING/SUCCEEDED/FAILED/INTERRUPTED',
  })
  status!: string;

  @Column({ name: 'started_at', type: 'timestamp', precision: 3, comment: '开始时间' })
  startedAt!: Date;

  @Column({
    name: 'finished_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '结束时间；非 RUNNING 必填',
  })
  finishedAt!: Date | null;

  @Column({
    name: 'manifest_path',
    type: 'varchar',
    length: 512,
    nullable: true,
    comment: '清单文件位置',
  })
  manifestPath!: string | null;

  @Column({
    name: 'manifest_checksum',
    type: 'char',
    length: 64,
    nullable: true,
    comment: '清单 SHA-256',
  })
  manifestChecksum!: string | null;

  @Column({
    name: 'byte_size',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | null): number | null => (value === null ? null : Number(value)),
    },
    comment: '备份总字节数',
  })
  byteSize!: number | null;

  @Column({
    name: 'attachment_count',
    type: 'int',
    unsigned: true,
    nullable: true,
    comment: '附件条目数',
  })
  attachmentCount!: number | null;

  @Column({
    name: 'schema_version',
    type: 'smallint',
    unsigned: true,
    nullable: true,
    comment: '备份时结构版本/迁移号',
  })
  schemaVersion!: number | null;

  @Column({
    name: 'error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '失败错误码',
  })
  errorCode!: string | null;

  @Column({
    name: 'error_message',
    type: 'varchar',
    length: 1000,
    nullable: true,
    comment: '失败说明；不含凭据',
  })
  errorMessage!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '创建时间',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
    comment: '更新时间',
  })
  updatedAt!: Date;
}
