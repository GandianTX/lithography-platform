// src/usecases/maintenance-report/submit-maintenance-report-formal.usecase.ts
//
// R051-01 正式提交：草稿与首次未保存表单都能直接提交。
//
// 与旧 submit-maintenance-report.usecase（PENDING_REVIEW，保留兼容不接线）不同：
// 本用例在同一事务内完成「校验 → 内容落库 → 冻结版本 → SUBMITTED →
// 正式 reference_document（来源方案二回链）」，不进入旧审核队列。
//
// 幂等语义（R051-01 / V5.3）：
// - submissionRequestId 由客户端首次发送前生成并保留至结果确认（超时不换新标识）；
// - 服务端按 (操作者, 公司, 提交标识) 定位既有结果并比对规范化内容摘要；
//   同标识同内容返回原 report_id / 冻结版本 / document_id，不再生成版本；
//   同标识异内容、同标识绑定不同 report_id 一律拒绝；
// - 已 SUBMITTED 报告即使换标识也不得再次正式提交；
// - 无 report_id 时以同一标识定位或 INSERT 唯一报告根，由唯一键处理并发竞争。
//
// 身份、工单、公司、版本均由服务端核对：作者与组织取自可信会话上下文，
// 不接受客户端自报归属。机型登记仅在独立历史报告 + 手填机型时发生，
// 且与本次业务写入同一事务（失败不留新机型或半份资料）。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  MaintenanceReportChangeKind,
  MaintenanceAiUsage,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
} from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EquipmentModelService } from '@src/modules/lithography/equipment-model.service';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type {
  MaintenanceReportDraftDetailView,
  MaintenanceReportSnapshot,
  RepairRequestWriteContext,
} from '@src/modules/lithography/maintenance-report.types';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  MaintenanceReportDraftInput,
  MaintenanceReportFormalSubmitResult,
  SubmitMaintenanceReportFormalCommand,
} from './maintenance-report-command.types';
import {
  ensureStagedAttachmentBinding,
  normalizeStagedAttachment,
  type NormalizedStagedAttachment,
} from './maintenance-report-attachment-binding.helpers';
import { assertAttachmentsUsableAfterBinding } from './maintenance-report-attachment-freeze.helpers';
import {
  assertFormalSubmitCompleteness,
  computeSubmissionPayloadHash,
  normalizeFormalRepairRequestId,
  resolveOrRegisterEquipmentModel,
  assertValidSubmissionRequestId,
} from './maintenance-report-formal-submit.helpers';
import {
  normalizeMaintenanceReportDraft,
  normalizeSourceType,
  trimOptionalText,
} from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { buildMaintenanceReportSnapshotPayload } from './maintenance-report-snapshot';
import { assertWorkOrderSummaryPreconditions } from './maintenance-report-work-order.constants';
import {
  assertNoWorkOrderSummaryClientContent,
  buildWorkOrderSummaryDraftInput,
  fingerprintWorkOrderSummarySource,
  isSameWorkOrderSummaryDraftContent,
  readFrozenSourceConfirmationFingerprint,
  readWorkOrderSummarySourceFacts,
  type WorkOrderSummarySourceFacts,
} from './maintenance-report-work-order-source.helpers';
import {
  assertNoApplicableWorkOrderSummaryAiConversation,
  assertWorkOrderSummaryAiEvaluationReference,
  resolveWorkOrderSummaryAiEvaluationInput,
  type MaintenanceReportAiEvaluationFields,
} from './maintenance-report-ai-evaluation.helpers';

/** 负责人姓名快照缺失时的安全回落（与建稿用例口径一致） */
const ENGINEER_NAME_FALLBACK = '工程师';

/** 本期阶段流程版本固定为 1（稳定编码 PHASE_01—PHASE_10） */
const CURRENT_PHASE_FLOW_VERSION = 1;

