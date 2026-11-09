// src/modules/account/base/entities/account.entity.ts
import { AccountStatus, LoginHistoryItemModel } from '@app-types/models/account.types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserInfoEntity } from './user-info.entity';

@Entity('base_user_account')
@Index('uk_login_name', ['loginName'], { unique: true })
@Index('uk_login_email', ['loginEmail'], { unique: true })
export class AccountEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: 'primary key' })
  id!: number;

  // 修改 loginName 字段，添加 nullable: true
  @Column({
    name: 'login_name',
    type: 'varchar',
    length: 30,
    nullable: true,
    comment: '账号名',
  })
  loginName!: string | null;

  @Column({
    name: 'login_email',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '账号email',
  })
  loginEmail!: string | null;

  @Column({ name: 'login_password', type: 'varchar', length: 255, comment: '密码' })
  loginPassword!: string;

  @Column({
    type: 'enum',
    enum: AccountStatus,
    default: AccountStatus.PENDING,
    comment: '"ACTIVE=1"、"BANNED=2"、"DELETED=3"、"PENDING=4"、"SUSPENDED=5"、"INACTIVE=6"',
  })
  status!: AccountStatus;

  @Column({ name: 'recent_login_history', type: 'json', nullable: true, comment: '最近5次登录IP' })
  recentLoginHistory!: LoginHistoryItemModel[] | null;

  @Column({
    name: 'identity_hint',
    type: 'varchar',
    length: 30,
    nullable: true,
    comment: '身份提示字段，用于加速判断当前账号角色：SUPER_ADMIN、ENGINEER、CUSTOMER',
  })
  identityHint!: string | null;

  @Column({
    name: 'admin_level',
    type: 'tinyint',
    nullable: true,
    comment: '管理员等级：1=一级；2=二级；NULL=非管理员或未映射',
  })
  adminLevel!: number | null;

  @Column({
    name: 'must_change_password',
    type: 'boolean',
    default: false,
    comment: '是否必须先修改密码',
  })
  mustChangePassword!: boolean;

  /**
   * 用户详细信息关联
   * 一对一关系的反向端（inverse side）
   */
  @OneToOne(() => UserInfoEntity, (userInfo) => userInfo.account)
  userInfo?: UserInfoEntity;

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
