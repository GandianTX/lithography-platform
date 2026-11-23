// src/usecases/admin-document-database/append-repair-request-revision.usecase.ts

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { normalizeRequiredText } from '@core/common/input-normalize/input-normalize.policy';
import { isRepairRequestVisibleToAdminOrganization } from '@core/repair-request/policy/repair-request-admin-scope.policy';
import {
  REPAIR_REQUEST_REVISION_SCHEMA_VERSION,
  buildRepairRequestRevisionSnapshot,
  type RepairRequestRevisionSnapshotPanel,
  type RepairRequestRevisionSnapshotStep,
} from '@core/repair-request/policy/repair-request-revision.policy';
import {
  normalizeMaintenanceRecord,
  type MaintenanceRecordRawInput,
  type NormalizedMaintenanceRecord,
} from '@core/repair-request/policy/repair-request-maintenance.policy';
import {
  isTerminalHandlingStatus,
  parseRepairRequestHandlingResult,
  resolveRepairRequestHandlingStatus,
} from '@core/repair-request/policy/repair-request-handling.policy';
import { requiresClosureReason } from '@core/repair-request/policy/repair-process-write.policy';
import {
  hasClosureReasonText,
  normalizeClosureReason,
  normalizeProcessOperationText,
  normalizeProcessTestResult,
  normalizeRepairProcessEntryId,
  normalizeRepairProcessExpectedVersion,
} from '@core/repair-request/policy/repair-request-write-normalize.policy';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  RepairMaintenanceFaultPanelView,
  RepairMaintenanceStepView,
} from '@src/modules/lithography/lithography.types';
import { RepairRequestMaintenanceService } from '@src/modules/lithography/repair-request-maintenance.service';
import {
  RepairRequestProcessRevisionTarget,
  RepairRequestRevisionService,
  RepairRequestRevisionTargetSnapshot,
} from '@src/modules/lithography/repair-request-revision.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { assertPositiveId } from './admin-document-database-filter.normalize';
import { resolveAdminOrganizationScope } from './admin-organization-scope';

export type RepairRequestProcessRevisionCommand = {
  entryId: string;
  expectedVersion: number;
  operationText: string;
  testResult?: string | null;
};

export type AppendRepairRequestRevisionCommand = {
  session: UsecaseSession;
  requestId: number;
  /** 必须等于工单当前 current_revision_no */
  expectedVersion: number;
  /** 修订原因（必填，最多 1000 字符） */
  reason: string;
  contentMd?: string | null;
  handlingResult?: RepairRequestHandlingResult | null;
  closureReason?: string | null;
  processEntries?: ReadonlyArray<RepairRequestProcessRevisionCommand>;
  /**
   * 结构化维修记录修订（可选）。提供时必须同时给出 expectedMaintenanceVersion；
   * 只允许订正维修字段、步骤与面板，不允许改附件绑定（attachment 字段不开放）。
   */
  expectedMaintenanceVersion?: number | null;
  maintenance?: MaintenanceRecordRawInput | null;
};

export type RepairRequestRevisionView = {
  requestId: number;
  revisionNo: number;
  previousVersion: number;
  reason: string;
  currentRevisionNo: number;
  actorNickname: string;
  createdAt: Date;
  hasComparableSnapshot: boolean;
  schemaVersion: number;
};

const MAX_REASON_LENGTH = 1000;

/**
 * 管理员工单修订用例（任务 04 管理员切片）。
 *
 * 业务边界：
 * - 仅已通过管理员精确授权且属于其组织范围的工单可修订；
 * - 只允许修订正文、处理结果、结单原因与已存在的过程文本（字段白名单见
 *   `repair-request-revision.policy.ts`）；客户原始提交、设备事实、接单人、
 *   组织归属、状态机事实与模型输出一律不改写；
 * - 一级管理员可修订全公司；二级管理员仅可信本公司；
 * - 版本条件：expectedVersion 必须等于工单当前 current_revision_no，
 *   条件更新命中 0 行按版本冲突拒绝；过程行同时校验自身 version_no；
 * - 同一事务内写快照与修订历史，任一失败整体回滚，不留部分更新；
 * - 管理员不代接单、不代写过程、不代写总结：本用例只订正已存在内容。
 *
 * 审计：修订历史行保存修改人、原因、前后完整快照与版本号；按 R030 不写
 * `management_audit_event`。
 */
