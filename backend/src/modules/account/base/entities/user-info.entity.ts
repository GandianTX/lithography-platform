// src/modules/account/base/entities/user-info.entity.ts
// src/modules/account/entities/user-info.entity.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import { Gender, UserState, type GeographicInfo } from '@app-types/models/user-info.types';
import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountEntity } from './account.entity';

@Index('uk_account_id', ['accountId'], { unique: true })
@Index('idx_base_user_info_customer_organization', ['customerOrganizationId'])
@ForeignKey('OrganizationEntity', ['customerOrganizationId'], ['id'], {
  name: 'fk_base_user_info_customer_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('base_user_info')
export class UserInfoEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '主键' })
  id!: number;

  @Column({ name: 'account_id', type: 'int', comment: 'base_user_account.id' })
  accountId!: number;

  @OneToOne(() => AccountEntity)
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Column({ type: 'varchar', length: 50, comment: '昵称' })
  nickname!: string;

  @Column({
    name: 'real_name',
    type: 'varchar',
    length: 200,
    nullable: true,
    comment: '真实姓名；与昵称分开',
  })
  realName!: string | null;

  @Column({
    name: 'customer_organization_id',
    type: 'int',
    nullable: true,
    comment: '客户所属公司ID；不自动授予工程师成员资格',
  })
  customerOrganizationId!: number | null;

  @Column({
    name: 'company_name',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '所属公司名称',
  })
  companyName!: string | null;

  @Column({
    type: 'enum',
    enum: Gender,
    default: Gender.SECRET,
    comment: '性别',
  })
  gender!: Gender;

  @Column({ name: 'birth_date', type: 'date', nullable: true, comment: '出生日期，仅保留年月日' })
  birthDate!: string | null;

  @Column({ name: 'avatar_url', type: 'varchar', length: 255, nullable: true, comment: '头像' })
  avatarUrl!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '邮箱' })
  email!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '个性签名' })
  signature!: string | null;

  @Column({ name: 'access_group', type: 'json', comment: '用户分组 ["guest"]' })
  accessGroup!: IdentityTypeEnum[];

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '地址' })
  address!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '电话' })
  phone!: string | null;

  @Column({ type: 'json', nullable: true, comment: '标签' })
  tags!: string[] | null;

  @Column({ type: 'json', nullable: true, comment: '地理位置' })
  geographic!: GeographicInfo | null;

  @Column({
    name: 'meta_digest',
    type: 'varchar',
    length: 1024,
    nullable: true,
    comment: '私有数据加密字段',
  })
  metaDigest!: IdentityTypeEnum[] | null; // 修改：从 string | null 改为 IdentityTypeEnum[] | null

  @Column({ name: 'notify_count', type: 'int', default: 0, comment: '通知数' })
  notifyCount!: number;

  @Column({ name: 'unread_count', type: 'int', default: 0, comment: '未读通知数' })
  unreadCount!: number;

  @Column({
    name: 'user_state',
    type: 'enum',
    enum: UserState,
    default: UserState.PENDING,
    comment: '账户统一状态：ACTIVE=可用，INACTIVE=停用，SUSPENDED=暂停，PENDING=待完善',
  })
  userState!: UserState;

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
