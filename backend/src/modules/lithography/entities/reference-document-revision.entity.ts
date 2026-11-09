import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('reference_document_revision', { comment: '资料生效修订表' })
@Index('uk_reference_document_revision_no', ['documentId', 'revisionNo'], { unique: true })
@ForeignKey('ReferenceDocumentEntity', ['documentId'], ['id'], {
  name: 'fk_reference_document_revision_document',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['actorAccountId'], ['id'], {
  name: 'fk_reference_document_revision_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_reference_document_revision_schema',
  [
    'JSON_VALID(`before_snapshot`)',
    'JSON_VALID(`after_snapshot`)',
    "JSON_EXTRACT(`before_snapshot`, '$.schema_version') IS NOT NULL",
    "JSON_TYPE(JSON_EXTRACT(`before_snapshot`, '$.schema_version')) <> 'NULL'",
    "JSON_EXTRACT(`after_snapshot`, '$.schema_version') IS NOT NULL",
    "JSON_TYPE(JSON_EXTRACT(`after_snapshot`, '$.schema_version')) <> 'NULL'",
  ].join(' AND '),
)
export class ReferenceDocumentRevisionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '资料修订ID' })
  id!: string;

  @Column({ name: 'document_id', type: 'int', comment: '所属资料ID' })
  documentId!: number;

  @Column({ name: 'revision_no', type: 'int', unsigned: true, comment: '生效修订号' })
  revisionNo!: number;

  @Column({ name: 'before_snapshot', type: 'longtext', comment: '修订前完整快照 JSON' })
  beforeSnapshot!: string;

  @Column({ name: 'after_snapshot', type: 'longtext', comment: '修订后完整快照 JSON' })
  afterSnapshot!: string;

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
