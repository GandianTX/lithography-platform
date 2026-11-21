// src/usecases/maintenance-report/maintenance-report-work-order-source.helpers.ts
//
// 2026-11-20 需求调整：工单维修总结改为只读核对——客户端不再重复填写任务 04
// 维修内容，冻结内容一律以服务端核验的工单事实为准派生。
//
// - readWorkOrderSummarySourceFacts：在同一事务上下文读取工单维修事实
//   （结构化维修记录、排查步骤、故障面板、结单原因、客户公司名、客户原始报修
//   与两份原件引用——只读核对页展示与来源指纹共用同一份事实）；
// - buildWorkOrderSummaryDraftInput：把工单事实映射为报告草稿输入
//   （步骤/故障面板与报告子表字段一一对应；实际原因/维修措施/复测结果
//   恒为空——工单不存在这三项事实，不得伪造）；
// - assertNoWorkOrderSummaryClientContent：拒绝客户端携带任何内容字段，
//   防止旧数据或越权客户端把工单之外的"维修内容"静默写进总结；
// - isSameWorkOrderSummaryDraftContent：派生内容与库内草稿比对，
//   用于「工单在草稿保存后被管理员修订」的版本变化检测。

import { createHash } from 'node:crypto';
import {
  MaintenanceReportFaultBranchKind,
  MaintenanceReportStepResult,
} from '@app-types/models/maintenance-report.types';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import type {
  MaintenanceReportDraftDetailView,
  RepairRequestWriteContext,
  WorkOrderSummarySourcePreviewView,
} from '@src/modules/lithography/maintenance-report.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportDraftInput } from './maintenance-report-command.types';
import { collectProvidedFieldNames } from './maintenance-report.input.normalize';

/** 来源工单原件的引用元数据（不暴露存储引用，不冒称已被冻结） */
export type WorkOrderSummarySourceAttachment = {
  fileId: string;
  originalFilename: string;
  byteSize: number;
};

/** 服务端核验后的来源工单维修事实 */
export type WorkOrderSummarySourceFacts = {
  repairRequestId: number;
  requestNo: string;
  equipmentModelId: number;
  handlingResult: string | null;
  closureReason: string | null;
  closedAt: Date | null;
  /** 冻结快照记录的来源修订版本（provenance，不参与内容比对） */
  currentRevisionNo: number;
  customerCompanyName: string | null;
  maintenanceDate: string | null;
  /** 维修记录人员名快照（只读核对页展示；参与内容指纹，改名需重新核对） */
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  attachment: WorkOrderSummarySourceAttachment | null;
  /** 客户原始报修（展示用，也参与内容指纹：页面所见即所核对） */
  intakeFaultDescription: string | null;
  /** 客户报修原件引用（展示与授权下载用；新增/移除/更换均改变指纹） */
  intakeCustomerFile: WorkOrderSummarySourceAttachment | null;
  steps: Array<{
    stepNo: number;
    errorCode: string | null;
    partName: string | null;
    actionText: string;
    resultCode: string;
  }>;
  panels: Array<{
    panelType: string;
    stepNo: number | null;
    phaseCode: string | null;
    mainError: string | null;
    unitError: string | null;
    source: string | null;
    errorType: string | null;
    gpibStatus: string | null;
    faultStatus: string | null;
    description: string;
    action: string | null;
  }>;
};

/** 读侧附件视图 → 来源原件引用（省略存储细节） */
const toAttachmentRef = (
  view: { fileId: string; originalFilename: string; byteSize: number } | null | undefined,
): WorkOrderSummarySourceAttachment | null =>
  view
    ? { fileId: view.fileId, originalFilename: view.originalFilename, byteSize: view.byteSize }
    : null;

/**
 * 读取来源工单维修事实（读侧组装；可传入事务上下文与锁定读同源）。
 *
 * 客户厂家取工单客户公司组织名：工单没有独立的"客户厂家"手填字段，
 * 总结不再手填，派生为空时正式提交按完整性校验失败关闭。
 */
