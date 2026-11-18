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

@Entity('repair_request_fault_panel', { comment: '工单故障面板' })
@Index('uk_repair_request_fault_panel_initial', ['initialRequestId'], { unique: true })
@Index('uk_repair_request_fault_panel_reset', ['resetRequestId'], { unique: true })
@Index('uk_repair_request_fault_panel_step', ['requestId', 'stepId'], { unique: true })
@ForeignKey('RepairRequestEntity', ['requestId'], ['id'], {
  name: 'fk_repair_request_fault_panel_request',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('RepairRequestDiagnosticStepEntity', ['requestId', 'stepId'], ['requestId', 'id'], {
  name: 'fk_repair_request_fault_panel_step',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_repair_request_fault_panel_type',
  "`panel_type` IN ('INITIAL', 'STEP_NEW_FAULT', 'RESET_NEW_FAULT')",
)
@Check(
  'chk_repair_request_fault_panel_step',
  "((`panel_type` = 'STEP_NEW_FAULT') AND (`step_id` IS NOT NULL)) OR ((`panel_type` <> 'STEP_NEW_FAULT') AND (`step_id` IS NULL))",
)
@Check(
  'chk_repair_request_fault_panel_phase',
  "`phase_code` IS NULL OR `phase_code` IN ('PHASE_01', 'PHASE_02', 'PHASE_03', 'PHASE_04', 'PHASE_05', 'PHASE_06', 'PHASE_07', 'PHASE_08', 'PHASE_09', 'PHASE_10')",
)
@Check('chk_repair_request_fault_panel_description', 'CHAR_LENGTH(TRIM(`description`)) > 0')
export class RepairRequestFaultPanelEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '故障面板主键ID' })
  id!: string;

  @Column({ name: 'request_id', type: 'int', comment: '所属工单ID' })
  requestId!: number;

  @Column({
    name: 'panel_type',
    type: 'varchar',
    length: 24,
    comment: 'INITIAL/STEP_NEW_FAULT/RESET_NEW_FAULT',
  })
  panelType!: string;

  @Column({
    name: 'step_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    comment: '来源步骤；仅 STEP_NEW_FAULT 非空',
  })
  stepId!: string | null;

  @Column({
    name: 'phase_code',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '稳定阶段编码；PHASE_01—PHASE_10',
  })
  phaseCode!: string | null;

  @Column({
    name: 'main_error',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '主报警代码',
  })
  mainError!: string | null;

  @Column({
    name: 'unit_error',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '单元报警代码',
  })
  unitError!: string | null;

  @Column({ name: 'source', type: 'varchar', length: 300, nullable: true, comment: '来源' })
  source!: string | null;

  @Column({
    name: 'error_type',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '错误类型',
  })
  errorType!: string | null;

  @Column({
    name: 'gpib_status',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: 'GPIB 状态',
  })
  gpibStatus!: string | null;

  @Column({
    name: 'fault_status',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '故障状态',
  })
  faultStatus!: string | null;

  @Column({ name: 'description', type: 'text', comment: '故障描述' })
  description!: string;

  @Column({ name: 'action', type: 'text', nullable: true, comment: '处理动作' })
  action!: string | null;

  @Column({
    name: 'initial_request_id',
    type: 'int',
    nullable: true,
    insert: false,
    update: false,
    asExpression: "IF(`panel_type` = 'INITIAL', `request_id`, NULL)",
    generatedType: 'STORED',
    comment: '生成列：初始面板唯一槽（只读）',
  })
  initialRequestId!: number | null;

  @Column({
    name: 'reset_request_id',
    type: 'int',
    nullable: true,
    insert: false,
    update: false,
    asExpression: "IF(`panel_type` = 'RESET_NEW_FAULT', `request_id`, NULL)",
    generatedType: 'STORED',
    comment: '生成列：复位新故障面板唯一槽（只读）',
  })
  resetRequestId!: number | null;

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
