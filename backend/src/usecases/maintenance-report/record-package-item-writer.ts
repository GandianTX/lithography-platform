// src/usecases/maintenance-report/record-package-item-writer.ts

/**
 * 维修报告域的**记录包受控写入实现**（任务 09 S3 补丁 P2／P4）。
 *
 * 与首版的差别（补丁要求的核心）：
 * - 首版走 `CreateMaintenanceReportDraftUsecase` → 生成**新 UUID、导入人当作者、
 *   版本 0 的草稿**，等于把"正式事实"悄悄改成"无关新草稿"；
 * - 本版按包内事实落库：**保持 `record_uuid`、原作者、公司、版本与业务状态**，
 *   并写入同版本的冻结版本行（正文快照原样保留）。
 *
 * 失败关闭（不静默降级、不冒用账号）：
 * - 包内缺来源账号 → 拒绝（不得把导入人写成原作者）；
 * - 包内缺来源状态 → 拒绝（不得把已通过结单降级成待审草稿）；
 * - 包内归属公司与目标公司不一致 → 由导入编排拒绝；
 * - 原件未接入受控写入（任务 11 暂存/绑定）→ 带原件条目拒绝，不丢原件；
 * - `WORK_ORDER_SUMMARY` 来源 → 关联工单事实与接单人规则未确认前拒绝；
 * - **来源身份在本机不可信**（S3 补丁 P4：账号不存在／已停用／已离开本公司／
 *   归属已变更／导入者对它没有当前权限）→ 由来源域核验器拒绝，不写业务。
 */

import { Inject, Injectable } from '@nestjs/common';

import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';

import type {
  RecordPackageItemWriteOutcome,
  RecordPackageItemWriteRequest,
  RecordPackageItemWriter,
} from '@usecases/common/ports/record-package-item-writer.contract';

import type { RecordPackageSourceIdentityDecision } from '@core/local-runtime/policy/record-package-source-identity.policy';

import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@usecases/common/ports/transaction-runner.contract';

import type { UsecaseSession } from '@app-types/auth/session.types';

import {
  MaintenanceReportChangeKind,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
} from '@app-types/models/maintenance-report.types';

import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { SyncSourceRecordQueryService } from '@src/modules/lithography/queries/sync-source-record.query.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';

import { bindStagedAttachmentToReport } from './maintenance-report-attachment-binding.helpers';
import { RecordPackageSourceIdentityVerifier } from './record-package-source-identity.verifier';

type SnapshotPayload = {
  sourceType?: unknown;
  repairRequestId?: unknown;
  title?: unknown;
  customerFactoryName?: unknown;
  equipmentModelId?: unknown;
  equipmentModelText?: unknown;
  maintenanceDate?: unknown;
  maintenanceEngineerAccountId?: unknown;
  maintenanceEngineerName?: unknown;
  phaseFlowVersion?: unknown;
  ai?: Record<string, unknown>;
  alarms?: unknown;
  steps?: unknown;
  faults?: unknown;
};

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * 来源业务状态 → 本机报告状态（正式事实不降级）。
 *
 * 逐值对应 06 的报告状态枚举：SUBMITTED＝R051 正式提交后的冻结态；
 * APPROVED＝已通过结单（只读）；PENDING_REVIEW／RETURNED 按原值保留。
 * DRAFT（草稿）没有冻结版本，本就不会被导出，因此不映射（按"状态不可核验"拒绝）。
 */
function mapSourceStatus(sourceStatus: string): MaintenanceReportStatus | null {
  const known = Object.values(MaintenanceReportStatus) as readonly string[];
  if (!known.includes(sourceStatus)) {
    return null;
  }
  return sourceStatus as MaintenanceReportStatus;
}

