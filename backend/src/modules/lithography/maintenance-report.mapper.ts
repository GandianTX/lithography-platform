// src/modules/lithography/maintenance-report.mapper.ts
// Entity → 域快照的纯映射，供写服务与查询服务共用。

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { MaintenanceReportFaultBranchKind } from '@app-types/models/maintenance-report.types';
import { MaintenanceReportAlarmEntity } from './entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportFaultEntity } from './entities/maintenance-report-fault.entity';
import { MaintenanceReportReviewEntity } from './entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from './entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from './entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import {
  MaintenanceReportAlarmSnapshot,
  MaintenanceReportAttachmentSnapshot,
  MaintenanceReportFaultSnapshot,
  MaintenanceReportReviewSnapshot,
  MaintenanceReportSnapshot,
  MaintenanceReportStepSnapshot,
  MaintenanceReportVersionAttachmentSnapshot,
  MaintenanceReportVersionSnapshot,
} from './maintenance-report.types';

export function toMaintenanceReportSnapshot(
  entity: MaintenanceReportEntity,
): MaintenanceReportSnapshot {
  return {
    id: entity.id,
    ownerOrganizationId: entity.ownerOrganizationId,
    sourceType: entity.sourceType as MaintenanceReportSnapshot['sourceType'],
    repairRequestId: entity.repairRequestId,
    title: entity.title,
    customerFactoryName: entity.customerFactoryName,
    equipmentModelId: entity.equipmentModelId,
    equipmentModelText: entity.equipmentModelText,
    maintenanceDate: entity.maintenanceDate,
    handlingResult: entity.handlingResult,
    closureReason: entity.closureReason,
    resetResult: entity.resetResult as MaintenanceReportSnapshot['resetResult'],
    actualCause: entity.actualCause,
    repairActions: entity.repairActions,
    verificationResult: entity.verificationResult,
    supplementaryNote: entity.supplementaryNote,
    maintenanceEngineerAccountId: entity.maintenanceEngineerAccountId,
    maintenanceEngineerNameSnapshot: entity.maintenanceEngineerNameSnapshot,
    phaseFlowVersion: entity.phaseFlowVersion,
    status: entity.status as MaintenanceReportSnapshot['status'],
    currentVersionNo: entity.currentVersionNo,
    submissionRequestId: entity.submissionRequestId,
    submissionPayloadHash: entity.submissionPayloadHash,
    lastSubmittedAt: entity.lastSubmittedAt,
    lastReviewedAt: entity.lastReviewedAt,
    aiUsage: entity.aiUsage as MaintenanceReportSnapshot['aiUsage'],
    aiSourceType: entity.aiSourceType,
    aiSourceId: entity.aiSourceId,
    aiSourceVersion: entity.aiSourceVersion,
    aiScore: entity.aiScore,
    aiCorrectness: entity.aiCorrectness as MaintenanceReportSnapshot['aiCorrectness'],
    aiHelpfulness: entity.aiHelpfulness,
    aiNote: entity.aiNote,
    createdByAccountId: entity.createdByAccountId,
    updatedByAccountId: entity.updatedByAccountId,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

export function toMaintenanceReportAlarmSnapshot(
  entity: MaintenanceReportAlarmEntity,
): MaintenanceReportAlarmSnapshot {
  return {
    id: entity.id,
    reportId: entity.reportId,
    alarmIndex: entity.alarmIndex,
    alarmCode: entity.alarmCode,
    alarmDescription: entity.alarmDescription,
    phaseCode: entity.phaseCode as MaintenanceReportAlarmSnapshot['phaseCode'],
    resetResult: entity.resetResult as MaintenanceReportAlarmSnapshot['resetResult'],
  };
}

export function toMaintenanceReportStepSnapshot(
  entity: MaintenanceReportStepEntity,
): MaintenanceReportStepSnapshot {
  return {
    id: entity.id,
    reportId: entity.reportId,
    stepNo: entity.stepNo,
    stepCode: entity.stepCode,
    phaseCode: entity.phaseCode as MaintenanceReportStepSnapshot['phaseCode'],
    partName: entity.partName,
    actionText: entity.actionText,
    resultCode: entity.resultCode as MaintenanceReportStepSnapshot['resultCode'],
    errorCode: entity.errorCode,
    resultText: entity.resultText,
    newAlarmCode: entity.newAlarmCode,
    isValidNewBranch: entity.isValidNewBranch,
  };
}

/**
 * 报告故障分支「领域枚举 ↔ 数据库 CHECK 值」双向映射。
 *
 * 已接受迁移 1775501300000 的 CHECK `chk_maintenance_report_fault_branch`
 * 只允许 `INITIAL_PANEL / NEW_FAULT_BRANCH / STEP_NEW_FAULT`；而与前端面板、
 * 工单故障面板一致的领域枚举 `MaintenanceReportFaultBranchKind` 为
 * `INITIAL / RESET_NEW_FAULT / STEP_NEW_FAULT`。写入与读取都在模块层显式
 * 转换，保持数据库约束不变；未知值失败关闭，不静默透传。
 */
const FAULT_BRANCH_KIND_DB_BY_DOMAIN: Readonly<
  Record<MaintenanceReportFaultBranchKind, 'INITIAL_PANEL' | 'NEW_FAULT_BRANCH' | 'STEP_NEW_FAULT'>
> = {
  [MaintenanceReportFaultBranchKind.INITIAL]: 'INITIAL_PANEL',
  [MaintenanceReportFaultBranchKind.RESET_NEW_FAULT]: 'NEW_FAULT_BRANCH',
  [MaintenanceReportFaultBranchKind.STEP_NEW_FAULT]: 'STEP_NEW_FAULT',
} as const;

const FAULT_BRANCH_KIND_DOMAIN_BY_DB: Readonly<
  Record<'INITIAL_PANEL' | 'NEW_FAULT_BRANCH' | 'STEP_NEW_FAULT', MaintenanceReportFaultBranchKind>
> = {
  INITIAL_PANEL: MaintenanceReportFaultBranchKind.INITIAL,
  NEW_FAULT_BRANCH: MaintenanceReportFaultBranchKind.RESET_NEW_FAULT,
  STEP_NEW_FAULT: MaintenanceReportFaultBranchKind.STEP_NEW_FAULT,
} as const;

export type MaintenanceReportFaultBranchKindDb = keyof typeof FAULT_BRANCH_KIND_DOMAIN_BY_DB;

export function faultBranchKindToDb(
  kind: MaintenanceReportFaultBranchKind,
): MaintenanceReportFaultBranchKindDb {
  const dbKind = FAULT_BRANCH_KIND_DB_BY_DOMAIN[kind];
  if (dbKind === undefined) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
      '报告故障分支类型不在已知领域枚举内',
      { branchKind: String(kind) },
    );
  }
  return dbKind;
}

