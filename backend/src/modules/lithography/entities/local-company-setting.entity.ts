import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('local_company_setting', { comment: '同机多公司配置表' })
@Check('chk_local_company_setting_backup_interval', '`backup_interval_hours` > 0')
@Check(
  'chk_local_company_setting_backup_schedule',
  '`backup_enabled` = 0 OR `next_backup_at` IS NOT NULL',
)
@Check('chk_local_company_setting_auto_upload', '`auto_upload_enabled` = 0 OR `backup_enabled` = 1')
@Index('uk_local_company_setting_scope', ['installationId', 'organizationId'], {
  unique: true,
})
@ForeignKey('LocalInstallationEntity', ['installationId'], ['installationId'], {
  name: 'fk_local_company_setting_installation',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_local_company_setting_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class LocalCompanySettingEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '配置ID' })
  id!: string;

  @Column({ name: 'installation_id', type: 'char', length: 36, comment: '本机安装标识' })
  installationId!: string;

  @Column({ name: 'organization_id', type: 'int', comment: '公司ID' })
  organizationId!: number;

  @Column({
    name: 'setting_source',
    type: 'varchar',
    length: 24,
    comment: 'LOCAL_MANUAL/CLOUD_MAPPING',
  })
  settingSource!: string;

  @Column({ name: 'is_current', type: 'boolean', default: false, comment: '是否当前生效' })
  isCurrent!: boolean;

  @Column({
    name: 'initialized_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '首次启用/初始化时间',
  })
  initializedAt!: Date;

  @Column({
    name: 'backup_interval_hours',
    type: 'int',
    unsigned: true,
    default: 72,
    comment: '备份间隔小时数',
  })
  backupIntervalHours!: number;

  @Column({
    name: 'backup_enabled',
    type: 'boolean',
    default: false,
    comment: '是否启用自动备份；默认关闭，迁移不自动开启',
  })
  backupEnabled!: boolean;

  @Column({
    name: 'next_backup_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '下次计划备份时间；旧行无证据时保持为空',
  })
  nextBackupAt!: Date | null;

  @Column({
    name: 'last_auto_success_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近自动备份成功时间',
  })
  lastAutoSuccessAt!: Date | null;

  @Column({
    name: 'last_auto_failure_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近自动备份失败时间',
  })
  lastAutoFailureAt!: Date | null;

  @Column({
    name: 'failure_reason',
    type: 'text',
    nullable: true,
    comment: '最近一次自动备份失败原因',
  })
  failureReason!: string | null;

  @Column({
    name: 'auto_upload_enabled',
    type: 'boolean',
    default: false,
    comment: '自动备份成功后是否自动上传',
  })
  autoUploadEnabled!: boolean;

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
