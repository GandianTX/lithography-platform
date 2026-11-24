// src/modules/lithography/entities/local-write-scope-lock.entity.ts

import { Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 本机写入／同步的**范围锁载体**（任务 09 独立验收 P1-1）。
 *
 * ## 为什么 `local_write_hold` 不够用
 *
 * - `local_write_hold` 记录的是**冻结事实**，未冻结时**没有行** ⇒ 无法承载
 *   "业务写入与恢复建立冻结互斥"所需的**行锁**（没有行就没有锁得住的对象）；
 * - 独立验收 P1-1 的反例是：业务事务 A 读到"未冻结"（此时没有锁）→ 恢复 B 建立冻结
 *   并开始整体替换数据 → A 继续写入并提交 ⇒ 业务写入穿透恢复窗口。
 *   只靠"读冻结事实"无法关闭这个窗口，必须有**双方共用、数据库可验证、持有到事务提交**的锁。
 *
 * ## 本表的职责
 *
 * 每个**（本机安装标识 × 公司数据区）**范围**恰好一行**（无业务语义，只是锁的载体）：
 * - 业务写入侧取**共享锁**（`SELECT … FOR SHARE`）：共享锁之间互不阻塞
 *   ⇒ 同一公司的正常业务写入仍然并发，不会被恢复串行化；
 * - 恢复建立／解除冻结侧取**排他锁**（`SELECT … FOR UPDATE`）：排他锁与共享锁互斥
 *   ⇒ 恢复建立冻结必须等**在途业务事务提交或回滚**后才成立；
 * - 行锁随事务提交／回滚**自动释放** ⇒ 进程崩溃不留"永远占着范围"的死锁
 *   （对比：应用内互斥或需要显式释放的锁在进程崩溃后会残留）。
 *
 * ## 为什么用行锁而不是数据库命名锁（`GET_LOCK`）
 *
 * `GET_LOCK` 是**会话级**的：它既不随业务事务提交释放，也不随事务回滚释放，
 * 业务侧要"持有到提交"就必须额外引入释放时序（提交后释放、异常时释放），
 * 任何一处遗漏都会把锁泄漏进连接池并卡死整个公司数据区。
 * 行锁与事务**同生共死**，不需要任何额外的释放时序 ⇒ 失败关闭得更干净。
 */
@Entity('local_write_scope_lock', { comment: '本机写入/同步范围锁载体表' })
@Index('uk_local_write_scope_lock_scope', ['installationId', 'organizationId'], {
  unique: true,
})
@ForeignKey('LocalInstallationEntity', ['installationId'], ['installationId'], {
  name: 'fk_local_write_scope_lock_installation',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['organizationId'], ['id'], {
  name: 'fk_local_write_scope_lock_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class LocalWriteScopeLockEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', comment: '范围锁行ID' })
  id!: string;

  @Column({ name: 'installation_id', type: 'char', length: 36, comment: '本机安装标识' })
  installationId!: string;

  @Column({ name: 'organization_id', type: 'int', comment: '公司数据区' })
  organizationId!: number;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '范围锁行建立时间',
  })
  createdAt!: Date;
}
