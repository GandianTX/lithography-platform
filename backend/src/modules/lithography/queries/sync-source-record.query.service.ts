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
 *
 * 扫描完整性：派生键不可反解，只能按（公司、类型）扫描候选记录再比对派生值。
 * 候选集超过上限时返回 `scanComplete=false`，调用方据此把无法还原的稳定键判为
 * **未知**（而不是"记录不存在"），避免把扫描截断误报成事实。
 */
export const SYNC_SOURCE_RESOURCE_TYPES = [
  'REFERENCE_DOCUMENT',
  'REPAIR_REQUEST',
  'MAINTENANCE_REPORT',
] as const;

export type SyncSourceResourceType = (typeof SYNC_SOURCE_RESOURCE_TYPES)[number];

/** 单次扫描的候选记录上限；超过即视为扫描不完整 */
export const SYNC_SOURCE_SCAN_LIMIT = 2000;

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
  /**
   * **材料级**适用性：true=材料本身适用、false=材料已下架／删除等不适用、
   * null=材料级无法判定（归属待确认等）。
   * 公司级运行模式事实源尚未落地，公司级适用性由上层另行裁决。
   */
  materialApplicable: boolean | null;
  /** 与该记录关联的账号（本人判定的事实来源，不参与授权有效性判定） */
  relatedAccountIds: number[];
  /**
   * **授权主体账号**：原归属账号（报告＝创建人，资料＝创建人，工单＝受理工程师）。
   * R090 的"授权失效"只以该账号的授权状态为准，其他关联账号的授权不影响本记录。
   */
  authorizationSubjectAccountId: number | null;
  /** 是否已删除下架／软删除 */
  withdrawn: boolean;
};

export type SyncSourceRecordFacts = {
  /** 按稳定键索引的事实 */
  facts: Map<string, SyncSourceRecordFact>;
  /** 候选扫描是否完整；false 表示可能有记录未被还原 */
  scanComplete: boolean;
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
   * 列出某公司某类型的来源记录事实（只返回请求的稳定键对应的记录）。
   *
   * 归属未知的存量行也会被读出（ownerOrganizationId=null）：稳定键还原需要覆盖它们，
   * 但授权环节会因归属未知而拒绝它们（有公司范围的调用者看不到它们）。
   */
  async listFacts(params: {
    organizationId: number;
    resourceType: SyncSourceResourceType;
    recordUuids: readonly string[];
  }): Promise<SyncSourceRecordFacts> {
    const wanted = new Set(params.recordUuids);
    const all =
      params.resourceType === 'MAINTENANCE_REPORT'
        ? await this.listReportFacts(params.organizationId)
        : params.resourceType === 'REFERENCE_DOCUMENT'
          ? await this.listDocumentFacts(params.organizationId)
          : await this.listRepairRequestFacts(params.organizationId);

    const scanComplete = all.length <= SYNC_SOURCE_SCAN_LIMIT;
    const facts = new Map<string, SyncSourceRecordFact>();
    for (const fact of all) {
      if (wanted.has(fact.recordUuid)) {
        facts.set(fact.recordUuid, fact);
      }
    }
    return { facts, scanComplete };
  }

  private async listReportFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.reportRepository.find({
      where: { ownerOrganizationId: organizationId },
      take: SYNC_SOURCE_SCAN_LIMIT + 1,
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
        materialApplicable: true,
        relatedAccountIds: [
          row.createdByAccountId,
          row.maintenanceEngineerAccountId,
          row.updatedByAccountId,
        ].filter((value): value is number => typeof value === 'number'),
        authorizationSubjectAccountId: row.createdByAccountId,
        // 报告没有软删除列：下架由业务状态表达，本层不推断
        withdrawn: false,
      };
    });
  }

  private async listDocumentFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.documentRepository.find({
      where: [{ ownerOrganizationId: organizationId }, { ownerOrganizationId: IsNull() }],
      take: SYNC_SOURCE_SCAN_LIMIT + 1,
    });

    return rows.map((row) => {
      const versionTrusted = row.currentRevisionNo > 0;
      const softDeleted = row.deprecated === true || row.deletedAt !== null;
      const offline = row.publicationStatus === 'OFFLINE';
      // 归属待确认（PENDING）时材料级适用性无法判定
      const materialApplicable =
        softDeleted || offline
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
        materialApplicable,
        relatedAccountIds: [row.createdByAccountId, row.updatedByAccountId].filter(
          (value): value is number => typeof value === 'number',
        ),
        authorizationSubjectAccountId: row.createdByAccountId,
        withdrawn: softDeleted || offline,
      };
    });
  }

  private async listRepairRequestFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.repairRequestRepository.find({
      where: [{ ownerOrganizationId: organizationId }, { ownerOrganizationId: IsNull() }],
      take: SYNC_SOURCE_SCAN_LIMIT + 1,
    });

    return rows.map((row) => {
      const versionTrusted = row.currentRevisionNo > 0;
      const softDeleted = row.deprecated === true || row.deletedAt !== null;
      return {
        resourceType: 'REPAIR_REQUEST' as const,
        recordUuid: deriveRecordUuid('REPAIR_REQUEST', row.id),
        recordId: row.id,
        ownerOrganizationId: row.ownerOrganizationId,
        currentVersion: versionTrusted ? row.currentRevisionNo : null,
        versionTrusted,
        materialApplicable: softDeleted ? false : true,
        relatedAccountIds: [
          row.customerAccountId,
          row.acceptedByEngineerAccountId,
          row.handlingRecordedByAccountId,
        ].filter((value): value is number => typeof value === 'number'),
        // 工单的授权主体是受理工程师；未受理时以客户账号兜底
        authorizationSubjectAccountId:
          row.acceptedByEngineerAccountId ?? row.customerAccountId ?? null,
        withdrawn: softDeleted,
      };
    });
  }
}