@Injectable()
export class MaintenanceReportRecordPackageItemWriter implements RecordPackageItemWriter {
  readonly supportedResourceTypes = ['MAINTENANCE_REPORT'] as const;

  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly syncSourceRecordQueryService: SyncSourceRecordQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly storedFileService: StoredFileService,
    private readonly sourceIdentityVerifier: RecordPackageSourceIdentityVerifier,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly localWriteHoldService: LocalWriteHoldService,
  ) {}

  /**
   * 按**工单跨端稳定编号**在本机定位关联工单（任务 09 S1-4）。
   *
   * 只用来源域只读事实（按公司过滤的稳定编号定位），不按源机数字外键猜工单。
   */
  private async resolveRelatedRepairRequest(
    request: RecordPackageItemWriteRequest,
  ): Promise<{ repairRequestId: number | null; failure: string | null }> {
    if (request.relatedRecordType !== 'REPAIR_REQUEST') {
      return {
        repairRequestId: null,
        failure: '工单总结来源的报告未携带关联工单的资源类型，该条未导入',
      };
    }
    if (request.relatedRecordUuid === null) {
      return {
        repairRequestId: null,
        failure: '工单总结来源的报告未携带关联工单的跨端稳定编号，无法在本机定位工单，该条未导入',
      };
    }
    const facts = await this.syncSourceRecordQueryService.listFacts({
      organizationId: request.organizationId,
      resourceType: 'REPAIR_REQUEST',
      recordUuids: [request.relatedRecordUuid],
    });
    const fact = facts.facts.get(request.relatedRecordUuid);
    if (fact === undefined) {
      return {
        repairRequestId: null,
        failure:
          '本机不存在包内关联工单（按工单跨端稳定编号核对），无法确认报告归属工单，该条未导入',
      };
    }
    if (fact.withdrawn) {
      return {
        repairRequestId: null,
        failure: '本机关联工单已删除或下架，导入不得复活已删除下架内容，该条未导入',
      };
    }
    return { repairRequestId: fact.recordId, failure: null };
  }

  /**
   * 来源身份本机可信核验（端口契约 `verifySourceIdentity`）。
   *
   * 裁决权在来源域：编排侧在暂存原件前先问一次，避免以不可信账号 id 登记暂存文件。
   */
  async verifySourceIdentity(params: {
    sourceAccountId: number | null;
    portableSourceIdentity: {
      sourceAccountUuid: string | null;
      sourceAccountLoginName: string | null;
      sourceAccountName: string | null;
      sourceOrganizationCode: string | null;
    };
    ownerOrganizationId: number | null;
    targetOrganizationId: number;
    importerAccountId: number;
  }): Promise<RecordPackageSourceIdentityDecision> {
    return this.sourceIdentityVerifier.verify(params);
  }

  async write(
    request: RecordPackageItemWriteRequest,
    session: UsecaseSession,
  ): Promise<RecordPackageItemWriteOutcome> {
    if (request.resourceType !== 'MAINTENANCE_REPORT') {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '该资源类型在维修报告域没有受控写入入口',
      };
    }
    if (request.originals.length > 1) {
      // 06 的报告附件业务上限为 1 份；超出即逐条拒绝，不静默丢弃原件
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '报告附件业务上限为 1 份，包内原件超出上限，该条未导入',
      };
    }

    // 来源身份本机可信核验（S3 补丁 P4）：
    // 包内自报的来源账号只是「待核验的账号 id」，授权真源是本机数据库当前事实
    // （账号存在且启用、资料启用、目标公司在职、导入者对它有当前权限）。
    const identity = await this.sourceIdentityVerifier.verify({
      sourceAccountId: request.sourceAccountId,
      portableSourceIdentity: request.portableSourceIdentity,
      ownerOrganizationId: request.ownerOrganizationId,
      targetOrganizationId: request.organizationId,
      importerAccountId: session.accountId,
    });
    if (!identity.allowed) {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: identity.reason,
      };
    }
    // 核验通过 ⇒ 来源账号必然存在且已核验（核验器对缺失／不可信来源账号失败关闭）
    const sourceAccountId = identity.sourceAccountId;

    // body 即包内条目的 content_snapshot（{schema_version, payload, submitted_at, change_kind…}）
    const payload =
      typeof request.body === 'object' && request.body !== null
        ? (request.body.payload as SnapshotPayload | undefined)
        : undefined;
    if (typeof payload !== 'object' || payload === null) {
      return { status: 'FAILED', localRecordId: null, reason: '包内报告载荷缺失或形状不受控' };
    }

    const sourceTypeText = readText(payload.sourceType);
    if (
      sourceTypeText !== MaintenanceReportSourceType.HISTORICAL_CASE &&
      sourceTypeText !== MaintenanceReportSourceType.WORK_ORDER_SUMMARY
    ) {
      return { status: 'FAILED', localRecordId: null, reason: '包内报告缺少来源类型' };
    }
    const sourceType = sourceTypeText;
    /** 本机工单主键：工单总结按跨端稳定编号定位；历史案例恒为 null */
    let repairRequestId: number | null = null;
    if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
      // 工单总结来源（任务 09 S1-4 已放行）：按**工单跨端稳定编号**在本机定位工单。
      //
      // 此前逐条拒绝的原因是"包内没有工单的跨端稳定编号"（源机数字外键跨机无意义，
      // 按数字 id 猜会把报告挂到**另一张**工单上）。现在导出侧随包携带
      // `related_record_uuid`（`repair_request.record_uuid`）与 `related_record_type`，
      // 目标机据此**按列定向定位**，并核对：工单存在且属于目标公司、未被删除下架。
      //
      // 仍不可核验时逐条明确拒绝（不猜工单、不静默改成无工单的历史案例）。
      const related = await this.resolveRelatedRepairRequest(request);
      if (related.failure !== null) {
        return { status: 'FAILED', localRecordId: null, reason: related.failure };
      }
      repairRequestId = related.repairRequestId;
    }

    const sourceStatus = readText(request.sourceStatus);
    const status = sourceStatus === null ? null : mapSourceStatus(sourceStatus);
    if (status === null) {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '包内未携带可核验的业务状态，不能把正式事实降级成草稿或待审',
      };
    }

    // 设备机型：包内的机型 id 是**全局型号库的自增主键**，跨设备不可移植
    // （与账号 id 同类缺陷：照抄会把报告挂到另一款机型上）。因此按包内携带的
    // **机型编码**在本机定位；定位不到即逐条拒绝，不猜机型、不静默清空机型事实。
    const payloadModelId = readNumber(payload.equipmentModelId);
    let equipmentModelId: number | null = null;
    let equipmentModelText: string | null = null;
    if (payloadModelId !== null) {
      const modelCode = request.sourceEquipmentModelCode;
      if (modelCode === null) {
        return {
          status: 'FAILED',
          localRecordId: null,
          reason: '包内未携带设备机型编码，无法在本机核验机型（机型 id 跨机不可移植），该条未导入',
        };
      }
      const model = await this.equipmentModelQueryService.findModelByCode({ modelCode });
      if (model === null) {
        return {
          status: 'FAILED',
          localRecordId: null,
          reason: '本机不存在包内记录的设备机型（按机型编码核对），该条未导入',
        };
      }
      equipmentModelId = model.id;
      // 实体 CHECK「机型 id 与机型文本二者只允许其一」：选了机型行就不再带文本快照。
      equipmentModelText = null;
    } else {
      equipmentModelId = null;
      equipmentModelText = readText(payload.equipmentModelText);
    }

    // 冻结载荷的**引用本地化**：包内 `repairRequestId` 是源机数字外键，跨机无意义；
    // 落库前改写为本机工单 id（历史案例恒为 null，与实体 CHECK 对齐）。
    const localizedPayload: SnapshotPayload = {
      ...payload,
      repairRequestId,
    };

    const submittedAtText = readText(request.body.submitted_at);
    const submittedAt = submittedAtText === null ? null : new Date(submittedAtText);
    // 变更种类按 06 的冻结口径取值：导入的是**正式冻结版本**，按正式修订登记
    const changeKind = MaintenanceReportChangeKind.FORMAL_CORRECTION;

    try {
      return await this.transactionRunner.run(async (transactionContext) => {
        // 恢复期写入冻结（**事务内**）：导入会回写业务正文（维修报告等），
        // 必须与恢复建立冻结互斥（独立验收 P1-1）：
        // 取范围共享锁并锁定读冻结事实 ⇒ 锁持有到本事务提交／回滚。
        await this.localWriteHoldService.assertCompanyWritableInTransaction({
          organizationId: request.organizationId,
          transactionContext,
        });
        const report = await this.maintenanceReportService.insertReport(
          {
            ownerOrganizationId: request.organizationId,
            sourceType,
            repairRequestId,
            title: readText(payload.title),
            customerFactoryName: readText(payload.customerFactoryName),
            equipmentModelId,
            equipmentModelText,
            maintenanceDate: readText(payload.maintenanceDate),
            // 责任工程师账号是**本机账号 id**，跨机不可移植：以来源账号为准，
            // 工程师姓名快照仍取包内事实（不丢业务事实）
            maintenanceEngineerAccountId: sourceAccountId,
            maintenanceEngineerNameSnapshot: readText(payload.maintenanceEngineerName) ?? '',
            phaseFlowVersion: readNumber(payload.phaseFlowVersion) ?? 1,
            createdByAccountId: sourceAccountId,
            updatedByAccountId: sourceAccountId,
            // 导入事实：保持包内的稳定身份、状态与版本
            recordUuid: request.recordUuid,
            status,
            currentVersionNo: request.versionNo,
            lastSubmittedAt: submittedAt,
          },
          transactionContext,
        );
        const reportId =
          (report as { id?: number }).id ?? (report as { reportId?: number }).reportId;
        if (typeof reportId !== 'number') {
          throw new Error('受控写入未返回报告主键');
        }
        const version = await this.maintenanceReportService.insertVersion(
          {
            reportId,
            versionNo: request.versionNo,
            changeKind,
            changeReason: '记录包导入',
            payloadSnapshot: localizedPayload,
            submittedByAccountId: sourceAccountId,
            submittedAt: submittedAt ?? new Date(),
          },
          transactionContext,
        );
        const versionId =
          (version as { versionId?: number }).versionId ?? (version as { id?: number }).id;
        if (typeof versionId !== 'number') {
          throw new Error('受控写入未返回版本主键');
        }

        // 原件绑定：暂存文件在**本事务内**绑定到报告根，并登记版本附件行
        // （绑定要求"暂存上传者＝绑定账号"、"归属公司＝报告归属公司"，故用来源账号）
        const versionAttachments: {
          attachmentId: number;
          sortOrder: number;
          descriptionSnapshot: string | null;
        }[] = [];
        for (const original of request.originals) {
          const attachment = await bindStagedAttachmentToReport({
            storedFileService: this.storedFileService,
            maintenanceReportService: this.maintenanceReportService,
            maintenanceReportQueryService: this.maintenanceReportQueryService,
            reportId,
            ownerOrganizationId: request.organizationId,
            accountId: sourceAccountId,
            attachment: {
              fileId: original.fileId,
              uploadContextId: original.uploadContextId,
              description: null,
            },
            transactionContext,
          });
          versionAttachments.push({
            attachmentId: attachment.id,
            sortOrder: attachment.sortOrder,
            descriptionSnapshot: attachment.description,
          });
        }
        if (versionAttachments.length > 0) {
          await this.maintenanceReportService.insertVersionAttachments(
            versionId,
            reportId,
            versionAttachments,
            transactionContext,
          );
        }
        return { status: 'CREATED', localRecordId: reportId, reason: null };
      });
    } catch (error) {
      // 恢复期冻结是**受控拒绝**，不是本条的普通写入失败：必须保留错误类别，
      // 让记录包导入编排能收敛本次 RUNNING，并在解冻后按幂等语义重试。
      // 其它拒绝仍沿用原契约，返回 FAILED outcome，不改变非记录包调用方。
      if (error instanceof DomainError && error.code === SYNC_ERROR.WRITE_HELD) {
        throw error;
      }
      return {
        status: 'FAILED',
        localRecordId: null,
        reason:
          error instanceof Error
            ? `受控写入被拒绝：${error.message}`
            : '受控写入被拒绝，该条未导入',
      };
    }
  }
}
