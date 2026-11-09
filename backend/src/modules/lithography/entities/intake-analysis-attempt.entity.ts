import { Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('intake_analysis_attempt', { comment: '报修分析尝试表' })
@Index('uk_intake_analysis_attempt_generation', ['intakeId', 'generationNo'], {
  unique: true,
})
@ForeignKey('RepairRequestIntakeEntity', ['intakeId'], ['id'], {
  name: 'fk_intake_analysis_attempt_intake',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AiProviderCallRecordEntity', ['providerCallId'], ['id'], {
  name: 'fk_intake_analysis_attempt_provider_call',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class IntakeAnalysisAttemptEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '分析尝试ID' })
  id!: string;

  @Column({ name: 'intake_id', type: 'int', comment: '原报修ID' })
  intakeId!: number;

  @Column({
    name: 'generation_no',
    type: 'int',
    unsigned: true,
    comment: '0=初次；1=唯一重试',
  })
  generationNo!: number;

  @Column({ type: 'varchar', length: 16, comment: 'RUNNING/SUCCEEDED/FAILED' })
  status!: string;

  @Column({ name: 'output_text', type: 'longtext', nullable: true, comment: '真实模型输出原文' })
  outputText!: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true, comment: '实际失败原因' })
  failureReason!: string | null;

  @Column({ name: 'provider_call_id', type: 'int', nullable: true, comment: '模型调用追溯ID' })
  providerCallId!: number | null;

  @Column({
    name: 'started_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '实际开始时间',
  })
  startedAt!: Date | null;

  @Column({
    name: 'finished_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '实际结束时间',
  })
  finishedAt!: Date | null;
}
