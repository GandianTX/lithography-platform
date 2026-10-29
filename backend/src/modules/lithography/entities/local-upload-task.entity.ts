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

@Entity('local_upload_task', { comment: '本地上传任务（幂等/回执）表' })
@Index('uk_local_upload_task_idempotency', ['idempotencyKey'], { unique: true })
@Index(
  'uk_local_upload_task_entity',
  ['installationId', 'entityType', 'entityLocalId', 'entityVersion'],
  {
    unique: true,
  },
)
@Index('idx_local_upload_task_status_created', ['status', 'createdAt'])
@ForeignKey('LocalInstallationEntity', ['installationId'], ['installationId'], {
  name: 'fk_local_upload_task_installation',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_local_upload_task_entity_type',
  "`entity_type` IN ('REPORT_VERSION', 'ATTACHMENT', 'BACKUP_MANIFEST')",
)
@Check(
  'chk_local_upload_task_status',
  "`status` IN ('PENDING', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELLED')",
)
@Check('chk_local_upload_task_attempt', '`attempt_count` >= 0')
@Check('chk_local_upload_task_version', 'CHAR_LENGTH(TRIM(`entity_version`)) > 0')
@Check('chk_local_upload_task_idempotency', 'CHAR_LENGTH(TRIM(`idempotency_key`)) > 0')
@Check(
  'chk_local_upload_task_error',
  "`status` <> 'FAILED' OR (`error_code` IS NOT NULL AND `error_message` IS NOT NULL)",
)
export class LocalUploadTaskEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '上传任务主键ID' })
  id!: number;

  @Column({ name: 'installation_id', type: 'char', length: 36, comment: '本地安装标识' })
  installationId!: string;

  @Column({
    name: 'entity_type',
    type: 'varchar',
    length: 32,
    comment: 'REPORT_VERSION/ATTACHMENT/BACKUP_MANIFEST',
  })
  entityType!: string;

  @Column({
    name: 'entity_local_id',
    type: 'int',
    unsigned: true,
    comment: '本地实体ID（仅本地语义）',
  })
  entityLocalId!: number;

  @Column({
    name: 'entity_version',
    type: 'varchar',
    length: 64,
    comment: '版本号或内容摘要',
  })
  entityVersion!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 191, comment: '幂等键' })
  idempotencyKey!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'PENDING',
    comment: 'PENDING/UPLOADING/SUCCEEDED/FAILED/CANCELLED',
  })
  status!: string;

  @Column({
    name: 'attempt_count',
    type: 'smallint',
    unsigned: true,
    default: 0,
    comment: '尝试次数',
  })
  attemptCount!: number;

  @Column({
    name: 'last_attempt_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近尝试时间',
  })
  lastAttemptAt!: Date | null;

  @Column({
    name: 'remote_id',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '云端返回标识（不反写业务主键）',
  })
  remoteId!: string | null;

  @Column({
    name: 'remote_receipt',
    type: 'varchar',
    length: 512,
    nullable: true,
    comment: '回执/摘要',
  })
  remoteReceipt!: string | null;

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
