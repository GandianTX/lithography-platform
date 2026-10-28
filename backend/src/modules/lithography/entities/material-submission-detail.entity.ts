import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('material_submission_detail', { comment: '普通资料投稿明细表' })
@Index('idx_material_submission_detail_equipment_model', ['equipmentModelId'])
@ForeignKey('ContentSubmissionEntity', ['submissionId'], ['id'], {
  name: 'fk_material_submission_detail_submission',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('EquipmentModelEntity', ['equipmentModelId'], ['id'], {
  name: 'fk_material_submission_detail_equipment_model',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check(
  'chk_material_submission_detail_model_exclusive',
  '(`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)',
)
@Check(
  'chk_material_submission_detail_type',
  "(`document_type` IS NULL OR `document_type` <> 'FAULT_CASE')",
)
export class MaterialSubmissionDetailEntity {
  @PrimaryColumn({ name: 'submission_id', type: 'int', comment: '投稿ID（主键即投稿外键）' })
  submissionId!: number;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '资料标题' })
  title!: string | null;

  @Column({
    name: 'document_type',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '资料类型；不允许 FAULT_CASE',
  })
  documentType!: string | null;

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

  @Column({ type: 'varchar', length: 2000, nullable: true, comment: '资料说明' })
  description!: string | null;

  @Column({ name: 'content_text', type: 'longtext', nullable: true, comment: '资料正文' })
  contentText!: string | null;

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
