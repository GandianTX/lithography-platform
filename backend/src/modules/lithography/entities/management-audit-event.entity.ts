import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('management_audit_event', { comment: '管理审计事件表' })
@Index('idx_management_audit_actor', ['actorAccountId', 'createdAt'])
@Index('idx_management_audit_organization', ['organizationId', 'createdAt'])
@Index('idx_management_audit_target', ['targetType', 'targetId', 'createdAt'])
@ForeignKey('AccountEntity', ['actorAccountId'], ['id'], {
  name: 'fk_management_audit_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_management_audit_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_management_audit_operation',
  "`operation` IN ('ADMIN_DELETE_DOCUMENT', 'CORRECT_DOCUMENT_OWNERSHIP', 'RESTORE_LOCAL_BUSINESS')",
)
export class ManagementAuditEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'char', length: 36, comment: '审计事件ID' })
  eventId!: string;

  @Column({ name: 'actor_account_id', type: 'int', comment: '操作人账号ID' })
  actorAccountId!: number;

  @Column({ name: 'actor_admin_level', type: 'tinyint', comment: '当时的实际管理员等级' })
  actorAdminLevel!: number;

  @Column({ name: 'organization_id', type: 'int', nullable: true, comment: '作用公司ID' })
  organizationId!: number | null;

  @Column({
    type: 'varchar',
    length: 32,
    comment:
      '管理操作类型：ADMIN_DELETE_DOCUMENT/CORRECT_DOCUMENT_OWNERSHIP/RESTORE_LOCAL_BUSINESS',
  })
  operation!: string;

  @Column({ name: 'target_type', type: 'varchar', length: 32, comment: '目标类型' })
  targetType!: string;

  @Column({ name: 'target_id', type: 'varchar', length: 64, comment: '目标真实ID' })
  targetId!: string;

  @Column({ type: 'varchar', length: 16, comment: 'SUCCEEDED/FAILED/DENIED' })
  result!: string;

  @Column({ type: 'text', nullable: true, comment: '可展示变更详情' })
  detail!: string | null;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
