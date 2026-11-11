import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('backup_asset', { comment: '云端备份资产表' })
@Index('idx_backup_asset_organization_status', ['organizationId', 'cloudStatus', 'createdAt'])
@Index('idx_backup_asset_installation', ['installationId', 'createdAt'])
@Check(
  'chk_backup_asset_manifest',
  '`manifest_checksum` IS NULL OR CHAR_LENGTH(`manifest_checksum`) = 64',
)
@Check('chk_backup_asset_format_version', '`format_version` IS NULL OR `format_version` >= 1')
@Check(
  'chk_backup_asset_local_cleanup',
  "((`local_status` = 'CLEANED' AND `local_reference` IS NULL) OR (`local_status` <> 'CLEANED' AND `deleted_at` IS NULL))",
)
@ForeignKey('LocalBackupRunEntity', ['runId'], ['id'], {
  name: 'fk_backup_asset_run',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_backup_asset_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('LocalBackupRunEntity', ['localCleanupRunId'], ['id'], {
  name: 'fk_backup_asset_cleanup_run',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class BackupAssetEntity {
  @PrimaryColumn({ name: 'backup_id', type: 'char', length: 36, comment: '备份资产ID' })
  backupId!: string;

  @Column({ name: 'run_id', type: 'int', comment: '对应本地备份运行ID' })
  runId!: number;

  @Column({ name: 'organization_id', type: 'int', comment: '公司数据区' })
  organizationId!: number;

  @Column({ name: 'local_cleanup_run_id', type: 'int', nullable: true, comment: '清理运行ID' })
  localCleanupRunId!: number | null;

  @Column({
    name: 'installation_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '产生备份的安装标识；历史未知为 NULL',
  })
  installationId!: string | null;

  @Column({
    name: 'format_version',
    type: 'int',
    unsigned: true,
    nullable: true,
    comment: '备份包格式版本；历史未知为 NULL',
  })
  formatVersion!: number | null;

  @Column({
    name: 'data_version',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '业务数据版本；历史未知为 NULL',
  })
  dataVersion!: string | null;

  @Column({
    name: 'manifest_checksum',
    type: 'char',
    length: 64,
    nullable: true,
    comment: '备份清单 SHA-256；历史未知为 NULL，不由 file_sha256 推定',
  })
  manifestChecksum!: string | null;

  @Column({
    name: 'local_reference',
    type: 'varchar',
    length: 1024,
    nullable: true,
    comment: '本地包引用；清理后为空',
  })
  localReference!: string | null;

  @Column({
    name: 'cloud_reference',
    type: 'varchar',
    length: 1024,
    nullable: true,
    comment: '云端对象引用；不从 storage_reference 推断',
  })
  cloudReference!: string | null;

  @Column({
    name: 'encryption_key_id',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '加密密钥标识；历史未知为 NULL',
  })
  encryptionKeyId!: string | null;

  @Column({
    name: 'verified_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近校验成功时间',
  })
  verifiedAt!: Date | null;

  @Column({
    name: 'retention_until',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '保留截止时间',
  })
  retentionUntil!: Date | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true, comment: '最近失败原因' })
  failureReason!: string | null;

  @Column({
    name: 'deleted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '本地包清理事实时间；历史 CLEANED 行无法证明时为 NULL',
  })
  deletedAt!: Date | null;

  @Column({
    name: 'local_cleanup_error',
    type: 'text',
    nullable: true,
    comment: '本地清理失败原因',
  })
  localCleanupError!: string | null;

  @Column({ name: 'storage_reference', type: 'varchar', length: 1024, comment: '云端私有引用' })
  storageReference!: string;

  @Column({ name: 'file_sha256', type: 'char', length: 64, comment: '备份文件 SHA-256' })
  fileSha256!: string;

  @Column({ name: 'byte_size', type: 'bigint', unsigned: true, comment: '备份文件字节数' })
  byteSize!: string;

  @Column({ name: 'cloud_status', type: 'varchar', length: 16, comment: '云端状态' })
  cloudStatus!: string;

  @Column({ name: 'local_status', type: 'varchar', length: 16, comment: '本地状态' })
  localStatus!: string;

  @Column({ name: 'cloud_receipt', type: 'text', nullable: true, comment: '云端回执' })
  cloudReceipt!: string | null;

  @Column({
    name: 'attempt_count',
    type: 'int',
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
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
