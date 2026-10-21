import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('fault_case_submission_detail', { comment: '故障案例投稿明细表' })
@Index('idx_fault_case_submission_detail_equipment_model', ['equipmentModelId'])
@ForeignKey('ContentSubmissionEntity', ['submissionId'], ['id'], {
  name: 'fk_fault_case_submission_detail_submission',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('EquipmentModelEntity', ['equipmentModelId'], ['id'], {
  name: 'fk_fault_case_submission_detail_equipment_model',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_fault_case_submission_detail_model_exclusive',
  '(`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)',
)
@Check(
  'chk_fault_case_submission_detail_handling_status',
  "(`handling_status` IS NULL OR `handling_status` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED'))",
)
@Check(
  'chk_fault_case_submission_detail_resolution',
  "(`handling_status` IS NULL OR `handling_status` <> 'RESOLVED' OR (`resolution` IS NOT NULL AND CHAR_LENGTH(TRIM(`resolution`)) > 0))",
)
export class FaultCaseSubmissionDetailEntity {
  @PrimaryColumn({ name: 'submission_id', type: 'int', comment: '投稿ID（主键即投稿外键）' })
  submissionId!: number;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '案例标题' })
  title!: string | null;

  @Column({
    name: 'equipment_model_id',
    type: 'int',
    nullable: true,
    comment: '适用设备型号ID；与机型文字互斥',
  })
  equipmentModelId!: number | null;

  @Column({
    name: 'equipment_model_text',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '机型文字（用户手填）；与机型ID互斥',
  })
  equipmentModelText!: string | null;

  @Column({
    name: 'error_code',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '设备错误码；保留大小写与内部符号',
  })
  errorCode!: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true, comment: '故障现象' })
  phenomenon!: string | null;

  @Column({
    name: 'condition_text',
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: '触发条件',
  })
  conditionText!: string | null;

  @Column({ name: 'reproduction_steps', type: 'text', nullable: true, comment: '复现步骤' })
  reproductionSteps!: string | null;

  @Column({ type: 'text', nullable: true, comment: '排查过程' })
  diagnosis!: string | null;

  @Column({ name: 'action_taken', type: 'text', nullable: true, comment: '处理措施' })
  actionTaken!: string | null;

  @Column({
    name: 'handling_status',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '处理状态：UNRESOLVED/IN_PROGRESS/RESOLVED',
  })
  handlingStatus!: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true, comment: '处理结果；已解决时必填' })
  resolution!: string | null;

  @Column({
    name: 'extension_json',
    type: 'json',
    nullable: true,
    comment: '按 schema_version 校验的补充属性',
  })
  extensionJson!: Record<string, unknown> | null;

  @Column({
    name: 'schema_version',
    type: 'smallint',
    unsigned: true,
    default: 1,
    comment: '明细 schema 版本',
  })
  schemaVersion!: number;

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
