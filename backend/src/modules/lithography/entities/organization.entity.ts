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
export class OrganizationEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '组织主键ID' })
  id!: number;

  @Column({ name: 'organization_code', type: 'varchar', length: 64, comment: '组织业务编码' })
  organizationCode!: string;

  @Column({ type: 'varchar', length: 100, comment: '组织名称' })
  name!: string;

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
