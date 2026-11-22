// src/modules/lithography/stored-file-retention.service.ts

/**
 * 暂存原件的**过期清理**事实层（任务 09 P3-3 跨资源失败补偿）。
 *
 * 职责边界：
 * - 组装清理候选（`stored_file` 当前事实 ＋ 业务入边引用事实）；
 * - 执行清理：先把"活着但永远不会被绑定"的暂存行**释放**（标记失效，行保留可追踪），
 *   再对**已失效且无引用**的行回收存储字节；
 * - **DB 行不物理删**（`docs/database/v13-deployment/data-contracts.md` §4.1：
 *   业务侧删除／下架不物理删 `stored_file`），只回收存储字节。
 *
 * "不误删他人对象"的三道闸门：
 * 1. **公司范围**：只处理本机安装映射公司的文件（`owner_organization_id`），不跨公司清理；
 * 2. **业务引用守卫**：被任何业务入边引用的行（含"退役但仍持外键"的附件行）
 *    一律**保留**——`binding_status='TEMPORARY'` 且 `business_id IS NULL`
 *    **不等于**"无引用"；
 * 3. **绑定守卫**：已绑定（BOUND）或已有业务 id 的行是活件，一律保留。
 *
 * 判定口径在 core 纯策略层（`core/stored-file/policy/stored-file-retention.policy.ts`），
 * 本服务只提供事实与执行，避免两处判定漂移。
 */

import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import {
  decideStoredFileRetentionTargets,
  STORED_FILE_TEMPORARY_RETENTION_DAYS,
  type StoredFileRetentionCandidate,
  type StoredFileRetentionTarget,
} from '@core/stored-file/policy/stored-file-retention.policy';

import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { StoredFileEntity } from './entities/stored-file.entity';
import { StoredFileService } from './stored-file.service';

import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@usecases/common/ports/stored-file-storage.contract';

/** 单次清理的候选上限（避免一次扫描拉全表） */
export const STORED_FILE_RETENTION_SCAN_LIMIT = 200;

/** 逐项清理结果（可追踪，不静默丢弃） */
export type StoredFileRetentionItem = {
  fileId: string;
  outcome: 'CLEANED' | 'RETAINED' | 'FAILED';
  reason: string;
};

export type StoredFileRetentionResult = {
  available: boolean;
  reason: string | null;
  targetCount: number;
  cleaned: number;
  retained: number;
  failed: number;
  items: StoredFileRetentionItem[];
};

@Injectable()
export class StoredFileRetentionService {
  constructor(
    @InjectRepository(StoredFileEntity)
    private readonly storedFileRepository: Repository<StoredFileEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly reportAttachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly intakeRepository: Repository<RepairRequestIntakeEntity>,
    @InjectRepository(RepairProcessEntryEntity)
    private readonly processEntryRepository: Repository<RepairProcessEntryEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    private readonly storedFileService: StoredFileService,
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
  ) {}

  /**
   * 组装清理候选：本公司范围内**未被业务绑定**的暂存／失效行。
   *
   * 只取"无业务 id 且未绑定"的行——活件（BOUND）根本不进入候选。
   */
  async listCandidates(input: {
    organizationId: number;
    now: Date;
    limit?: number;
  }): Promise<StoredFileRetentionCandidate[]> {
    const rows = await this.storedFileRepository.find({
      where: [
        {
          ownerOrganizationId: input.organizationId,
          status: 'VALID',
          bindingStatus: 'TEMPORARY',
          businessId: IsNull(),
        },
        {
          ownerOrganizationId: input.organizationId,
          status: 'STAGING',
        },
        {
          ownerOrganizationId: input.organizationId,
          status: 'FAILED',
        },
      ],
      order: { createdAt: 'ASC' },
      take: input.limit ?? STORED_FILE_RETENTION_SCAN_LIMIT,
    });

    if (rows.length === 0) {
      return [];
    }

    const fileIds = rows.map((row) => row.fileId);
    const referenced = await this.listReferencedFileIds(fileIds);

    return rows.map((row) => ({
      fileId: row.fileId,
      ownerOrganizationId: row.ownerOrganizationId,
      status: row.status,
      bindingStatus: row.bindingStatus,
      businessId: row.businessId,
      createdAt: row.createdAt,
      referenced: referenced.has(row.fileId),
    }));
  }

