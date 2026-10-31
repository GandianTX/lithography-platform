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

/**
 * 维修报告当前附件集合实体。
 *
 * 数据库另有生成列 `active_sort_order`（CURRENT 时为 sort_order，否则 NULL）
 * 与其唯一键，用于保证「同一报告内当前附件排序不重复」的库级约束。
 * 按项目既定规则，生成列以只读列声明，保证 Entity 与迁移结构一致。
 * 结构真源见迁移 1775401300000-create-maintenance-report-attachment-version-review。
 */
@Entity('maintenance_report_attachment', { comment: '维修报告当前附件集合表' })
@Index('uk_maintenance_report_attachment_active_slot', ['reportId', 'activeSortOrder'], {
  unique: true,
})
@Index('uk_maintenance_report_attachment_id_report', ['id', 'reportId'], { unique: true })
@Index('idx_maintenance_report_attachment_report_status', ['reportId', 'status', 'sortOrder'])
@ForeignKey('MaintenanceReportEntity', ['reportId'], ['id'], {
  name: 'fk_maintenance_report_attachment_report',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['uploadedByAccountId'], ['id'], {
  name: 'fk_maintenance_report_attachment_uploaded_by',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_maintenance_report_attachment_byte_size', '`byte_size` > 0 AND `byte_size` <= 20971520')
@Check('chk_maintenance_report_attachment_sort', '`sort_order` BETWEEN 1 AND 10')
@Check('chk_maintenance_report_attachment_status', "`status` IN ('CURRENT', 'RETIRED')")
@Check(
  'chk_maintenance_report_attachment_retired',
  "((`status` = 'CURRENT' AND `retired_at` IS NULL) OR (`status` = 'RETIRED' AND `retired_at` IS NOT NULL))",
)
@Check('chk_maintenance_report_attachment_storage', "`storage_backend` IN ('LOCAL', 'OBJECT')")
@Check('chk_maintenance_report_attachment_filename', 'CHAR_LENGTH(TRIM(`original_filename`)) > 0')
export class MaintenanceReportAttachmentEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '附件主键ID（本地标识，非云端主键）' })
  id!: number;

  @Column({ name: 'report_id', type: 'int', comment: '所属报告ID' })
  reportId!: number;

  @Column({
    name: 'original_filename',
    type: 'varchar',
    length: 255,
    comment: '原文件名快照',
  })
  originalFilename!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100, comment: 'MIME 类型' })
  mimeType!: string;

  @Column({
    name: 'byte_size',
    type: 'bigint',
    unsigned: true,
    transformer: {
      to: (value: number): number => value,
      from: (value: string): number => Number(value),
    },
    comment: '文件字节数',
  })
  byteSize!: number;

  @Column({
    name: 'checksum_sha256',
    type: 'char',
    length: 64,
    nullable: true,
    comment: 'SHA-256 校验值',
  })
  checksumSha256!: string | null;

  @Column({
    name: 'storage_backend',
    type: 'varchar',
    length: 16,
    comment: 'LOCAL/OBJECT',
  })
  storageBackend!: string;

  @Column({
    name: 'storage_reference',
    type: 'varchar',
    length: 512,
    comment: '本地相对路径或对象键',
  })
  storageReference!: string;

  @Column({ name: 'sort_order', type: 'smallint', unsigned: true, comment: '展示顺序 1-10' })
  sortOrder!: number;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '附件说明' })
  description!: string | null;

  @Column({
    name: 'active_sort_order',
    type: 'smallint',
    unsigned: true,
    nullable: true,
    insert: false,
    update: false,
    asExpression: "IF(`status` = 'CURRENT', `sort_order`, NULL)",
    generatedType: 'STORED',
    comment: '生成列：CURRENT 时为排序值，否则为 NULL（只读）',
  })
  activeSortOrder!: number | null;

  @Column({ type: 'varchar', length: 16, default: 'CURRENT', comment: 'CURRENT/RETIRED' })
  status!: string;

  @Column({ name: 'uploaded_by_account_id', type: 'int', comment: '上传人账号ID' })
  uploadedByAccountId!: number;

  @Column({
    name: 'retired_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '退役时间；RETIRED 必填',
  })
  retiredAt!: Date | null;

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
