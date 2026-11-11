import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('sync_conflict', { comment: '同步冲突表' })
@Index('uk_sync_conflict_scope', ['recordUuid', 'organizationId', 'resourceType', 'versionNo'], {
  unique: true,
})
@Index('idx_sync_conflict_organization_status', ['organizationId', 'status', 'createdAt'])
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_sync_conflict_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['confirmedByAccountId'], ['id'], {
  name: 'fk_sync_conflict_confirmer',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_sync_conflict_schema',
  [
    'JSON_VALID(`local_snapshot`)',
    'JSON_VALID(`cloud_snapshot`)',
    "JSON_EXTRACT(`local_snapshot`, '$.schema_version') IS NOT NULL",
    "JSON_TYPE(JSON_EXTRACT(`local_snapshot`, '$.schema_version')) <> 'NULL'",
    "JSON_EXTRACT(`cloud_snapshot`, '$.schema_version') IS NOT NULL",
    "JSON_TYPE(JSON_EXTRACT(`cloud_snapshot`, '$.schema_version')) <> 'NULL'",
  ].join(' AND '),
)
@Check(
  'chk_sync_conflict_versions',
  '(`local_version` IS NULL AND `cloud_version` IS NULL) OR (`local_version` IS NOT NULL AND `cloud_version` IS NOT NULL)',
)
@Check(
  'chk_sync_conflict_decision',
  "`decision` IS NULL OR `decision` IN ('PENDING', 'LOCAL', 'CLOUD')",
)
export class SyncConflictEntity {
  @PrimaryColumn({ name: 'conflict_id', type: 'char', length: 36, comment: '冲突ID' })
  conflictId!: string;

  @Column({ name: 'record_uuid', type: 'char', length: 36, comment: '业务稳定编号' })
  recordUuid!: string;

  @Column({ name: 'organization_id', type: 'int', comment: '公司数据区' })
  organizationId!: number;

  @Column({ name: 'resource_type', type: 'varchar', length: 32, comment: '冲突资源类型' })
  resourceType!: string;

  @Column({
    name: 'version_no',
    type: 'int',
    unsigned: true,
    comment: '旧冲突版本号（不映射本地/云端）',
  })
  versionNo!: number;

  @Column({
    name: 'local_version',
    type: 'int',
    unsigned: true,
    nullable: true,
    comment: '本地数据版本；旧行 NULL 表示历史未知',
  })
  localVersion!: number | null;

  @Column({
    name: 'cloud_version',
    type: 'int',
    unsigned: true,
    nullable: true,
    comment: '云端数据版本；旧行 NULL 表示历史未知',
  })
  cloudVersion!: number | null;

  @Column({
    name: 'displayed_cloud_version',
    type: 'int',
    unsigned: true,
    nullable: true,
    comment: '已展示的云端版本；旧行 NULL 表示历史未知',
  })
  displayedCloudVersion!: number | null;

  @Column({
    type: 'varchar',
    length: 24,
    nullable: true,
    default: 'PENDING',
    comment: 'PENDING/LOCAL/CLOUD；旧行 NULL 表示历史未知',
  })
  decision!: string | null;

  @Column({ name: 'local_snapshot', type: 'longtext', comment: '本地快照 JSON' })
  localSnapshot!: string;

  @Column({ name: 'cloud_snapshot', type: 'longtext', comment: '云端快照 JSON' })
  cloudSnapshot!: string;

  @Column({ name: 'conflict_reason', type: 'text', comment: '可展示的冲突原因' })
  conflictReason!: string;

  @Column({ type: 'varchar', length: 16, comment: 'PENDING/RESOLVED/IGNORED' })
  status!: string;

  @Column({
    name: 'confirmed_by_account_id',
    type: 'int',
    nullable: true,
    comment: '确认处理人',
  })
  confirmedByAccountId!: number | null;

  @Column({
    name: 'confirmed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '确认时间',
  })
  confirmedAt!: Date | null;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