@Injectable()
export class AppendRepairRequestRevisionUsecase {
  constructor(
    private readonly revisionService: RepairRequestRevisionService,
    private readonly maintenanceService: RepairRequestMaintenanceService,
    private readonly accountQueryService: AccountQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: AppendRepairRequestRevisionCommand): Promise<RepairRequestRevisionView> {
    assertAdminDocumentDatabasePermission(command.session, '修订维修申请');
    assertPositiveId(command.requestId, '维修申请 ID', 'requestId');
    assertExpectedVersion(command.expectedVersion);
    const reason = normalizeReason(command.reason);
    const organizationScope = await resolveAdminOrganizationScope({
      session: command.session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });

    const contentMd = normalizeOptionalContent(command.contentMd);
    const handlingResult = normalizeOptionalHandlingResult(command.handlingResult);
    const closureReasonInput = command.closureReason;
    const processEntries = normalizeProcessEntries(command.processEntries);
    if (processEntries.length > 0) {
      // 任务 04 旧过程转为历史只读：管理员修订不能成为写旧过程文本的旁路。
      // 新版结构化维修记录的修订仍走 maintenance 分支。
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_READONLY,
        '旧维修过程已只读，管理员不能修订旧过程文本；请在新版结构化维修记录中修订',
        { requestId: command.requestId },
      );
    }
    const maintenance = normalizeAdminMaintenance(command);
    if (
      contentMd === null &&
      handlingResult === null &&
      closureReasonInput === undefined &&
      processEntries.length === 0 &&
      maintenance === null
    ) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '未检测到需要修订的字段');
    }

    const now = new Date();
    const result = await this.transactionRunner.run(async (transactionContext) => {
      const target = requireAccessibleRevisionTarget(
        await this.revisionService.lockRequestForRevision(command.requestId, transactionContext),
        command.requestId,
        organizationScope.organizationId,
      );
      // 恢复期写入冻结：工单归属公司数据区正在恢复时不得写入修订历史
      await this.localWriteHoldService.assertBusinessWritable({
        organizationId: target.ownerOrganizationId,
      });

      if (target.currentRevisionNo !== command.expectedVersion) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
          '工单已被其他修订更新，请刷新后重试',
          { requestId: command.requestId, expectedVersion: command.expectedVersion },
        );
      }
      if (handlingResult !== null && !target.isAccepted) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.HANDLING_NOT_AVAILABLE,
          '工单尚未接单，不能修订处理结果',
          { requestId: command.requestId },
        );
      }
      const nextClosureReason = resolveClosureReasonForRevision({
        target,
        handlingResult,
        closureReasonInput,
      });

      const processTargets = await this.revisionService.lockProcessEntriesForRevision(
        command.requestId,
        transactionContext,
      );
      const responses = await this.revisionService.listResponsesForSnapshot(
        command.requestId,
        transactionContext,
      );
      const beforeMaintenanceSteps = await this.revisionService.lockMaintenanceSteps(
        command.requestId,
        transactionContext,
      );
      const beforeMaintenancePanels = await this.revisionService.lockMaintenancePanels(
        command.requestId,
        transactionContext,
      );

      if (maintenance !== null) {
        assertExpectedMaintenanceVersion(command.expectedMaintenanceVersion);
        if (target.maintenanceVersionNo !== command.expectedMaintenanceVersion) {
          throw new DomainError(
            REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
            '维修记录已被其他操作更新，请刷新后重试',
            {
              requestId: command.requestId,
              expectedMaintenanceVersion: command.expectedMaintenanceVersion,
            },
          );
        }
      }

      const nextProcessEntries = resolveNextProcessEntries(processTargets, processEntries);
      const nextRequest = resolveNextRequest(target, {
        contentMd,
        handlingResult,
        closureReason: nextClosureReason,
        now,
        actorAccountId: command.session.accountId,
        nextRevisionNo: target.currentRevisionNo + 1,
        maintenance,
      });

      if (
        nextRequest.contentMd === target.contentMd &&
        nextRequest.handlingResult === target.handlingResult &&
        nextRequest.closureReason === target.closureReason &&
        nextProcessEntries.changed.length === 0 &&
        (maintenance === null ||
          !hasMaintenanceChanges(
            target,
            beforeMaintenanceSteps,
            beforeMaintenancePanels,
            maintenance,
          ))
      ) {
        throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '未检测到需要修订的字段');
      }

      const beforeSnapshot = buildRepairRequestRevisionSnapshot({
        request: target,
        processEntries: processTargets,
        responses,
        maintenanceSteps: beforeMaintenanceSteps.map(toSnapshotStep),
        maintenanceFaultPanels: beforeMaintenancePanels.map(toSnapshotPanel),
      });

      const affected = await this.revisionService.updateRequestRevisionFields(
        {
          requestId: command.requestId,
          expectedVersion: command.expectedVersion,
          nextVersion: nextRequest.currentRevisionNo,
          contentMd: contentMd ?? undefined,
          handlingResult: nextRequest.handlingResultValue ?? undefined,
          handlingStatus: nextRequest.handlingStatusValue ?? undefined,
          handlingRecordedAt: nextRequest.handlingRecordedAt,
          handlingRecordedByAccountId: nextRequest.handlingRecordedByAccountId,
          handlingEndedAt: nextRequest.handlingEndedAt,
          closureReason: nextRequest.closureReasonValue,
        },
        transactionContext,
      );
      if (affected !== 1) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
          '工单已被其他修订更新，请刷新后重试',
          { requestId: command.requestId, expectedVersion: command.expectedVersion },
        );
      }

      for (const change of nextProcessEntries.changed) {
        const changedRows = await this.revisionService.updateProcessEntryRevision(
          {
            requestId: command.requestId,
            entryId: change.entryId,
            expectedVersion: change.expectedVersion,
            operationText: change.operationText,
            testResult: change.testResult,
          },
          transactionContext,
        );
        if (changedRows !== 1) {
          throw new DomainError(
            REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
            '维修过程已被其他操作更新，请刷新后重试',
            { requestId: command.requestId, entryId: change.entryId },
          );
        }
      }

      // 维修记录写入与工单/过程修订同事务；附件绑定不在管理员白名单内，故不传 attachment
      if (maintenance !== null) {
        await this.maintenanceService.saveMaintenance(
          {
            requestId: command.requestId,
            expectedVersion: target.maintenanceVersionNo,
            maintenanceDate: maintenance.maintenanceDate,
            engineerName: maintenance.engineerName,
            resetResult: maintenance.resetResult,
            supplementaryNote: maintenance.supplementaryNote,
            steps: maintenance.steps,
            panels: maintenance.panels,
          },
          transactionContext,
        );
      }

      const afterMaintenanceSteps = await this.revisionService.listMaintenanceStepsAfterWrite(
        command.requestId,
        transactionContext,
      );
      const afterMaintenancePanels = await this.revisionService.listMaintenancePanelsAfterWrite(
        command.requestId,
        transactionContext,
      );

      const afterSnapshot = buildRepairRequestRevisionSnapshot({
        request: nextRequest.requestSnapshot,
        processEntries: nextProcessEntries.after,
        responses,
        maintenanceSteps: afterMaintenanceSteps.map(toSnapshotStep),
        maintenanceFaultPanels: afterMaintenancePanels.map(toSnapshotPanel),
      });
      const revision = await this.revisionService.insertRevision(
        {
          requestId: command.requestId,
          revisionNo: target.currentRevisionNo + 1,
          previousVersion: command.expectedVersion,
          beforeSnapshot: JSON.stringify(beforeSnapshot),
          afterSnapshot: JSON.stringify(afterSnapshot),
          schemaVersion: REPAIR_REQUEST_REVISION_SCHEMA_VERSION,
          actorAccountId: command.session.accountId,
          reason,
        },
        transactionContext,
      );

      return {
        requestId: command.requestId,
        revisionNo: revision.revisionNo,
        previousVersion: revision.previousVersion,
        reason: revision.reason,
        currentRevisionNo: nextRequest.currentRevisionNo,
        createdAt: revision.createdAt,
        // 本用例写入的始终是当前结构版本，前后快照完整可比
        hasComparableSnapshot: true,
        schemaVersion: REPAIR_REQUEST_REVISION_SCHEMA_VERSION,
      };
    });

    return {
      ...result,
      // 事务已明确提交成功后再做展示富集；昵称查询失败只回退展示值，
      // 不改写已提交结果，也不重试 mutation。
      actorNickname: await this.findAdminNicknameSafely(command.session.accountId),
    };
  }

  private async findAdminNicknameSafely(accountId: number): Promise<string> {
    try {
      return await this.findAdminNickname(accountId);
    } catch {
      // 修订事务已成功；昵称属于非关键展示字段，失败关闭为占位昵称。
      return '管理员';
    }
  }

  private async findAdminNickname(accountId: number): Promise<string> {
    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([accountId]);
    return nicknames.get(accountId) ?? '管理员';
  }
}

