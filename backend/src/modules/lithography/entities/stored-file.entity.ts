import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('stored_file', { comment: '统一私有原件登记表' })
@Index('uk_stored_file_upload_context', ['uploadContextId'], { unique: true })
@Index('idx_stored_file_business', ['businessType', 'businessId'])
@Index('idx_stored_file_owner_created', ['ownerOrganizationId', 'createdAt'])
@Index('idx_stored_file_status_created', ['status', 'createdAt'])
@ForeignKey('AccountEntity', ['uploadedByAccountId'], ['id'], {
  name: 'fk_stored_file_uploader',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['ownerOrganizationId'], ['id'], {
  name: 'fk_stored_file_owner_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class StoredFileEntity {
  @PrimaryColumn({ name: 'file_id', type: 'char', length: 36, comment: '稳定原件编号' })
  fileId!: string;

  @Column({ name: 'uploaded_by_account_id', type: 'int', comment: '实际上传者账号ID' })
  uploadedByAccountId!: number;

  @Column({ name: 'owner_organization_id', type: 'int', comment: '可信文件归属公司ID' })
  ownerOrganizationId!: number;

  @Column({ name: 'storage_reference', type: 'varchar', length: 1024, comment: '私有存储引用' })
  storageReference!: string;

  @Column({ name: 'original_filename', type: 'varchar', length: 255, comment: '原始文件名' })
  originalFilename!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 255, comment: '实际内容类型' })
  mimeType!: string;

  @Column({ name: 'byte_size', type: 'bigint', unsigned: true, comment: '精确字节数' })
  byteSize!: string;

  @Column({ name: 'checksum_sha256', type: 'char', length: 64, comment: '文件 SHA-256' })
  checksumSha256!: string;

  @Column({ type: 'varchar', length: 16, comment: 'STAGING/VALID/FAILED' })
  status!: string;

  @Column({ name: 'business_type', type: 'varchar', length: 32, comment: '业务引用类型' })
  businessType!: string;

  @Column({
    name: 'business_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '绑定业务真实ID',
  })
  businessId!: string | null;

  @Column({ name: 'upload_context_id', type: 'char', length: 36, comment: '上传上下文' })
  uploadContextId!: string;

  @Column({ name: 'binding_status', type: 'varchar', length: 16, comment: 'TEMPORARY/BOUND' })
  bindingStatus!: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @Column({
    name: 'verified_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '完整校验时间',
  })
  verifiedAt!: Date | null;
}
