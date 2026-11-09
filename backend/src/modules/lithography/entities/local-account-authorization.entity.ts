import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('local_account_authorization', { comment: '本机账号授权表' })
@Check(
  'chk_local_account_authorization_signed_claims',
  '((`signed_claims` IS NULL AND `permission_version` IS NULL AND `last_verified_at` IS NULL) OR (`signed_claims` IS NOT NULL AND `permission_version` IS NOT NULL AND `last_verified_at` IS NOT NULL))',
)
@Check(
  'chk_local_account_authorization_permission_version',
  '(`permission_version` IS NULL OR `permission_version` >= 1)',
)
@Index('uk_local_account_authorization_scope', ['installationId', 'accountId', 'organizationId'], {
  unique: true,
})
@Index('idx_local_account_authorization_account', ['accountId', 'authorizationStatus'])
@ForeignKey('LocalInstallationEntity', ['installationId'], ['installationId'], {
  name: 'fk_local_account_authorization_installation',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['accountId'], ['id'], {
  name: 'fk_local_account_authorization_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_local_account_authorization_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class LocalAccountAuthorizationEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '授权记录ID' })
  id!: string;

  @Column({ name: 'installation_id', type: 'char', length: 36, comment: '本机安装标识' })
  installationId!: string;

  @Column({ name: 'account_id', type: 'int', comment: '被授权账号ID' })
  accountId!: number;

  @Column({ name: 'organization_id', type: 'int', comment: '授权生效公司ID' })
  organizationId!: number;

  @Column({
    name: 'authorization_status',
    type: 'varchar',
    length: 16,
    comment: 'ACTIVE/REVOKED',
  })
  authorizationStatus!: string;

  @Column({
    name: 'authorized_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  authorizedAt!: Date;

  @Column({
    name: 'revoked_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '撤销时间',
  })
  revokedAt!: Date | null;

  @Column({
    name: 'signed_claims',
    type: 'json',
    nullable: true,
    comment: '签名凭据原文；历史行不伪造',
  })
  signedClaims!: unknown;

  @Column({
    name: 'permission_version',
    type: 'int',
    unsigned: true,
    nullable: true,
    comment: '签名权限版本',
  })
  permissionVersion!: number | null;

  @Column({
    name: 'last_verified_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近一次签名校验成功时间',
  })
  lastVerifiedAt!: Date | null;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