function requireAccessibleRevisionTarget(
  target: RepairRequestRevisionTargetSnapshot | null,
  requestId: number,
  organizationId: number | null,
): RepairRequestRevisionTargetSnapshot {
  if (
    !target ||
    target.deprecated ||
    !isRepairRequestVisibleToAdminOrganization(
      target,
      organizationId,
      target.intakeServiceOrganizationId,
    )
  ) {
    throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可访问', {
      requestId,
    });
  }
  return target;
}

function resolveClosureReasonForRevision(input: {
  target: RepairRequestRevisionTargetSnapshot;
  handlingResult: RepairRequestHandlingResult | null;
  closureReasonInput: string | null | undefined;
}): string | null | undefined {
  const { target, handlingResult, closureReasonInput } = input;
  if (closureReasonInput === undefined) {
    if (
      handlingResult !== null &&
      requiresClosureReason(handlingResult) &&
      !hasClosureReasonText(target.closureReason)
    ) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.INVALID_PARAMS,
        '中断或无法修复时必须填写结单原因',
      );
    }
    return undefined;
  }
  const currentHandlingResult = parseRepairRequestHandlingResult(target.handlingResult);
  if (handlingResult === null && currentHandlingResult === null) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      '尚无处理结果，不能单独修订结单原因',
    );
  }
  return normalizeClosureReason(
    closureReasonInput,
    handlingResult ?? (currentHandlingResult as RepairRequestHandlingResult),
  );
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '工单版本号格式不合法');
  }
}

