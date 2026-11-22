// src/modules/lithography/queries/sync-source-record.query.service.ts

import { deriveRecordUuid } from '@core/local-runtime/policy/record-package-export.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

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
 * 身份口径（任务 09 后续S1.4）：
 * - **优先定向定位**：源表已持久化稳定编号 `record_uuid`（创建入口一次性生成，
 *   跨端一致），可按列直接定位记录，不再依赖派生值反解；
 * - **历史行回退**：未持久化稳定编号的历史行仍用 `deriveRecordUuid(resourceType,
 *   本地自增 ID)` 派生值定位。派生值只在**本机内**唯一（不同设备的同号自增 ID
 *   会派生出相同 UUID），因此这类命中标记为 `identityPersisted=false`，
 *   由上层如实表达"跨端稳定身份尚未持久化"，不得对外宣称跨端唯一。
 *
 * 扫描完整性：派生键不可反解，回退定位只能按（公司、类型）扫描候选记录再比对
 * 派生值。候选集超过上限时返回 `scanComplete=false`，调用方据此把无法还原的
 * 稳定键判为**未知**（而不是"记录不存在"），避免把扫描截断误报成事实。
 */
export const SYNC_SOURCE_RESOURCE_TYPES = [
  'REFERENCE_DOCUMENT',
  'REPAIR_REQUEST',
  'MAINTENANCE_REPORT',
] as const;

export type SyncSourceResourceType = (typeof SYNC_SOURCE_RESOURCE_TYPES)[number];

/** 单次扫描的候选记录上限；超过即视为扫描不完整 */
export const SYNC_SOURCE_SCAN_LIMIT = 2000;

/**
 * 列投影：状态判定只需要身份、归属、版本、授权主体与下架标记。
 *
 * 不投影正文列（`reference_document.content_text`、`repair_request.content_md` 等），
 * 避免一次状态查询把上千行正文拉进内存。
 */
const REPORT_FACT_COLUMNS = {
  id: true,
  recordUuid: true,
  ownerOrganizationId: true,
  currentVersionNo: true,
  status: true,
  createdByAccountId: true,
  maintenanceEngineerAccountId: true,
  updatedByAccountId: true,
} as const;

const DOCUMENT_FACT_COLUMNS = {
  id: true,
  recordUuid: true,
  ownerOrganizationId: true,
  currentRevisionNo: true,
  createdByAccountId: true,
  updatedByAccountId: true,
  deprecated: true,
  deletedAt: true,
  publicationStatus: true,
  ownershipStatus: true,
} as const;

const REPAIR_REQUEST_FACT_COLUMNS = {
  id: true,
  recordUuid: true,
  ownerOrganizationId: true,
  currentRevisionNo: true,
  handlingStatus: true,
  closureStatus: true,
  customerAccountId: true,
  acceptedByEngineerAccountId: true,
  handlingRecordedByAccountId: true,
  deprecated: true,
  deletedAt: true,
} as const;

