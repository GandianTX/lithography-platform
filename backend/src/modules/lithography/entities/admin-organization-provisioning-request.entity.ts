import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 一级管理员「新增公司档案」开通提交标识（幂等台账）。
 *
 * 唯一键 `（purpose, actor_account_id, submission_key）` 是并发串行点：
 * 事务内先插入 PENDING 行，创建公司与管理员的写入完成后更新为 COMPLETED。
 * 本表不保存临时密码、密码哈希或输入原文，只保存规范化输入摘要。
 */
@Entity('admin_organization_provisioning_request', {
  comment: '一级管理员新增公司开通提交标识（幂等）',
})
@Index('uk_provisioning_purpose_actor_key', ['purpose', 'actorAccountId', 'submissionKey'], {
  unique: true,
})
@Index('idx_provisioning_organization', ['organizationId'])
@Index('idx_provisioning_admin_account', ['adminAccountId'])
@ForeignKey('AccountEntity', ['actorAccountId'], ['id'], {
  name: 'fk_provisioning_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_provisioning_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['adminAccountId'], ['id'], {
  name: 'fk_provisioning_admin_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_provisioning_purpose', "`purpose` = 'ADMIN_CREATE_ORGANIZATION'")
@Check('chk_provisioning_state', "`state` IN ('PENDING', 'COMPLETED')")
@Check('chk_provisioning_key_nonempty', 'CHAR_LENGTH(TRIM(`submission_key`)) > 0')
@Check('chk_provisioning_fingerprint_length', 'CHAR_LENGTH(`input_fingerprint`) = 64')
@Check(
  'chk_provisioning_completion',
  "`state` = 'PENDING' OR (`organization_id` IS NOT NULL AND `admin_account_id` IS NOT NULL)",
)
export class AdminOrganizationProvisioningRequestEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '开通请求主键ID' })
  id!: number;

  @Column({
    type: 'varchar',
    length: 32,
    comment: '开通用途；当前仅 ADMIN_CREATE_ORGANIZATION',
  })
  purpose!: string;

  @Column({
    name: 'submission_key',
    type: 'varchar',
    length: 36,
    comment: '提交标识（UUID）；同次提交重试复用',
  })
  submissionKey!: string;

  @Column({ name: 'actor_account_id', type: 'int', comment: '可信操作者账号（请求期会话账号）' })
  actorAccountId!: number;

  @Column({
    name: 'input_fingerprint',
    type: 'char',
    length: 64,
    comment: '规范化输入 SHA-256',
  })
  inputFingerprint!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'PENDING',
    comment: 'PENDING=进行中；COMPLETED=已完成',
  })
  state!: string;

  @Column({ name: 'organization_id', type: 'int', nullable: true, comment: '已开通公司' })
  organizationId!: number | null;

  @Column({
    name: 'admin_account_id',
    type: 'int',
    nullable: true,
    comment: '已开通二级管理员账号',
  })
  adminAccountId!: number | null;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '创建时间',
  })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
    comment: '更新时间',
  })
  updatedAt!: Date;
}