function normalizeReason(input: string): string {
  const reason = normalizeRequiredText(input, { fieldName: '修订原因' });
  if (reason.length > MAX_REASON_LENGTH) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      `修订原因不能超过 ${MAX_REASON_LENGTH} 个字符`,
    );
  }
  return reason;
}

function normalizeOptionalContent(input: string | null | undefined): string | null {
  if (input === undefined || input === null) {
    return null;
  }
  return normalizeRequiredText(input, { fieldName: '故障正文' });
}

function normalizeOptionalHandlingResult(
  input: RepairRequestHandlingResult | null | undefined,
): RepairRequestHandlingResult | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Object.values(RepairRequestHandlingResult).includes(input)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '处理结果不合法');
  }
  return input;
}

type NormalizedProcessRevision = {
  entryId: string;
  expectedVersion: number;
  operationText: string;
  testResult: string | null;
};

function normalizeProcessEntries(
  input: ReadonlyArray<RepairRequestProcessRevisionCommand> | undefined,
): NormalizedProcessRevision[] {
  if (input === undefined) {
    return [];
  }
  if (input.length === 0) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '过程修订列表不能为空');
  }
  const seen = new Set<string>();
  return input.map((item) => {
    const entryId = normalizeRepairProcessEntryId(item.entryId);
    if (seen.has(entryId)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '过程修订列表存在重复编号');
    }
    seen.add(entryId);
    return {
      entryId,
      expectedVersion: normalizeRepairProcessExpectedVersion(item.expectedVersion),
      operationText: normalizeProcessOperationText(item.operationText),
      testResult: normalizeProcessTestResult(item.testResult),
    };
  });
}