  /**
   * 业务入边引用检查：四张引用 `stored_file` 的表。
   *
   * 注意：附件行**退役**（`status='RETIRED'`）后仍保留 `file_id` 外键，
   * 历史读取权要保留 → 因此这里**不按附件状态过滤**。
   */
  private async listReferencedFileIds(fileIds: string[]): Promise<Set<string>> {
    const referenced = new Set<string>();

    const attachments = await this.reportAttachmentRepository.find({
      where: { fileId: In(fileIds) },
      select: { fileId: true },
    });
    for (const row of attachments) {
      if (row.fileId !== null) {
        referenced.add(row.fileId);
      }
    }

    const intakes = await this.intakeRepository.find({
      where: { fileId: In(fileIds) },
      select: { fileId: true },
    });
    for (const row of intakes) {
      if (row.fileId !== null) {
        referenced.add(row.fileId);
      }
    }

    const entries = await this.processEntryRepository.find({
      where: { fileId: In(fileIds) },
      select: { fileId: true },
    });
    for (const row of entries) {
      if (row.fileId !== null) {
        referenced.add(row.fileId);
      }
    }

    const repairRequests = await this.repairRequestRepository.find({
      where: { maintenanceAttachmentFileId: In(fileIds) },
      select: { maintenanceAttachmentFileId: true },
    });
    for (const row of repairRequests) {
      if (row.maintenanceAttachmentFileId !== null) {
        referenced.add(row.maintenanceAttachmentFileId);
      }
    }

    return referenced;
  }

  /**
   * 执行清理：按裁决结果逐项处理。
   *
   * - `EXPIRED_TEMPORARY`：先把行**释放**（标记失效），再回收字节；
   * - `DEAD_STATUS`：行已是失效态，只回收字节；
   * - 任一步失败逐项记 `FAILED`（保留事实，不假装已清理），下一轮重试。
   */
  async cleanup(input: {
    organizationId: number;
    now?: Date;
    retentionDays?: number;
    limit?: number;
  }): Promise<StoredFileRetentionResult> {
    const now = input.now ?? new Date();
    const candidates = await this.listCandidates({
      organizationId: input.organizationId,
      now,
      limit: input.limit,
    });
    const decision = decideStoredFileRetentionTargets(
      candidates,
      now,
      input.retentionDays ?? STORED_FILE_TEMPORARY_RETENTION_DAYS,
    );

    const items: StoredFileRetentionItem[] = [];
    for (const target of decision.targets) {
      items.push(await this.cleanupOne(target));
    }
    for (const skip of decision.skipped) {
      items.push({
        fileId: skip.candidate.fileId,
        outcome: 'RETAINED',
        reason: skip.reason,
      });
    }

    return {
      available: true,
      reason: null,
      targetCount: decision.targets.length,
      cleaned: items.filter((item) => item.outcome === 'CLEANED').length,
      retained: items.filter((item) => item.outcome === 'RETAINED').length,
      failed: items.filter((item) => item.outcome === 'FAILED').length,
      items,
    };
  }

  /**
   * 本机**安装映射公司**的过期清理（后台每日检查用）。
   *
   * 安装身份缺失或未映射公司时返回空结果：**不猜公司、不跨公司清理**。
   */
  async cleanupAllExpired(
    input: {
      now?: Date;
      retentionDays?: number;
      limit?: number;
    } = {},
  ): Promise<StoredFileRetentionResult> {
    const installation = await this.installationRepository?.findOne({ where: { id: 1 } });
    const organizationId = installation?.organizationId ?? null;
    if (organizationId === null) {
      return {
        available: false,
        reason: '本机安装未映射公司，不清理暂存原件（不猜公司、不跨公司清理）',
        targetCount: 0,
        cleaned: 0,
        retained: 0,
        failed: 0,
        items: [],
      };
    }
    return this.cleanup({
      organizationId,
      now: input.now,
      retentionDays: input.retentionDays,
      limit: input.limit,
    });
  }

  /** 单个候选的清理：释放（必要时）＋ 字节回收 */
  private async cleanupOne(target: StoredFileRetentionTarget): Promise<StoredFileRetentionItem> {
    const fileId = target.candidate.fileId;
    try {
      if (target.reason === 'EXPIRED_TEMPORARY') {
        // 释放：标记失效（行保留、可追踪）；命中 0 表示已被绑定或状态已变 → 保留
        const released = await this.storedFileService.releaseTemporaryFiles({ fileIds: [fileId] });
        if (released === 0) {
          return { fileId, outcome: 'RETAINED', reason: 'ALREADY_BOUND_OR_CHANGED' };
        }
      }

      const row = await this.storedFileRepository.findOne({ where: { fileId } });
      if (row === null) {
        return { fileId, outcome: 'RETAINED', reason: 'ROW_NOT_FOUND' };
      }
      // 二次闸门：仍有业务 id / 已绑定 → 保留
      if (row.businessId !== null || row.bindingStatus === 'BOUND') {
        return { fileId, outcome: 'RETAINED', reason: 'BOUND' };
      }

      // 字节回收：仅对**未绑定且无业务 id**的行；存储契约允许 delete 用于补偿清理
      await this.storage.delete(row.storageReference);
      return { fileId, outcome: 'CLEANED', reason: target.reason };
    } catch (error) {
      // 失败保留事实（不假装已清理），下一轮重试
      return {
        fileId,
        outcome: 'FAILED',
        reason: error instanceof Error ? error.message : '清理失败',
      };
    }
  }
}
