import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('maintenance_report_alarm', { comment: '维修报告初始八项报警表' })
@Index('uk_maintenance_report_alarm_slot', ['reportId', 'alarmIndex'], { unique: true })
@Index('idx_maintenance_report_alarm_code', ['alarmCode'])
@ForeignKey('MaintenanceReportEntity', ['reportId'], ['id'], {
  name: 'fk_maintenance_report_alarm_report',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_maintenance_report_alarm_index', '`alarm_index` BETWEEN 1 AND 8')
@Check('chk_maintenance_report_alarm_code', 'CHAR_LENGTH(TRIM(`alarm_code`)) > 0')
@Check(
  'chk_maintenance_report_alarm_phase',
  "`phase_code` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10')",
)
@Check(
  'chk_maintenance_report_alarm_reset',
  "`reset_result` IN ('RESET_OK', 'RESET_FAILED', 'NOT_ATTEMPTED')",
)
export class MaintenanceReportAlarmEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '报警项主键ID' })
  id!: number;

  @Column({ name: 'report_id', type: 'int', comment: '所属报告ID' })
  reportId!: number;

  @Column({
    name: 'alarm_index',
    type: 'tinyint',
    unsigned: true,
    comment: '固定槽位 1-8',
  })
  alarmIndex!: number;

  @Column({
    name: 'alarm_code',
    type: 'varchar',
    length: 100,
    comment: '报警代码原文（保留大小写与前导零）',
  })
  alarmCode!: string;

  @Column({
    name: 'alarm_description',
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '报警说明',
  })
  alarmDescription!: string | null;

  @Column({ name: 'phase_code', type: 'varchar', length: 32, comment: '稳定阶段编码' })
  phaseCode!: string;

  @Column({
    name: 'reset_result',
    type: 'varchar',
    length: 16,
    comment: 'RESET_OK/RESET_FAILED/NOT_ATTEMPTED',
  })
  resetResult!: string;
}
