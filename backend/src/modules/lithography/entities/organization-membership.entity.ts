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

@Entity('organization_membership', { comment: '组织成员关系表' })
@Index('uk_organization_membership_org_account', ['organizationId', 'accountId'], { unique: true })
@Index('idx_organization_membership_account_status', ['accountId', 'status'])
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
@Check('chk_organization_membership_role', "`member_role` IN ('SUPER_ADMIN', 'ENGINEER')")
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
    comment: '组织内角色：SUPER_ADMIN=组织管理员；ENGINEER=工程师',
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
