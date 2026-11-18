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

@Entity('repair_request_diagnostic_step', { comment: '工单排查步骤' })
@Index('uk_repair_request_diagnostic_step_no', ['requestId', 'stepNo'], { unique: true })
@Index('uk_repair_request_diagnostic_step_id', ['requestId', 'id'], { unique: true })
@ForeignKey('RepairRequestEntity', ['requestId'], ['id'], {
  name: 'fk_repair_request_diagnostic_step_request',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_repair_request_diagnostic_step_no', '`step_no` >= 1')
@Check('chk_repair_request_diagnostic_step_action', 'CHAR_LENGTH(TRIM(`action_text`)) > 0')
@Check(
  'chk_repair_request_diagnostic_step_result',
  "`result_code` IN ('RESOLVED', 'UNRESOLVED', 'NEW_FAULT')",
)
export class RepairRequestDiagnosticStepEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '排查步骤主键ID' })
  id!: string;

  @Column({ name: 'request_id', type: 'int', comment: '所属工单ID' })
  requestId!: number;

  @Column({
    name: 'step_no',
    type: 'int',
    unsigned: true,
    comment: '工单内顺序号；>=1 且唯一',
  })
  stepNo!: number;

  @Column({
    name: 'error_code',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '步骤报错代码；保留前导零',
  })
  errorCode!: string | null;

  @Column({
    name: 'part_name',
    type: 'varchar',
    length: 300,
    nullable: true,
    comment: '零件/部位；选填',
  })
  partName!: string | null;

  @Column({ name: 'action_text', type: 'text', comment: '排查动作' })
  actionText!: string;

  @Column({
    name: 'result_code',
    type: 'varchar',
    length: 16,
    comment: 'RESOLVED/UNRESOLVED/NEW_FAULT',
  })
  resultCode!: string;

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
