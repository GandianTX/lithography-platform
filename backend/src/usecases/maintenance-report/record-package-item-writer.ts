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
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';

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
    private readonly storedFileService: StoredFileService,
    private readonly sourceIdentityVerifier: RecordPackageSourceIdentityVerifier,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 来源身份本机可信核验（端口契约 `verifySourceIdentity`）。
   *
   * 裁决权在来源域：编排侧在暂存原件前先问一次，避免以不可信账号 id 登记暂存文件。
   */
  async verifySourceIdentity(params: {
    sourceAccountId: number | null;
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
    if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
      // 工单总结来源（P2-3 核对结论）：**本机无法核验关联工单事实**，逐条明确拒绝。
      //
      // 核对过的事实（见 `docs/plan/task09/证据/S3补丁-P4-来源身份与工单总结核对-20261123.md`）：
      // - 工单总结报告必须绑定一张工单（`chk_maintenance_report_request_source`
      //   要求 `repair_request_id` 非空；`fk_maintenance_report_repair_request` 为物理外键）；
      // - 接单人的权威事实是工单行的 `accepted_by_engineer_account_id`（**本机账号 id**），
      //   报告的 `maintenance_engineer_account_id` 同样只是本机账号 id；
      // - 包内只带**源机**的数字外键（`payload.repairRequestId`、`source_account_id`），
      //   既没有工单的跨端稳定编号（`repair_request.record_uuid` 全仓未随包携带），
      //   也没有可移植的账号标识；
      // ⇒ 目标机无法确认"关联工单存在且属于目标公司""接单人与包内来源账号一致"，
      //   按数字 id 猜工单会把报告挂到**另一张**工单上（且可能违反一工单一份总结的约束）。
      //
      // 因此保持逐条失败关闭，且原因写明真实阻断点（不是笼统的统一失败）。
      // 放行所需的前置条件（工单跨端稳定编号随包携带等）见证据文档。
      return {
        status: 'FAILED',
        localRecordId: null,
        reason:
          '工单总结来源的报告无法在本机核验关联工单事实与接单人（包内无工单跨端稳定编号、账号 id 跨机不可移植），该条未导入',
      };
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

    const submittedAtText = readText(request.body.submitted_at);
    const submittedAt = submittedAtText === null ? null : new Date(submittedAtText);
    // 变更种类按 06 的冻结口径取值：导入的是**正式冻结版本**，按正式修订登记
    const changeKind = MaintenanceReportChangeKind.FORMAL_CORRECTION;

    try {
      return await this.transactionRunner.run(async (transactionContext) => {
        const report = await this.maintenanceReportService.insertReport(
          {
            ownerOrganizationId: request.organizationId,
            sourceType,
            repairRequestId: readNumber(payload.repairRequestId),
            title: readText(payload.title),
            customerFactoryName: readText(payload.customerFactoryName),
            equipmentModelId: readNumber(payload.equipmentModelId),
            equipmentModelText: readText(payload.equipmentModelText),
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
            payloadSnapshot: payload,
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
