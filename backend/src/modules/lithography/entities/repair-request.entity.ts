import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('repair_request', { comment: '客户维修申请表' })
@Index('uk_repair_request_no', ['requestNo'], { unique: true })
@Index('idx_repair_request_customer_created', ['customerAccountId', 'createdAt'])
@Index('idx_repair_request_accepted_created', ['isAccepted', 'createdAt'])
@Index('idx_repair_request_engineer', ['acceptedByEngineerAccountId'])
@Index('idx_repair_request_equipment_model', ['equipmentModelId'])
@Index('idx_repair_request_created_at', ['createdAt'])
@Index('uk_repair_request_id_owner', ['id', 'ownerOrganizationId'], { unique: true })
@Index('idx_repair_request_owner_created', ['ownerOrganizationId', 'createdAt'])
@Index('idx_repair_request_owner_status', ['ownerOrganizationId', 'handlingStatus'])
@Index('idx_repair_request_handling_recorder', ['handlingRecordedByAccountId'])
@ForeignKey('OrganizationEntity', ['ownerOrganizationId'], ['id'], {
  name: 'fk_repair_request_owner_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['handlingRecordedByAccountId'], ['id'], {
  name: 'fk_repair_request_handling_recorder',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['customerAccountId'], ['id'], {
  name: 'fk_repair_request_customer_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('EquipmentModelEntity', ['equipmentModelId'], ['id'], {
  name: 'fk_repair_request_equipment_model',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['acceptedByEngineerAccountId'], ['id'], {
  name: 'fk_repair_request_engineer_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_repair_request_is_accepted', '`is_accepted` IN (0, 1)')
@Check('chk_repair_request_deprecated', '`deprecated` IN (0, 1)')
@Check(
  'chk_repair_request_acceptance_consistency',
  '((`is_accepted` = 0 AND `accepted_by_engineer_account_id` IS NULL AND `accepted_at` IS NULL) OR (`is_accepted` = 1 AND `accepted_by_engineer_account_id` IS NOT NULL AND `accepted_at` IS NOT NULL))',
)
@Check(
  'chk_repair_request_deletion_consistency',
  '((`deprecated` = 0 AND `deleted_at` IS NULL) OR (`deprecated` = 1 AND `deleted_at` IS NOT NULL AND `is_accepted` = 0))',
)
@Check(
  'chk_repair_request_handling_result',
  "`handling_result` IS NULL OR `handling_result` IN ('FIXED', 'PART_PURCHASED', 'PROVIDE_PLAN_SELF_EXECUTE', 'INTERRUPTED', 'UNREPAIRABLE')",
)
@Check(
  'chk_repair_request_handling_status',
  "`handling_status` IS NULL OR `handling_status` IN ('COMPLETED', 'IN_PROGRESS', 'UNRESOLVED')",
)
@Check(
  'chk_repair_request_handling_mapping',
  "((`handling_result` IS NULL AND `handling_status` IS NULL) OR (`handling_result` = 'FIXED' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'PART_PURCHASED' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'PROVIDE_PLAN_SELF_EXECUTE' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'INTERRUPTED' AND `handling_status` = 'IN_PROGRESS') OR (`handling_result` = 'UNREPAIRABLE' AND `handling_status` = 'UNRESOLVED'))",
)
@Check(
  'chk_repair_request_handling_requires_accepted',
  '`handling_result` IS NULL OR `is_accepted` = 1',
)
@Check(
  'chk_repair_request_handling_time',
  "((`handling_result` IS NULL AND `handling_ended_at` IS NULL AND `handling_recorded_at` IS NULL) OR (`handling_result` IS NOT NULL AND `handling_recorded_at` IS NOT NULL AND ((`handling_status` = 'IN_PROGRESS' AND `handling_ended_at` IS NULL) OR (`handling_status` IN ('COMPLETED', 'UNRESOLVED') AND `handling_ended_at` IS NOT NULL))))",
)
export class RepairRequestEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '维修申请主键ID' })
  id!: number;

  @Column({ name: 'request_no', type: 'varchar', length: 50, comment: '维修申请编号' })
  requestNo!: string;

  @Column({ name: 'customer_account_id', type: 'int', comment: '提交申请的客户账号ID' })
  customerAccountId!: number;

  @Column({ name: 'equipment_model_id', type: 'int', comment: '设备型号ID' })
  equipmentModelId!: number;

  @Column({ name: 'error_code', type: 'varchar', length: 100, comment: '设备错误代码' })
  errorCode!: string;

  @Column({ name: 'fault_description', type: 'text', comment: '客户填写的故障描述' })
  faultDescription!: string;

  @Column({ name: 'content_md', type: 'longtext', comment: '维修申请Markdown内容' })
  contentMd!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '申请创建时间（系统事件时间）',
  })
  createdAt!: Date;

  @Column({
    name: 'is_accepted',
    type: 'boolean',
    default: false,
    comment: '是否已被工程师接单',
  })
  isAccepted!: boolean;

  @Column({
    name: 'accepted_by_engineer_account_id',
    type: 'int',
    nullable: true,
    comment: '接单工程师账号ID',
  })
  acceptedByEngineerAccountId!: number | null;

  @Column({
    name: 'accepted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '接单时间（系统事件时间）',
  })
  acceptedAt!: Date | null;

  @Column({
    name: 'owner_organization_id',
    type: 'int',
    nullable: true,
    comment: '所属组织ID；存量无证据时为空',
  })
  ownerOrganizationId!: number | null;

  @Column({
    name: 'handling_result',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '处理结果：FIXED/PART_PURCHASED/PROVIDE_PLAN_SELF_EXECUTE/INTERRUPTED/UNREPAIRABLE',
  })
  handlingResult!: string | null;

  @Column({
    name: 'handling_status',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '实际处理状态：COMPLETED/IN_PROGRESS/UNRESOLVED；服务端按固定映射维护',
  })
  handlingStatus!: string | null;

  @Column({
    name: 'handling_recorded_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '处理结果记录时间（事件时间）',
  })
  handlingRecordedAt!: Date | null;

  @Column({
    name: 'handling_recorded_by_account_id',
    type: 'int',
    nullable: true,
    comment: '处理结果记录人账号ID',
  })
  handlingRecordedByAccountId!: number | null;

  @Column({
    name: 'handling_ended_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '终结时间；完成/未完成必填，处理中必须为空',
  })
  handlingEndedAt!: Date | null;

  @Column({ type: 'boolean', default: false, comment: '是否已撤回/作废' })
  deprecated!: boolean;

  @Column({
    name: 'deleted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '撤回/作废时间（系统事件时间）',
  })
  deletedAt!: Date | null;
}