export async function readWorkOrderSummarySourceFacts(params: {
  request: RepairRequestWriteContext;
  maintenanceQueryService: RepairRequestMaintenanceQueryService;
  organizationQueryService: OrganizationQueryService;
  transactionContext?: PersistenceTransactionContext;
}): Promise<WorkOrderSummarySourceFacts> {
  const { request, maintenanceQueryService, organizationQueryService, transactionContext } = params;
  const [record, steps, panels, customerCompanyName, intakeSource] = await Promise.all([
    maintenanceQueryService.findRecord(request.id, transactionContext),
    maintenanceQueryService.listSteps(request.id, transactionContext),
    maintenanceQueryService.listFaultPanels(request.id, transactionContext),
    request.customerOrganizationId === null
      ? Promise.resolve(null)
      : organizationQueryService.findOrganizationNameById({
          organizationId: request.customerOrganizationId,
          transactionContext,
        }),
    maintenanceQueryService.findIntakeSource(request.id, transactionContext),
  ]);

  return {
    repairRequestId: request.id,
    requestNo: request.requestNo,
    equipmentModelId: request.equipmentModelId,
    handlingResult: request.handlingResult,
    closureReason: request.closureReason,
    closedAt: request.closedAt,
    currentRevisionNo: request.currentRevisionNo,
    customerCompanyName,
    maintenanceDate: record?.maintenanceDate ?? null,
    engineerName: record?.engineerName ?? null,
    intakeFaultDescription: intakeSource?.faultDescription ?? null,
    intakeCustomerFile: toAttachmentRef(intakeSource?.customerFile ?? null),
    resetResult: record?.resetResult ?? null,
    supplementaryNote: record?.supplementaryNote ?? null,
    attachment: record?.attachment
      ? {
          fileId: record.attachment.fileId,
          originalFilename: record.attachment.originalFilename,
          byteSize: record.attachment.byteSize,
        }
      : null,
    steps: steps.map((step) => ({
      stepNo: step.stepNo,
      errorCode: step.errorCode,
      partName: step.partName,
      actionText: step.actionText,
      resultCode: step.resultCode,
    })),
    panels: panels.map((panel) => ({
      panelType: panel.panelType,
      stepNo: resolvePanelStepNo(panel, steps),
      phaseCode: panel.phaseCode,
      mainError: panel.mainError,
      unitError: panel.unitError,
      source: panel.source,
      errorType: panel.errorType,
      gpibStatus: panel.gpibStatus,
      faultStatus: panel.faultStatus,
      description: panel.description,
      action: panel.action,
    })),
  };
}

/** 比对实际展示的维修事实与原件，不因空修订记录拦截。 */
export function fingerprintWorkOrderSummarySource(facts: WorkOrderSummarySourceFacts): string {
  // provenance 修订号不参与内容比对（rest 兄弟属性析构丢弃）
  const { currentRevisionNo, ...content } = facts;
  void currentRevisionNo;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * 来源工单只读核对预览（2026-11-21 需求调整）。
 *
 * 直接投影同一份 `WorkOrderSummarySourceFacts`（剔除 provenance 修订号）：
 * 页面展示与 `sourceConfirmation` 指纹来自同一次服务端读取，
 * 预览与校验不再走两条读取路径，避免「两次请求都成功即认定一致」的假绑定。
 */
export function buildWorkOrderSummarySourcePreview(
  facts: WorkOrderSummarySourceFacts,
): WorkOrderSummarySourcePreviewView {
  return {
    customerCompanyName: facts.customerCompanyName,
    handlingResult: facts.handlingResult,
    closureReason: facts.closureReason,
    maintenanceDate: facts.maintenanceDate,
    engineerName: facts.engineerName,
    resetResult: facts.resetResult,
    supplementaryNote: facts.supplementaryNote,
    attachment: facts.attachment,
    intakeFaultDescription: facts.intakeFaultDescription,
    intakeCustomerFile: facts.intakeCustomerFile,
    steps: facts.steps,
    panels: facts.panels,
  };
}

/** 冻结快照来源确认指纹键名（冻结写入与读取共用，防止键名漂移） */
const FROZEN_FINGERPRINT_KEY = 'sourceWorkOrderConfirmationFingerprint';

/**
 * 从冻结版本 payload 读取提交时核验通过的来源确认指纹。
 *
 * 由本轮实现写入快照；缺失属数据不定式破坏，失败关闭——
 * 既不给冻结预览伪造标识，也不让重试绕过冻结侧核对。
 */
export function readFrozenSourceConfirmationFingerprint(
  payload: Record<string, unknown>,
  reportId: number,
): string {
  const fingerprint = payload[FROZEN_FINGERPRINT_KEY];
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
      '已提交总结缺少来源确认指纹，无法按冻结内容读取或核对重试请求',
      { reportId },
    );
  }
  return fingerprint;
}

