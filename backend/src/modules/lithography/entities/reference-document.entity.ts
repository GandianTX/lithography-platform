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

@Entity('reference_document', { comment: '光刻机AI参考资料元数据表' })
@Index('idx_reference_document_model_type', ['equipmentModelId', 'documentType'])
@Index('idx_reference_document_creator_created', ['createdByAccountId', 'createdAt'])
@Index('idx_reference_document_storage', ['storageBackend', 'storageReference'])
@Index('idx_reference_document_deprecated_created', ['deprecated', 'createdAt'])
@Index('uk_reference_document_source_submission', ['sourceSubmissionId'], { unique: true })
@Index('idx_reference_document_source_revision', ['sourceRevisionId', 'sourceSubmissionId'])
@Index('idx_reference_document_org_deleted_created', [
  'ownerOrganizationId',
  'deletedAt',
  'createdAt',
])
@ForeignKey('EquipmentModelEntity', ['equipmentModelId'], ['id'], {
  name: 'fk_reference_document_equipment_model',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['createdByAccountId'], ['id'], {
  name: 'fk_reference_document_created_by_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['ownerOrganizationId'], ['id'], {
  name: 'fk_reference_document_owner_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('ContentSubmissionEntity', ['sourceSubmissionId'], ['id'], {
  name: 'fk_reference_document_source_submission',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey(
  'ContentSubmissionRevisionEntity',
  ['sourceRevisionId', 'sourceSubmissionId'],
  ['id', 'submissionId'],
  {
    name: 'fk_reference_document_source_revision',
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
)
@ForeignKey('AccountEntity', ['updatedByAccountId'], ['id'], {
  name: 'fk_reference_document_updated_by_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_reference_document_deprecated', '`deprecated` IN (0, 1)')
@Check(
  'chk_reference_document_deletion_consistency',
  '((`deprecated` = 0 AND `deleted_at` IS NULL) OR (`deprecated` = 1 AND `deleted_at` IS NOT NULL))',
)
@Check(
  'chk_reference_document_storage_pair',
  '((`storage_backend` IS NULL AND `storage_reference` IS NULL) OR (`storage_backend` IS NOT NULL AND `storage_reference` IS NOT NULL))',
)
@Check(
  'chk_reference_document_content_source',
  '(`content_text` IS NOT NULL OR `storage_reference` IS NOT NULL)',
)
@Check(
  'chk_reference_document_ingest_method',
  "`ingest_method` IN ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT')",
)
@Check(
  'chk_reference_document_source_pair',
  '((`source_submission_id` IS NULL AND `source_revision_id` IS NULL) OR (`source_submission_id` IS NOT NULL AND `source_revision_id` IS NOT NULL))',
)
@Check(
  'chk_reference_document_model_exclusive',
  '(`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)',
)
export class ReferenceDocumentEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '参考文档主键ID' })
  id!: number;

  @Column({ type: 'varchar', length: 255, comment: '文档标题' })
  title!: string;

  @Column({ name: 'document_type', type: 'varchar', length: 100, comment: '文档类型' })
  documentType!: string;

  @Column({
    name: 'equipment_model_id',
    type: 'int',
    nullable: true,
    comment: '适用设备型号ID；为空表示通用资料',
  })
  equipmentModelId!: number | null;

  @Column({ type: 'text', nullable: true, comment: '文档说明' })
  description!: string | null;

  @Column({
    name: 'original_filename',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '原始文件名',
  })
  originalFilename!: string | null;

  @Column({
    name: 'mime_type',
    type: 'varchar',
    length: 127,
    nullable: true,
    comment: '文件MIME类型',
  })
  mimeType!: string | null;

  @Column({
    name: 'content_text',
    type: 'longtext',
    nullable: true,
    comment: '从文档提取的可搜索文本',
  })
  contentText!: string | null;

  @Column({
    name: 'storage_backend',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '外部存储类型',
  })
  storageBackend!: string | null;

  @Column({
    name: 'storage_reference',
    type: 'varchar',
    length: 512,
    nullable: true,
    comment: '外部存储引用',
  })
  storageReference!: string | null;

  @Column({ name: 'created_by_account_id', type: 'int', comment: '创建人账号ID' })
  createdByAccountId!: number;

  @Column({ name: 'owner_organization_id', type: 'int', comment: '所属组织ID' })
  ownerOrganizationId!: number;

  @Column({
    name: 'ingest_method',
    type: 'varchar',
    length: 32,
    default: 'ADMIN_DIRECT',
    comment: '入库方式：ADMIN_DIRECT=管理员直建；REVIEWED_SUBMISSION=审核发布；SYSTEM_IMPORT=预留',
  })
  ingestMethod!: string;

  @Column({
    name: 'source_submission_id',
    type: 'int',
    nullable: true,
    comment: '来源投稿ID；管理员直建为空',
  })
  sourceSubmissionId!: number | null;

  @Column({
    name: 'source_revision_id',
    type: 'int',
    nullable: true,
    comment: '来源送审版本ID；必须属于来源投稿',
  })
  sourceRevisionId!: number | null;

  @Column({
    name: 'equipment_model_text',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '机型文字（用户手填）；与机型ID互斥',
  })
  equipmentModelText!: string | null;

  @Column({
    name: 'updated_by_account_id',
    type: 'int',
    nullable: true,
    comment: '最后修改人账号ID；正式更正时必写',
  })
  updatedByAccountId!: number | null;

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
    comment: '内容 schema 版本',
  })
  schemaVersion!: number;

  @Column({ type: 'boolean', default: false, comment: '是否已软删除' })
  deprecated!: boolean;

  @Column({
    name: 'deleted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '软删除时间',
  })
  deletedAt!: Date | null;

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
