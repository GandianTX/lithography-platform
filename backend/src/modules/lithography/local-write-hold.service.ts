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
import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  decideLocalWriteHoldVerdict,
  LOCAL_WRITE_HOLD_REASON_CODES,
  LOCAL_WRITE_HOLD_TYPES,
  type LocalWriteHoldFact,
} from '@core/local-runtime/policy/local-write-hold.policy';
import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';

import { LocalWriteHoldEntity } from './entities/local-write-hold.entity';

import { LocalRuntimeQueryService } from './queries/local-runtime.query.service';

@Injectable()
export class LocalWriteHoldService {
  constructor(
    @InjectRepository(LocalWriteHoldEntity)
    private readonly holdRepository: Repository<LocalWriteHoldEntity>,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
  ) {}

  /**
   * 建立（或续用）一条 ACTIVE 冻结。
   *
   * 同一（本机,公司,类型）范围**只保留一条** ACTIVE 冻结：重复调用不会堆叠，
   * 但会刷新原因与关联的恢复运行 ID（便于"重启后可识别"时看清是哪次恢复）。
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
    const existing = await this.holdRepository.findOne({
      where: {
        installationId: input.installationId,
        organizationId: input.organizationId,
        holdType,
        status: 'ACTIVE',
      },
    });
    if (existing !== null) {
      existing.reason = input.reason;
      existing.restoreId = input.restoreId ?? existing.restoreId;
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
        restoreId: input.restoreId ?? null,
        reason: input.reason,
        createdAt: now,
        updatedAt: now,
        releasedAt: null,
      }),
    );
    return { holdId, created: true };
  }

  /** 解除冻结（标记 RELEASED）；返回受影响行数（0＝没有 ACTIVE 冻结） */
  async release(input: {
    installationId: string;
    organizationId: number;
    holdType?: string;
    now?: Date;
  }): Promise<number> {
    const holdType = input.holdType ?? LOCAL_WRITE_HOLD_TYPES.RESTORE;
    const now = input.now ?? new Date();
    const result = await this.holdRepository.update(
      {
        installationId: input.installationId,
        organizationId: input.organizationId,
        holdType,
        status: 'ACTIVE',
      },
      { status: 'RELEASED', releasedAt: now, updatedAt: now },
    );
    return result.affected ?? 0;
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