export type SyncSourceRecordFact = {
  resourceType: SyncSourceResourceType;
  /** 本机稳定键（持久化稳定编号优先，历史行为派生值） */
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
   * 公司级运行模式由上层另行裁决（见 `sync-status.policy.ts`）。
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
  /**
   * 内容只读事实（任务 09 S2.3）：删除／下架、冻结、结单三类。
   * 只读内容不得被冲突裁决恢复或覆盖。
   */
  contentState: {
    /** 已删除／已下架 */
    withdrawn: boolean;
    /** 冻结：内容正在被别处推进（处理中／待审核／归属待确认） */
    frozen: boolean;
    /** 结单：业务已完成，内容只读 */
    closed: boolean;
  };
  /**
   * 身份是否为源表**持久化**的稳定编号：
   * - true：跨端稳定身份已持久化（可随记录包搬运到其他设备）；
   * - false：历史行仅由本机自增 ID 派生，跨端唯一性不成立。
   */
  identityPersisted: boolean;
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
   * 两段定位：
   * 1. 定向定位：按源表持久化的 `record_uuid` 精确命中（跨端稳定身份）；
   * 2. 回退定位：仍未命中的键按派生值扫描比对（历史行兼容）。
   *
   * 归属未知的存量行也会被读出（ownerOrganizationId=null）：稳定键还原需要覆盖它们，
   * 但授权环节会因归属未知而拒绝它们（有公司范围的调用者看不到它们）。
   */
  async listFacts(params: {
    organizationId: number;
    resourceType: SyncSourceResourceType;
    recordUuids: readonly string[];
  }): Promise<SyncSourceRecordFacts> {
    const facts = new Map<string, SyncSourceRecordFact>();

    // 第一段：按持久化稳定编号定向定位
    const persisted = await this.findPersistedFacts(params);
    for (const [uuid, fact] of persisted) {
      facts.set(uuid, fact);
    }

    // 第二段：未命中的键按派生值回退扫描（历史行未持久化稳定编号）
    const missing = params.recordUuids.filter((uuid) => !facts.has(uuid));
    let scanComplete = true;
    if (missing.length > 0) {
      const scanned = await this.scanDerivedFacts(params, missing);
      scanComplete = scanned.scanComplete;
      for (const [uuid, fact] of scanned.facts) {
        facts.set(uuid, fact);
      }
    }

    return { facts, scanComplete };
  }

  /** 按源表持久化稳定编号定向定位（不扫描全表） */
  private async findPersistedFacts(params: {
    organizationId: number;
    resourceType: SyncSourceResourceType;
    recordUuids: readonly string[];
  }): Promise<Map<string, SyncSourceRecordFact>> {
    const facts = new Map<string, SyncSourceRecordFact>();
    if (params.recordUuids.length === 0) {
      return facts;
    }

    if (params.resourceType === 'MAINTENANCE_REPORT') {
      const rows = await this.reportRepository.find({
        where: {
          ownerOrganizationId: params.organizationId,
          recordUuid: In([...params.recordUuids]),
        },
        select: { ...REPORT_FACT_COLUMNS },
      });
      for (const row of rows) {
        if (row.recordUuid === null) {
          continue;
        }
        facts.set(row.recordUuid, this.toReportFact(row));
      }
      return facts;
    }

    if (params.resourceType === 'REFERENCE_DOCUMENT') {
      const rows = await this.documentRepository.find({
        where: [
          { ownerOrganizationId: params.organizationId, recordUuid: In([...params.recordUuids]) },
          { ownerOrganizationId: IsNull(), recordUuid: In([...params.recordUuids]) },
        ],
        select: { ...DOCUMENT_FACT_COLUMNS },
      });
      for (const row of rows) {
        if (row.recordUuid === null) {
          continue;
        }
        facts.set(row.recordUuid, this.toDocumentFact(row));
      }
      return facts;
    }

    const rows = await this.repairRequestRepository.find({
      where: [
        { ownerOrganizationId: params.organizationId, recordUuid: In([...params.recordUuids]) },
        { ownerOrganizationId: IsNull(), recordUuid: In([...params.recordUuids]) },
      ],
      select: { ...REPAIR_REQUEST_FACT_COLUMNS },
    });
    for (const row of rows) {
      if (row.recordUuid === null) {
        continue;
      }
      facts.set(row.recordUuid, this.toRepairRequestFact(row));
    }
    return facts;
  }

  /** 回退扫描：按（公司、类型）取候选记录并比对派生值（历史行兼容） */
  private async scanDerivedFacts(
    params: {
      organizationId: number;
      resourceType: SyncSourceResourceType;
    },
    missing: readonly string[],
  ): Promise<SyncSourceRecordFacts> {
    const wanted = new Set(missing);
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
      select: { ...REPORT_FACT_COLUMNS },
      // 固定排序：没有 ORDER BY 时 LIMIT 取到的是不确定子集，会把"漏行"误报成"记录不存在"
      order: { id: 'ASC' },
      take: SYNC_SOURCE_SCAN_LIMIT + 1,
    });

    return rows.map((row) => ({
      ...this.toReportFact(row),
      // 历史行未持久化稳定编号：身份按派生值表达（跨端唯一性不成立）
      recordUuid: deriveRecordUuid('MAINTENANCE_REPORT', row.id),
      identityPersisted: false,
    }));
  }

  private async listDocumentFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.documentRepository.find({
      where: [{ ownerOrganizationId: organizationId }, { ownerOrganizationId: IsNull() }],
      select: { ...DOCUMENT_FACT_COLUMNS },
      order: { id: 'ASC' },
      take: SYNC_SOURCE_SCAN_LIMIT + 1,
    });

    return rows.map((row) => ({
      ...this.toDocumentFact(row),
      recordUuid: deriveRecordUuid('REFERENCE_DOCUMENT', row.id),
      identityPersisted: false,
    }));
  }

  private async listRepairRequestFacts(organizationId: number): Promise<SyncSourceRecordFact[]> {
    const rows = await this.repairRequestRepository.find({
      where: [{ ownerOrganizationId: organizationId }, { ownerOrganizationId: IsNull() }],
      select: { ...REPAIR_REQUEST_FACT_COLUMNS },
      order: { id: 'ASC' },
      take: SYNC_SOURCE_SCAN_LIMIT + 1,
    });

    return rows.map((row) => ({
      ...this.toRepairRequestFact(row),
      recordUuid: deriveRecordUuid('REPAIR_REQUEST', row.id),
      identityPersisted: false,
    }));
  }

  private toReportFact(row: MaintenanceReportEntity): SyncSourceRecordFact {
    // 报告的草稿版本恒为 0：无法区分两次草稿编辑，版本不可核验
    const versionTrusted = row.currentVersionNo > 0;
    return {
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: row.recordUuid ?? deriveRecordUuid('MAINTENANCE_REPORT', row.id),
      recordId: row.id,
      ownerOrganizationId: row.ownerOrganizationId,
      currentVersion: versionTrusted ? row.currentVersionNo : null,
      versionTrusted,
      materialApplicable: true,
      contentState: {
        withdrawn: false,
        // 报告没有软删除列：下架由业务状态表达，本层不推断
        frozen: row.status === 'PENDING_REVIEW',
        closed: row.status === 'APPROVED',
      },
      relatedAccountIds: [
        row.createdByAccountId,
        row.maintenanceEngineerAccountId,
        row.updatedByAccountId,
      ].filter((value): value is number => typeof value === 'number'),
      authorizationSubjectAccountId: row.createdByAccountId,
      // 报告没有软删除列：下架由业务状态表达，本层不推断
      withdrawn: false,
      identityPersisted: row.recordUuid !== null,
    };
  }

  private toDocumentFact(row: ReferenceDocumentEntity): SyncSourceRecordFact {
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
      resourceType: 'REFERENCE_DOCUMENT',
      recordUuid: row.recordUuid ?? deriveRecordUuid('REFERENCE_DOCUMENT', row.id),
      recordId: row.id,
      ownerOrganizationId: row.ownerOrganizationId,
      currentVersion: versionTrusted ? row.currentRevisionNo : null,
      versionTrusted,
      materialApplicable,
      contentState: {
        withdrawn: softDeleted || offline,
        frozen: row.ownershipStatus === 'PENDING',
        closed: false,
      },
      relatedAccountIds: [row.createdByAccountId, row.updatedByAccountId].filter(
        (value): value is number => typeof value === 'number',
      ),
      authorizationSubjectAccountId: row.createdByAccountId,
      withdrawn: softDeleted || offline,
      identityPersisted: row.recordUuid !== null,
    };
  }

  private toRepairRequestFact(row: RepairRequestEntity): SyncSourceRecordFact {
    const versionTrusted = row.currentRevisionNo > 0;
    const softDeleted = row.deprecated === true || row.deletedAt !== null;
    return {
      resourceType: 'REPAIR_REQUEST',
      recordUuid: row.recordUuid ?? deriveRecordUuid('REPAIR_REQUEST', row.id),
      recordId: row.id,
      ownerOrganizationId: row.ownerOrganizationId,
      currentVersion: versionTrusted ? row.currentRevisionNo : null,
      versionTrusted,
      materialApplicable: softDeleted ? false : true,
      contentState: {
        withdrawn: softDeleted,
        frozen: row.handlingStatus === 'IN_PROGRESS',
        closed: row.closureStatus === 'CLOSED',
      },
      relatedAccountIds: [
        row.customerAccountId,
        row.acceptedByEngineerAccountId,
        row.handlingRecordedByAccountId,
      ].filter((value): value is number => typeof value === 'number'),
      // 工单的授权主体是受理工程师；未受理时以客户账号兜底
      authorizationSubjectAccountId:
        row.acceptedByEngineerAccountId ?? row.customerAccountId ?? null,
      withdrawn: softDeleted,
      identityPersisted: row.recordUuid !== null,
    };
  }
}
