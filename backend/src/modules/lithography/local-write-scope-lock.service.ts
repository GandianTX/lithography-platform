// src/modules/lithography/local-write-scope-lock.service.ts

/**
 * 本机写入／同步的**范围锁**（任务 09 独立验收 P1-1）。
 *
 * ## 定位
 *
 * 恢复期的写入冻结事实落在 `local_write_hold`（**有没有冻结**），
 * 本服务提供的是**与业务写入共用的并发协议**（**能不能与恢复并行**）：
 *
 * - 业务写入侧取**共享锁**（`SELECT … FOR SHARE`）；
 * - 恢复建立／解除冻结侧取**排他锁**（`SELECT … FOR UPDATE`）。
 *
 * 共享锁之间互不阻塞 ⇒ 同一公司的正常业务写入仍然并发；
 * 排他锁与共享锁互斥 ⇒ **恢复建立冻结必须等在途业务事务提交或回滚后才成立**，
 * 从而关闭独立验收 P1-1 的反例：
 * "A 已检查未冻结但尚未提交 → B 建立冻结并开始恢复 → A 继续写入"。
 *
 * 行锁随事务**提交／回滚自动释放** ⇒ 进程崩溃不会留下"永远占着范围"的死锁。
 *
 * ## 为什么要独立成一张表
 *
 * `local_write_hold` 记录的是**冻结事实**，未冻结时**没有行** ⇒ 没有行就没有
 * "锁得住的对象"。本表为每个**（本机安装标识 × 公司数据区）**范围提供恰好一行，
 * 行内**只有范围标识，没有任何业务语义** ⇒ 它不是数据，只是锁的载体。
 *
 * ## 与数据库命名锁（`GET_LOCK`）的取舍
 *
 * `GET_LOCK` 是**会话级**的：既不随业务事务提交释放，也不随回滚释放，
 * "持有到提交"必须额外引入"提交后释放／异常时释放"的时序，
 * 任何一处遗漏都会把锁泄漏进连接池并卡死整个公司数据区。
 * 行锁与事务同生共死，不需要额外释放时序 ⇒ 失败关闭得更干净。
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';
import { LOCAL_WRITE_HOLD_REASON_CODES } from '@core/local-runtime/policy/local-write-hold.policy';

/** MySQL 锁等待超时（`ER_LOCK_WAIT_TIMEOUT`）：范围被长事务占住，本次等不到锁 */
const MYSQL_LOCK_WAIT_TIMEOUT = 1205;
/** MySQL 死锁（`ER_LOCK_DEADLOCK`）：本次事务被数据库判定为死锁牺牲者 */
const MYSQL_LOCK_DEADLOCK = 1213;

@Injectable()
export class LocalWriteScopeLockService {
  /**
   * 业务写入侧：取范围**共享锁**（持有到调用方事务提交或回滚）。
   *
   * @param manager 调用方的**事务** EntityManager（锁必须落在业务事务那条连接上，
   *   否则锁会随语句结束而失去与业务事务的绑定）
   */
  async acquireSharedScopeLock(input: {
    manager: EntityManager;
    installationId: string;
    organizationId: number;
  }): Promise<void> {
    await this.acquireScopeLock(input, 'FOR SHARE');
  }

  /**
   * 恢复侧：取范围**排他锁**（持有到调用方事务提交或回滚）。
   *
   * 排他锁与业务侧共享锁互斥 ⇒ 恢复建立／解除冻结与在途业务写入**串行**。
   */
  async acquireExclusiveScopeLock(input: {
    manager: EntityManager;
    installationId: string;
    organizationId: number;
  }): Promise<void> {
    await this.acquireScopeLock(input, 'FOR UPDATE');
  }

