import { Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('repair_request_intake', { comment: '报修原始输入表' })
@Index('uk_repair_request_intake_record_uuid', ['recordUuid'], { unique: true })
@Index('uk_repair_request_intake_converted', ['convertedRequestId'], { unique: true })
@Index('idx_repair_request_intake_customer_created', ['customerAccountId', 'createdAt'])
@Index('idx_repair_request_intake_organization_status', [
  'customerOrganizationId',
  'analysisStatus',
])
@ForeignKey('AccountEntity', ['customerAccountId'], ['id'], {
  name: 'fk_repair_request_intake_customer_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['customerOrganizationId'], ['id'], {
  name: 'fk_repair_request_intake_customer_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['serviceOrganizationId'], ['id'], {
  name: 'fk_repair_request_intake_service_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('EquipmentModelEntity', ['equipmentModelId'], ['id'], {
  name: 'fk_repair_request_intake_equipment_model',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('StoredFileEntity', ['fileId'], ['fileId'], {
  name: 'fk_repair_request_intake_file',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('RepairRequestEntity', ['convertedRequestId'], ['id'], {
  name: 'fk_repair_request_intake_converted_request',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class RepairRequestIntakeEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '报修请求ID' })
  id!: number;

  @Column({ name: 'record_uuid', type: 'char', length: 36, comment: '跨端稳定编号' })
  recordUuid!: string;

  @Column({ name: 'customer_account_id', type: 'int', comment: '报修客户账号ID' })
  customerAccountId!: number;

  @Column({ name: 'customer_organization_id', type: 'int', comment: '客户可信公司ID' })
  customerOrganizationId!: number;

  @Column({ name: 'service_organization_id', type: 'int', comment: '选定维修公司ID' })
  serviceOrganizationId!: number;

  @Column({ name: 'equipment_model_id', type: 'int', comment: '预置机型ID' })
  equipmentModelId!: number;

  @Column({ name: 'error_code', type: 'varchar', length: 100, comment: '设备错误代码' })
  errorCode!: string;

  @Column({ name: 'fault_description', type: 'longtext', comment: '客户原始故障' })
  faultDescription!: string;

  @Column({ name: 'file_id', type: 'char', length: 36, nullable: true, comment: '报修私有原件' })
  fileId!: string | null;

  @Column({ name: 'analysis_status', type: 'varchar', length: 16, comment: '分析状态' })
  analysisStatus!: string;

  @Column({
    name: 'analysis_generation',
    type: 'int',
    unsigned: true,
    default: 0,
    comment: '0=初次；1=唯一重试',
  })
  analysisGeneration!: number;

  @Column({
    name: 'converted_request_id',
    type: 'int',
    nullable: true,
    comment: '转换后的唯一维修工单ID',
  })
  convertedRequestId!: number | null;

  @Column({
    name: 'deleted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '逻辑删除时间',
  })
  deletedAt!: Date | null;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
