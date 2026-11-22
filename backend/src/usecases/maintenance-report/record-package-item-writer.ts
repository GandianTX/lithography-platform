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
 * - `WORK_ORDER_SUMMARY` 来源 → 关联工单事实与接单人规则未确认前拒绝。
 */

import { Inject, Injectable } from '@nestjs/common';

import type {
  RecordPackageItemWriteOutcome,
  RecordPackageItemWriteRequest,
  RecordPackageItemWriter,
} from '@usecases/common/ports/record-package-item-writer.contract';

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
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async write(
    request: RecordPackageItemWriteRequest,
    _session: UsecaseSession,
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
    if (request.sourceAccountId === null) {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '包内未携带来源账号，原作者不可核验（不以导入人冒充原作者）',
      };
    }

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
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '工单总结来源的报告需核对关联工单事实与接单人规则，当前不导入',
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
            maintenanceEngineerAccountId: request.sourceAccountId as number,
            maintenanceEngineerNameSnapshot: readText(payload.maintenanceEngineerName) ?? '',
            phaseFlowVersion: readNumber(payload.phaseFlowVersion) ?? 1,
            createdByAccountId: request.sourceAccountId as number,
            updatedByAccountId: request.sourceAccountId as number,
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
            submittedByAccountId: request.sourceAccountId as number,
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
            accountId: request.sourceAccountId as number,
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
