import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('maintenance_report_version_attachment', {
  comment: '维修报告冻结附件清单与发布选择表',
})
@Index('uk_maintenance_report_version_attachment_sort', ['versionId', 'sortOrder'], {
  unique: true,
})
@Index('idx_maintenance_report_version_attachment_attachment', ['attachmentId'])
@ForeignKey('MaintenanceReportVersionEntity', ['versionId', 'reportId'], ['id', 'reportId'], {
  name: 'fk_maintenance_report_version_attachment_version',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('MaintenanceReportAttachmentEntity', ['attachmentId', 'reportId'], ['id', 'reportId'], {
  name: 'fk_maintenance_report_version_attachment_attachment',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_maintenance_report_version_attachment_sort', '`sort_order` BETWEEN 1 AND 10')
@Check('chk_maintenance_report_version_attachment_publish', '`publish_flag` IN (0, 1)')
export class MaintenanceReportVersionAttachmentEntity {
  @PrimaryColumn({ name: 'version_id', type: 'int', comment: '冻结版本ID' })
  versionId!: number;

  @PrimaryColumn({ name: 'attachment_id', type: 'int', comment: '附件ID' })
  attachmentId!: number;

  @Column({ name: 'report_id', type: 'int', comment: '所属报告ID（复合外键锚点）' })
  reportId!: number;

  @Column({ name: 'sort_order', type: 'smallint', unsigned: true, comment: '冻结时展示顺序' })
  sortOrder!: number;

  @Column({
    name: 'description_snapshot',
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '冻结时附件说明',
  })
  descriptionSnapshot!: string | null;

  @Column({
    name: 'publish_flag',
    type: 'boolean',
    default: false,
    comment: '审核通过时的发布选择；提交前恒为 0',
  })
  publishFlag!: boolean;
}
