import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('local_installation', { comment: '本地部署身份与设置（单行）表' })
@Index('uk_local_installation_installation_id', ['installationId'], { unique: true })
@Index('idx_local_installation_organization', ['organizationId'])
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_local_installation_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_local_installation_singleton', '`id` = 1')
@Check('chk_local_installation_interval', '`backup_interval_days` >= 1')
export class LocalInstallationEntity {
  @PrimaryColumn({ type: 'tinyint', unsigned: true, comment: '单例行，恒为 1' })
  id!: number;

  @Column({
    name: 'installation_id',
    type: 'char',
    length: 36,
    comment: '稳定安装标识（UUID），本地来源标识',
  })
  installationId!: string;

  @Column({
    name: 'organization_id',
    type: 'int',
    nullable: true,
    comment: '云端组织映射；未映射为空',
  })
  organizationId!: number | null;

  @Column({
    name: 'organization_code_snapshot',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '映射时组织编码留痕',
  })
  organizationCodeSnapshot!: string | null;

  @Column({
    name: 'local_site_name',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '现场名称',
  })
  localSiteName!: string | null;

  @Column({
    name: 'auto_upload_enabled',
    type: 'boolean',
    default: false,
    comment: '自动上传开关；默认关闭',
  })
  autoUploadEnabled!: boolean;

  @Column({
    name: 'backup_interval_days',
    type: 'smallint',
    unsigned: true,
    default: 3,
    comment: '自动备份间隔天数',
  })
  backupIntervalDays!: number;

  @Column({
    name: 'last_backup_completed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近成功备份完成时间',
  })
  lastBackupCompletedAt!: Date | null;

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
