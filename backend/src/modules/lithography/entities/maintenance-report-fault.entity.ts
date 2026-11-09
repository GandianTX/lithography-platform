import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('maintenance_report_fault', { comment: '报告故障分支表' })
@Check(
  'chk_maintenance_report_fault_lifecycle_status',
  "`lifecycle_status` IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')",
)
@Check(
  'chk_maintenance_report_fault_lifecycle_source',
  "`lifecycle_source` IN ('USER', 'ADMIN', 'SYSTEM')",
)
@Check(
  'chk_maintenance_report_fault_description_len',
  '`fault_description` IS NULL OR CHAR_LENGTH(`fault_description`) <= 10000',
)
@Check(
  'chk_maintenance_report_fault_action_len',
  '`handling_action` IS NULL OR CHAR_LENGTH(`handling_action`) <= 10000',
)
@Check(
  'chk_maintenance_report_fault_phase_code',
  "`phase_code` IS NULL OR `phase_code` IN ('PHASE_01', 'PHASE_02', 'PHASE_03', 'PHASE_04', 'PHASE_05', 'PHASE_06', 'PHASE_07', 'PHASE_08', 'PHASE_09', 'PHASE_10')",
)
@Check('chk_maintenance_report_fault_active', '`is_active` IS NULL OR `is_active` IN (0, 1)')
@Index('uk_maintenance_report_fault_uuid', ['faultUuid'], { unique: true })
@Index('idx_maintenance_report_fault_report', ['reportId', 'branchKind'])
@ForeignKey('MaintenanceReportEntity', ['reportId'], ['id'], {
  name: 'fk_maintenance_report_fault_report',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('MaintenanceReportStepEntity', ['reportId', 'stepCode'], ['reportId', 'stepCode'], {
  name: 'fk_maintenance_report_fault_step',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class MaintenanceReportFaultEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '故障ID' })
  id!: string;

  @Column({ name: 'report_id', type: 'int', comment: '所属报告ID' })
  reportId!: number;

  @Column({ name: 'fault_uuid', type: 'char', length: 36, comment: '报告内稳定故障标识' })
  faultUuid!: string;

  @Column({ name: 'branch_kind', type: 'varchar', length: 32, comment: '故障分支类型' })
  branchKind!: string;

  @Column({
    name: 'step_code',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '关联步骤编号',
  })
  stepCode!: string | null;

  @Column({ name: 'panel_snapshot', type: 'longtext', nullable: true, comment: '故障面板快照' })
  panelSnapshot!: string | null;

  @Column({ name: 'fault_description', type: 'text', comment: '故障现象描述' })
  faultDescription!: string;

  @Column({ name: 'fault_cause', type: 'text', nullable: true, comment: '故障原因判断' })
  faultCause!: string | null;

  @Column({ name: 'handling_action', type: 'longtext', nullable: true, comment: '对应处理动作' })
  handlingAction!: string | null;

  @Column({
    name: 'main_error',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '原始主错误文本',
  })
  mainError!: string | null;

  @Column({
    name: 'unit_error',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '原始单元错误文本',
  })
  unitError!: string | null;

  @Column({
    name: 'error_type',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '原始错误类型',
  })
  errorType!: string | null;

  @Column({
    name: 'gpib_status',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '原始 GPIB 状态',
  })
  gpibStatus!: string | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '原始故障状态文本（面板原始字段，不是生命周期）',
  })
  status!: string | null;

  @Column({
    name: 'source',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '原始故障来源文本（面板原始字段，不是生命周期）',
  })
  source!: string | null;

  @Column({
    name: 'phase_code',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '所属流程阶段：PHASE_01—PHASE_10；历史未知为 NULL',
  })
  phaseCode!: string | null;

  @Column({
    name: 'is_active',
    type: 'boolean',
    nullable: true,
    comment: '是否当前有效分支；历史未知为 NULL，新流程必须显式写入',
  })
  isActive!: boolean | null;

  @Column({
    name: 'lifecycle_status',
    type: 'varchar',
    length: 16,
    comment: 'OPEN/IN_PROGRESS/RESOLVED',
  })
  lifecycleStatus!: string;

  @Column({ name: 'lifecycle_source', type: 'varchar', length: 16, comment: 'USER/ADMIN/SYSTEM' })
  lifecycleSource!: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
