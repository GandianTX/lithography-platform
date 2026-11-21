// src/modules/lithography/queries/sync-status.query.service.ts

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

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
 * 两条硬性过滤：
 * - **只合并 `BUSINESS_SYNC` 任务**：`BACKUP_UPLOAD`（备份上云）与历史遗留的
 *   `task_kind IS NULL` 行都不代表业务同步，必须隔离，否则会把"备份已上传"
 *   误显示为"业务记录已同步"；
 * - **回执按（公司、类型、稳定键、版本）精确匹配**：旧版本回执不代表当前正文已同步。
 */
export type SyncStatusTaskRow = {
  recordUuid: string;
  sourceVersion: number | null;
  status: string;
};

export type SyncStatusReceiptRow = {
  recordUuid: string;
  versionNo: number;
  receiptStatus: string;
  manifestChecksum: string | null;
};

export type SyncStatusConflictRow = {
  conflictId: string;
  recordUuid: string;
  status: string;
  localVersion: number | null;
  cloudVersion: number | null;
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

  /** 读取业务同步任务事实（仅 BUSINESS_SYNC，按稳定键过滤） */
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
    });
    return rows.map((row) => ({
      recordUuid: row.recordUuid ?? '',
      sourceVersion: row.sourceVersion,
      status: row.status,
    }));
  }

  /** 读取回执事实（按公司、类型、稳定键精确匹配） */
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
      status: row.status,
      localVersion: row.localVersion,
      cloudVersion: row.cloudVersion,
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
