import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('content_submission', { comment: '内容投稿主表（资料/案例草稿与送审状态）' })
@Index('idx_content_submission_org_status_updated', ['ownerOrganizationId', 'status', 'updatedAt'])
@Index('idx_content_submission_submitter_status_updated', [
  'submittedByAccountId',
  'status',
  'updatedAt',
])
@ForeignKey('OrganizationEntity', ['ownerOrganizationId'], ['id'], {
  name: 'fk_content_submission_owner_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['submittedByAccountId'], ['id'], {
  name: 'fk_content_submission_submitted_by_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_content_submission_kind', "`submission_kind` IN ('MATERIAL', 'FAULT_CASE')")
@Check(
  'chk_content_submission_status',
  "`status` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'PUBLISHED')",
)
@Check(
  'chk_content_submission_revision_consistency',
  "((`status` = 'DRAFT' AND `current_revision_no` = 0 AND `last_submitted_at` IS NULL) OR (`status` <> 'DRAFT' AND `current_revision_no` >= 1 AND `last_submitted_at` IS NOT NULL))",
)
@Check(
  'chk_content_submission_publish_consistency',
  "((`status` = 'PUBLISHED' AND `published_at` IS NOT NULL) OR (`status` <> 'PUBLISHED' AND `published_at` IS NULL))",
)
export class ContentSubmissionEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '投稿主键ID' })
  id!: number;

  @Column({
    name: 'submission_kind',
    type: 'varchar',
    length: 32,
    comment: '投稿类别：MATERIAL=普通资料；FAULT_CASE=故障案例',
  })
  submissionKind!: string;

  @Column({ name: 'owner_organization_id', type: 'int', comment: '所属组织ID' })
  ownerOrganizationId!: number;

  @Column({ name: 'submitted_by_account_id', type: 'int', comment: '投稿人账号ID' })
  submittedByAccountId!: number;

  @Column({
    type: 'varchar',
    length: 32,
    default: 'DRAFT',
    comment: '投稿状态：DRAFT/PENDING_REVIEW/RETURNED/PUBLISHED',
  })
  status!: string;

  @Column({
    name: 'current_revision_no',
    type: 'int',
    unsigned: true,
    default: 0,
    comment: '当前送审版本号；0=尚未送审',
  })
  currentRevisionNo!: number;

  @Column({
    name: 'last_submitted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近送审时间（系统事件时间）',
  })
  lastSubmittedAt!: Date | null;

  @Column({
    name: 'published_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近发布时间（系统事件时间）',
  })
  publishedAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '创建时间（系统事件时间）',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
    comment: '更新时间（系统事件时间）',
  })
  updatedAt!: Date;
}
