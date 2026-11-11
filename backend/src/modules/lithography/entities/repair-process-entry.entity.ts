import { Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('repair_process_entry', { comment: '工单内部维修过程表' })
@Index('uk_repair_process_entry_uuid', ['entryUuid'], { unique: true })
@Index('idx_repair_process_entry_request_created', ['requestId', 'createdAt'])
@ForeignKey('RepairRequestEntity', ['requestId'], ['id'], {
  name: 'fk_repair_process_entry_request',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['authorAccountId'], ['id'], {
  name: 'fk_repair_process_entry_author',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('StoredFileEntity', ['fileId'], ['fileId'], {
  name: 'fk_repair_process_entry_file',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class RepairProcessEntryEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '过程ID' })
  id!: string;

  @Column({ name: 'entry_uuid', type: 'char', length: 36, comment: '稳定记录编号' })
  entryUuid!: string;

  @Column({ name: 'request_id', type: 'int', comment: '所属工单ID' })
  requestId!: number;

  @Column({ name: 'author_account_id', type: 'int', comment: '实际记录人账号ID' })
  authorAccountId!: number;

  @Column({ name: 'operation_text', type: 'longtext', comment: '人工执行操作' })
  operationText!: string;

  @Column({ name: 'test_result', type: 'longtext', nullable: true, comment: '实际测试事实' })
  testResult!: string | null;

  @Column({
    name: 'occurred_at',
    type: 'datetime',
    nullable: true,
    comment: '业务现场事件时间',
  })
  occurredAt!: Date | null;

  @Column({ name: 'time_source', type: 'varchar', length: 32, comment: '时间来源' })
  timeSource!: string;

  @Column({ name: 'file_id', type: 'char', length: 36, nullable: true, comment: '内部私有原件' })
  fileId!: string | null;

  @Column({ name: 'version_no', type: 'int', unsigned: true, comment: '过程修改版本' })
  versionNo!: number;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
