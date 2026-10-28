import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('content_submission_review', { comment: '投稿审核记录表' })
@Index('uk_content_submission_review_revision', ['revisionId'], { unique: true })
@Index('idx_content_submission_review_revision_submission', ['revisionId', 'submissionId'])
@Index('idx_content_submission_review_submission_reviewed', ['submissionId', 'reviewedAt'])
@Index('idx_content_submission_review_reviewed_by', ['reviewedByAccountId'])
@ForeignKey(
  'ContentSubmissionRevisionEntity',
  ['revisionId', 'submissionId'],
  ['id', 'submissionId'],
  {
    name: 'fk_content_submission_review_revision',
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
)
@ForeignKey('AccountEntity', ['reviewedByAccountId'], ['id'], {
  name: 'fk_content_submission_review_reviewed_by_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_content_submission_review_decision', "`decision` IN ('RETURN', 'APPROVE')")
@Check(
  'chk_content_submission_review_comment',
  "(`decision` <> 'RETURN' OR (`comment` IS NOT NULL AND CHAR_LENGTH(TRIM(`comment`)) > 0))",
)
@Check(
  'chk_content_submission_review_publish_flag',
  "(`decision` <> 'RETURN' OR `publish_attachment` = 0)",
)
export class ContentSubmissionReviewEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '审核记录主键ID' })
  id!: number;

  @Column({ name: 'submission_id', type: 'int', comment: '所属投稿ID' })
  submissionId!: number;

  @Column({ name: 'revision_id', type: 'int', comment: '被审核的冻结版本ID' })
  revisionId!: number;

  @Column({
    type: 'varchar',
    length: 16,
    comment: '审核决定：RETURN=退回；APPROVE=通过',
  })
  decision!: string;

  @Column({ name: 'reviewed_by_account_id', type: 'int', comment: '审核人账号ID' })
  reviewedByAccountId!: number;

  @Column({
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: '审核意见；退回时必填',
  })
  comment!: string | null;

  @Column({
    name: 'publish_attachment',
    type: 'boolean',
    default: false,
    comment: '通过时是否将当次附件发布为正式文件',
  })
  publishAttachment!: boolean;

  @Column({
    name: 'reviewed_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '审核时间（系统事件时间）',
  })
  reviewedAt!: Date;
}
