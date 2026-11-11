import { Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('record_package_item', { comment: '记录包逐条导入结果表' })
@Index('uk_record_package_item_scope', ['packageId', 'recordUuid', 'resourceType', 'versionNo'], {
  unique: true,
})
@ForeignKey('RecordPackageImportEntity', ['packageId'], ['packageId'], {
  name: 'fk_record_package_item_package',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('SyncReceiptEntity', ['receiptId'], ['receiptId'], {
  name: 'fk_record_package_item_receipt',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class RecordPackageItemEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '导入条目ID' })
  id!: string;

  @Column({ name: 'package_id', type: 'char', length: 36, comment: '所属导入包' })
  packageId!: string;

  @Column({ name: 'record_uuid', type: 'char', length: 36, comment: '业务稳定编号' })
  recordUuid!: string;

  @Column({ name: 'resource_type', type: 'varchar', length: 32, comment: '资源类型' })
  resourceType!: string;

  @Column({ name: 'version_no', type: 'int', unsigned: true, comment: '业务版本号' })
  versionNo!: number;

  @Column({
    name: 'check_result',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '检查结果：NULL 未完成或历史未判定/PASSED/REJECTED',
  })
  checkResult!: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '导入结果：NULL 未执行/SUCCEEDED/FAILED/SKIPPED/CONFLICT',
  })
  result!: string | null;

  @Column({ name: 'receipt_id', type: 'char', length: 36, nullable: true, comment: '同步回执ID' })
  receiptId!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true, comment: '失败原因' })
  errorMessage!: string | null;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