  /**
   * 取范围锁的统一实现。
   *
   * 范围行**可能尚不存在**（该范围第一次发生业务写入）：
   * 此时锁定读会读到 0 行 ⇒ **没有锁住任何东西** ⇒ 互斥失效。
   * 因此固定为"**普通读预检 → 需要就预建 → 锁定读**"三步：
   *
   * 1. **普通读**（非锁定）预检范围行是否存在：普通读**不取间隙锁**，
   *    因此不会与"并发预建范围行"互相等待（真实库实测：先用锁定读再预建，
   *    会在 REPEATABLE READ 下因间隙锁与并发插入互相等待而触发死锁 1213）；
   * 2. 范围行不存在 ⇒ 在**同一事务内**幂等预建（`INSERT IGNORE`）：
   *    与业务事务同生共死，避免"范围行建在事务外、事务回滚后留下半截状态"；
   * 3. **锁定读**取范围锁：`FOR SHARE`（业务侧）／`FOR UPDATE`（恢复侧）。
   *
   * 三步都在**调用方的事务连接**上执行 ⇒ 锁随事务提交／回滚释放。
   */
  private async acquireScopeLock(
    input: { manager: EntityManager; installationId: string; organizationId: number },
    lockClause: 'FOR SHARE' | 'FOR UPDATE',
  ): Promise<void> {
    try {
      if (!(await this.scopeRowExists(input.manager, input))) {
        await this.insertScopeRow(input.manager, input);
      }
      if (await this.tryLockScopeRow(input.manager, input, lockClause)) {
        return;
      }
      throw new DomainError(
        SYNC_ERROR.WRITE_HELD,
        '目标公司数据区的范围锁不可得（范围行建立后仍无法加锁），本次写入已被拒绝',
        { reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_BUSY },
      );
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (isLockContentionError(error)) {
        // 锁等待超时／死锁：本次拿不到范围锁 ⇒ **不放行**（失败关闭）
        throw new DomainError(
          SYNC_ERROR.WRITE_HELD,
          '目标公司数据区正在被其它操作占用，本次写入已被拒绝，请稍后重试',
          { reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_BUSY },
          error,
        );
      }
      throw error;
    }
  }

  /**
   * 普通读预检范围行是否存在（**不加锁**）。
   *
   * 用普通读而不是锁定读：锁定读在行不存在时会取**间隙锁**，
   * 而间隙锁会让"并发预建同一范围行"互相等待 ⇒ 真实库实测会触发死锁 1213。
   */
  private async scopeRowExists(
    manager: EntityManager,
    input: { installationId: string; organizationId: number },
  ): Promise<boolean> {
    const rows: unknown = await manager.query(
      'SELECT `installation_id` FROM `local_write_scope_lock` ' +
        'WHERE `installation_id` = ? AND `organization_id` = ? LIMIT 1',
      [input.installationId, input.organizationId],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * 在**当前事务内**幂等预建范围行。
   *
   * 用 `INSERT IGNORE`：并发预建同一范围时只有一条成功，其余被忽略；
   * 忽略的其它错误（如外键不成立）由随后的锁定读"读不到行"暴露出来 ⇒ 失败关闭。
   */
  private async insertScopeRow(
    manager: EntityManager,
    input: { installationId: string; organizationId: number },
  ): Promise<void> {
    await manager.query(
      'INSERT IGNORE INTO `local_write_scope_lock` (`installation_id`, `organization_id`) ' +
        'VALUES (?, ?)',
      [input.installationId, input.organizationId],
    );
  }

  /** 锁定读范围行；读到行即表示锁已建立（InnoDB 行锁随事务提交／回滚释放） */
  private async tryLockScopeRow(
    manager: EntityManager,
    input: { installationId: string; organizationId: number },
    lockClause: 'FOR SHARE' | 'FOR UPDATE',
  ): Promise<boolean> {
    const rows: unknown = await manager.query(
      'SELECT `installation_id` FROM `local_write_scope_lock` ' +
        'WHERE `installation_id` = ? AND `organization_id` = ? ' +
        lockClause,
      [input.installationId, input.organizationId],
    );
    return Array.isArray(rows) && rows.length > 0;
  }
}

/** 判定是否属于"锁竞争"类数据库错误（等待超时／死锁） */
function isLockContentionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { errno?: unknown; code?: unknown };
  if (candidate.errno === MYSQL_LOCK_WAIT_TIMEOUT || candidate.errno === MYSQL_LOCK_DEADLOCK) {
    return true;
  }
  return candidate.code === 'ER_LOCK_WAIT_TIMEOUT' || candidate.code === 'ER_LOCK_DEADLOCK';
}