/** 冻结 payload 严格读取辅助：键缺失或类型不符一律失败关闭 */
function frozenString(
  payload: Record<string, unknown>,
  key: string,
  reportId: number,
): string | null {
  const value = payload[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT, '冻结快照字段类型异常', {
      reportId,
      key,
    });
  }
  return value;
}

function frozenStringOrThrow(
  payload: Record<string, unknown>,
  key: string,
  reportId: number,
): string {
  const value = frozenString(payload, key, reportId);
  if (value === null) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT, '冻结快照缺少必要字段', {
      reportId,
      key,
    });
  }
  return value;
}

function frozenAttachmentRef(
  payload: Record<string, unknown>,
  key: string,
  reportId: number,
): WorkOrderSummarySourceAttachment | null {
  const value = payload[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT, '冻结快照原件引用类型异常', {
      reportId,
      key,
    });
  }
  const ref = value as Record<string, unknown>;
  if (
    typeof ref['fileId'] !== 'string' ||
    typeof ref['originalFilename'] !== 'string' ||
    typeof ref['byteSize'] !== 'number'
  ) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
      '冻结快照原件引用字段不完整',
      { reportId, key },
    );
  }
  return {
    fileId: ref['fileId'],
    originalFilename: ref['originalFilename'],
    byteSize: ref['byteSize'],
  };
}

function frozenRows(payload: Record<string, unknown>, key: string, reportId: number): unknown[] {
  const value = payload[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT, '冻结快照清单字段类型异常', {
      reportId,
      key,
    });
  }
  return value;
}

/** 步骤稳定编码 STEP-{n} → 顺序号；非步骤新故障分支无顺序号 */
function stepNoFromStepCode(stepCode: string | null): number | null {
  if (stepCode === null) return null;
  const match = /^STEP-(\d+)$/.exec(stepCode);
  return match === null ? null : Number(match[1]);
}

/**
 * 工单总结冻结预览（2026-11-21 冻结读取需求）。
 *
 * 已正式提交的总结不再从当前工单拼装预览：页面展示与提交校验标识
 * 全部来自冻结版本 payload（与 Word/PDF 的 SAVED_VERSION 导出同一来源）。
 * 提交前的只读核对页仍读取当前工单（buildWorkOrderSummarySourcePreview）。
 * 原件仅为引用元数据，不冒称文件内容已被冻结。
 */
