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

/**
 * 工程师自助注册申请实体（对应 `engineer_registration_application`）。
 *
 * 数据库另有生成列 `pending_account_id`（PENDING 时为 account_id，否则 NULL）
 * 与其唯一键，用于保证「同一账号同时最多一份待审申请」，防止向多个组织并发申请。
 * 按项目既定规则，生成列以只读列声明，保证 Entity 与迁移结构一致；写入由数据库计算。
 * 结构真源见迁移 1775401500000-create-engineer-registration-application。
 */
@Entity('engineer_registration_application', { comment: '工程师自助注册申请与组织审核记录表' })
@Index('uk_engineer_registration_application_pending_account', ['pendingAccountId'], {
  unique: true,
})
@Index('idx_engineer_registration_application_org_status_submitted', [
  'organizationId',
  'status',
  'submittedAt',
  'id',
])
@Index('idx_engineer_registration_application_account_submitted', [
  'accountId',
  'submittedAt',
  'id',
])
@ForeignKey('AccountEntity', ['accountId'], ['id'], {
  name: 'fk_engineer_registration_application_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_engineer_registration_application_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['reviewedByAccountId'], ['id'], {
  name: 'fk_engineer_registration_application_reviewer',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_engineer_registration_application_status',
  "`status` IN ('PENDING', 'APPROVED', 'REJECTED')",
)
@Check(
  'chk_engineer_registration_application_pending_review',
  "((`status` = 'PENDING' AND `reviewed_by_account_id` IS NULL AND `reviewed_at` IS NULL AND `review_comment` IS NULL) OR (`status` <> 'PENDING'))",
)
@Check(
  'chk_engineer_registration_application_reviewed',
  "((`status` = 'PENDING') OR (`reviewed_by_account_id` IS NOT NULL AND `reviewed_at` IS NOT NULL))",
)
@Check(
  'chk_engineer_registration_application_reject_comment',
  "(`status` <> 'REJECTED' OR (`review_comment` IS NOT NULL AND CHAR_LENGTH(TRIM(`review_comment`)) > 0))",
)
@Check(
  'chk_engineer_registration_application_review_time',
  '(`reviewed_at` IS NULL OR `reviewed_at` >= `submitted_at`)',
)
export class EngineerRegistrationApplicationEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '申请记录主键ID' })
  id!: number;

  @Column({ name: 'account_id', type: 'int', comment: '待审工程师账号ID' })
  accountId!: number;

  @Column({ name: 'organization_id', type: 'int', comment: '本次申请的目标组织ID' })
  organizationId!: number;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'PENDING',
    comment: 'PENDING=待审核；APPROVED=已通过；REJECTED=已拒绝',
  })
  status!: string;

  @Column({
    name: 'application_note',
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: '申请说明；可空',
  })
  applicationNote!: string | null;

  @Column({
    name: 'submitted_at',
    type: 'timestamp',
    precision: 3,
    comment: '提交时间（系统事件时间）',
  })
  submittedAt!: Date;

  @Column({
    name: 'reviewed_by_account_id',
    type: 'int',
    nullable: true,
    comment: '审核管理员账号ID；待审为空',
  })
  reviewedByAccountId!: number | null;

  @Column({
    name: 'reviewed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '审核事件时间；待审为空',
  })
  reviewedAt!: Date | null;

  @Column({
    name: 'review_comment',
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: '审核意见；拒绝必填非空白，通过可空',
  })
  reviewComment!: string | null;

  @Column({
    name: 'pending_account_id',
    type: 'int',
    nullable: true,
    insert: false,
    update: false,
    asExpression: "IF(`status` = 'PENDING', `account_id`, NULL)",
    generatedType: 'STORED',
    comment: '生成列：PENDING 时为账号ID，否则为 NULL（只读）',
  })
  pendingAccountId!: number | null;

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
