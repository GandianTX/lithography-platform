import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('sync_receipt', { comment: '同步回执表' })
@Index('uk_sync_receipt_scope_v13', ['organizationId', 'resourceType', 'recordUuid', 'versionNo'], {
  unique: true,
})
@Index('idx_sync_receipt_organization_status', ['organizationId', 'receiptStatus', 'createdAt'])
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_sync_receipt_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class SyncReceiptEntity {
  @PrimaryColumn({ name: 'receipt_id', type: 'char', length: 36, comment: '回执ID' })
  receiptId!: string;

  @Column({ name: 'record_uuid', type: 'char', length: 36, comment: '业务稳定编号' })
  recordUuid!: string;

  @Column({ name: 'organization_id', type: 'int', comment: '公司数据区' })
  organizationId!: number;

  @Column({ name: 'resource_type', type: 'varchar', length: 32, comment: '同步资源类型' })
  resourceType!: string;

  @Column({ name: 'version_no', type: 'int', unsigned: true, comment: '同步版本号' })
  versionNo!: number;

  @Column({
    name: 'source_system',
    type: 'varchar',
    length: 16,
    comment: '兼容描述：旧版 LOCAL/CLOUD 来源维度，不参与四维唯一键',
  })
  sourceSystem!: string;

  @Column({
    name: 'source_installation_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '远端来源安装标识；历史未知为 NULL，不因本机未登记而拒绝',
  })
  sourceInstallationId!: string | null;

  @Column({
    name: 'remote_resource_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '云端远端资源标识；本机写入或历史未知时为空',
  })
  remoteResourceId!: string | null;

  @Column({
    name: 'received_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '设计字段：对端实际接收时间；历史未知为 NULL，不从 confirmed_at 复制',
  })
  receivedAt!: Date | null;

  @Column({
    name: 'receipt_status',
    type: 'varchar',
    length: 16,
    comment: '有效同步状态（对应设计 status）：PENDING/SUCCEEDED/FAILED/CONFLICT',
  })
  receiptStatus!: string;

  @Column({ name: 'manifest_checksum', type: 'char', length: 64, comment: '同步清单 SHA-256' })
  manifestChecksum!: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @Column({
    name: 'confirmed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '旧版确认事件时间；历史未知为 NULL，不双写新 received_at',
  })
  confirmedAt!: Date | null;
}
