import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('reference_document_case_detail', { comment: '正式故障案例明细表' })
@ForeignKey('ReferenceDocumentEntity', ['documentId'], ['id'], {
  name: 'fk_reference_document_case_detail_document',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_reference_document_case_detail_status',
  "`handling_status` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED')",
)
@Check(
  'chk_reference_document_case_detail_resolution',
  "(`handling_status` <> 'RESOLVED' OR (`resolution` IS NOT NULL AND CHAR_LENGTH(TRIM(`resolution`)) > 0))",
)
export class ReferenceDocumentCaseDetailEntity {
  @PrimaryColumn({ name: 'document_id', type: 'int', comment: '正式资料ID（主键即资料外键）' })
  documentId!: number;

  @Column({
    name: 'error_code',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '设备错误码；保留大小写与内部符号',
  })
  errorCode!: string | null;

  @Column({
    name: 'handling_status',
    type: 'varchar',
    length: 32,
    comment: '处理状态：UNRESOLVED/IN_PROGRESS/RESOLVED',
  })
  handlingStatus!: string;

  @Column({ type: 'varchar', length: 2000, comment: '故障现象' })
  phenomenon!: string;

  @Column({
    name: 'condition_text',
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: '触发条件',
  })
  conditionText!: string | null;

  @Column({ name: 'reproduction_steps', type: 'text', comment: '复现步骤' })
  reproductionSteps!: string;

  @Column({ type: 'text', nullable: true, comment: '排查过程' })
  diagnosis!: string | null;

  @Column({ name: 'action_taken', type: 'text', nullable: true, comment: '处理措施' })
  actionTaken!: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true, comment: '处理结果；已解决时必填' })
  resolution!: string | null;

  @Column({
    name: 'case_payload_json',
    type: 'json',
    nullable: true,
    comment: '案例结构化补充快照（按 schema_version 校验）',
  })
  casePayloadJson!: Record<string, unknown> | null;

  @Column({
    name: 'schema_version',
    type: 'smallint',
    unsigned: true,
    default: 1,
    comment: '明细 schema 版本',
  })
  schemaVersion!: number;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '创建时间（系统事件时间）',
  })
  createdAt!: Date;

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
