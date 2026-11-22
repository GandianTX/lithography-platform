// src/modules/lithography/business-sync-receipt.service.ts
/**
 * 同步回执与冲突写入服务（任务 09 S2.2）。
 *
 * 职责：把派发链的核对结果落成**可被读侧核对的事实**：
 * - `sync_receipt`：本机版本已在云端落地的回执（唯一键：公司+类型+稳定键+版本）；
 * - `sync_conflict`：本机与云端版本不一致的待裁决事实。
 *
 * 幂等口径：同一（公司, 类型, 稳定键, 版本）只应有一行。重复写入（响应丢失后重试）
 * 更新同一行，不新增行——这是"响应丢失不会产生重复回执"的落点。
 */

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { isDuplicateKeyError } from '@src/modules/common/utils/database-error.util';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import { SyncConflictEntity } from './entities/sync-conflict.entity';
import { SyncReceiptEntity } from './entities/sync-receipt.entity';

/** 导入登记回执的来源标记（本机导入自其他安装，不是云端回执） */
/**
 * 导入回执的 `source_system`。
 *
 * 取值必须落在 DB CHECK 约束 `chk_sync_receipt_source` 内（`'LOCAL'` / `'CLOUD'`）：
 * 记录包是**本机之间**的交付（U盘／离线拷贝），属"本地"来源；
 * "是哪一台本地安装交付的"由 `source_installation_id` 区分（记**来源安装**，不是本机），
 * 读侧据此不会把导入记录误判成"已同步到云端"。
 *
 * 早期版本写 `'LOCAL_IMPORT'`，落在 CHECK 白名单外 ⇒ **真实数据库**上的导入回执登记
 * 必然失败（单测用替身掩盖了它）。
 */
export const IMPORT_RECEIPT_SOURCE_SYSTEM = 'LOCAL';

/** 成功回执写入入参 */
export type BusinessSyncSuccessReceiptInput = {
  organizationId: number;
  resourceType: string;
  recordUuid: string;
  versionNo: number;
  /** 正文与原件清单摘要（必须与任务登记值一致） */
  manifestChecksum: string;
  /** 本机安装标识（读侧据此确认回执来源是本机） */
  installationId: string;
  /** 云端资源标识 */
  remoteResourceId: string | null;
  /** 云端实际接收时间 */
  receivedAt: Date | null;
};

/** 冲突写入入参 */
export type BusinessSyncConflictInput = {
  organizationId: number;
  resourceType: string;
  recordUuid: string;
  /** 冲突版本号（本机版本；唯一键的一部分） */
  versionNo: number;
  localVersion: number | null;
  cloudVersion: number | null;
  /** 本机快照（必须含 schema_version） */
  localSnapshot: Record<string, unknown>;
  /** 云端快照（必须含 schema_version） */
  cloudSnapshot: Record<string, unknown>;
  /** 受控冲突说明（不含正文与凭据） */
  conflictReason: string;
};

@Injectable()
export class BusinessSyncReceiptService {
  constructor(
    @InjectRepository(SyncReceiptEntity)
    private readonly receiptRepository: Repository<SyncReceiptEntity>,
    @InjectRepository(SyncConflictEntity)
    private readonly conflictRepository: Repository<SyncConflictEntity>,
  ) {}

  /**
   * 幂等落成功回执。
   *
   * 已存在同键回执时按"同一事实"更新（响应丢失后重试不会产生第二行）。
   */
  async recordSuccess(
    input: BusinessSyncSuccessReceiptInput,
    transactionContext: PersistenceTransactionContext,
  ): Promise<string> {
    const repository = getTypeOrmEntityManager(transactionContext).getRepository(
      this.receiptRepository.target,
    );
    const existing = await repository.findOne({
      where: {
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        recordUuid: input.recordUuid,
        versionNo: input.versionNo,
      },
    });
    const patch = {
      sourceSystem: 'LOCAL',
      sourceInstallationId: input.installationId,
      remoteResourceId: input.remoteResourceId,
      receivedAt: input.receivedAt,
      receiptStatus: 'SUCCEEDED',
      manifestChecksum: input.manifestChecksum,
    };
    if (existing !== null) {
      await repository.update({ receiptId: existing.receiptId }, patch);
      return existing.receiptId;
    }
    return this.insertReceiptIdempotently(
      repository,
      {
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        recordUuid: input.recordUuid,
        versionNo: input.versionNo,
      },
      (receiptId) =>
        repository.create({
          receiptId,
          organizationId: input.organizationId,
          resourceType: input.resourceType,
          recordUuid: input.recordUuid,
          versionNo: input.versionNo,
          ...patch,
        }),
    );
  }