export function buildWorkOrderSummaryFrozenPreview(
  payload: Record<string, unknown>,
  reportId: number,
): WorkOrderSummarySourcePreviewView {
  const stepRows = frozenRows(payload, 'steps', reportId);
  const faultRows = frozenRows(payload, 'faults', reportId);
  return {
    customerCompanyName: frozenString(payload, 'customerFactoryName', reportId),
    handlingResult: frozenString(payload, 'handlingResult', reportId),
    closureReason: frozenString(payload, 'closureReason', reportId),
    maintenanceDate: frozenString(payload, 'maintenanceDate', reportId),
    engineerName: frozenString(payload, 'maintenanceEngineerName', reportId),
    resetResult: frozenString(payload, 'resetResult', reportId),
    supplementaryNote: frozenString(payload, 'supplementaryNote', reportId),
    attachment: frozenAttachmentRef(payload, 'sourceWorkOrderAttachment', reportId),
    intakeFaultDescription: frozenString(
      payload,
      'sourceWorkOrderIntakeFaultDescription',
      reportId,
    ),
    intakeCustomerFile: frozenAttachmentRef(payload, 'sourceWorkOrderIntakeCustomerFile', reportId),
    steps: stepRows.map((row) => {
      const step = row as Record<string, unknown>;
      const stepNo = step['stepNo'];
      if (typeof stepNo !== 'number') {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
          '冻结快照步骤缺少顺序号',
          { reportId },
        );
      }
      return {
        stepNo,
        errorCode: frozenString(step, 'errorCode', reportId),
        partName: frozenString(step, 'partName', reportId),
        actionText: frozenStringOrThrow(step, 'actionText', reportId),
        resultCode: frozenStringOrThrow(step, 'resultCode', reportId),
      };
    }),
    panels: faultRows.map((row) => {
      const panel = row as Record<string, unknown>;
      const description = frozenString(panel, 'description', reportId);
      if (description === null) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
          '冻结快照故障分支缺少描述',
          { reportId },
        );
      }
      return {
        panelType: frozenStringOrThrow(panel, 'branchKind', reportId),
        stepNo:
          frozenStringOrThrow(panel, 'branchKind', reportId) ===
          MaintenanceReportFaultBranchKind.STEP_NEW_FAULT.valueOf()
            ? stepNoFromStepCode(frozenString(panel, 'stepCode', reportId))
            : null,
        phaseCode: frozenString(panel, 'phaseCode', reportId),
        mainError: frozenString(panel, 'mainError', reportId),
        unitError: frozenString(panel, 'unitError', reportId),
        source: frozenString(panel, 'source', reportId),
        errorType: frozenString(panel, 'errorType', reportId),
        gpibStatus: frozenString(panel, 'gpibStatus', reportId),
        faultStatus: frozenString(panel, 'faultStatus', reportId),
        description,
        action: frozenString(panel, 'action', reportId),
      };
    }),
  };
}

/** 步骤新故障面板按 step_id 对应排查步骤的稳定顺序号；步骤缺失时面板被剔除 */
function resolvePanelStepNo(
  panel: { panelType: string; stepId: string | null },
  steps: Array<{ id: string; stepNo: number }>,
): number | null {
  // 工单故障面板类型与报告故障分支共用同一组字面量（DB CHECK 约束），
  // 这里按字符串比较避免跨枚举类型的 lint 误报
  if (panel.panelType !== MaintenanceReportFaultBranchKind.STEP_NEW_FAULT.valueOf()) return null;
  const stepId = panel.stepId;
  if (stepId === null) return null;
  return steps.find((step) => step.id === stepId)?.stepNo ?? null;
}

/**
 * 工单事实 → 报告草稿输入。
 *
 * - 步骤使用 `STEP-{stepNo}` 稳定编码；步骤新故障面板以步骤顺序号引用，
 *   由归一化器过滤"步骤结果不是新故障/步骤缺失"的失效分支；
 * - 报警清单为空（工单没有独立的报警清单事实）；
 * - AI 评价组由调用方按库内既有值回填（本函数不猜测模型来源）。
 */
export function buildWorkOrderSummaryDraftInput(
  facts: WorkOrderSummarySourceFacts,
): MaintenanceReportDraftInput {
  return {
    title: null,
    customerFactoryName: facts.customerCompanyName,
    equipmentModelId: facts.equipmentModelId,
    equipmentModelText: null,
    maintenanceDate: facts.maintenanceDate,
    handlingResult: facts.handlingResult,
    closureReason: facts.closureReason,
    resetResult: facts.resetResult,
    actualCause: null,
    repairActions: null,
    verificationResult: null,
    supplementaryNote: facts.supplementaryNote,
    alarms: [],
    steps: facts.steps.map((step) => ({
      stepCode: `STEP-${step.stepNo}`,
      phaseCode: null,
      partName: step.partName,
      actionText: step.actionText,
      // 工单排查步骤结果与报告步骤结果共用同一组字面量（DB CHECK 约束），
      // 这里按字符串比较避免跨枚举类型的 lint 误报
      resultCode:
        step.resultCode === MaintenanceReportStepResult.RESOLVED.valueOf() ||
        step.resultCode === MaintenanceReportStepResult.UNRESOLVED.valueOf() ||
        step.resultCode === MaintenanceReportStepResult.NEW_FAULT.valueOf()
          ? step.resultCode
          : null,
      errorCode: step.errorCode,
      resultText: null,
    })),
    faults: facts.panels.map((panel) => ({
      branchKind: panel.panelType,
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
    })),
  };
}

