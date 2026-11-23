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
import { Repository } from 'typeorm';

import {
  decideLocalWriteHoldVerdict,
  decideRestoreScopeOccupancyVerdict,
  decideWriteHoldReleaseVerdict,
  LOCAL_WRITE_HOLD_REASON_CODES,
  LOCAL_WRITE_HOLD_TYPES,
  type LocalWriteHoldFact,
} from '@core/local-runtime/policy/local-write-hold.policy';
import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';

import { LocalWriteHoldEntity } from './entities/local-write-hold.entity';

import { LocalRuntimeQueryService } from './queries/local-runtime.query.service';

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
      async () => {
        const active = await this.holdRepository.find({
          where: {
            installationId: input.installationId,
            organizationId: input.organizationId,
            holdType,
            status: 'ACTIVE',
          },
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
        if (existing !== undefined) {
          // 续用：刷新原因与时间；**归属不被改写**（旧实现会覆盖 restore_id）
          existing.reason = input.reason;
          existing.updatedAt = now;
          await this.holdRepository.save(existing);
          return { holdId: existing.holdId, created: false };
        }
        const holdId = randomUUID();
        await this.holdRepository.save(
          this.holdRepository.create({
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
      },
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

    return await this.withScopeLock(input.installationId, input.organizationId, async () => {
      const active = await this.holdRepository.find({
        where: {
          installationId: input.installationId,
          organizationId: input.organizationId,
          holdType,
          status: 'ACTIVE',
        },
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
        const result = await this.holdRepository.update(
          { holdId: target.holdId, status: 'ACTIVE' },
          { status: 'RELEASED', releasedAt: now, updatedAt: now },
        );
        released += result.affected ?? 0;
      }
      return released;
    });
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
    return await this.withScopeLock(input.installationId, input.organizationId, async () => {
      const active = await this.holdRepository.find({
        where: {
          installationId: input.installationId,
          organizationId: input.organizationId,
          holdType,
          status: 'ACTIVE',
        },
      });
      const verdict = decideWriteHoldReleaseVerdict({
        ownerRestoreId: active[0]?.restoreId ?? null,
        requestedRestoreId: input.incidentRestoreId,
        hasActiveHold: active.length > 0,
      });
      if (!verdict.allowed && verdict.reasonCode !== null) {
        throw new DomainError(SYNC_ERROR.WRITE_HELD, verdict.reason, {
          reasonCode: verdict.reasonCode,
        });
      }
      const result = await this.holdRepository.update(
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
    });
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
   * 业务写入准入守卫：**本机未启用本地运行部署时按"无冻结"放行**。
   *
   * 与 `assertCompanyWritable` 的区别只在"本机安装身份缺失"这一种情况：
   * - 本机**已初始化**本地运行身份 ⇒ 与 `assertCompanyWritable` 同口径（冻结期失败关闭）；
   * - 本机**未初始化** ⇒ 该部署根本不具备本地备份/恢复能力，不存在恢复期冻结，
   *   此时若失败关闭会把既有业务写入（工单、报告、资料）整体打挂，故按放行处理。
   *
   * 该方法供**业务域**写入口调用（任务 09 S2-1 冻结入口清单化核对）。
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
