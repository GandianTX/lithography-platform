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
 * 组织成员关系实体。
 *
 * 数据库另有生成列 `active_account_id`（ACTIVE 时为 account_id，否则 NULL）
 * 与其唯一键 `uk_organization_membership_active_account`，用于保证「一个账号
 * 只有一个有效组织」的库级约束。按项目既定规则，生成列必须以只读列声明，
 * 保证 Entity 与迁移结构一致；写入由数据库计算，ORM 不参与。结构真源见迁移
 * 1775401000000-alter-organization-membership-customer-single-active。
 */
@Entity('organization_membership', { comment: '组织成员关系表' })
@Index('uk_organization_membership_org_account', ['organizationId', 'accountId'], { unique: true })
@Index('idx_organization_membership_account_status', ['accountId', 'status'])
@Index('idx_organization_membership_org_role_status', ['organizationId', 'memberRole', 'status'])
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_organization_membership_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['accountId'], ['id'], {
  name: 'fk_organization_membership_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_organization_membership_role',
  "`member_role` IN ('SUPER_ADMIN', 'ENGINEER', 'CUSTOMER')",
)
@Check('chk_organization_membership_status', "`status` IN ('ACTIVE', 'LEFT')")
@Check(
  'chk_organization_membership_period',
  "((`status` = 'ACTIVE' AND `left_at` IS NULL) OR (`status` = 'LEFT' AND `left_at` IS NOT NULL))",
)
export class OrganizationMembershipEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '成员关系主键ID' })
  id!: number;

  @Column({ name: 'organization_id', type: 'int', comment: '组织ID' })
  organizationId!: number;

  @Column({ name: 'account_id', type: 'int', comment: '账号ID' })
  accountId!: number;

  @Column({
    name: 'member_role',
    type: 'varchar',
    length: 32,
    comment: '组织内角色：SUPER_ADMIN=组织管理员；ENGINEER=工程师；CUSTOMER=客户',
  })
  memberRole!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'ACTIVE',
    comment: '成员状态：ACTIVE=在籍；LEFT=已退出',
  })
  status!: string;

  @Column({
    name: 'joined_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '加入时间（系统事件时间）',
  })
  joinedAt!: Date;

  @Column({
    name: 'left_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '退出时间（系统事件时间）',
  })
  leftAt!: Date | null;

  @Column({
    name: 'active_account_id',
    type: 'int',
    nullable: true,
    insert: false,
    update: false,
    asExpression: "IF(`status` = 'ACTIVE', `account_id`, NULL)",
    generatedType: 'STORED',
    comment: '生成列：ACTIVE 时为账号ID，否则为 NULL（只读）',
  })
  activeAccountId!: number | null;

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
