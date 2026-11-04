// src/modules/lithography/maintenance-report.mapper.ts
// Entity → 域快照的纯映射，供写服务与查询服务共用。

import { MaintenanceReportAlarmEntity } from './entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportReviewEntity } from './entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from './entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from './entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import {
  MaintenanceReportAlarmSnapshot,
  MaintenanceReportAttachmentSnapshot,
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
    maintenanceEngineerAccountId: entity.maintenanceEngineerAccountId,
    maintenanceEngineerNameSnapshot: entity.maintenanceEngineerNameSnapshot,
    phaseFlowVersion: entity.phaseFlowVersion,
    status: entity.status as MaintenanceReportSnapshot['status'],
    currentVersionNo: entity.currentVersionNo,
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
    resultText: entity.resultText,
    newAlarmCode: entity.newAlarmCode,
    isValidNewBranch: entity.isValidNewBranch,
  };
}

export function toMaintenanceReportAttachmentSnapshot(
  entity: MaintenanceReportAttachmentEntity,
): MaintenanceReportAttachmentSnapshot {
  return {
    id: entity.id,
    reportId: entity.reportId,
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
