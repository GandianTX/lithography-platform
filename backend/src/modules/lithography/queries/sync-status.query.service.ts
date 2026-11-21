// src/modules/lithography/queries/sync-status.query.service.ts

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { LocalAccountAuthorizationEntity } from '../entities/local-account-authorization.entity';
import { LocalUploadTaskEntity } from '../entities/local-upload-task.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { SyncReceiptEntity } from '../entities/sync-receipt.entity';

/**
 * 同步状态事实读取（任务 09 后续S1／S2）。
 *
 * 只负责"取事实"，不做任何展示判定；展示语义由
 * `core/local-runtime/policy/sync-status.policy.ts` 裁决。
 *
 * 三条硬性过滤：
 * - **只合并 `BUSINESS_SYNC` 任务**：`BACKUP_UPLOAD`（备份上云）与历史遗留的
 *   `task_kind IS NULL` 行都不代表业务同步，必须隔离，否则会把"备份已上传"
 *   误显示为"业务记录已同步"；遗留行单独读出，用于表达"存在用途无法确认的任务"；
 * - **回执按（公司、类型、稳定键、安装标识）匹配**：旧版本回执不代表当前正文已同步；
 *   来源安装标识为空或不是本机的回执**不得**作为本机已同步的证据（派生键跨设备会撞号）；
 * - **任务取最新一条**：同一版本可能先后登记多条（失败后重试），取最新才不失真。
 */
export type SyncStatusTaskRow = {
  recordUuid: string;
  sourceVersion: number | null;
  status: string;
  manifestChecksum: string | null;
  entityType: string;
};

export type SyncStatusReceiptRow = {
  recordUuid: string;
  versionNo: number;
  receiptStatus: string;
  manifestChecksum: string | null;
  sourceInstallationId: string | null;
};

export type SyncStatusConflictRow = {
  conflictId: string;
  recordUuid: string;
  organizationId: number;
  status: string;
  localVersion: number | null;
  cloudVersion: number | null;
  versionNo: number | null;
  /** 冲突登记时已展示的云端版本；旧行 NULL 表示历史未知 */
  displayedCloudVersion: number | null;
};

@Injectable()
export class SyncStatusQueryService {
  constructor(
    @InjectRepository(LocalUploadTaskEntity)
    private readonly taskRepository: Repository<LocalUploadTaskEntity>,
    @InjectRepository(SyncReceiptEntity)
    private readonly receiptRepository: Repository<SyncReceiptEntity>,
    @InjectRepository(SyncConflictEntity)
    private readonly conflictRepository: Repository<SyncConflictEntity>,
    @InjectRepository(LocalAccountAuthorizationEntity)
    private readonly authorizationRepository: Repository<LocalAccountAuthorizationEntity>,
  ) {}

  /** 读取业务同步任务事实（仅 BUSINESS_SYNC，按稳定键过滤，取最新一条优先） */
  async readBusinessSyncTasks(
    installationId: string,
    recordUuids: readonly string[],
  ): Promise<SyncStatusTaskRow[]> {
    if (recordUuids.length === 0) {
      return [];
    }
    const rows = await this.taskRepository.find({
      where: {
        installationId,
        recordUuid: In([...recordUuids]),
        taskKind: 'BUSINESS_SYNC',
      },
      order: { id: 'DESC' },
    });
    return rows.map((row) => ({
      recordUuid: row.recordUuid ?? '',
      sourceVersion: row.sourceVersion,
      status: row.status,
      manifestChecksum: row.manifestChecksum,
      entityType: row.entityType,
    }));
  }

  /**
   * 读取历史遗留任务（`task_kind IS NULL`）的存在性。
   *
   * 这类行无法确认为业务同步（也可能是备份上云的历史写法），因此**不参与**状态裁决，
   * 只用于避免把"存在一条用途不明的任务"误报成"没有任务"。
   */
  async readLegacyTaskUuids(
    installationId: string,
    recordUuids: readonly string[],
  ): Promise<string[]> {
    if (recordUuids.length === 0) {
      return [];
    }
    const rows = await this.taskRepository.find({
      where: {
        installationId,
        recordUuid: In([...recordUuids]),
        taskKind: IsNull(),
      },
      select: { recordUuid: true },
    });
    const uuids: string[] = [];
    for (const row of rows) {
      const uuid = row.recordUuid;
      if (uuid !== null && !uuids.includes(uuid)) {
        uuids.push(uuid);
      }
    }
    return uuids;
  }

  /** 读取回执事实（按公司、类型、稳定键匹配） */
  async readReceipts(
    organizationId: number,
    resourceType: string,
    recordUuids: readonly string[],
  ): Promise<SyncStatusReceiptRow[]> {
    if (recordUuids.length === 0) {
      return [];
    }
    const rows = await this.receiptRepository.find({
      where: {
        organizationId,
        resourceType,
        recordUuid: In([...recordUuids]),
      },
    });
    return rows.map((row) => ({
      recordUuid: row.recordUuid,
      versionNo: row.versionNo,
      receiptStatus: row.receiptStatus,
      manifestChecksum:
        typeof row.manifestChecksum === 'string' && row.manifestChecksum.length > 0
          ? row.manifestChecksum
          : null,
      sourceInstallationId: row.sourceInstallationId,
    }));
  }

  /** 读取待处理冲突事实（按公司、类型、稳定键过滤） */
  async readPendingConflicts(
    organizationId: number,
    resourceType: string,
    recordUuids: readonly string[],
  ): Promise<SyncStatusConflictRow[]> {
    if (recordUuids.length === 0) {
      return [];
    }
    const rows = await this.conflictRepository.find({
      where: {
        organizationId,
        resourceType,
        recordUuid: In([...recordUuids]),
        status: 'PENDING',
      },
    });
    return rows.map((row) => ({
      conflictId: row.conflictId,
      recordUuid: row.recordUuid,
      organizationId: row.organizationId,
      status: row.status,
      localVersion: row.localVersion,
      cloudVersion: row.cloudVersion,
      versionNo: row.versionNo,
      displayedCloudVersion: row.displayedCloudVersion,
    }));
  }

  /**
   * 读取账号授权事实：返回 accountId → 授权状态。
   *
   * 没有授权行时**不**判定为失效（只表示未取得该事实），由上层按"未知"处理。
   */
  async readAuthorizations(
    installationId: string,
    organizationId: number,
    accountIds: readonly number[],
  ): Promise<Map<number, 'ACTIVE' | 'REVOKED'>> {
    const result = new Map<number, 'ACTIVE' | 'REVOKED'>();
    if (accountIds.length === 0) {
      return result;
    }
    const rows = await this.authorizationRepository.find({
      where: {
        installationId,
        organizationId,
        accountId: In([...accountIds]),
      },
    });
    for (const row of rows) {
      const status = row.authorizationStatus === 'REVOKED' ? 'REVOKED' : 'ACTIVE';
      result.set(row.accountId, status);
    }
    return result;
  }
}
