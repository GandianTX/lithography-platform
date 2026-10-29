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

@Entity('maintenance_report', { comment: '统一维修报告根表' })
@Index('uk_maintenance_report_request', ['repairRequestId'], { unique: true })
@Index('uk_maintenance_report_id_owner', ['id', 'ownerOrganizationId'], { unique: true })
@Index('idx_maintenance_report_owner_status_created', [
  'ownerOrganizationId',
  'status',
  'createdAt',
])
@Index('idx_maintenance_report_engineer_created', ['maintenanceEngineerAccountId', 'createdAt'])
@Index('idx_maintenance_report_source_created', ['sourceType', 'createdAt'])
@ForeignKey('OrganizationEntity', ['ownerOrganizationId'], ['id'], {
  name: 'fk_maintenance_report_owner_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('RepairRequestEntity', ['repairRequestId'], ['id'], {
  name: 'fk_maintenance_report_repair_request',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('EquipmentModelEntity', ['equipmentModelId'], ['id'], {
  name: 'fk_maintenance_report_equipment_model',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['maintenanceEngineerAccountId'], ['id'], {
  name: 'fk_maintenance_report_engineer_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['createdByAccountId'], ['id'], {
  name: 'fk_maintenance_report_created_by',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['updatedByAccountId'], ['id'], {
  name: 'fk_maintenance_report_updated_by',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_maintenance_report_source',
  "`source_type` IN ('HISTORICAL_CASE', 'WORK_ORDER_SUMMARY')",
)
@Check(
  'chk_maintenance_report_request_source',
  "((`source_type` = 'WORK_ORDER_SUMMARY' AND `repair_request_id` IS NOT NULL) OR (`source_type` = 'HISTORICAL_CASE' AND `repair_request_id` IS NULL))",
)
@Check(
  'chk_maintenance_report_status',
  "`status` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')",
)
@Check(
  'chk_maintenance_report_status_consistency',
  "((`status` = 'DRAFT' AND `current_version_no` = 0 AND `last_submitted_at` IS NULL AND `last_reviewed_at` IS NULL) OR (`status` = 'PENDING_REVIEW' AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NULL) OR (`status` IN ('RETURNED', 'APPROVED') AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NOT NULL))",
)
@Check(
  'chk_maintenance_report_model_exclusive',
  '`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL',
)
@Check('chk_maintenance_report_phase_flow', '`phase_flow_version` >= 1')
@Check(
  'chk_maintenance_report_ai_usage',
  "((`ai_usage` = 'NOT_USED' AND `ai_source_type` IS NULL AND `ai_source_id` IS NULL AND `ai_source_version` IS NULL AND `ai_score` IS NULL AND `ai_correctness` IS NULL AND `ai_helpfulness` IS NULL AND `ai_note` IS NULL) OR (`ai_usage` = 'USED' AND `ai_source_type` IS NOT NULL AND CHAR_LENGTH(TRIM(`ai_source_type`)) > 0 AND `ai_source_id` IS NOT NULL AND `ai_source_version` IS NOT NULL))",
)
@Check('chk_maintenance_report_ai_score', '`ai_score` IS NULL OR `ai_score` BETWEEN 1 AND 5')
@Check(
  'chk_maintenance_report_ai_helpfulness',
  '`ai_helpfulness` IS NULL OR `ai_helpfulness` BETWEEN 1 AND 5',
)
@Check(
  'chk_maintenance_report_ai_correctness',
  "`ai_correctness` IS NULL OR `ai_correctness` IN ('CORRECT', 'PARTIAL', 'INCORRECT')",
)
export class MaintenanceReportEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '报告主键ID' })
  id!: number;

  @Column({ name: 'owner_organization_id', type: 'int', comment: '所属组织ID' })
  ownerOrganizationId!: number;

  @Column({
    name: 'source_type',
    type: 'varchar',
    length: 32,
    comment: '来源：HISTORICAL_CASE/WORK_ORDER_SUMMARY',
  })
  sourceType!: string;

  @Column({
    name: 'repair_request_id',
    type: 'int',
    nullable: true,
    comment: '关联工单ID；工单总结必填，历史案例为空',
  })
  repairRequestId!: number | null;

  @Column({
    type: 'varchar',
    length: 200,
    nullable: true,
    comment: '标题；草稿可空，提交前必填',
  })
  title!: string | null;

  @Column({
    name: 'customer_factory_name',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '客户厂家（手填，不作为权限来源）',
  })
  customerFactoryName!: string | null;

  @Column({
    name: 'equipment_model_id',
    type: 'int',
    nullable: true,
    comment: '设备型号ID（全局型号库）',
  })
  equipmentModelId!: number | null;

  @Column({
    name: 'equipment_model_text',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '型号文字快照；与型号ID互斥',
  })
  equipmentModelText!: string | null;

  @Column({
    name: 'maintenance_date',
    type: 'date',
    nullable: true,
    comment: '维修业务日期；不默认今天',
  })
  maintenanceDate!: string | null;

  @Column({
    name: 'maintenance_engineer_account_id',
    type: 'int',
    comment: '负责工程师账号ID',
  })
  maintenanceEngineerAccountId!: number;

  @Column({
    name: 'maintenance_engineer_name_snapshot',
    type: 'varchar',
    length: 50,
    comment: '负责工程师姓名快照',
  })
  maintenanceEngineerNameSnapshot!: string;

  @Column({
    name: 'phase_flow_version',
    type: 'smallint',
    unsigned: true,
    default: 1,
    comment: '阶段流程版本',
  })
  phaseFlowVersion!: number;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'DRAFT',
    comment: 'DRAFT/PENDING_REVIEW/RETURNED/APPROVED',
  })
  status!: string;

  @Column({
    name: 'current_version_no',
    type: 'int',
    unsigned: true,
    default: 0,
    comment: '最近冻结版本号',
  })
  currentVersionNo!: number;

  @Column({
    name: 'last_submitted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近提交事件时间',
  })
  lastSubmittedAt!: Date | null;

  @Column({
    name: 'last_reviewed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '最近审核事件时间',
  })
  lastReviewedAt!: Date | null;

  @Column({
    name: 'ai_usage',
    type: 'varchar',
    length: 16,
    default: 'NOT_USED',
    comment: 'AI 使用标记：USED/NOT_USED',
  })
  aiUsage!: string;

  @Column({
    name: 'ai_source_type',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '分析结果来源命名空间',
  })
  aiSourceType!: string | null;

  @Column({
    name: 'ai_source_id',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '分析结果稳定标识',
  })
  aiSourceId!: string | null;

  @Column({
    name: 'ai_source_version',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '分析结果不可变版本/内容摘要',
  })
  aiSourceVersion!: string | null;

  @Column({
    name: 'ai_score',
    type: 'tinyint',
    unsigned: true,
    nullable: true,
    comment: 'AI 评分 1-5；不适用为空',
  })
  aiScore!: number | null;

  @Column({
    name: 'ai_correctness',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: 'AI 正确性：CORRECT/PARTIAL/INCORRECT',
  })
  aiCorrectness!: string | null;

  @Column({
    name: 'ai_helpfulness',
    type: 'tinyint',
    unsigned: true,
    nullable: true,
    comment: 'AI 帮助程度 1-5；不适用为空',
  })
  aiHelpfulness!: number | null;

  @Column({
    name: 'ai_note',
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: 'AI 文字评价',
  })
  aiNote!: string | null;

  @Column({ name: 'created_by_account_id', type: 'int', comment: '创建人账号ID' })
  createdByAccountId!: number;

  @Column({ name: 'updated_by_account_id', type: 'int', comment: '最后修改人账号ID' })
  updatedByAccountId!: number;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '创建时间',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
    comment: '更新时间',
  })
  updatedAt!: Date;
}
