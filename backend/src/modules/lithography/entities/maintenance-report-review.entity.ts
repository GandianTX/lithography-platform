import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('maintenance_report_review', { comment: '维修报告审核记录表' })
@Index('uk_maintenance_report_review_version', ['versionId'], { unique: true })
@Index('uk_maintenance_report_review_id_report', ['id', 'reportId'], { unique: true })
@Index('idx_maintenance_report_review_report_time', ['reportId', 'reviewedAt'])
@ForeignKey('MaintenanceReportVersionEntity', ['versionId', 'reportId'], ['id', 'reportId'], {
  name: 'fk_maintenance_report_review_version',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['reviewedByAccountId'], ['id'], {
  name: 'fk_maintenance_report_review_reviewer',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_maintenance_report_review_decision', "`decision` IN ('APPROVE', 'RETURN')")
@Check('chk_maintenance_report_review_comment', "`decision` = 'APPROVE' OR `comment` IS NOT NULL")
export class MaintenanceReportReviewEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '审核记录主键ID' })
  id!: number;

  @Column({ name: 'report_id', type: 'int', comment: '所属报告ID' })
  reportId!: number;

  @Column({ name: 'version_id', type: 'int', comment: '被审核冻结版本ID；每版本至多一条' })
  versionId!: number;

  @Column({ type: 'varchar', length: 16, comment: 'APPROVE/RETURN' })
  decision!: string;

  @Column({
    type: 'varchar',
    length: 2000,
    nullable: true,
    comment: '审核意见；退回必填',
  })
  comment!: string | null;

  @Column({ name: 'reviewed_by_account_id', type: 'int', comment: '审核管理员账号ID' })
  reviewedByAccountId!: number;

  @Column({ name: 'reviewed_at', type: 'timestamp', precision: 3, comment: '审核事件时间' })
  reviewedAt!: Date;
}