  /**
   * 登记一次**导入**（U 盘记录包入本机）并返回回执 ID。
   *
   * 语义：这条记录@版本已由**来源安装**（包的 `installation_id`）交付到本机。
   * 因此 `source_installation_id` 记来源安装（不是本机），本机读侧据此不会把
   * 导入记录误判成"已同步到云端"。
   *
   * 幂等：同键已存在则复用该行（不新增、不覆盖来源安装标识）。
   */
  async recordImportedVersion(
    input: {
      organizationId: number;
      resourceType: string;
      recordUuid: string;
      versionNo: number;
      manifestChecksum: string;
      /** 来源安装标识（包的 installation_id） */
      sourceInstallationId: string;
    },
    transactionContext: PersistenceTransactionContext,
  ): Promise<string> {
    const repository = getTypeOrmEntityManager(transactionContext).getRepository(
      this.receiptRepository.target,
    );
    const existing = await repository.findOne({
      where: {
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        recordUuid: input.recordUuid,
        versionNo: input.versionNo,
      },
    });
    if (existing !== null) {
      return existing.receiptId;
    }
    return this.insertReceiptIdempotently(
      repository,
      {
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        recordUuid: input.recordUuid,
        versionNo: input.versionNo,
      },
      (receiptId) =>
        repository.create({
          receiptId,
          organizationId: input.organizationId,
          resourceType: input.resourceType,
          recordUuid: input.recordUuid,
          versionNo: input.versionNo,
          sourceSystem: IMPORT_RECEIPT_SOURCE_SYSTEM,
          sourceInstallationId: input.sourceInstallationId,
          remoteResourceId: null,
          // 「对端实际接收时间」：导入场景即**本机收到该记录@版本的时刻**
          // （来源安装已把该版本交付到本机）。
          // 必须写：`chk_sync_receipt_confirm_time` 要求
          // 非 PENDING/CONFLICT 的回执必须有 received_at 或 confirmed_at 可证明确认事件；
          // 此前留空会让**真实数据库**上的导入回执登记必然失败（单测用替身掩盖了它）。
          // 不写 confirmed_at：那是旧版确认事件字段，实体注释明确"不双写新 received_at"。
          receivedAt: new Date(),
          receiptStatus: 'SUCCEEDED',
          manifestChecksum: input.manifestChecksum,
        }),
    );
  }

  /**
   * 幂等落冲突记录。
   *
   * 已存在同键冲突时只补齐事实，不覆盖既有裁决（decision／local_resolution_state）。
   */
  /**
   * 插入回执行并处理**唯一键竞争**（需求口径：**并发重复只一修订**）。
   *
   * 背景：`sync_receipt` 上有唯一键 `uk_sync_receipt_scope_v13`
   * （`organization_id` ＋ `resource_type` ＋ `record_uuid` ＋ `version_no`）。
   * 「先查后插」在并发下会**双双查不到**、然后双双插入 ⇒ 其中一方被唯一键拒绝（`ER_DUP_ENTRY`）。
   *
   * 语义要求：败方应**幂等复用**胜方的行（返回同一个 `receiptId`），
   * 而不是把原始 DB 错误抛给上层——否则同一条记录会被误判成"同步/导入失败"。
   *
   * 典型场景：**业务同步派发**与**记录包导入**写同一把键（同一公司、同一资源、同一记录、同一版本）。
   */
  private async insertReceiptIdempotently(
    repository: Repository<SyncReceiptEntity>,
    key: {
      organizationId: number;
      resourceType: string;
      recordUuid: string;
      versionNo: number;
    },
    build: (receiptId: string) => SyncReceiptEntity,
  ): Promise<string> {
    const receiptId = randomUUID();
    try {
      await repository.insert(build(receiptId));
      return receiptId;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const winner = await repository.findOne({ where: key });
      if (winner === null) {
        // 竞态方已消失（异常状态）：如实抛出原错误，由上层登记失败，不伪造成功
        throw error;
      }
      return winner.receiptId;
    }
  }

  async recordConflict(
    input: BusinessSyncConflictInput,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = getTypeOrmEntityManager(transactionContext).getRepository(
      this.conflictRepository.target,
    );
    const existing = await repository.findOne({
      where: {
        recordUuid: input.recordUuid,
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        versionNo: input.versionNo,
      },
    });
    const patch = {
      localVersion: input.localVersion,
      cloudVersion: input.cloudVersion,
      displayedCloudVersion: input.cloudVersion,
      localSnapshot: JSON.stringify(input.localSnapshot),
      cloudSnapshot: JSON.stringify(input.cloudSnapshot),
      conflictReason: input.conflictReason,
      status: 'PENDING',
    };
    if (existing !== null) {
      await repository.update({ conflictId: existing.conflictId }, patch);
      return;
    }
    await repository.insert(
      repository.create({
        conflictId: randomUUID(),
        recordUuid: input.recordUuid,
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        versionNo: input.versionNo,
        decision: 'PENDING',
        localResolutionState: null,
        confirmedByAccountId: null,
        confirmedAt: null,
        ...patch,
      }),
    );
  }
}