function resolveNextProcessEntries(
  current: RepairRequestProcessRevisionTarget[],
  commands: NormalizedProcessRevision[],
): {
  changed: Array<{
    entryId: string;
    expectedVersion: number;
    operationText: string;
    testResult: string | null;
  }>;
  after: RepairRequestProcessRevisionTarget[];
} {
  if (commands.length === 0) {
    return { changed: [], after: current };
  }
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const changed: Array<{
    entryId: string;
    expectedVersion: number;
    operationText: string;
    testResult: string | null;
  }> = [];
  const updates = new Map<
    string,
    { operationText: string; testResult: string | null; versionNo: number }
  >();

  for (const command of commands) {
    const target = byId.get(command.entryId);
    if (!target) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_NOT_FOUND,
        '维修过程不存在或不属于该工单',
        {
          entryId: command.entryId,
        },
      );
    }
    if (target.versionNo !== command.expectedVersion) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
        '维修过程已被其他操作更新，请刷新后重试',
        { entryId: command.entryId, expectedVersion: command.expectedVersion },
      );
    }
    if (
      target.operationText !== command.operationText ||
      target.testResult !== command.testResult
    ) {
      changed.push(command);
      updates.set(command.entryId, {
        operationText: command.operationText,
        testResult: command.testResult,
        versionNo: target.versionNo + 1,
      });
    }
  }

  return {
    changed,
    after: current.map((entry) => {
      const update = updates.get(entry.id);
      return update
        ? {
            ...entry,
            operationText: update.operationText,
            testResult: update.testResult,
            versionNo: update.versionNo,
          }
        : entry;
    }),
  };
}

