// src/modules/lithography/backup-restore-acceptance.service.ts

/**
 * 恢复**受理复核**（任务 09 S5 第 1 条：确认前再次检查权限、目标与保护副本）。
 *
 * 职责边界：
 * - **受理 ≠ 恢复**：本服务只复核"能不能受理"，并把受理事实写进预检记录的 `confirmation`；
 *   它**不**冻结写入、**不**恢复任何业务数据、**不**产生"恢复成功"结论；
 * - 复核项与计划要求一一对应：预检存在且结论通过、**未被受理过**（换包后旧确认作废）、
 *   **目标设备仍是本机**（异机／旧预检作废）、授权公司一致、**被恢复的备份资产仍在**、
 *   **保护副本仍在且未被清理**；
 * - 任一项不满足即拒绝，并给出**可展示的受控原因**（不含包正文与凭据）。
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';

export type RestoreAcceptanceReview =
  | {
      accepted: true;
      restoreId: string;
      backupId: string;
      protectionBackupId: string;
      organizationId: number;
      acceptedAt: string;
    }
  | { accepted: false; restoreId: string; reason: string };

@Injectable()
export class BackupRestoreAcceptanceService {
  constructor(
    @InjectRepository(BackupRestoreRunEntity)
    private readonly restoreRunRepository: Repository<BackupRestoreRunEntity>,
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository: Repository<BackupAssetEntity>,
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
  ) {}

  /**
   * 复核并受理一次恢复预检。
   *
   * @param input.allowedOrganizationId 允许的公司数据区；`null`＝一级管理员全局范围
   */
  async review(input: {
    restoreId: string;
    acceptedByAccountId: number;
    allowedOrganizationId: number | null;
    now: Date;
  }): Promise<RestoreAcceptanceReview> {
    const run = await this.restoreRunRepository.findOne({
      where: { restoreId: input.restoreId },
    });
    if (run === null) {
      return { accepted: false, restoreId: input.restoreId, reason: '恢复预检不存在或已失效' };
    }
    if (run.checkStatus !== 'PASSED') {
      return { accepted: false, restoreId: input.restoreId, reason: '恢复预检结论未通过' };
    }
    if (run.confirmation !== null && run.confirmation !== undefined) {
      return {
        accepted: false,
        restoreId: input.restoreId,
        reason: '该恢复预检已被受理，请重新预检后再确认',
      };
    }
    if (run.status !== 'PENDING') {
      return { accepted: false, restoreId: input.restoreId, reason: '恢复预检状态已变化' };
    }
    if (
      input.allowedOrganizationId !== null &&
      run.organizationId !== input.allowedOrganizationId
    ) {
      return { accepted: false, restoreId: input.restoreId, reason: '不在授权的公司数据区内' };
    }

    // 目标设备仍是本机：异机产生的旧预检在本机一律作废
    const installation = await this.installationRepository.findOne({ where: { id: 1 } });
    if (installation !== null && run.targetInstallationId !== installation.installationId) {
      return {
        accepted: false,
        restoreId: input.restoreId,
        reason: '该恢复预检来自其它设备，已失效（请在本机重新预检）',
      };
    }

    // 被恢复的备份资产仍在（本地包已清理则不能受理本机恢复）
    const asset = await this.backupAssetRepository.findOne({
      where: { backupId: run.backupId },
    });
    if (asset === null) {
      return { accepted: false, restoreId: input.restoreId, reason: '被恢复的备份资产已不存在' };
    }
    if (asset.localStatus === 'CLEANED') {
      return {
        accepted: false,
        restoreId: input.restoreId,
        reason: '被恢复的本地包已清理，无法受理本机恢复',
      };
    }

    // 保护副本标识：预检行是 PENDING，库级 CHECK 不允许本列带值，
    // 标识随**快照**落库；本列在受理（→ RUNNING）时才写入。
    const protectionBackupId = resolveProtectionBackupId(run);
    if (protectionBackupId === null) {
      return { accepted: false, restoreId: input.restoreId, reason: '保护副本已不存在' };
    }
    const protection = await this.backupAssetRepository.findOne({
      where: { backupId: protectionBackupId },
    });
    if (protection === null) {
      return { accepted: false, restoreId: input.restoreId, reason: '保护副本已不存在' };
    }
    if (protection.localStatus === 'CLEANED') {
      return { accepted: false, restoreId: input.restoreId, reason: '保护副本已被清理' };
    }

    const acceptedAt = input.now.toISOString();
    // 受理用**条件更新**（CAS）：只有仍处于 PENDING 且未受理的行才能被受理。
    //
    // 为什么不能"先查后写"：并发受理（浏览器重复点击／两个管理员同时确认）时，
    // 两个请求都可能通过前面的检查 ⇒ 都执行 update ⇒ 受理事实被后写覆盖
    // （`accepted_by_account_id` 漂移），且调用方都以为自己受理成功。
    // CAS 让**只有一个**请求能把 PENDING 推进到 RUNNING，另一个如实看到"已被受理"。
    const accepted = await this.restoreRunRepository.update(
      {
        restoreId: input.restoreId,
        status: 'PENDING',
        confirmation: IsNull(),
      },
      {
        // 受理即进入 RUNNING：状态机约束要求 PENDING 行的 `confirmation` 必须为空，
        // 且 RUNNING 行必须带 `started_at` ＋ `protection_backup_id`。
        // （此前只写 `confirmation` ⇒ **真实数据库**上的受理必然违反 CHECK 约束。）
        status: 'RUNNING',
        startedAt: input.now,
        protectionBackupId,
        confirmation: JSON.stringify({
          accepted_at: acceptedAt,
          accepted_by_account_id: input.acceptedByAccountId,
          restore_id: input.restoreId,
          backup_id: run.backupId,
          protection_backup_id: protectionBackupId,
          organization_id: run.organizationId,
        }),
      },
    );
    if ((accepted.affected ?? 0) === 0) {
      // 并发受理：另一条请求已完成受理 ⇒ 本次如实拒绝（不重复受理、不覆盖受理人）
      return {
        accepted: false,
        restoreId: input.restoreId,
        reason: '该恢复预检已被受理，请重新预检后再确认',
      };
    }

    return {
      accepted: true,
      restoreId: input.restoreId,
      backupId: run.backupId,
      protectionBackupId,
      organizationId: run.organizationId,
      acceptedAt,
    };
  }
}

/**
 * 保护副本标识的解析：预检行是 PENDING，库级 CHECK
 * `chk_backup_restore_run_execution_guard` 规定 PENDING 行本列必须为空，
 * 标识随**快照**（`check_snapshot`）落库；本列在受理（→ RUNNING）时才写入。
 *
 * 快照读回可能是 JSON 文本（`longtext` 列）或对象，两种都认；
 * 解析不出受控形态一律按"没有保护副本"处理（失败关闭）。
 */
function resolveProtectionBackupId(run: BackupRestoreRunEntity): string | null {
  const columnValue = run.protectionBackupId;
  if (typeof columnValue === 'string' && columnValue.length > 0) {
    return columnValue;
  }
  const snapshot = run.checkSnapshot;
  if (typeof snapshot !== 'string' || snapshot.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const protection = (parsed as { protection?: { backupId?: unknown } }).protection;
  const backupId = protection?.backupId;
  return typeof backupId === 'string' && backupId.length > 0 ? backupId : null;
}
