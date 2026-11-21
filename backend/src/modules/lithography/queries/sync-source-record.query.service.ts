// src/modules/lithography/queries/sync-source-record.query.service.ts

import { deriveRecordUuid } from '@core/local-runtime/policy/record-package-export.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { MaintenanceReportEntity } from '../entities/maintenance-report.entity';
import { ReferenceDocumentEntity } from '../entities/reference-document.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';

/**
 * 同步来源记录只读事实（任务 09 后续S1／S2）。
 *
 * 用途：同步状态聚合需要回答三个**只能来自来源业务**的问题——
 * 1. 这条记录归属哪个公司（公司维度不能信客户端）；
 * 2. 它当前的业务版本是多少（版本不能信客户端）；
 * 3. 它是否适用本机业务同步、是否已删除下架（适用性不能由"缺任务"推断）。
 *
 * 身份口径：`recordUuid` 目前由 `deriveRecordUuid(resourceType, 本地自增 ID)` 派生，
 * 它是**本机设备内**的稳定键（本服务据此把稳定键还原到本地记录），**不是**跨设备
 * 全局身份——不同设备的同号自增 ID 会派生出相同 UUID。因此本服务只提供设备内事实，
 * 跨端身份方案另行设计（见证据 S0-基线与06对齐记录 §5）。
 */
export const SYNC_SOURCE_RESOURCE_TYPES = [
  'REFERENCE_DOCUMENT',
  'REPAIR_REQUEST',
  'MAINTENANCE_REPORT',
] as const;

export type SyncSourceResourceType = (typeof SYNC_SOURCE_RESOURCE_TYPES)[number];

export type SyncSourceRecordFact = {
  resourceType: SyncSourceResourceType;
  /** 本机稳定键（设备内派生；跨设备不保证唯一） */
  recordUuid: string;
  recordId: number;
  /** 归属公司；null 表示归属未知（存量无证据，不猜测） */
  ownerOrganizationId: number | null;
  /** 当前业务版本；null 表示没有可信版本 */
  currentVersion: number | null;
  /** 当前版本是否可核验（草稿版本 0 之类不可核验的版本不算） */
  versionTrusted: boolean;
  /** 是否适用本机业务同步：true=适用、false=不适用、null=无法判定 */
  applicable: boolean | null;
  /** 与该记录关联的账号（本人判定的事实来源） */
  relatedAccountIds: number[];
  /** 是否已删除下架 */
  withdrawn: boolean;
};

@Injectable()
export class SyncSourceRecordQueryService {
  constructor(
    @InjectRepository(MaintenanceReportEntity)
    private readonly reportRepository: Repository<MaintenanceReportEntity>,
    @InjectRepository(ReferenceDocumentEntity)
    private readonly documentRepository: Repository<ReferenceDocumentEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
  ) {}

  /**
   * 列出某公司某类型的来源记录事实。
   *
   * 归属未知的存量行也会被读出（ownerOrganizationId=null）：稳定键还原需要覆盖它们，
   * 但授权环节会因归属未知而拒绝它们（有公司范围的调用者看不到它们）。
   */
  async listFacts(
    organizationId: number,
    resourceType: SyncSourceResourceType,
  ): Promise<SyncSourceRecordFact[]> {
    switch (resourceType) {
      case 'MAINTENANCE_REPORT':
        return this.listReportFacts(organizationId);
      case 'REFERENCE_DOCUMENT':
        return this.listDocumentFacts(organizationId);
      case 'REPAIR_REQUEST':
        return this.listRepairRequestFacts(organizationId);
      default: {
        const exhaustive: never = resourceType;
        throw new Error(`未知来源资源类型：${String(exhaustive)}`);
      }
    }
  }

  private async listReportFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.reportRepository.find({
      where: { ownerOrganizationId: organizationId },
    });

    return rows.map((row) => {
      // 报告的草稿版本恒为 0：无法区分两次草稿编辑，版本不可核验
      const versionTrusted = row.currentVersionNo > 0;
      return {
        resourceType: 'MAINTENANCE_REPORT' as const,
        recordUuid: deriveRecordUuid('MAINTENANCE_REPORT', row.id),
        recordId: row.id,
        ownerOrganizationId: row.ownerOrganizationId,
        currentVersion: versionTrusted ? row.currentVersionNo : null,
        versionTrusted,
        // 报告是本机可同步来源；已提交的正式版本才具备可信版本
        applicable: true,
        relatedAccountIds: [
          row.createdByAccountId,
          row.maintenanceEngineerAccountId,
          row.updatedByAccountId,
        ],
        withdrawn: false,
      };
    });
  }

  private async listDocumentFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.documentRepository.find({
      where: [{ ownerOrganizationId: organizationId }, { ownerOrganizationId: IsNull() }],
    });

    return rows.map((row) => {
      const versionTrusted = row.currentRevisionNo > 0;
      // 下架（OFFLINE）不适用本机同步；归属待确认（PENDING）无法判定适用性
      const applicable =
        row.publicationStatus === 'OFFLINE'
          ? false
          : row.ownershipStatus === 'CONFIRMED' && row.publicationStatus === 'ONLINE'
            ? true
            : null;
      return {
        resourceType: 'REFERENCE_DOCUMENT' as const,
        recordUuid: deriveRecordUuid('REFERENCE_DOCUMENT', row.id),
        recordId: row.id,
        ownerOrganizationId: row.ownerOrganizationId,
        currentVersion: versionTrusted ? row.currentRevisionNo : null,
        versionTrusted,
        applicable,
        relatedAccountIds: [row.createdByAccountId, row.updatedByAccountId].filter(
          (value): value is number => typeof value === 'number',
        ),
        withdrawn: row.publicationStatus === 'OFFLINE',
      };
    });
  }

  private async listRepairRequestFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.repairRequestRepository.find({
      where: [{ ownerOrganizationId: organizationId }, { ownerOrganizationId: IsNull() }],
    });

    return rows.map((row) => {
      const versionTrusted = row.currentRevisionNo > 0;
      return {
        resourceType: 'REPAIR_REQUEST' as const,
        recordUuid: deriveRecordUuid('REPAIR_REQUEST', row.id),
        recordId: row.id,
        ownerOrganizationId: row.ownerOrganizationId,
        currentVersion: versionTrusted ? row.currentRevisionNo : null,
        versionTrusted,
        applicable: true,
        relatedAccountIds: [
          row.customerAccountId,
          row.acceptedByEngineerAccountId,
          row.handlingRecordedByAccountId,
        ].filter((value): value is number => typeof value === 'number'),
        withdrawn: false,
      };
    });
  }
}
