// src/usecases/maintenance-report/maintenance-report-snapshot.ts
// 维修报告 v2 冻结快照构建与送审完整校验。
//
// 冻结快照（payload_snapshot）只包含内容事实：报告基本信息、初始八项报警、
// 排查步骤、AI 使用与评价。附件清单单独落在 version_attachment（受复合外键约束），
// 二者共同构成一次提交的不可变证据；不混入内部存储引用、组织或状态列。

import {
  MAINTENANCE_ATTACHMENT_MAX_COUNT,
  MAINTENANCE_REPORT_SNAPSHOT_SCHEMA_VERSION,
  MaintenanceAiUsage,
  MaintenanceReportSourceType,
} from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { isBlankText } from '@core/common/text/text.helper';
import type {
  MaintenanceReportAlarmSnapshot,
  MaintenanceReportDraftDetailView,
  MaintenanceReportFaultSnapshot,
  MaintenanceReportSnapshot,
  MaintenanceReportStepSnapshot,
} from '@src/modules/lithography/maintenance-report.types';

export type MaintenanceReportSnapshotPayloadV2 = {
  schemaVersion: typeof MAINTENANCE_REPORT_SNAPSHOT_SCHEMA_VERSION;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string;
  customerFactoryName: string;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  /**
   * 任务 06 机型冻结语义修复（加法式扩展，schemaVersion 保持 2）：
   * 提交事务内按机型库解析的机型显示名随快照冻结；旧快照缺此键，
   * 导出/查看旧版本时按现行 ID 解析回落（不伪造历史值）。
   */
  equipmentModelName?: string | null;
  maintenanceDate: string;
  maintenanceEngineerAccountId: number;
  maintenanceEngineerName: string;
  phaseFlowVersion: number;
  alarms: Array<{
    alarmIndex: number;
    alarmCode: string;
    alarmDescription: string | null;
    phaseCode: string;
    resetResult: string;
  }>;
  steps: Array<{
    stepNo: number;
    stepCode: string;
    phaseCode: string;
    partName: string | null;
    actionText: string;
    resultText: string | null;
    newAlarmCode: string | null;
    isValidNewBranch: boolean;
    /**
     * 任务 06 扩展（加法式扩展，schemaVersion 保持 2）：
     * 步骤结果码随冻结快照入库；旧快照缺键在冻结预览侧按数据不定式失败关闭。
     */
    resultCode?: string | null;
  }>;
  /**
   * 任务 06 扩展（加法式扩展，schemaVersion 保持 2）：
   * 有效故障分支与结果/说明字段随冻结快照入库；
   * 旧读取方按未知键忽略，不破坏任务 04 既有冻结版本。
   */
  faults?: Array<{
    branchKind: string;
    stepCode: string | null;
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
  handlingResult?: string | null;
  closureReason?: string | null;
  resetResult?: string | null;
  actualCause?: string | null;
  repairActions?: string | null;
  verificationResult?: string | null;
  supplementaryNote?: string | null;
  ai: {
    usage: MaintenanceAiUsage;
    sourceType: string | null;
    sourceId: string | null;
    sourceVersion: string | null;
    score: number | null;
    correctness: string | null;
    helpfulness: number | null;
    note: string | null;
  };
  /**
   * 任务 06 工单总结（加法式扩展，schemaVersion 保持 2）：
   * 冻结时来源工单的修订版本与来源原件引用元数据（provenance）。
   * 仅为引用记录，不冒称原件内容已随报告冻结；历史案例与旧快照无此键。
   */
  sourceWorkOrderRevisionNo?: number | null;
  sourceWorkOrderAttachment?: {
    fileId: string;
    originalFilename: string;
    byteSize: number;
  } | null;
  /**
   * 任务 06 扩展（加法式扩展，schemaVersion 保持 2）：
   * 冻结时核验通过的来源确认指纹与客户报修事实引用。
   * 指纹用于「首提响应丢失后同标识原请求重试」的冻结侧核对——
   * 重试不得依赖修订后的当前工单重新计算原请求；报修描述与报修原件
   * 仅为引用元数据（不复制/不改绑原件文件），供冻结预览展示。
   * 历史案例与旧快照无这些键。
   */
  sourceWorkOrderConfirmationFingerprint?: string;
  sourceWorkOrderIntakeFaultDescription?: string | null;
  sourceWorkOrderIntakeCustomerFile?: {
    fileId: string;
    originalFilename: string;
    byteSize: number;
  } | null;
};

function incomplete(message: string, details?: Record<string, unknown>): never {
  throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, message, details);
}

function requireText(value: string | null, fieldName: string): string {
  if (value === null || isBlankText(value)) {
    incomplete(`提交前必须填写${fieldName}`, { fieldName });
  }
  return value;
}

/**
 * 送审完整校验：在报告行锁内、基于真实落库事实判定。
 *
 * 仅本函数通过后才允许生成冻结版本，任何缺项都在写入前失败关闭。
 */
export function assertMaintenanceReportSubmittable(draft: MaintenanceReportDraftDetailView): void {
  const { report, alarms, steps } = draft;
  requireText(report.title, '报告标题');
  requireText(report.customerFactoryName, '客户厂家');
  if (isBlankText(report.maintenanceDate)) {
    incomplete('提交前必须填写维修日期', { fieldName: 'maintenanceDate' });
  }
  if (alarms.length > 8) {
    incomplete('报警项最多 8 项', { count: alarms.length });
  }
  if (steps.length === 0) {
    incomplete('提交前至少需要一条排查步骤');
  }
  if (draft.attachments.length > MAINTENANCE_ATTACHMENT_MAX_COUNT) {
    incomplete(`当前附件最多 ${MAINTENANCE_ATTACHMENT_MAX_COUNT} 个`, {
      count: draft.attachments.length,
    });
  }
  if (
    report.aiUsage === MaintenanceAiUsage.USED &&
    (!report.aiSourceType || !report.aiSourceId || !report.aiSourceVersion)
  ) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REFERENCE_REQUIRED,
      '已使用 AI 时必须提供分析结果来源、稳定标识与不可变版本',
    );
  }
}

