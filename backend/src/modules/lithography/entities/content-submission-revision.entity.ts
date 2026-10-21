import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('content_submission_revision', { comment: '投稿送审冻结版本表' })
@Index('uk_content_submission_revision_submission_no', ['submissionId', 'revisionNo'], {
  unique: true,
})
@Index('uk_content_submission_revision_id_submission', ['id', 'submissionId'], { unique: true })
@Index('idx_content_submission_revision_attachment', ['attachmentId', 'submissionId'])
@Index('idx_content_submission_revision_confirmed_by', ['confirmedByAccountId'])
@ForeignKey('ContentSubmissionEntity', ['submissionId'], ['id'], {
  name: 'fk_content_submission_revision_submission',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey(
  'ContentSubmissionAttachmentEntity',
  ['attachmentId', 'submissionId'],
  ['id', 'submissionId'],
  {
    name: 'fk_content_submission_revision_attachment',
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
)
@ForeignKey('AccountEntity', ['confirmedByAccountId'], ['id'], {
  name: 'fk_content_submission_revision_confirmed_by_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_content_submission_revision_no', '`revision_no` >= 1')
@Check('chk_content_submission_revision_title', 'CHAR_LENGTH(TRIM(`title_snapshot`)) > 0')
@Check('chk_content_submission_revision_notice', 'CHAR_LENGTH(TRIM(`notice_version`)) > 0')
export class ContentSubmissionRevisionEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '送审版本主键ID' })
  id!: number;

  @Column({ name: 'submission_id', type: 'int', comment: '所属投稿ID' })
  submissionId!: number;

  @Column({
    name: 'revision_no',
    type: 'int',
    unsigned: true,
    comment: '版本号；从 1 开始递增',
  })
  revisionNo!: number;

  @Column({ name: 'payload_snapshot', type: 'json', comment: '送审内容完整快照' })
  payloadSnapshot!: Record<string, unknown>;

  @Column({
    name: 'schema_version',
    type: 'smallint',
    unsigned: true,
    default: 1,
    comment: '快照 schema 版本',
  })
  schemaVersion!: number;

  @Column({ name: 'title_snapshot', type: 'varchar', length: 255, comment: '标题快照' })
  titleSnapshot!: string;

  @Column({
    name: 'attachment_id',
    type: 'int',
    nullable: true,
    comment: '当次送审冻结附件ID；为空表示纯文本投稿',
  })
  attachmentId!: number | null;

  @Column({
    name: 'notice_version',
    type: 'varchar',
    length: 64,
    comment: '入库告知版本（服务端固定）',
  })
  noticeVersion!: string;

  @Column({
    name: 'confirmed_by_account_id',
    type: 'int',
    comment: '入库告知确认人账号ID',
  })
  confirmedByAccountId!: number;

  @Column({
    name: 'confirmed_at',
    type: 'timestamp',
    precision: 3,
    comment: '入库告知确认时间（系统事件时间）',
  })
  confirmedAt!: Date;

  @Column({
    name: 'submitted_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '送审时间（系统事件时间）',
  })
  submittedAt!: Date;
}
