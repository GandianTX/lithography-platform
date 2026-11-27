// src/modules/lithography/local-write-hold.service.ts

/**
 * 写入／同步冻结闸门的事实层（任务 09 S5-2／S5-3）。
 *
 * 定位：范围与准入的**裁决**在 core 纯策略（`core/local-runtime/policy/local-write-hold.policy.ts`），
 * 本服务只提供事实与执行，避免两处判定漂移。
 *
 * 冻结范围＝**本机安装标识 × 受影响公司数据区**；冻结事实**落库**，
 * 因此进程重启后仍能识别"这台设备当时停写停传"（S5-3 的"重启后可识别"）。
 */
import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

import {
  decideIncidentForceReleaseVerdict,
  decideLocalWriteHoldVerdict,
  decideRestoreScopeOccupancyVerdict,
  decideWriteHoldReleaseVerdict,
  LOCAL_WRITE_HOLD_REASON_CODES,
  LOCAL_WRITE_HOLD_TYPES,
  type LocalWriteHoldFact,
} from '@core/local-runtime/policy/local-write-hold.policy';
import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';

import { LocalWriteHoldEntity } from './entities/local-write-hold.entity';

import { LocalRuntimeQueryService } from './queries/local-runtime.query.service';
import { LocalWriteScopeLockService } from './local-write-scope-lock.service';

/**
 * 恢复范围的**数据库级占用锁名**。
 *
 * 为什么用 MySQL 命名锁（`GET_LOCK`）而不是应用内互斥：
 * - 它由**数据库**持有 ⇒ 跨进程、跨连接互斥（多个 Node 进程 / Worker 同一口径）；
 * - 进程崩溃或连接断开时**自动释放** ⇒ 中断的恢复不会留下"永远占着范围"的死锁，
 *   运维可以重新执行收口（这是"崩溃恢复"要求的硬条件）。
 *
 * 锁名长度上限 64 字节 ⇒ 用 SHA-1 摘要压缩 `installationId:organizationId`。
 */
function scopeLockName(installationId: string, organizationId: number): string {
  const digest = createHash('sha1').update(`${installationId}:${organizationId}`).digest('hex');
  return `task09:hold:${digest}`;
}