@Injectable()
export class SubmitMaintenanceReportFormalUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly equipmentModelService: EquipmentModelService,
    private readonly referenceDocumentService: ReferenceDocumentService,
    private readonly accountQueryService: AccountQueryService,
    private readonly storedFileService: StoredFileService,
    private readonly maintenanceQueryService: RepairRequestMaintenanceQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly aiConversationQueryService: AiConversationQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(STORED_FILE_STORAGE)
    private readonly storedFileStorage: StoredFileStorage,
  ) {}

  async execute(
    command: SubmitMaintenanceReportFormalCommand,
  ): Promise<MaintenanceReportFormalSubmitResult> {
    assertMaintenanceReportAuthorRole(command.session);
    const sourceType = normalizeSourceType(command.sourceType);
    const repairRequestId = normalizeFormalRepairRequestId(sourceType, command.repairRequestId);
    const submissionRequestId = assertValidSubmissionRequestId(command.submissionRequestId);
    // 2026-11-20 需求调整：工单总结只读核对——客户端不携带内容字段，也不附带原件；
    // 冻结内容在事务内核验工单后由服务端派生（见 submitExistingDraft/submitWithoutReport）
    const isWorkOrderSummary = sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY;
    if (isWorkOrderSummary) {
      if (command.sourceConfirmation === null) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT,
          '请先打开工单总结并核对来源工单',
        );
      }
      assertNoWorkOrderSummaryClientContent(command.draft);
      if (command.attachment !== null && command.attachment !== undefined) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
          '工单维修总结不单独登记报告原件，来源工单原件按工单权限读取',
        );
      }
    }
    const draft = isWorkOrderSummary
      ? null
      : normalizeMaintenanceReportDraft(command.draft, command.session.accountId);
    // R051-01：直接提交可附带本轮暂存原件；file_id/上下文形态在事务前核验
    const attachment = normalizeStagedAttachment(command.attachment);
    // 正式完整性在内容确定后判定（历史案例：事务前；工单总结：事务内派生后、写入前）
    if (draft !== null) {
      assertFormalSubmitCompleteness(draft);
    }

    return this.transactionRunner.run((transactionContext) =>
      this.doSubmit(
        command,
        sourceType,
        repairRequestId,
        submissionRequestId,
        draft,
        attachment,
        transactionContext,
      ),
    );
  }

  private async doSubmit(
    command: SubmitMaintenanceReportFormalCommand,
    sourceType: MaintenanceReportSourceType,
    repairRequestId: number | null,
    submissionRequestId: string,
    draft: ReturnType<typeof normalizeMaintenanceReportDraft> | null,
    attachment: NormalizedStagedAttachment,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportFormalSubmitResult> {
    if (command.reportId !== null && command.reportId !== undefined) {
      assertMaintenanceReportId(command.reportId);
      return this.submitExistingDraft(
        command,
        sourceType,
        repairRequestId,
        submissionRequestId,
        draft,
        attachment,
        transactionContext,
      );
    }
    return this.submitWithoutReport(
      command,
      sourceType,
      repairRequestId,
      submissionRequestId,
      draft,
      attachment,
      transactionContext,
    );
  }

  /** 已有草稿路径：报告行锁必须作为事务内第一次读取，随后解析组织与归属 */
  private async submitExistingDraft(
    command: SubmitMaintenanceReportFormalCommand,
    sourceType: MaintenanceReportSourceType,
    repairRequestId: number | null,
    submissionRequestId: string,
    draft: ReturnType<typeof normalizeMaintenanceReportDraft> | null,
    attachment: NormalizedStagedAttachment,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportFormalSubmitResult> {
    const reportId = command.reportId as number;
    const report = await this.maintenanceReportService.lockReportForWrite(
      reportId,
      transactionContext,
    );
    if (report === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId,
      });
    }
    const organizationId = await this.resolveOrganizationId(
      command.session.accountId,
      transactionContext,
    );
    if (
      report.maintenanceEngineerAccountId !== command.session.accountId ||
      report.ownerOrganizationId !== organizationId
    ) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId,
      });
    }
    this.assertReportMatchesSubmission(report, sourceType, repairRequestId);

    // 幂等重试（2026-11-21 冻结重试）：报告已绑定某次提交标识时先按冻结请求
    // 核对并返回原结果；异标识拒绝。工单总结不读取/不派生修订后的当前工单。
    if (report.submissionRequestId !== null) {
      if (report.submissionRequestId !== submissionRequestId) {
        if (report.status === MaintenanceReportStatus.SUBMITTED) {
          throw new DomainError(
            MAINTENANCE_REPORT_ERROR.SUBMISSION_ALREADY_SUBMITTED,
            '该报告已正式提交，不能再次提交',
            { reportId },
          );
        }
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
          '提交标识与报告既有提交不一致，请刷新后重试',
          { reportId },
        );
      }
      if (report.status === MaintenanceReportStatus.SUBMITTED) {
        if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
          await this.assertWorkOrderSummaryRetryRequestMatchesFrozen({
            report,
            command,
            transactionContext,
          });
        } else {
          const retryDigest = computeSubmissionPayloadHash({
            sourceType,
            repairRequestId,
            draft: draft as ReturnType<typeof normalizeMaintenanceReportDraft>,
            attachmentFileId: attachment?.fileId ?? null,
          });
          if (report.submissionPayloadHash !== retryDigest) {
            throw new DomainError(
              MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
              '同一提交标识对应的内容已变化，请生成新的提交后重试',
              { reportId },
            );
          }
        }
        return this.readExistingFormalResult(report, submissionRequestId, transactionContext);
      }
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
        '提交标识状态异常，请刷新后重试',
        { reportId },
      );
    }
    if (report.status === MaintenanceReportStatus.SUBMITTED) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_ALREADY_SUBMITTED,
        '该报告已正式提交，不能再次提交',
        { reportId },
      );
    }

    // 工单总结：重新核验本人接单/已结单/组织，并以锁定工单后的服务端事实派生内容；
    // 派生内容与库内草稿不一致 → 来源工单在草稿保存后被修订，要求重新核对后再提交
    let effectiveDraft: ReturnType<typeof normalizeMaintenanceReportDraft>;
    let digest: string;
    let sourceFacts: WorkOrderSummarySourceFacts | null = null;
    if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
      const derived = await this.deriveWorkOrderSummaryForSubmit({
        report,
        accountId: command.session.accountId,
        organizationId,
        aiPatch: command.draft,
        transactionContext,
      });
      this.assertSourceConfirmation(command, derived.facts);
      if (
        command.sourceConfirmation === undefined &&
        (derived.stored === null ||
          !isSameWorkOrderSummaryDraftContent(derived.stored, derived.draft))
      ) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT,
          '来源工单在保存草稿后已被修订，请重新核对内容并重新保存总结后再提交',
          { reportId, repairRequestId },
        );
      }
      assertFormalSubmitCompleteness(derived.draft);
      effectiveDraft = derived.draft;
      sourceFacts = derived.facts;
      digest = computeSubmissionPayloadHash({
        sourceType,
        repairRequestId,
        draft: effectiveDraft,
        attachmentFileId: null,
      });
    } else {
      effectiveDraft = draft as ReturnType<typeof normalizeMaintenanceReportDraft>;
      digest = computeSubmissionPayloadHash({
        sourceType,
        repairRequestId,
        draft: effectiveDraft,
        attachmentFileId: attachment?.fileId ?? null,
      });
    }
    if (
      command.expectedVersionNo !== null &&
      command.expectedVersionNo !== undefined &&
      report.currentVersionNo !== command.expectedVersionNo
    ) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT,
        '报告已在其他会话更新，请刷新草稿后重试',
        { reportId, expectedVersionNo: command.expectedVersionNo },
      );
    }
    // 2026-11-21 需求：确认无适用会话才不强制评分——真正要冻结时在事务内裁决；
    // 幂等重试（上方已按同标识返回原结果）不重复裁决
    if (
      sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY &&
      effectiveDraft.aiUsage !== MaintenanceAiUsage.USED
    ) {
      await assertNoApplicableWorkOrderSummaryAiConversation({
        viewerAccountId: command.session.accountId,
        viewerOrganizationId: organizationId,
        repairRequestId: report.repairRequestId as number,
        aiConversationQueryService: this.aiConversationQueryService,
      });
    }

    const adjustedDraft = await this.applyEquipmentModelResolution(
      effectiveDraft,
      sourceType,
      transactionContext,
    );
    await this.persistDraftContent(report.id, adjustedDraft, transactionContext);
    return this.freezeAndPublish(
      report.id,
      adjustedDraft,
      digest,
      submissionRequestId,
      command.session.accountId,
      organizationId,
      attachment,
      sourceFacts,
      transactionContext,
    );
  }

  /** 直接提交路径：无 report_id 时以提交标识定位既有结果，或创建唯一报告根 */
  private async submitWithoutReport(
    command: SubmitMaintenanceReportFormalCommand,
    sourceType: MaintenanceReportSourceType,
    repairRequestId: number | null,
    submissionRequestId: string,
    draft: ReturnType<typeof normalizeMaintenanceReportDraft> | null,
    attachment: NormalizedStagedAttachment,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportFormalSubmitResult> {
    const organizationId = await this.resolveOrganizationId(
      command.session.accountId,
      transactionContext,
    );

    // 幂等定位放最前（2026-11-21 需求）：首提响应丢失后，同标识重试必须先走
    // 既有结果比对，不得被「已存在总结」等前置拦截挡住
    const existing = await this.maintenanceReportQueryService.findBySubmissionKey(
      {
        createdByAccountId: command.session.accountId,
        ownerOrganizationId: organizationId,
        submissionRequestId,
      },
      transactionContext,
    );

    if (repairRequestId !== null) {
      const workOrder = await this.maintenanceReportService.readRepairRequestWriteContext(
        repairRequestId,
        transactionContext,
      );
      assertWorkOrderSummaryPreconditions({
        request: workOrder,
        repairRequestId,
        accountId: command.session.accountId,
        organizationId,
      });
    }

    // 幂等定位放最前（2026-11-21 需求）：首提响应丢失后，同标识重试必须先走
    // 既有结果核对，不得被「已存在总结」等前置拦截挡住；
    // 冻结重试按冻结快照核对原请求，不依赖修订后的当前工单重新派生
    if (existing !== null) {
      if (existing.status === MaintenanceReportStatus.SUBMITTED) {
        if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
          await this.assertWorkOrderSummaryRetryRequestMatchesFrozen({
            report: existing,
            command,
            transactionContext,
          });
        } else {
          const retryDigest = computeSubmissionPayloadHash({
            sourceType,
            repairRequestId,
            draft: draft as ReturnType<typeof normalizeMaintenanceReportDraft>,
            attachmentFileId: attachment?.fileId ?? null,
          });
          if (existing.submissionPayloadHash !== retryDigest) {
            throw new DomainError(
              MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
              '同一提交标识对应的内容已变化，请生成新的提交后重试',
            );
          }
        }
        return this.readExistingFormalResult(existing, submissionRequestId, transactionContext);
      }
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
        '提交标识状态异常，请刷新后重试',
      );
    }

    // 全新提交路径：先挡「已存在总结」，再派生当前事实并复核来源与 AI 评价要求
    let effectiveDraft: ReturnType<typeof normalizeMaintenanceReportDraft>;
    let digest: string;
    let sourceFacts: WorkOrderSummarySourceFacts | null = null;
    if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
      const derived = await this.deriveWorkOrderSummaryForSubmit({
        repairRequestId: repairRequestId as number,
        accountId: command.session.accountId,
        organizationId,
        aiPatch: command.draft,
        transactionContext,
      });
      assertFormalSubmitCompleteness(derived.draft);
      effectiveDraft = derived.draft;
      sourceFacts = derived.facts;
      digest = computeSubmissionPayloadHash({
        sourceType,
        repairRequestId,
        draft: effectiveDraft,
        attachmentFileId: null,
      });
    } else {
      effectiveDraft = draft as ReturnType<typeof normalizeMaintenanceReportDraft>;
      digest = computeSubmissionPayloadHash({
        sourceType,
        repairRequestId,
        draft: effectiveDraft,
        attachmentFileId: attachment?.fileId ?? null,
      });
    }

    if (repairRequestId !== null) {
      const exists = await this.maintenanceReportQueryService.hasWorkOrderSummary(
        repairRequestId,
        transactionContext,
      );
      if (exists) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED,
          '该工单已存在维修总结',
          { repairRequestId },
        );
      }
    }
    if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
      // 2026-11-21 需求：直接提交同样在事务内复核来源——预览后工单内容或原件
      // 新增/移除/更换都会使指纹失配；纯修订号变化不参与指纹，不拦截
      this.assertSourceConfirmation(command, sourceFacts as WorkOrderSummarySourceFacts);
      // 确认无适用会话才不强制评分；枚举失败向上抛出，不按无会话提交
      if (effectiveDraft.aiUsage !== MaintenanceAiUsage.USED) {
        await assertNoApplicableWorkOrderSummaryAiConversation({
          viewerAccountId: command.session.accountId,
          viewerOrganizationId: organizationId,
          repairRequestId: repairRequestId as number,
          aiConversationQueryService: this.aiConversationQueryService,
        });
      }
    }

    const adjustedDraft = await this.applyEquipmentModelResolution(
      effectiveDraft,
      sourceType,
      transactionContext,
    );

    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([
      command.session.accountId,
    ]);
    const engineerName = nicknames.get(command.session.accountId) ?? ENGINEER_NAME_FALLBACK;

    let report: MaintenanceReportSnapshot;
    try {
      // 提交标识与摘要在报告根创建即写入：并发重试由
      // uk_maintenance_report_submission 唯一键兜底（V5.4/R051-01 方案二）
      report = await this.maintenanceReportService.insertReport(
        {
          ownerOrganizationId: organizationId,
          sourceType,
          repairRequestId,
          title: adjustedDraft.title,
          customerFactoryName: adjustedDraft.customerFactoryName,
          equipmentModelId: adjustedDraft.equipmentModelId,
          equipmentModelText: adjustedDraft.equipmentModelText,
          maintenanceDate: adjustedDraft.maintenanceDate,
          maintenanceEngineerAccountId: command.session.accountId,
          maintenanceEngineerNameSnapshot: engineerName,
          phaseFlowVersion: CURRENT_PHASE_FLOW_VERSION,
          createdByAccountId: command.session.accountId,
          updatedByAccountId: command.session.accountId,
          submissionRequestId,
          submissionPayloadHash: digest,
        },
        transactionContext,
      );
    } catch (error) {
      return this.resolveInsertConflict(
        error,
        command,
        organizationId,
        submissionRequestId,
        digest,
        repairRequestId,
        transactionContext,
      );
    }

    await this.persistDraftContent(report.id, adjustedDraft, transactionContext);
    return this.freezeAndPublish(
      report.id,
      adjustedDraft,
      digest,
      submissionRequestId,
      command.session.accountId,
      organizationId,
      attachment,
      sourceFacts,
      transactionContext,
    );
  }

  /**
   * 工单总结派生（提交事务内，工单行已锁定）：
   * - 带 reportId：读取库内草稿用于「工单修订后内容比对」；
   * - 直接提交：只派生当前事实。
   * AI 评价组回填报告既有值，不覆盖既有评价。
   */
  private assertSourceConfirmation(
    command: SubmitMaintenanceReportFormalCommand,
    facts: WorkOrderSummarySourceFacts,
  ): void {
    if (
      command.sourceConfirmation !== undefined &&
      command.sourceConfirmation !== fingerprintWorkOrderSummarySource(facts)
    ) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT,
        '来源工单或原件已变化，请刷新并重新核对后再提交',
      );
    }
  }

  private async deriveWorkOrderSummaryForSubmit(params: {
    report?: MaintenanceReportSnapshot;
    repairRequestId?: number;
    accountId: number;
    organizationId: number;
    /** 客户端显式携带的 AI 评价字段（内容字段已被拒绝） */
    aiPatch: MaintenanceReportDraftInput;
    transactionContext: PersistenceTransactionContext;
  }): Promise<{
    draft: ReturnType<typeof normalizeMaintenanceReportDraft>;
    facts: WorkOrderSummarySourceFacts;
    stored: MaintenanceReportDraftDetailView | null;
  }> {
    const report = params.report;
    const repairRequestId = report ? report.repairRequestId : (params.repairRequestId as number);
    if (repairRequestId === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT, '工单总结缺少关联工单');
    }
    const workOrder = await this.maintenanceReportService.readRepairRequestWriteContext(
      repairRequestId,
      params.transactionContext,
    );
    assertWorkOrderSummaryPreconditions({
      request: workOrder,
      repairRequestId,
      accountId: params.accountId,
      organizationId: params.organizationId,
    });
    const stored = report
      ? await this.maintenanceReportQueryService.readDraftDetail(
          report.id,
          params.transactionContext,
        )
      : null;
    if (report && stored === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在', {
        reportId: report.id,
      });
    }
    const facts = await readWorkOrderSummarySourceFacts({
      request: workOrder as RepairRequestWriteContext,
      maintenanceQueryService: this.maintenanceQueryService,
      organizationQueryService: this.organizationQueryService,
      transactionContext: params.transactionContext,
    });
    const input = buildWorkOrderSummaryDraftInput(facts);
    const ai = resolveWorkOrderSummaryAiEvaluationInput(
      params.aiPatch,
      stored === null ? null : stored.report,
    );
    input.aiUsage = ai.aiUsage;
    input.aiSourceType = ai.aiSourceType;
    input.aiSourceId = ai.aiSourceId;
    input.aiSourceVersion = ai.aiSourceVersion;
    input.aiScore = ai.aiScore;
    input.aiCorrectness = ai.aiCorrectness;
    input.aiHelpfulness = ai.aiHelpfulness;
    input.aiNote = ai.aiNote;
    const draft = normalizeMaintenanceReportDraft(input, params.accountId, {
      preservedAiHelpfulness:
        params.aiPatch.aiHelpfulness === undefined ? (stored?.report.aiHelpfulness ?? null) : null,
      // 工单总结派生复用结单侧（任务 04）结单原因规则：非终结结果原因可选
      allowNonTerminalClosureReason: true,
    });
    // 评价引用必须是本人工单内、所选版本有有效回复的真实会话；查不到/查失败一律拒绝
    await assertWorkOrderSummaryAiEvaluationReference({
      ai: {
        aiUsage: draft.aiUsage,
        aiSourceType: draft.aiSourceType,
        aiSourceId: draft.aiSourceId,
        aiSourceVersion: draft.aiSourceVersion,
        aiScore: draft.aiScore,
        aiCorrectness: draft.aiCorrectness,
        aiHelpfulness: draft.aiHelpfulness,
        aiNote: draft.aiNote,
      },
      viewerAccountId: params.accountId,
      viewerOrganizationId: params.organizationId,
      repairRequestId,
      aiConversationQueryService: this.aiConversationQueryService,
    });
    return { draft, facts, stored };
  }

  /** 创建报告根唯一键冲突：定位既有提交结果（幂等）或按业务冲突拒绝 */
  private async resolveInsertConflict(
    error: unknown,
    command: SubmitMaintenanceReportFormalCommand,
    organizationId: number,
    submissionRequestId: string,
    digest: string,
    repairRequestId: number | null,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportFormalSubmitResult> {
    const accountId = command.session.accountId;
    const existing = await this.maintenanceReportQueryService.findBySubmissionKey(
      {
        createdByAccountId: accountId,
        ownerOrganizationId: organizationId,
        submissionRequestId,
      },
      transactionContext,
    );
    if (existing !== null) {
      if (existing.status === MaintenanceReportStatus.SUBMITTED) {
        if (repairRequestId !== null) {
          // 工单总结按冻结请求核对（2026-11-21）：不依赖修订后的当前工单重新派生
          await this.assertWorkOrderSummaryRetryRequestMatchesFrozen({
            report: existing,
            command,
            transactionContext,
          });
          return this.readExistingFormalResult(existing, submissionRequestId, transactionContext);
        }
        if (existing.submissionPayloadHash === digest) {
          return this.readExistingFormalResult(existing, submissionRequestId, transactionContext);
        }
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
          '同一提交标识对应的内容已变化，请生成新的提交后重试',
        );
      }
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
        '提交标识状态异常，请刷新后重试',
      );
    }
    if (repairRequestId !== null) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED,
        '该工单已存在维修总结',
        { repairRequestId },
      );
    }
    // 并发竞争下既有行尚未提交可见：按可重试冲突返回，客户端沿用原标识重试
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
      '提交处理中，请稍后使用原提交重试',
      undefined,
      error,
    );
  }

  /** 行锁后内容落库：草稿字段 + 报警/步骤/故障（故障依赖步骤复合外键，最后写入） */
  private async persistDraftContent(
    reportId: number,
    draft: ReturnType<typeof normalizeMaintenanceReportDraft>,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    await this.maintenanceReportService.updateDraft(reportId, draft, transactionContext);
    await this.maintenanceReportService.replaceAlarms(reportId, draft.alarms, transactionContext);
    await this.maintenanceReportService.replaceSteps(reportId, draft.steps, transactionContext);
    await this.maintenanceReportService.replaceFaults(reportId, draft.faults, transactionContext);
  }

  /**
   * 机型展示名解析（2026-11-21 修复）：ID 优先机型库按名称取值（名称缺失回落
   * 编码）；机型库记录缺失或无 ID 时回落手填文本（兼容历史快照缺字段/机型为空），
   * 不阻断提交，也不伪造机型。
   */
  private async resolveEquipmentModelLabel(params: {
    equipmentModelId: number | null;
    equipmentModelText: string | null;
    transactionContext: PersistenceTransactionContext;
  }): Promise<string | null> {
    if (params.equipmentModelId === null) {
      return params.equipmentModelText;
    }
    const model = await this.equipmentModelQueryService.findModelById({
      id: params.equipmentModelId,
      transactionContext: params.transactionContext,
    });
    if (model === null) {
      return params.equipmentModelText;
    }
    return model.modelName || model.modelCode || params.equipmentModelText;
  }

  /** 独立历史报告 + 手填机型：登记并回填最终机型 ID（文本不再作为机型字段） */
  private async applyEquipmentModelResolution(
    draft: ReturnType<typeof normalizeMaintenanceReportDraft>,
    sourceType: MaintenanceReportSourceType,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReturnType<typeof normalizeMaintenanceReportDraft>> {
    if (sourceType !== MaintenanceReportSourceType.HISTORICAL_CASE) {
      return draft;
    }
    if (draft.equipmentModelId !== null || draft.equipmentModelText === null) {
      if (draft.equipmentModelId !== null) {
        const model = await this.equipmentModelQueryService.findModelById({
          id: draft.equipmentModelId,
          transactionContext,
        });
        if (!model) {
          throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '设备型号不存在', {
            equipmentModelId: draft.equipmentModelId,
          });
        }
      }
      return draft;
    }
    const modelId = await resolveOrRegisterEquipmentModel({
      equipmentModelText: draft.equipmentModelText,
      equipmentModelService: this.equipmentModelService,
      transactionContext,
    });
    return { ...draft, equipmentModelId: modelId, equipmentModelText: null };
  }

  /**
   * 冻结与发布：版本、版本附件、条件更新 SUBMITTED、正式资料全部在同一事务；
   * 任一步失败整体回滚，不留半份成品或新机型。
   * R051-01：附带暂存原件在本段开头绑定登记（含 file_id），随本次冻结版本关联。
   */
  private async freezeAndPublish(
    reportId: number,
    draft: ReturnType<typeof normalizeMaintenanceReportDraft>,
    digest: string,
    submissionRequestId: string,
    accountId: number,
    organizationId: number,
    attachment: NormalizedStagedAttachment,
    /** 工单总结来源事实：冻结快照记录来源修订版本与来源原件引用（provenance） */
    sourceFacts: WorkOrderSummarySourceFacts | null,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportFormalSubmitResult> {
    if (attachment !== null) {
      // R062-01：单份报告最多 1 份有效原件；已有有效原件且 file_id 不同时
      // 同事务先退役旧关联再绑定新原件，任一步失败与冻结一起回滚
      await ensureStagedAttachmentBinding({
        storedFileService: this.storedFileService,
        maintenanceReportService: this.maintenanceReportService,
        maintenanceReportQueryService: this.maintenanceReportQueryService,
        reportId,
        ownerOrganizationId: organizationId,
        accountId,
        attachment,
        mode: 'replace',
        transactionContext,
      });
    }
    const draftDetail = await this.maintenanceReportQueryService.readDraftDetail(
      reportId,
      transactionContext,
    );
    if (!draftDetail) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在', { reportId });
    }
    const currentAttachments =
      await this.maintenanceReportQueryService.readCurrentAttachmentsForSubmit(
        reportId,
        transactionContext,
      );
    const submitDraft = { ...draftDetail, attachments: currentAttachments };
    // 2026-11-21 修复：正式资料正文「机型」行取机型库名称——两条来源提交后
    // equipmentModelText 均为 null（历史记录手填文本已裁决为 ID；工单总结恒 ID），
    // 必须按 equipmentModelId 反查机型库，否则正文机型恒为空
    const equipmentModelLabel = await this.resolveEquipmentModelLabel({
      equipmentModelId: draftDetail.report.equipmentModelId,
      equipmentModelText: draftDetail.report.equipmentModelText,
      transactionContext,
    });
    // 挂接后复核：文件仍存在、状态有效、归属未改变；不可用附件失败关闭，
    // 本事务整体回滚，不冻结半份证据
    await assertAttachmentsUsableAfterBinding({
      attachments: currentAttachments,
      authorAccountId: accountId,
      storage: this.storedFileStorage,
    });
    const payload = buildMaintenanceReportSnapshotPayload(
      submitDraft,
      sourceFacts === null
        ? undefined
        : {
            sourceWorkOrderRevisionNo: sourceFacts.currentRevisionNo,
            sourceWorkOrderAttachment: sourceFacts.attachment,
            sourceWorkOrderConfirmationFingerprint: fingerprintWorkOrderSummarySource(sourceFacts),
            sourceWorkOrderIntakeFaultDescription: sourceFacts.intakeFaultDescription,
            sourceWorkOrderIntakeCustomerFile: sourceFacts.intakeCustomerFile,
          },
      // 机型冻结语义：提交当时解析的显示名随快照冻结，旧版本导出/查看不再依赖机型库
      equipmentModelLabel,
    );
    const versionNo = draftDetail.report.currentVersionNo + 1;
    const submittedAt = new Date();

    const version = await this.maintenanceReportService.insertVersion(
      {
        reportId,
        versionNo,
        changeKind: MaintenanceReportChangeKind.SUBMIT,
        changeReason: null,
        payloadSnapshot: payload,
        submittedByAccountId: accountId,
        submittedAt,
      },
      transactionContext,
    );
    await this.maintenanceReportService.insertVersionAttachments(
      version.id,
      reportId,
      currentAttachments.map((attachment) => ({
        attachmentId: attachment.id,
        sortOrder: attachment.sortOrder,
        descriptionSnapshot: attachment.description,
      })),
      transactionContext,
    );
    try {
      await this.maintenanceReportService.markSubmitted(
        reportId,
        versionNo,
        submittedAt,
        accountId,
        submissionRequestId,
        digest,
        transactionContext,
      );
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      // 条件更新命中 uk_maintenance_report_submission：同标识已绑定其他报告 → 冲突
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
        '提交标识已被其他报告占用，请刷新后重试',
        { reportId },
        error,
      );
    }

    const document = await this.referenceDocumentService.insertDocument(
      {
        title: draftDetail.report.title ?? buildFallbackDocumentTitle(draftDetail.report),
        documentType: 'MAINTENANCE_REPORT',
        equipmentModelId: draftDetail.report.equipmentModelId,
        equipmentModelText: draftDetail.report.equipmentModelText,
        description: null,
        contentText: buildFormalDocumentText(submitDraft, equipmentModelLabel),
        originalFilename: null,
        mimeType: null,
        storageBackend: null,
        storageReference: null,
        createdByAccountId: accountId,
        ownerOrganizationId: organizationId,
        ingestMethod: 'DIRECT_SUBMISSION',
        sourceKind:
          draftDetail.report.sourceType === MaintenanceReportSourceType.HISTORICAL_CASE
            ? 'INDEPENDENT_REPORT'
            : 'WORK_ORDER_SUMMARY',
        sourceReportId: reportId,
        sourceReportVersionId: version.id,
      },
      transactionContext,
    );

    return {
      reportId,
      versionId: version.id,
      versionNo,
      status: 'SUBMITTED',
      submissionRequestId,
      referenceDocumentId: document.id,
    };
  }

  /**
   * 冻结重试核对（2026-11-21）：同标识重试命中已正式提交的工单总结时，
   * 客户端请求按冻结快照核对——不读取、不派生修订后的当前工单事实。
   * - 来源确认标识必须等于冻结时核验通过的指纹（缺失指纹失败关闭）；
   * - AI 评价组按冻结值解析：客户端显式修改任一字段即拒绝。
   * 通过后由调用方返回原报告/冻结版本/资料 ID，不产生任何新写入；
   * 无权访问既有结果的操作者根本走不到这里（提交键含操作者与公司）。
   */
  private async assertWorkOrderSummaryRetryRequestMatchesFrozen(params: {
    report: MaintenanceReportSnapshot;
    command: SubmitMaintenanceReportFormalCommand;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    const version = await this.maintenanceReportQueryService.readVersion(
      params.report.id,
      params.report.currentVersionNo,
      params.transactionContext,
    );
    if (version === null) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
        '已提交报告缺少当前版本行',
        { reportId: params.report.id },
      );
    }
    const frozenFingerprint = readFrozenSourceConfirmationFingerprint(
      version.payloadSnapshot,
      params.report.id,
    );
    if (
      params.command.sourceConfirmation !== undefined &&
      params.command.sourceConfirmation !== frozenFingerprint
    ) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
        '同一提交标识对应的来源确认标识已变化，请刷新后重新核对',
        { reportId: params.report.id },
      );
    }
    const resolved = resolveWorkOrderSummaryAiEvaluationInput(params.command.draft, params.report);
    const frozen: MaintenanceReportAiEvaluationFields = {
      aiUsage: params.report.aiUsage,
      aiSourceType: params.report.aiSourceType,
      aiSourceId: params.report.aiSourceId,
      aiSourceVersion: params.report.aiSourceVersion,
      aiScore: params.report.aiScore,
      aiCorrectness: params.report.aiCorrectness,
      aiHelpfulness: params.report.aiHelpfulness,
      aiNote: params.report.aiNote,
    };
    const modifiedField = (
      Object.keys(resolved) as Array<keyof MaintenanceReportAiEvaluationFields>
    ).find((key) => resolved[key] !== frozen[key]);
    if (modifiedField !== undefined) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT,
        '同一提交标识对应的 AI 评价已变化，请生成新的提交后重试',
        { reportId: params.report.id, field: modifiedField },
      );
    }
  }

  /** 合法重试读侧：返回原 report_id / 冻结版本 / document_id，不生成新版本 */
  private async readExistingFormalResult(
    report: MaintenanceReportSnapshot,
    submissionRequestId: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportFormalSubmitResult> {
    const versionId = await this.maintenanceReportQueryService.findVersionIdByReportAndVersionNo(
      report.id,
      report.currentVersionNo,
      transactionContext,
    );
    if (versionId === null) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
        '已提交报告缺少当前版本行',
        { reportId: report.id },
      );
    }
    const referenceDocumentId =
      await this.referenceDocumentService.findDocumentIdBySourceReportVersion(
        versionId,
        transactionContext,
      );
    return {
      reportId: report.id,
      versionId,
      versionNo: report.currentVersionNo,
      status: 'SUBMITTED',
      submissionRequestId,
      referenceDocumentId,
    };
  }

  private async resolveOrganizationId(
    accountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<number> {
    const membership = await this.organizationContextService.resolveForAccount({
      accountId,
      transactionContext,
    });
    // 恢复期写入冻结：该公司数据区正在恢复时不得正式提交（报告会写入并生成正式资料）
    await this.localWriteHoldService.assertBusinessWritableInTransaction({
      organizationId: membership.organizationId,
      transactionContext,
    });
    return membership.organizationId;
  }

  /** 提交来源与既有报告不一致属于调用方错误（非幂等冲突） */
  private assertReportMatchesSubmission(
    report: MaintenanceReportSnapshot,
    sourceType: MaintenanceReportSourceType,
    repairRequestId: number | null,
  ): void {
    if (report.sourceType !== sourceType || report.repairRequestId !== repairRequestId) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '提交来源与报告事实不一致', {
        reportId: report.id,
      });
    }
  }
}