export function faultBranchKindFromDb(dbKind: string): MaintenanceReportFaultBranchKind {
  const domainKind = FAULT_BRANCH_KIND_DOMAIN_BY_DB[dbKind as MaintenanceReportFaultBranchKindDb];
  if (domainKind === undefined) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
      '报告故障分支数据库值不在已知映射内',
      { branchKind: String(dbKind) },
    );
  }
  return domainKind;
}

export function toMaintenanceReportFaultSnapshot(
  entity: MaintenanceReportFaultEntity,
): MaintenanceReportFaultSnapshot {
  return {
    id: entity.id,
    reportId: entity.reportId,
    faultUuid: entity.faultUuid,
    branchKind: faultBranchKindFromDb(entity.branchKind),
    stepCode: entity.stepCode,
    phaseCode: entity.phaseCode as MaintenanceReportFaultSnapshot['phaseCode'],
    mainError: entity.mainError,
    unitError: entity.unitError,
    source: entity.source,
    errorType: entity.errorType,
    gpibStatus: entity.gpibStatus,
    faultStatus: entity.status,
    description: entity.faultDescription,
    action: entity.handlingAction,
  };
}

export function toMaintenanceReportAttachmentSnapshot(
  entity: MaintenanceReportAttachmentEntity,
): MaintenanceReportAttachmentSnapshot {
  return {
    id: entity.id,
    reportId: entity.reportId,
    fileId: entity.fileId,
    originalFilename: entity.originalFilename,
    mimeType: entity.mimeType,
    byteSize: Number(entity.byteSize),
    checksumSha256: entity.checksumSha256,
    storageBackend: entity.storageBackend as MaintenanceReportAttachmentSnapshot['storageBackend'],
    storageReference: entity.storageReference,
    sortOrder: entity.sortOrder,
    description: entity.description,
    status: entity.status as MaintenanceReportAttachmentSnapshot['status'],
    uploadedByAccountId: entity.uploadedByAccountId,
    retiredAt: entity.retiredAt,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

export function toMaintenanceReportVersionSnapshot(
  entity: MaintenanceReportVersionEntity,
): MaintenanceReportVersionSnapshot {
  return {
    id: entity.id,
    reportId: entity.reportId,
    versionNo: entity.versionNo,
    changeKind: entity.changeKind as MaintenanceReportVersionSnapshot['changeKind'],
    changeReason: entity.changeReason,
    schemaVersion: entity.schemaVersion,
    payloadSnapshot: entity.payloadSnapshot,
    submittedByAccountId: entity.submittedByAccountId,
    submittedAt: entity.submittedAt,
    createdAt: entity.createdAt,
  };
}

export function toMaintenanceReportVersionAttachmentSnapshot(
  entity: MaintenanceReportVersionAttachmentEntity,
): MaintenanceReportVersionAttachmentSnapshot {
  return {
    versionId: entity.versionId,
    attachmentId: entity.attachmentId,
    reportId: entity.reportId,
    sortOrder: entity.sortOrder,
    descriptionSnapshot: entity.descriptionSnapshot,
    publishFlag: entity.publishFlag,
  };
}

export function toMaintenanceReportReviewSnapshot(
  entity: MaintenanceReportReviewEntity,
): MaintenanceReportReviewSnapshot {
  return {
    id: entity.id,
    reportId: entity.reportId,
    versionId: entity.versionId,
    decision: entity.decision as MaintenanceReportReviewSnapshot['decision'],
    comment: entity.comment,
    reviewedByAccountId: entity.reviewedByAccountId,
    reviewedAt: entity.reviewedAt,
  };
}