function resolveNextRequest(
  target: RepairRequestRevisionTargetSnapshot,
  input: {
    contentMd: string | null;
    handlingResult: RepairRequestHandlingResult | null;
    closureReason: string | null | undefined;
    now: Date;
    actorAccountId: number;
    nextRevisionNo: number;
    maintenance: NormalizedMaintenanceRecord | null;
  },
): {
  requestSnapshot: Parameters<typeof buildRepairRequestRevisionSnapshot>[0]['request'];
  currentRevisionNo: number;
  contentMd: string;
  handlingResult: string | null;
  handlingResultValue: RepairRequestHandlingResult | null;
  handlingStatusValue: RepairRequestHandlingStatus | null;
  handlingRecordedAt: Date | undefined;
  handlingRecordedByAccountId: number | undefined;
  handlingEndedAt: Date | null | undefined;
  closureReason: string | null;
  closureReasonValue: string | null | undefined;
} {
  const contentMd = input.contentMd ?? target.contentMd;
  const handling = resolveNextHandlingFacts(target, {
    handlingResult: input.handlingResult,
    now: input.now,
    actorAccountId: input.actorAccountId,
  });
  const closureReason =
    input.closureReason === undefined ? target.closureReason : (input.closureReason ?? null);
  const maintenanceFacts =
    input.maintenance === null
      ? {
          maintenanceDate: target.maintenanceDate,
          maintenanceEngineerName: target.maintenanceEngineerName,
          resetResult: target.resetResult,
          supplementaryNote: target.supplementaryNote,
          maintenanceVersionNo: target.maintenanceVersionNo,
          maintenanceAttachmentFileId: target.maintenanceAttachmentFileId,
        }
      : {
          maintenanceDate: input.maintenance.maintenanceDate,
          maintenanceEngineerName: input.maintenance.engineerName,
          resetResult: input.maintenance.resetResult,
          supplementaryNote: input.maintenance.supplementaryNote,
          // 保存成功会原子递增维修版本号
          maintenanceVersionNo: target.maintenanceVersionNo + 1,
          // 附件绑定不在管理员白名单内，保持原值
          maintenanceAttachmentFileId: target.maintenanceAttachmentFileId,
        };

  return {
    requestSnapshot: {
      requestNo: target.requestNo,
      customerAccountId: target.customerAccountId,
      equipmentModelId: target.equipmentModelId,
      errorCode: target.errorCode,
      faultDescription: target.faultDescription,
      contentMd,
      createdAt: target.createdAt,
      isAccepted: target.isAccepted,
      acceptedByEngineerAccountId: target.acceptedByEngineerAccountId,
      acceptedAt: target.acceptedAt,
      ownerOrganizationId: target.ownerOrganizationId,
      serviceOrganizationId: target.serviceOrganizationId,
      handlingResult: handling.handlingResult,
      handlingStatus: handling.handlingStatus,
      handlingRecordedAt: handling.handlingRecordedAt,
      handlingRecordedByAccountId: handling.handlingRecordedByAccountId,
      handlingEndedAt: handling.handlingEndedAt,
      closureStatus: target.closureStatus,
      closedAt: target.closedAt,
      closureReason,
      currentRevisionNo: input.nextRevisionNo,
      ...maintenanceFacts,
    },
    currentRevisionNo: input.nextRevisionNo,
    contentMd,
    handlingResult: handling.handlingResult,
    handlingResultValue: handling.handlingResultValue,
    handlingStatusValue: handling.handlingStatusValue,
    handlingRecordedAt: handling.handlingRecordedAtChanged ? input.now : undefined,
    handlingRecordedByAccountId: handling.handlingRecordedAtChanged
      ? input.actorAccountId
      : undefined,
    handlingEndedAt: handling.handlingRecordedAtChanged ? handling.handlingEndedAt : undefined,
    closureReason,
    closureReasonValue: input.closureReason,
  };
}

/**
 * 管理员维修修订归一：必须显式携带维修版本号；附件绑定不在白名单内。
 */
function normalizeAdminMaintenance(
  command: AppendRepairRequestRevisionCommand,
): NormalizedMaintenanceRecord | null {
  if (command.maintenance === undefined || command.maintenance === null) {
    return null;
  }
  assertExpectedMaintenanceVersion(command.expectedMaintenanceVersion);
  return normalizeMaintenanceRecord(command.maintenance);
}

function assertExpectedMaintenanceVersion(value: number | null | undefined): void {
  if (value === undefined || value === null) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '修订维修记录时必须提供维修版本号');
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修版本号格式不合法');
  }
}