/** 无标题报告的资料标题回落：厂家 + 日期可读组合 */
function buildFallbackDocumentTitle(report: {
  customerFactoryName: string | null;
  maintenanceDate: string | null;
  sourceType: MaintenanceReportSourceType;
}): string {
  const factory = trimOptionalText(report.customerFactoryName) ?? '未知厂家';
  const date = trimOptionalText(report.maintenanceDate) ?? '未注明日期';
  const prefix =
    report.sourceType === MaintenanceReportSourceType.HISTORICAL_CASE
      ? '历史维修记录'
      : '工单维修总结';
  return `${date} ${factory} ${prefix}`;
}

/** 正式资料可检索正文：表头、步骤与有效故障分支的扁平文本 */
function buildFormalDocumentText(
  submitDraft: {
    report: {
      customerFactoryName: string | null;
      equipmentModelText: string | null;
      maintenanceDate: string | null;
      maintenanceEngineerNameSnapshot: string;
      handlingResult: string | null;
      actualCause: string | null;
      repairActions: string | null;
      verificationResult: string | null;
      supplementaryNote: string | null;
    };
    steps: Array<{ stepNo: number; actionText: string; resultText: string | null }>;
    faults: Array<{ description: string; action: string | null; phaseCode: string | null }>;
  },
  /** 机型展示名（2026-11-21 修复）：已按机型库解析，缺失回落手填文本 */
  equipmentModelLabel: string | null,
): string {
  const report = submitDraft.report;
  const lines: string[] = [
    `客户厂家：${report.customerFactoryName ?? ''}`,
    `机型：${equipmentModelLabel ?? ''}`,
    `维修日期：${report.maintenanceDate ?? ''}`,
    `维修人员：${report.maintenanceEngineerNameSnapshot}`,
    `维修结果：${report.handlingResult ?? ''}`,
    `实际原因：${report.actualCause ?? ''}`,
    `维修措施：${report.repairActions ?? ''}`,
    `复测结果：${report.verificationResult ?? ''}`,
    `补充说明：${report.supplementaryNote ?? ''}`,
  ];
  for (const step of submitDraft.steps) {
    lines.push(
      `步骤${step.stepNo}：${step.actionText}${step.resultText ? `（${step.resultText}）` : ''}`,
    );
  }
  for (const fault of submitDraft.faults) {
    lines.push(
      `故障[${fault.phaseCode ?? '-'}]：${fault.description}${fault.action ? `；${fault.action}` : ''}`,
    );
  }
  return lines.join('\n');
}
