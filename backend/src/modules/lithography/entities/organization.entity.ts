import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('organization', { comment: '组织表（甲方/同行）' })
@Index('uk_organization_code', ['organizationCode'], { unique: true })
@Index('idx_organization_kind_status', ['kind', 'status'])
@Check('chk_organization_kind', "`kind` IN ('CLIENT', 'PEER')")
@Check('chk_organization_status', "`status` IN ('ACTIVE', 'DISABLED')")
@Check('chk_organization_service_provider', '`is_service_provider` IN (0, 1)')
@Check('chk_organization_managed_company', '`is_managed_company` IN (0, 1)')
export class OrganizationEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '组织主键ID' })
  id!: number;

  @Column({ name: 'organization_code', type: 'varchar', length: 64, comment: '组织业务编码' })
  organizationCode!: string;

  @Column({ type: 'varchar', length: 200, comment: '组织全称；编号不随改名变化' })
  name!: string;

  @Column({ name: 'short_name', type: 'varchar', length: 100, nullable: true, comment: '简称' })
  shortName!: string | null;

  @Column({
    name: 'contact_name',
    type: 'varchar',
    length: 200,
    nullable: true,
    comment: '联系人姓名',
  })
  contactName!: string | null;

  @Column({
    name: 'contact_phone',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '联系电话',
  })
  contactPhone!: string | null;

  @Column({
    name: 'contact_email',
    type: 'varchar',
    length: 254,
    nullable: true,
    comment: '公司邮箱',
  })
  contactEmail!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true, comment: '公司地址' })
  address!: string | null;

  @Column({ type: 'text', nullable: true, comment: '备注' })
  remark!: string | null;

  @Column({
    name: 'is_service_provider',
    type: 'boolean',
    default: false,
    comment: '是否具备维修服务资格',
  })
  isServiceProvider!: boolean;

  @Column({
    name: 'is_managed_company',
    type: 'boolean',
    default: false,
    comment: '是否属于一级维护的公司名单',
  })
  isManagedCompany!: boolean;

  @Column({ type: 'varchar', length: 16, comment: '组织类别：CLIENT=甲方；PEER=同行' })
  kind!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'ACTIVE',
    comment: '组织状态：ACTIVE=启用；DISABLED=停用',
  })
  status!: string;

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