/** 维修字段/步骤/面板与当前值是否真实变化（调序也算变化） */
function hasMaintenanceChanges(
  target: RepairRequestRevisionTargetSnapshot,
  steps: RepairMaintenanceStepView[],
  panels: RepairMaintenanceFaultPanelView[],
  next: NormalizedMaintenanceRecord,
): boolean {
  if (
    target.maintenanceDate !== next.maintenanceDate ||
    target.maintenanceEngineerName !== next.engineerName ||
    target.resetResult !== next.resetResult ||
    target.supplementaryNote !== next.supplementaryNote
  ) {
    return true;
  }
  const currentSteps = steps.map((step) => ({
    id: step.id,
    stepNo: step.stepNo,
    errorCode: step.errorCode,
    partName: step.partName,
    actionText: step.actionText,
    resultCode: step.resultCode,
  }));
  const nextSteps = next.steps.map((step) => ({
    id: step.id,
    stepNo: step.stepNo,
    errorCode: step.errorCode,
    partName: step.partName,
    actionText: step.actionText,
    resultCode: step.resultCode,
  }));
  if (stableStepJson(currentSteps) !== stableStepJson(nextSteps)) {
    return true;
  }

  const stepNoById = new Map(steps.map((step) => [step.id, step.stepNo]));
  const currentPanels = panels.map((panel) => ({
    id: panel.id,
    panelType: panel.panelType,
    stepNo: panel.stepId === null ? null : (stepNoById.get(panel.stepId) ?? null),
    phaseCode: panel.phaseCode,
    mainError: panel.mainError,
    unitError: panel.unitError,
    source: panel.source,
    errorType: panel.errorType,
    gpibStatus: panel.gpibStatus,
    faultStatus: panel.faultStatus,
    description: panel.description,
    action: panel.action,
  }));
  const nextPanels = next.panels.map((panel) => ({
    id: panel.id,
    panelType: panel.panelType,
    stepNo: panel.stepNo,
    phaseCode: panel.phaseCode,
    mainError: panel.mainError,
    unitError: panel.unitError,
    source: panel.source,
    errorType: panel.errorType,
    gpibStatus: panel.gpibStatus,
    faultStatus: panel.faultStatus,
    description: panel.description,
    action: panel.action,
  }));
  return stablePanelJson(currentPanels) !== stablePanelJson(nextPanels);
}

function stableStepJson(rows: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify([...rows].sort((a, b) => Number(a.stepNo) - Number(b.stepNo)));
}

function stablePanelJson(rows: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))));
}

function toSnapshotStep(step: RepairMaintenanceStepView): RepairRequestRevisionSnapshotStep {
  return { ...step };
}

function toSnapshotPanel(
  panel: RepairMaintenanceFaultPanelView,
): RepairRequestRevisionSnapshotPanel {
  return { ...panel };
}

type NextHandlingFacts = {
  handlingResult: string | null;
  handlingStatus: string | null;
  handlingEndedAt: Date | null;
  handlingRecordedAt: Date | null;
  handlingRecordedByAccountId: number | null;
  handlingResultValue: RepairRequestHandlingResult | null;
  handlingStatusValue: RepairRequestHandlingStatus | null;
  handlingRecordedAtChanged: boolean;
};

/**
 * 处理结果只在值真实变化时生效：同值回传不得改写处理时间、记录人与终结时间。
 */
function resolveNextHandlingFacts(
  target: RepairRequestRevisionTargetSnapshot,
  input: {
    handlingResult: RepairRequestHandlingResult | null;
    now: Date;
    actorAccountId: number;
  },
): NextHandlingFacts {
  if (input.handlingResult === null || input.handlingResult === target.handlingResult) {
    return {
      handlingResult: target.handlingResult,
      handlingStatus: target.handlingStatus,
      handlingEndedAt: target.handlingEndedAt,
      handlingRecordedAt: target.handlingRecordedAt,
      handlingRecordedByAccountId: target.handlingRecordedByAccountId,
      handlingResultValue: null,
      handlingStatusValue: null,
      handlingRecordedAtChanged: false,
    };
  }

  const status = resolveRepairRequestHandlingStatus(input.handlingResult);
  return {
    handlingResult: input.handlingResult,
    handlingStatus: status,
    handlingEndedAt: isTerminalHandlingStatus(status)
      ? (target.handlingEndedAt ?? input.now)
      : null,
    handlingRecordedAt: input.now,
    handlingRecordedByAccountId: input.actorAccountId,
    handlingResultValue: input.handlingResult,
    handlingStatusValue: status,
    handlingRecordedAtChanged: true,
  };
}
