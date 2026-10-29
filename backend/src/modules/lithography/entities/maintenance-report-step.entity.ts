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

@Entity('maintenance_report_step', { comment: '维修报告排查步骤（工作态）表' })
@Index('uk_maintenance_report_step_no', ['reportId', 'stepNo'], { unique: true })
@Index('uk_maintenance_report_step_code', ['reportId', 'stepCode'], { unique: true })
@Index('idx_maintenance_report_step_phase', ['reportId', 'phaseCode'])
@ForeignKey('MaintenanceReportEntity', ['reportId'], ['id'], {
  name: 'fk_maintenance_report_step_report',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_maintenance_report_step_no', '`step_no` >= 1')
@Check('chk_maintenance_report_step_code', 'CHAR_LENGTH(TRIM(`step_code`)) > 0')
@Check('chk_maintenance_report_step_action', 'CHAR_LENGTH(TRIM(`action_text`)) > 0')
@Check(
  'chk_maintenance_report_step_phase',
  "`phase_code` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10')",
)
@Check(
  'chk_maintenance_report_step_branch',
  '`is_valid_new_branch` IN (0, 1) AND (`is_valid_new_branch` = 0 OR `new_alarm_code` IS NOT NULL)',
)
export class MaintenanceReportStepEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '排查步骤主键ID' })
  id!: number;

  @Column({ name: 'report_id', type: 'int', comment: '所属报告ID' })
  reportId!: number;

  @Column({ name: 'step_no', type: 'smallint', unsigned: true, comment: '顺序号；从 1 连续' })
  stepNo!: number;

  @Column({ name: 'step_code', type: 'varchar', length: 64, comment: '步骤稳定编码' })
  stepCode!: string;

  @Column({ name: 'phase_code', type: 'varchar', length: 32, comment: '稳定阶段编码' })
  phaseCode!: string;

  @Column({ name: 'part_name', type: 'varchar', length: 100, nullable: true, comment: '零件/部位' })
  partName!: string | null;

  @Column({ name: 'action_text', type: 'text', comment: '动作' })
  actionText!: string;

  @Column({
    name: 'result_text',
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: '结果',
  })
  resultText!: string | null;

  @Column({
    name: 'new_alarm_code',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '新故障分支对应报警代码原文',
  })
  newAlarmCode!: string | null;

  @Column({
    name: 'is_valid_new_branch',
    type: 'boolean',
    default: false,
    comment: '有效新故障分支标记',
  })
  isValidNewBranch!: boolean;

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
