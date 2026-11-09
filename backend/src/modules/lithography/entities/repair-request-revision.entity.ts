import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('repair_request_revision', { comment: '工单管理修订表' })
@Index('uk_repair_request_revision_no', ['requestId', 'revisionNo'], { unique: true })
@ForeignKey('RepairRequestEntity', ['requestId'], ['id'], {
  name: 'fk_repair_request_revision_request',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['actorAccountId'], ['id'], {
  name: 'fk_repair_request_revision_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_repair_request_revision_schema',
  [
    '`schema_version` >= 1',
    'JSON_VALID(`before_snapshot`)',
    'JSON_VALID(`after_snapshot`)',
    "JSON_EXTRACT(`before_snapshot`, '$.schema_version') IS NOT NULL",
    "JSON_TYPE(JSON_EXTRACT(`before_snapshot`, '$.schema_version')) <> 'NULL'",
    "JSON_EXTRACT(`after_snapshot`, '$.schema_version') IS NOT NULL",
    "JSON_TYPE(JSON_EXTRACT(`after_snapshot`, '$.schema_version')) <> 'NULL'",
    "JSON_EXTRACT(`before_snapshot`, '$.schema_version') = `schema_version`",
    "JSON_EXTRACT(`after_snapshot`, '$.schema_version') = `schema_version`",
  ].join(' AND '),
)
@Check(
  'chk_repair_request_revision_previous_version',
  '`previous_version` IS NULL OR `previous_version` < `revision_no`',
)
export class RepairRequestRevisionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '修订ID' })
  id!: string;

  @Column({ name: 'request_id', type: 'int', comment: '所属工单ID' })
  requestId!: number;

  @Column({ name: 'revision_no', type: 'int', unsigned: true, comment: '生效修订号' })
  revisionNo!: number;

  @Column({
    name: 'previous_version',
    type: 'int',
    unsigned: true,
    nullable: true,
    comment: '该修订比较/基于的上一生效修订号；0=首版；NULL=历史无法证明',
  })
  previousVersion!: number | null;

  @Column({ name: 'before_snapshot', type: 'longtext', comment: '修订前完整快照 JSON' })
  beforeSnapshot!: string;

  @Column({ name: 'after_snapshot', type: 'longtext', comment: '修订后完整快照 JSON' })
  afterSnapshot!: string;

  @Column({
    name: 'schema_version',
    type: 'int',
    unsigned: true,
    comment: '快照格式版本；与 JSON 内同值',
  })
  schemaVersion!: number;

  @Column({ name: 'actor_account_id', type: 'int', comment: '实际修订人账号ID' })
  actorAccountId!: number;

  @Column({ type: 'text', comment: '修订原因' })
  reason!: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
