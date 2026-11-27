// src/modules/lithography/entities/local-write-hold.entity.ts

import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

/**
 * 本机写入／同步冻结闸门（任务 09 S5-2／S5-3）。
 *
 * 冻结范围＝**本机安装标识 × 受影响公司数据区**（"受影响设备公司范围"）。
 * 冻结事实**落库**：进程重启后仍可识别"这台设备当时停写停传"，不依赖内存状态。
 */
@Entity('local_write_hold', { comment: '本机写入/同步冻结闸门表' })
@Check('chk_local_write_hold_type', "`hold_type` IN ('RESTORE')")
@Check('chk_local_write_hold_status', "`status` IN ('ACTIVE', 'RELEASED')")
@Check(
  'chk_local_write_hold_released',
  "((`status` = 'ACTIVE' AND `released_at` IS NULL) OR (`status` = 'RELEASED' AND `released_at` IS NOT NULL))",
)
@Index('idx_local_write_hold_scope', ['installationId', 'organizationId', 'status'])
@ForeignKey('LocalInstallationEntity', ['installationId'], ['installationId'], {
  name: 'fk_local_write_hold_installation',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_local_write_hold_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class LocalWriteHoldEntity {
  @PrimaryColumn({ name: 'hold_id', type: 'char', length: 36, comment: '冻结ID' })
  holdId!: string;

  @Column({ name: 'installation_id', type: 'char', length: 36, comment: '本机安装标识' })
  installationId!: string;

  @Column({ name: 'organization_id', type: 'int', comment: '受影响公司数据区' })
  organizationId!: number;

  @Column({ name: 'hold_type', type: 'varchar', length: 16, comment: '冻结类型：RESTORE' })
  holdType!: string;

  @Column({ name: 'status', type: 'varchar', length: 16, comment: 'ACTIVE/RELEASED' })
  status!: string;

  @Column({
    name: 'restore_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '关联恢复运行ID',
  })
  restoreId!: string | null;

  @Column({ name: 'reason', type: 'varchar', length: 255, comment: '冻结原因（受控说明）' })
  reason!: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;

  @Column({ name: 'released_at', type: 'timestamp', precision: 3, nullable: true })
  releasedAt!: Date | null;
}