/** 工单总结不接受的内容字段清单（含表头/结果/报警/步骤/故障全部内容项） */
const WORK_ORDER_SUMMARY_CONTENT_FIELDS = [
  'title',
  'customerFactoryName',
  'equipmentModelId',
  'equipmentModelText',
  'maintenanceDate',
  'handlingResult',
  'closureReason',
  'resetResult',
  'actualCause',
  'repairActions',
  'verificationResult',
  'supplementaryNote',
  'alarms',
  'steps',
  'faults',
] as const;

/**
 * 工单总结不接受客户端重复填写的内容字段。
 *
 * 只读核对页面的保存/提交/导出不携带内容；客户端携带任何内容字段（含空值）
 * 都按 INVALID_PARAMS 拒绝，避免静默丢弃输入或混入工单之外的内容。
 */
export function assertNoWorkOrderSummaryClientContent(draft: MaintenanceReportDraftInput): void {
  const draftRecord = draft as unknown as Record<string, unknown>;
  const provided = collectProvidedFieldNames(draftRecord, WORK_ORDER_SUMMARY_CONTENT_FIELDS);
  if (provided.length > 0) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      '工单维修总结为只读核对：内容以服务端核验的工单事实为准，不接受重复填写',
      { fields: provided },
    );
  }
}

/**
 * 派生内容与库内草稿是否一致（版本变化检测）。
 *
 * 比对范围与冻结内容一致：表头/结果字段、报警、步骤（含稳定编码）、故障分支。
 * `updatedByAccountId` 与 AI 评价组不参与：修订检测只针对工单事实。
 */
export function isSameWorkOrderSummaryDraftContent(
  stored: MaintenanceReportDraftDetailView,
  derivedDraft: {
    title: string | null;
    customerFactoryName: string | null;
    equipmentModelId: number | null;
    equipmentModelText: string | null;
    maintenanceDate: string | null;
    handlingResult: string | null;
    closureReason: string | null;
    resetResult: string | null;
    actualCause: string | null;
    repairActions: string | null;
    verificationResult: string | null;
    supplementaryNote: string | null;
    alarms: unknown[];
    steps: Array<Record<string, unknown>>;
    faults: Array<Record<string, unknown>>;
  },
): boolean {
  const report = stored.report as unknown as Record<string, unknown>;
  const derived = derivedDraft as unknown as Record<string, unknown>;
  const headerFields = [
    'title',
    'customerFactoryName',
    'equipmentModelId',
    'equipmentModelText',
    'maintenanceDate',
    'handlingResult',
    'closureReason',
    'resetResult',
    'actualCause',
    'repairActions',
    'verificationResult',
    'supplementaryNote',
  ] as const;
  const allHeaderFieldsEqual = headerFields.every((field) => report[field] === derived[field]);
  if (!allHeaderFieldsEqual) return false;
  if (
    stored.alarms.length !== derivedDraft.alarms.length ||
    stored.steps.length !== derivedDraft.steps.length ||
    stored.faults.length !== derivedDraft.faults.length
  ) {
    return false;
  }
  const rowsDiffer = (
    storedRows: Array<Record<string, unknown>>,
    derivedRows: Array<Record<string, unknown>>,
    fields: readonly string[],
  ): boolean =>
    storedRows.some((storedRow, index) =>
      fields.some((field) => storedRow[field] !== derivedRows[index]?.[field]),
    );
  const stepFields = [
    'stepCode',
    'phaseCode',
    'partName',
    'actionText',
    'resultCode',
    'errorCode',
    'resultText',
    'newAlarmCode',
    'isValidNewBranch',
  ] as const;
  const faultFields = [
    'branchKind',
    'stepCode',
    'phaseCode',
    'mainError',
    'unitError',
    'source',
    'errorType',
    'gpibStatus',
    'faultStatus',
    'description',
    'action',
  ] as const;
  const storedStepRows = stored.steps as unknown as Array<Record<string, unknown>>;
  const storedFaultRows = stored.faults as unknown as Array<Record<string, unknown>>;
  return (
    !rowsDiffer(storedStepRows, derivedDraft.steps, stepFields) &&
    !rowsDiffer(storedFaultRows, derivedDraft.faults, faultFields)
  );
}