/**
 * 构建 v2 冻结快照。
 *
 * 调用方必须已通过 `assertMaintenanceReportSubmittable`；本函数按真实落库值
 * 枚举输出，不读取也未定义的扩展键（v1 空扩展位保持不扩键）。
 */
export function buildMaintenanceReportSnapshotPayload(
  draft: MaintenanceReportDraftDetailView,
  /** 工单总结来源事实（可选）：写入来源修订版本、原件引用与冻结核对扩展键 */
  source?: {
    sourceWorkOrderRevisionNo: number | null;
    sourceWorkOrderAttachment: {
      fileId: string;
      originalFilename: string;
      byteSize: number;
    } | null;
    sourceWorkOrderConfirmationFingerprint: string;
    sourceWorkOrderIntakeFaultDescription: string | null;
    sourceWorkOrderIntakeCustomerFile: {
      fileId: string;
      originalFilename: string;
      byteSize: number;
    } | null;
  },
  /**
   * 机型冻结语义（可选）：提交事务内解析的机型显示名；传 undefined 时
   * 不写键（任务 04 夹具与旧调用方快照输出不变）。
   */
  equipmentModelName?: string | null,
): MaintenanceReportSnapshotPayloadV2 {
  const { report, alarms, steps } = draft;
  return {
    schemaVersion: MAINTENANCE_REPORT_SNAPSHOT_SCHEMA_VERSION,
    sourceType: report.sourceType,
    repairRequestId: report.repairRequestId,
    title: report.title ?? '',
    customerFactoryName: report.customerFactoryName ?? '',
    equipmentModelId: report.equipmentModelId,
    equipmentModelText: report.equipmentModelText,
    ...(equipmentModelName === undefined ? {} : { equipmentModelName }),
    maintenanceDate: report.maintenanceDate ?? '',
    maintenanceEngineerAccountId: report.maintenanceEngineerAccountId,
    maintenanceEngineerName: report.maintenanceEngineerNameSnapshot,
    phaseFlowVersion: report.phaseFlowVersion,
    alarms: alarms.map(toAlarmPayload),
    steps: steps.map(toStepPayload),
    // 容忍未带 faults 的旧调用方（任务 04 夹具/兼容路径）：缺省为空数组，
    // 保证任务 04 快照输出不变
    faults: (draft.faults ?? []).map(toFaultPayload),
    handlingResult: report.handlingResult,
    closureReason: report.closureReason,
    resetResult: report.resetResult,
    actualCause: report.actualCause,
    repairActions: report.repairActions,
    verificationResult: report.verificationResult,
    supplementaryNote: report.supplementaryNote,
    ai: {
      usage: report.aiUsage,
      sourceType: report.aiSourceType,
      sourceId: report.aiSourceId,
      sourceVersion: report.aiSourceVersion,
      score: report.aiScore,
      correctness: report.aiCorrectness,
      helpfulness: report.aiHelpfulness,
      note: report.aiNote,
    },
    ...(source === undefined
      ? {}
      : {
          sourceWorkOrderRevisionNo: source.sourceWorkOrderRevisionNo,
          sourceWorkOrderAttachment: source.sourceWorkOrderAttachment,
          sourceWorkOrderConfirmationFingerprint: source.sourceWorkOrderConfirmationFingerprint,
          sourceWorkOrderIntakeFaultDescription: source.sourceWorkOrderIntakeFaultDescription,
          sourceWorkOrderIntakeCustomerFile: source.sourceWorkOrderIntakeCustomerFile,
        }),
  };
}

function toAlarmPayload(alarm: MaintenanceReportAlarmSnapshot) {
  return {
    alarmIndex: alarm.alarmIndex,
    alarmCode: alarm.alarmCode,
    alarmDescription: alarm.alarmDescription,
    phaseCode: alarm.phaseCode,
    resetResult: alarm.resetResult,
  };
}

function toStepPayload(step: MaintenanceReportStepSnapshot) {
  return {
    stepNo: step.stepNo,
    stepCode: step.stepCode,
    phaseCode: step.phaseCode,
    partName: step.partName,
    actionText: step.actionText,
    // 2026-11-21：步骤报错代码此前未进冻结快照，导致预览有、Word/PDF 无；
    // 加法式补键，旧快照缺键在导出侧按 null 兼容。
    errorCode: step.errorCode,
    resultText: step.resultText,
    newAlarmCode: step.newAlarmCode,
    isValidNewBranch: step.isValidNewBranch,
    // 2026-11-21（冻结读取）：步骤结果码随快照入库，冻结预览不再回读当前工单
    resultCode: step.resultCode,
  };
}

function toFaultPayload(fault: MaintenanceReportFaultSnapshot) {
  return {
    branchKind: fault.branchKind,
    stepCode: fault.stepCode,
    phaseCode: fault.phaseCode,
    mainError: fault.mainError,
    unitError: fault.unitError,
    source: fault.source,
    errorType: fault.errorType,
    gpibStatus: fault.gpibStatus,
    faultStatus: fault.faultStatus,
    description: fault.description,
    action: fault.action,
  };
}

/**
 * 报告 AI 使用与引用事实的最小校验输入（usecase 从报告快照装配）。
 */
export type MaintenanceReportAiReferenceFacts = Pick<
  MaintenanceReportSnapshot,
  'ownerOrganizationId' | 'repairRequestId' | 'aiUsage'
>;
