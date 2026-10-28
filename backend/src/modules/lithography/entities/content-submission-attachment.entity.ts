import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('content_submission_attachment', { comment: '投稿私有附件表（单附件模型）' })
@Index('uk_content_submission_attachment_id_submission', ['id', 'submissionId'], { unique: true })
@Index('idx_content_submission_attachment_submission_status', ['submissionId', 'status'])
@Index('idx_content_submission_attachment_uploaded_by', ['uploadedByAccountId'])
@ForeignKey('ContentSubmissionEntity', ['submissionId'], ['id'], {
  name: 'fk_content_submission_attachment_submission',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['uploadedByAccountId'], ['id'], {
  name: 'fk_content_submission_attachment_uploaded_by_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_content_submission_attachment_status', "`status` IN ('CURRENT', 'RETIRED')")
@Check(
  'chk_content_submission_attachment_retire_consistency',
  "((`status` = 'CURRENT' AND `retired_at` IS NULL) OR (`status` = 'RETIRED' AND `retired_at` IS NOT NULL))",
)
export class ContentSubmissionAttachmentEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '附件主键ID' })
  id!: number;

  @Column({ name: 'submission_id', type: 'int', comment: '所属投稿ID' })
  submissionId!: number;

  @Column({ name: 'original_filename', type: 'varchar', length: 255, comment: '原始文件名' })
  originalFilename!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 127, comment: '文件MIME类型' })
  mimeType!: string;

  @Column({
    name: 'byte_size',
    type: 'int',
    unsigned: true,
    comment: '文件实际字节大小（依据服务端接收字节）',
  })
  byteSize!: number;

  @Column({ name: 'storage_backend', type: 'varchar', length: 32, comment: '私有存储后端' })
  storageBackend!: string;

  @Column({ name: 'storage_reference', type: 'varchar', length: 512, comment: '私有存储引用' })
  storageReference!: string;

  @Column({ name: 'uploaded_by_account_id', type: 'int', comment: '上传人账号ID' })
  uploadedByAccountId!: number;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'CURRENT',
    comment: '附件状态：CURRENT=当前有效；RETIRED=已退役',
  })
  status!: string;

  @Column({
    name: 'uploaded_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '上传时间（系统事件时间）',
  })
  uploadedAt!: Date;

  @Column({
    name: 'retired_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '退役时间（系统事件时间）',
  })
  retiredAt!: Date | null;
}
