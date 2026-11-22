// src/usecases/reference-document/reference-document-effective-content.ts

import type {
  ReferenceDocumentContentSource,
  ReferenceDocumentFrozenReportView,
} from '@src/modules/lithography/lithography.types';
import type { MaintenanceReportVersionSnapshot } from '@src/modules/lithography/maintenance-report.types';

/**
 * 参考资料生效正文解析（任务 07）。
 *
 * 读取口径：
 * - 存在管理修订（effectiveRevisionNo > 0）：读修订后正文，来源 CURRENT_REVISION；
 * - 报告来源且无管理修订：读原始冻结报告版本快照，来源 FROZEN_REPORT；
 * - 其余：读资料自身正文，来源 ORIGINAL（合法无附件资料的正文即此处）。
 *
 * 只读取白名单键，不透传原始 JSON；缺键按空值输出（历史快照 schema 差异不阻断读取）。
 */

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableBoolean(value: unknown): boolean {
  return value === true;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 冻结报告快照（payload_snapshot）→ 对外只读视图；结构缺失按空值降级，不阻断列表读取 */
export function parseFrozenReportVersion(
  version: MaintenanceReportVersionSnapshot,
): ReferenceDocumentFrozenReportView {
  const payload = asRecord(version.payloadSnapshot);
  const ai = asRecord(payload.ai);
  return {
    versionId: version.id,
    versionNo: version.versionNo,
    schemaVersion: version.schemaVersion,
    submittedAt: version.submittedAt,
    sourceType: asText(payload.sourceType),
    repairRequestId: asNullableNumber(payload.repairRequestId),
    title: asText(payload.title),
    customerFactoryName: asText(payload.customerFactoryName),
    equipmentModelId: asNullableNumber(payload.equipmentModelId),
    equipmentModelText: asNullableText(payload.equipmentModelText),
    maintenanceDate: asText(payload.maintenanceDate),
    maintenanceEngineerName: asText(payload.maintenanceEngineerName),
    alarms: asArray(payload.alarms).map((item) => {
      const alarm = asRecord(item);
      return {
        alarmIndex: asNullableNumber(alarm.alarmIndex) ?? 0,
        alarmCode: asText(alarm.alarmCode),
        alarmDescription: asNullableText(alarm.alarmDescription),
        phaseCode: asText(alarm.phaseCode),
        resetResult: asText(alarm.resetResult),
      };
    }),
    steps: asArray(payload.steps).map((item) => {
      const step = asRecord(item);
      return {
        stepNo: asNullableNumber(step.stepNo) ?? 0,
        stepCode: asText(step.stepCode),
        phaseCode: asText(step.phaseCode),
        partName: asNullableText(step.partName),
        actionText: asText(step.actionText),
        resultText: asNullableText(step.resultText),
        newAlarmCode: asNullableText(step.newAlarmCode),
        isValidNewBranch: asNullableBoolean(step.isValidNewBranch),
      };
    }),
    // 任务 07 管理修订（加法式扩展）：任务 06 快照扩展键的结构化展示视图；
    // 任务 04 旧快照缺键按空值降级，未知键忽略，不阻断既有展示。
    faults: asArray(payload.faults).map((item) => {
      const fault = asRecord(item);
      return {
        branchKind: asText(fault.branchKind),
        stepCode: asNullableText(fault.stepCode),
        phaseCode: asNullableText(fault.phaseCode),
        mainError: asNullableText(fault.mainError),
        unitError: asNullableText(fault.unitError),
        source: asNullableText(fault.source),
        errorType: asNullableText(fault.errorType),
        gpibStatus: asNullableText(fault.gpibStatus),
        faultStatus: asNullableText(fault.faultStatus),
        description: asText(fault.description),
        action: asNullableText(fault.action),
      };
    }),
    handlingResult: asNullableText(payload.handlingResult),
    closureReason: asNullableText(payload.closureReason),
    resetResult: asNullableText(payload.resetResult),
    actualCause: asNullableText(payload.actualCause),
    repairActions: asNullableText(payload.repairActions),
    verificationResult: asNullableText(payload.verificationResult),
    supplementaryNote: asNullableText(payload.supplementaryNote),
    ai: {
      usage: asText(ai.usage),
      sourceType: asNullableText(ai.sourceType),
      sourceId: asNullableText(ai.sourceId),
      sourceVersion: asNullableText(ai.sourceVersion),
      score: asNullableNumber(ai.score),
      correctness: asNullableText(ai.correctness),
      helpfulness: asNullableNumber(ai.helpfulness),
      note: asNullableText(ai.note),
    },
  };
}

/** 生效正文文本：冻结报告按块拼装为可读纯文本，供文本视图与检索复用 */
export function composeFrozenReportText(report: ReferenceDocumentFrozenReportView): string {
  const lines: string[] = [];
  if (report.title) lines.push(`报告标题：${report.title}`);
  if (report.customerFactoryName) lines.push(`客户厂家：${report.customerFactoryName}`);
  if (report.maintenanceDate) lines.push(`维修日期：${report.maintenanceDate}`);
  if (report.maintenanceEngineerName) lines.push(`维修工程师：${report.maintenanceEngineerName}`);
  const equipment = report.equipmentModelText;
  if (equipment) lines.push(`适用机型：${equipment}`);
  if (report.alarms.length > 0) {
    lines.push('', '初始报警：');
    for (const alarm of report.alarms) {
      const description = alarm.alarmDescription ? ` ${alarm.alarmDescription}` : '';
      lines.push(
        `${alarm.alarmIndex}. ${alarm.alarmCode}${description}（${alarm.phaseCode}，复位：${alarm.resetResult}）`,
      );
    }
  }
  if (report.steps.length > 0) {
    lines.push('', '排查步骤：');
    for (const step of report.steps) {
      const part = step.partName ? `［${step.partName}］` : '';
      const result = step.resultText ? `；结果：${step.resultText}` : '';
      lines.push(`${step.stepNo}. ${step.phaseCode}${part} ${step.actionText}${result}`);
    }
  }
  if (report.ai.usage) {
    lines.push('', `AI 使用：${report.ai.usage}`);
    if (report.ai.note) lines.push(`AI 说明：${report.ai.note}`);
  }
  return lines.join('\n');
}

/**
 * 管理修订快照 → 生效正文。
 * `after_snapshot` 只读取内容键（contentText / title），未知键原样忽略。
 */
export function readRevisionContentText(snapshot: Record<string, unknown>): string | null {
  const contentText = snapshot.contentText;
  if (typeof contentText === 'string') return contentText;
  return null;
}

/** 生效正文来源决议：管理修订优先于原始冻结报告，最后回落到资料正文 */
export function resolveContentSource(params: {
  effectiveRevisionNo: number;
  sourceKind: string;
  sourceReportVersionId: number | null;
}): ReferenceDocumentContentSource {
  if (params.effectiveRevisionNo > 0) return 'CURRENT_REVISION';
  if (
    params.sourceReportVersionId !== null &&
    (params.sourceKind === 'INDEPENDENT_REPORT' || params.sourceKind === 'WORK_ORDER_SUMMARY')
  ) {
    return 'FROZEN_REPORT';
  }
  return 'ORIGINAL';
}
