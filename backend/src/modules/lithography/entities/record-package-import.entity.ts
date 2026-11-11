import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('record_package_import', { comment: '记录包导入批次表' })
@Index('idx_record_package_import_organization', ['organizationId', 'createdAt'])
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_record_package_import_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['importedByAccountId'], ['id'], {
  name: 'fk_record_package_import_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class RecordPackageImportEntity {
  @PrimaryColumn({ name: 'package_id', type: 'char', length: 36, comment: '导入包ID' })
  packageId!: string;

  @Column({ name: 'organization_id', type: 'int', comment: '目标公司数据区' })
  organizationId!: number;

  @Column({ name: 'imported_by_account_id', type: 'int', comment: '实际导入人' })
  importedByAccountId!: number;

  @Column({ name: 'manifest_json', type: 'longtext', comment: '包清单 JSON' })
  manifestJson!: string;

  @Column({ name: 'manifest_checksum', type: 'char', length: 64, comment: '包清单 SHA-256' })
  manifestChecksum!: string;

  @Column({
    type: 'varchar',
    length: 16,
    comment: '导入阶段：PENDING/RUNNING/SUCCEEDED/PARTIAL/FAILED',
  })
  status!: string;

  @Column({
    name: 'check_status',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '检查状态：NULL 历史未判定/PENDING/PASSED/REJECTED',
  })
  checkStatus!: string | null;

  @Column({ name: 'item_total', type: 'int', unsigned: true, default: 0, comment: '清点总条数' })
  itemTotal!: number;

  @Column({
    name: 'item_succeeded',
    type: 'int',
    unsigned: true,
    default: 0,
    comment: '成功条数',
  })
  itemSucceeded!: number;

  @Column({ name: 'item_failed', type: 'int', unsigned: true, default: 0, comment: '失败条数' })
  itemFailed!: number;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @Column({
    name: 'completed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '完成时间',
  })
  completedAt!: Date | null;
}