@Injectable()
export class LocalWriteHoldService {
  constructor(
    @InjectRepository(LocalWriteHoldEntity)
    private readonly holdRepository: Repository<LocalWriteHoldEntity>,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly scopeLockService: LocalWriteScopeLockService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * 建立（或续用）一条 ACTIVE 冻结。
   *
   * 同一（本机,公司,类型）范围**只保留一条** ACTIVE 冻结：重复调用不会堆叠。
   *
   * **归属不可覆盖**（与旧实现的关键差别）：
   * 旧实现会把已有 ACTIVE 冻结的 `restore_id` 覆盖成新的恢复 ID ⇒
   * 别人的占用被抢走、原持有者失去释放资格。现在：
   * - 已有冻结属于**同一次恢复** ⇒ 续用（刷新原因与时间，**不改**归属）；
   * - 已有冻结属于**其它恢复** ⇒ **受控拒绝**（不覆盖、不抢占）；
   * - 同范围存在**多条**并存 ACTIVE（历史冲突）⇒ **失败关闭**，不静默挑一条。
   *
   * 并发互斥由**数据库命名锁**保证（`GET_LOCK`），因此"查—判—写"是原子的：
   * 并发建立同一范围的冻结时，只有一个能进入判定分支。
   */
  async hold(input: {
    installationId: string;
    organizationId: number;
    holdType?: string;
    restoreId?: string | null;
    reason: string;
    now?: Date;
  }): Promise<{ holdId: string; created: boolean }> {
    const holdType = input.holdType ?? LOCAL_WRITE_HOLD_TYPES.RESTORE;
    const now = input.now ?? new Date();
    const requestedRestoreId = input.restoreId ?? null;

    return await this.holdScope(
      input.installationId,
      input.organizationId,
      requestedRestoreId,
      async () =>
        await this.holdRepository.manager.transaction(async (manager) => {
          // ⓿ **排他范围锁**（任务 09 独立验收 P1-1）：
          //    与业务写入侧的共享锁互斥 ⇒ 冻结只在**在途业务事务提交或回滚之后**才成立。
          //    没有这一步，"A 已检查未冻结但尚未提交 → B 建立冻结并开始恢复 → A 继续写入"
          //    的窗口就仍然成立（业务侧只是"读"过冻结事实，没有与恢复共用任何锁）。
          await this.scopeLockService.acquireExclusiveScopeLock({
            manager,
            installationId: input.installationId,
            organizationId: input.organizationId,
          });
          const active = await this.listHoldRows(manager, {
            installationId: input.installationId,
            organizationId: input.organizationId,
            holdType,
          });
          const occupancy = decideRestoreScopeOccupancyVerdict({
            existingRestoreId: active[0]?.restoreId ?? null,
            requestedRestoreId,
            activeHoldCount: active.length,
          });
          if (!occupancy.allowed) {
            throw new DomainError(SYNC_ERROR.WRITE_HELD, occupancy.reason, {
              reasonCode: occupancy.reasonCode,
            });
          }
          const existing = active[0];
          const holdRepository = manager.getRepository(LocalWriteHoldEntity);
          if (existing !== undefined) {
            // 续用：刷新原因与时间；**归属不被改写**（旧实现会覆盖 restore_id）
            existing.reason = input.reason;
            existing.updatedAt = now;
            await holdRepository.save(existing);
            return { holdId: existing.holdId, created: false };
          }
          const holdId = randomUUID();
          await holdRepository.save(
            holdRepository.create({
              holdId,
              installationId: input.installationId,
              organizationId: input.organizationId,
              holdType,
              status: 'ACTIVE',
              restoreId: requestedRestoreId,
              reason: input.reason,
              createdAt: now,
              updatedAt: now,
              releasedAt: null,
            }),
          );
          return { holdId, created: true };
        }),
    );
  }

  /**
   * 解除冻结（标记 RELEASED）；返回受影响行数（0＝没有 ACTIVE 冻结）。
   *
   * **必须**声明归属：没有归属校验时，任何一次"按范围释放"都能把
   * **别人**的恢复期冻结解掉 ⇒ 恢复期间目标公司数据区重新可写，
   * 恢复写回的结果会被并发业务写入污染。
   *
   * 两种受控释放方式：
   * - **按归属**（`restoreId`）：只解冻归属一致的那些，范围内的其它冻结**不受影响**
   *   （既不误伤，也不报错）；
   * - **按精确 ID**（`holdId`）：只针对那一条；归属不符 ⇒ **受控拒绝**。
   *
   * 两者都不给（既无 `restoreId` 也无 `holdId`）⇒ **受控拒绝**
   * （不允许"按范围一刀切"的释放）。
   *
   * @param input.restoreId 释放方声明的恢复 ID
   * @param input.holdId 精确到某一条（自检按本轮真实 ID 精确回收时用）
   */
  async release(input: {
    installationId: string;
    organizationId: number;
    holdType?: string;
    restoreId?: string | null;
    holdId?: string;
    now?: Date;
  }): Promise<number> {
    const holdType = input.holdType ?? LOCAL_WRITE_HOLD_TYPES.RESTORE;
    const now = input.now ?? new Date();
    const requestedRestoreId = input.restoreId ?? null;

    return await this.withScopeLock(
      input.installationId,
      input.organizationId,
      async () =>
        await this.holdRepository.manager.transaction(async (manager) => {
          // **排他范围锁**：解除冻结与在途业务写入串行（与建立冻结同一把锁）
          await this.scopeLockService.acquireExclusiveScopeLock({
            manager,
            installationId: input.installationId,
            organizationId: input.organizationId,
          });
          const active = await this.listHoldRows(manager, {
            installationId: input.installationId,
            organizationId: input.organizationId,
            holdType,
          });
          if (active.length === 0) {
            // 没有 ACTIVE 冻结：幂等语义，如实返回"未释放"
            return 0;
          }
          if (input.holdId === undefined && requestedRestoreId === null) {
            // 既不声明归属、也不给精确 ID ⇒ 按范围一刀切的释放，受控拒绝
            throw new DomainError(
              SYNC_ERROR.WRITE_HELD,
              '解除冻结必须声明持有者（恢复 ID）或精确的冻结 ID，不接受按范围释放',
              { reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.RELEASE_NOT_PERMITTED_NOT_OWNER },
            );
          }
          let targets: typeof active;
          if (input.holdId !== undefined) {
            // 精确路径：归属不符 ⇒ 受控拒绝（不释放）
            const target = active.find((row) => row.holdId === input.holdId);
            if (target === undefined) {
              return 0;
            }
            const verdict = decideWriteHoldReleaseVerdict({
              ownerRestoreId: target.restoreId ?? null,
              requestedRestoreId,
              hasActiveHold: true,
            });
            if (!verdict.allowed && verdict.reasonCode !== null) {
              throw new DomainError(SYNC_ERROR.WRITE_HELD, verdict.reason, {
                reasonCode: verdict.reasonCode,
              });
            }
            targets = [target];
          } else {
            // 按归属路径：只解冻归属一致的那些（范围内的其它冻结不受影响）
            targets = active.filter((row) => (row.restoreId ?? null) === requestedRestoreId);
          }
          if (targets.length === 0) {
            return 0;
          }
          let released = 0;
          for (const target of targets) {
            const result = await manager
              .getRepository(LocalWriteHoldEntity)
              .update(
                { holdId: target.holdId, status: 'ACTIVE' },
                { status: 'RELEASED', releasedAt: now, updatedAt: now },
              );
            released += result.affected ?? 0;
          }
          return released;
        }),
    );
  }

  /**
   * 管理员受控**恢复故障现场**的强制解冻。
   *
   * 与 `release()` 的区别：这是**明确的例外路径**，用于"恢复进程已消失、
   * 但它留下的冻结还挡着业务写入"的现场。调用方必须显式传入
   * `incidentRestoreId`（现场对应的恢复 ID）：归属不一致仍然拒绝，
   * 避免"按范围一刀切"式地解掉别人的冻结。
   */
  async forceReleaseForRecoveryIncident(input: {
    installationId: string;
    organizationId: number;
    holdType?: string;
    /** 现场对应的恢复 ID（必须与该条冻结的归属一致） */
    incidentRestoreId: string;
    now?: Date;
  }): Promise<number> {
    const holdType = input.holdType ?? LOCAL_WRITE_HOLD_TYPES.RESTORE;
    const now = input.now ?? new Date();
    return await this.withScopeLock(
      input.installationId,
      input.organizationId,
      async () =>
        await this.holdRepository.manager.transaction(
          async (manager) =>
            await this.releaseForRecoveryIncidentInTransaction({
              manager,
              installationId: input.installationId,
              organizationId: input.organizationId,
              holdType,
              incidentRestoreId: input.incidentRestoreId,
              now,
            }),
        ),
    );
  }

  /**
   * 故障现场的强制解冻（**事务内动作**）：接受**调用方已有**的事务 manager。
   *
   * 为什么要拆出这一层（任务 09 恢复链最小修复 02）：
   * - "解冻"与"成功处置审计"必须落在**同一个事务**里 ⇒ 解冻动作不能再自己开事务
   *   （否则审计写失败时冻结已经提交，无法回滚）；
   * - 但既有外层入口（{@link forceReleaseForRecoveryIncident}）的**对外行为**必须保持
   *   不变（自己开事务 ＋ 命名锁 ＋ 排他范围锁）⇒ 由它复用本事务内动作。
   *
   * 锁：本方法在给定事务内取**排他范围锁**（与建立冻结同一把锁）⇒ 与在途业务写入
   * （共享锁）互斥；同一事务内重复取同一把锁是幂等的（不会自锁）。
   */
  async releaseForRecoveryIncidentInTransaction(input: {
    manager: EntityManager;
    installationId: string;
    organizationId: number;
    holdType?: string;
    incidentRestoreId: string;
    now?: Date;
  }): Promise<number> {
    const holdType = input.holdType ?? LOCAL_WRITE_HOLD_TYPES.RESTORE;
    const now = input.now ?? new Date();
    // **排他范围锁**：与在途业务写入串行（与建立冻结同一把锁）
    await this.scopeLockService.acquireExclusiveScopeLock({
      manager: input.manager,
      installationId: input.installationId,
      organizationId: input.organizationId,
    });
    const active = await this.listHoldRows(input.manager, {
      installationId: input.installationId,
      organizationId: input.organizationId,
      holdType,
    });
    const owned = active.filter((row) => (row.restoreId ?? null) === input.incidentRestoreId);
    const verdict = decideIncidentForceReleaseVerdict({
      ownedHoldCount: owned.length,
      incidentRestoreId: input.incidentRestoreId,
    });
    if (!verdict.allowed) {
      throw new DomainError(SYNC_ERROR.WRITE_HELD, verdict.reason, {
        reasonCode: verdict.reasonCode,
      });
    }
    const result = await input.manager.getRepository(LocalWriteHoldEntity).update(
      {
        installationId: input.installationId,
        organizationId: input.organizationId,
        holdType,
        status: 'ACTIVE',
        restoreId: input.incidentRestoreId,
      },
      { status: 'RELEASED', releasedAt: now, updatedAt: now },
    );
    return result.affected ?? 0;
  }

  /**
   * 在**数据库命名锁**保护下执行回调（与建立／解除冻结**同一把锁**、同一有界等待策略）。
   *
   * 供"解冻 ＋ 成功审计同事务"的处置入口复用：锁顺序固定为
   * 「命名锁 → 事务内排他范围锁」，与既有建立／解除冻结路径一致 ⇒ 不引入新的死锁序。
   */
  async withRecoveryScopeLock<T>(
    input: { installationId: string; organizationId: number },
    callback: () => Promise<T>,
  ): Promise<T> {
    return await this.withScopeLock(input.installationId, input.organizationId, callback);
  }

  /**
   * 在**数据库命名锁**保护下执行回调（锁范围＝安装 × 公司）。
   *
   * - 锁由**数据库**持有 ⇒ 跨进程、跨连接互斥（多个 Node 进程 / Worker 同一口径）；
   * - 进程崩溃或连接断开 ⇒ 锁**自动释放** ⇒ 中断的恢复不会留下"永远占着范围"的死锁；
   * - 第一次**不等待**；未取得 ⇒ 允许一次**有界等待**（释放路径：并发释放应当串行，
   *   而不是偶发失败）。
   */
  private async withScopeLock<T>(
    installationId: string,
    organizationId: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    const first = await this.tryWithScopeLock(installationId, organizationId, 0, callback);
    if (first.ok) {
      return first.value;
    }
    const second = await this.tryWithScopeLock(installationId, organizationId, 5, callback);
    if (!second.ok) {
      throw new DomainError(
        SYNC_ERROR.WRITE_HELD,
        '目标公司数据区正在被其它恢复占用（范围锁未取得），本次操作被拒绝',
        {
          reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED,
        },
      );
    }
    return second.value;
  }

  /**
   * "建立／续用冻结"的可重入流程（区分两类并发，G30–G33）：
   * - **同一次恢复的并发**（幂等重试／崩溃后收口）⇒ **等待**范围锁后**续用**同一条，
   *   不得当成"冲突"拒掉（否则重试与收口都做不成）；
   * - **其它恢复的并发** ⇒ **立即拒绝**（不等待、不排队）。
   *
   * 等待策略：第一次不等待；未取得 ⇒ 让并发方有机会先完成建立 ⇒ 复读归属；
   * 归属一致 ⇒ 改为**有界等待**再取锁；归属不同 ⇒ 立即受控拒绝。
   */
  private async holdScope<T>(
    installationId: string,
    organizationId: number,
    requestedRestoreId: string | null,
    callback: () => Promise<T>,
  ): Promise<T> {
    const first = await this.tryWithScopeLock(installationId, organizationId, 0, callback);
    if (first.ok) {
      return first.value;
    }
    // 未取得锁：给并发方一点时间完成建立，再复读归属决定"等待"还是"拒绝"
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const preExisting = await this.holdRepository.find({
      where: {
        installationId,
        organizationId,
        holdType: LOCAL_WRITE_HOLD_TYPES.RESTORE,
        status: 'ACTIVE',
      },
    });
    const sameOwner =
      preExisting.length === 1 && (preExisting[0]?.restoreId ?? null) === requestedRestoreId;
    if (!sameOwner) {
      throw new DomainError(
        SYNC_ERROR.WRITE_HELD,
        '目标公司数据区正在被其它恢复占用（范围锁未取得），本次操作被拒绝',
        {
          reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED,
        },
      );
    }
    const second = await this.tryWithScopeLock(installationId, organizationId, 5, callback);
    if (!second.ok) {
      throw new DomainError(
        SYNC_ERROR.WRITE_HELD,
        '目标公司数据区正在被其它恢复占用（等待范围锁超时），本次操作被拒绝',
        {
          reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED,
        },
      );
    }
    return second.value;
  }

  /** 范围锁内的执行：拿不到锁就如实返回"未取得"，不抛错 */
  private async tryWithScopeLock<T>(
    installationId: string,
    organizationId: number,
    waitSeconds: number,
    callback: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const name = scopeLockName(installationId, organizationId);
    // 用**仓储的 manager** 取独占连接：本模块没有 DataSource provider
    // （`DataSource` 只在应用根模块可用）⇒ 从 `Repository.manager.connection` 取等价能力。
    const queryRunner = this.holdRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    try {
      const rows: unknown = await queryRunner.query('SELECT GET_LOCK(?, ?) AS `locked`', [
        name,
        waitSeconds,
      ]);
      const locked = Number((rows as Array<{ locked: number | null }>)[0]?.locked ?? 0);
      if (locked !== 1) {
        return { ok: false };
      }
      try {
        return { ok: true, value: await callback() };
      } finally {
        const released: unknown = await queryRunner
          .query('SELECT RELEASE_LOCK(?) AS `released`', [name])
          .catch(() => undefined);
        const releasedValue = Number(
          (released as Array<{ released: number | null }> | undefined)?.[0]?.released ?? 0,
        );
        if (releasedValue !== 1) {
          // 锁未能释放 ⇒ 该范围会持续被占用（失败关闭：同范围后续操作被拒）。
          // 这是"宁可挡住也不能并发写"的取舍；进程重启后连接断开 ⇒ 锁自动释放。
          this.logger.error(
            { lockName: name, released: releasedValue },
            '恢复范围锁未能显式释放（连接断开时由数据库自动释放）',
          );
        }
      }
    } finally {
      await queryRunner.release().catch(() => undefined);
    }
  }

  /** 读取本机当前 ACTIVE 的冻结事实（判定用） */
  async listActive(input: {
    installationId: string;
    organizationId?: number | null;
  }): Promise<LocalWriteHoldFact[]> {
    const rows = await this.holdRepository.find({
      where: {
        installationId: input.installationId,
        status: 'ACTIVE',
        ...(input.organizationId === undefined || input.organizationId === null
          ? {}
          : { organizationId: input.organizationId }),
      },
    });
    return rows.map((row) => ({
      organizationId: row.organizationId,
      holdType: row.holdType,
      status: row.status,
      reason: row.reason,
    }));
  }

  /**
   * 写入／同步准入守卫（**按公司数据区**，本机安装身份自动解析）。
   *
   * 供各写入/派发入口统一调用：不需要各自解析安装身份，避免"口径相同、实现不同"。
   */
  async assertCompanyWritable(input: { organizationId: number }): Promise<void> {
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (installation === null) {
      throw new DomainError(SYNC_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }
    await this.assertWritable({
      installationId: installation.installationId,
      organizationId: input.organizationId,
    });
  }

  /**
   * 业务写入准入守卫（**只读预检**）：**本机未启用本地运行部署时按"无冻结"放行**。
   *
   * 与 `assertCompanyWritable` 的区别只在"本机安装身份缺失"这一一种情况：
   * - 本机**已初始化**本地运行身份 ⇒ 与 `assertCompanyWritable` 同口径（冻结期失败关闭）；
   * - 本机**未初始化** ⇒ 该部署根本不具备本地备份/恢复能力，不存在恢复期冻结，
   *   此时若失败关闭会把既有业务写入（工单、报告、资料）整体打挂，故按放行处理。
   *
   * ## 只读预检的边界（任务 09 独立验收 P1-1）
   *
   * 本方法**不持任何锁**，只读当前冻结事实 ⇒ 只能用于**任何副作用之前**的快速拒绝，
   * **不能**作为"写入与恢复互斥"的依据。真正的互斥由
   * {@link assertBusinessWritableInTransaction} 在业务事务内提供：
   * 取范围共享锁并锁定读冻结事实，锁随事务提交／回滚释放。
   *
   * 两者配套使用：只读预检挡住"冻结已在生效"的写入（避免副作用），
   * 事务内守卫挡住"冻结在写入途中建立"的写入（保证互斥）。
   */
  async assertBusinessWritable(input: {
    organizationId: number | null | undefined;
  }): Promise<void> {
    if (input.organizationId === null || input.organizationId === undefined) {
      // 归属公司为空 ⇒ 该行不属于任何公司数据区（与备份/恢复范围口径一致），不受冻结影响
      return;
    }
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (installation === null) {
      return;
    }
    await this.assertWritable({
      installationId: installation.installationId,
      organizationId: input.organizationId,
    });
  }

  /**
   * 业务写入准入守卫（**事务内版本**）：与恢复建立冻结**互斥**。
   *
   * 在**业务事务内**完成两件事，缺一不可：
   * 1. 取**范围共享锁**（`FOR SHARE`）—— 锁随事务提交／回滚释放，
   *    因此"检查未冻结"与"本次写入"之间不存在"恢复插进来"的窗口；
   * 2. 以**锁定读**（当前读）读取冻结事实 —— 不受事务快照影响，
   *    读到的就是"此刻真实的冻结事实"。
   *
   * 只读冻结事实而不持锁时，"A 读到未冻结 → B 建立冻结并恢复 → A 写入"
   * 的窗口成立：恢复的整体替换会把 A 的写入覆盖掉，或让 A 的写入混进恢复结果。
   *
   * @param input.transactionContext 业务写入的**事务上下文**
   *   （锁必须落在同一条事务连接上，否则锁与业务写入不再同生共死）
   */
  async assertBusinessWritableInTransaction(input: {
    organizationId: number | null | undefined;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    if (input.organizationId === null || input.organizationId === undefined) {
      // 归属公司为空 ⇒ 该行不属于任何公司数据区（与备份/恢复范围口径一致），不受冻结影响
      return;
    }
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (installation === null) {
      return;
    }
    const manager = getTypeOrmEntityManager(input.transactionContext);
    // ① 范围共享锁：与恢复建立冻结的排他锁互斥 ⇒ 持有到本事务提交或回滚
    await this.scopeLockService.acquireSharedScopeLock({
      manager,
      installationId: installation.installationId,
      organizationId: input.organizationId,
    });
    // ② 锁定读冻结事实（当前读）：读到的是"此刻真实"的冻结事实
    const holds = await this.listActiveFacts(manager, {
      installationId: installation.installationId,
      organizationId: input.organizationId,
    });
    const verdict = decideLocalWriteHoldVerdict({
      organizationId: input.organizationId,
      holds,
    });
    if (verdict.allowed) {
      return;
    }
    throw new DomainError(SYNC_ERROR.WRITE_HELD, verdict.reason, {
      reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE,
    });
  }

  /**
   * 本机运行域的写入准入守卫（**事务内**版本）。
   *
   * 与 `assertCompanyWritable` 的区别：
   * - 本机安装身份缺失 ⇒ **受控拒绝**（本机运行域必须先有安装身份）；
   * - 在**事务内**取范围共享锁并锁定读冻结事实 ⇒ 与恢复建立冻结互斥。
   *
   * 供本机运行数据写入入口（上传任务派发、备份运行登记、记录包导入等）调用。
   */
  async assertCompanyWritableInTransaction(input: {
    organizationId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (installation === null) {
      throw new DomainError(SYNC_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }
    const manager = getTypeOrmEntityManager(input.transactionContext);
    await this.scopeLockService.acquireSharedScopeLock({
      manager,
      installationId: installation.installationId,
      organizationId: input.organizationId,
    });
    const holds = await this.listActiveFacts(manager, {
      installationId: installation.installationId,
      organizationId: input.organizationId,
    });
    const verdict = decideLocalWriteHoldVerdict({
      organizationId: input.organizationId,
      holds,
    });
    if (verdict.allowed) {
      return;
    }
    throw new DomainError(SYNC_ERROR.WRITE_HELD, verdict.reason, {
      reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE,
    });
  }

  /**
   * 事务内读取本范围的活动冻结事实（**锁定读**）。
   *
   * 用锁定读（`FOR SHARE`）而不是普通读：锁定读是"当前读"，
   * 读到的永远是最新已提交版本，不会被事务快照回退成"冻结还不存在"。
   */
  private async listActiveFacts(
    manager: EntityManager,
    input: { installationId: string; organizationId: number },
  ): Promise<LocalWriteHoldFact[]> {
    const rows = await this.listHoldRows(
      manager,
      {
        installationId: input.installationId,
        organizationId: input.organizationId,
        holdType: LOCAL_WRITE_HOLD_TYPES.RESTORE,
      },
      'pessimistic_read',
    );
    return rows.map((row) => ({
      organizationId: row.organizationId,
      holdType: row.holdType,
      status: row.status,
      reason: row.reason,
    }));
  }

  /**
   * 在事务内按范围读取冻结行（带行锁）。
   *
   * @param lockMode `pessimistic_read`＝共享锁（业务侧）／`pessimistic_write`＝排他锁（恢复侧）
   */
  private async listHoldRows(
    manager: EntityManager,
    input: { installationId: string; organizationId: number; holdType: string },
    lockMode: 'pessimistic_read' | 'pessimistic_write' = 'pessimistic_write',
  ): Promise<LocalWriteHoldEntity[]> {
    return await manager.getRepository(LocalWriteHoldEntity).find({
      where: {
        installationId: input.installationId,
        organizationId: input.organizationId,
        holdType: input.holdType,
        status: 'ACTIVE',
      },
      lock: { mode: lockMode },
    });
  }

  /**
   * 写入／同步准入守卫：目标公司处于恢复期冻结时**失败关闭**。
   *
   * 判定只有一处（core 纯策略）；本方法只取事实并把结论变成受控错误。
   */
  async assertWritable(input: { installationId: string; organizationId: number }): Promise<void> {
    const holds = await this.listActive({
      installationId: input.installationId,
      organizationId: input.organizationId,
    });
    const verdict = decideLocalWriteHoldVerdict({
      organizationId: input.organizationId,
      holds,
    });
    if (verdict.allowed) {
      return;
    }
    throw new DomainError(SYNC_ERROR.WRITE_HELD, verdict.reason, {
      reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE,
    });
  }
}
