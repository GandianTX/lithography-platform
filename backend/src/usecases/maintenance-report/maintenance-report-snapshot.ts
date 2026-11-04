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
  }>;
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
    maintenanceDate: report.maintenanceDate ?? '',
    maintenanceEngineerAccountId: report.maintenanceEngineerAccountId,
    maintenanceEngineerName: report.maintenanceEngineerNameSnapshot,
    phaseFlowVersion: report.phaseFlowVersion,
    alarms: alarms.map(toAlarmPayload),
    steps: steps.map(toStepPayload),
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
    resultText: step.resultText,
    newAlarmCode: step.newAlarmCode,
    isValidNewBranch: step.isValidNewBranch,
  };
}

/**
 * 报告 AI 使用与引用事实的最小校验输入（usecase 从报告快照装配）。
 */
export type MaintenanceReportAiReferenceFacts = Pick<
  MaintenanceReportSnapshot,
  'ownerOrganizationId' | 'repairRequestId' | 'aiUsage'
>;
