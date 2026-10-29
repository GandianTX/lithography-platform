// src/modules/lithography/maintenance-report.types.ts
// 维修报告域写模型与读模型（模块层内部契约，不含 GraphQL 装饰器）。

import {
  MaintenanceAiCorrectness,
  MaintenanceAiUsage,
  MaintenanceAlarmResetResult,
  MaintenanceAttachmentStatus,
  MaintenanceAttachmentStorageBackend,
  MaintenancePhaseCode,
  MaintenanceReportChangeKind,
  MaintenanceReportReviewDecision,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
} from '@app-types/models/maintenance-report.types';

export type MaintenanceReportAlarmWriteData = {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: MaintenancePhaseCode;
  resetResult: MaintenanceAlarmResetResult;
};

export type MaintenanceReportStepWriteData = {
  stepNo: number;
  stepCode: string;
  phaseCode: MaintenancePhaseCode;
  partName: string | null;
  actionText: string;
  resultText: string | null;
  newAlarmCode: string | null;
  isValidNewBranch: boolean;
};

export type MaintenanceReportInsertData = {
  ownerOrganizationId: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  maintenanceEngineerAccountId: number;
  maintenanceEngineerNameSnapshot: string;
  phaseFlowVersion: number;
  createdByAccountId: number;
  updatedByAccountId: number;
};

export type MaintenanceReportDraftWriteData = {
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  aiUsage: MaintenanceAiUsage;
  aiSourceType: string | null;
  aiSourceId: string | null;
  aiSourceVersion: string | null;
  aiScore: number | null;
  aiCorrectness: MaintenanceAiCorrectness | null;
  aiHelpfulness: number | null;
  aiNote: string | null;
  alarms: MaintenanceReportAlarmWriteData[];
  steps: MaintenanceReportStepWriteData[];
  updatedByAccountId: number;
};

export type MaintenanceReportAttachmentInsertData = {
  reportId: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string | null;
  storageBackend: MaintenanceAttachmentStorageBackend;
  storageReference: string;
  sortOrder: number;
  description: string | null;
  uploadedByAccountId: number;
};

export type MaintenanceReportVersionInsertData = {
  reportId: number;
  versionNo: number;
  changeKind: MaintenanceReportChangeKind;
  changeReason: string | null;
  payloadSnapshot: Record<string, unknown>;
  submittedByAccountId: number;
  submittedAt: Date;
};

export type MaintenanceReportVersionAttachmentWriteData = {
  attachmentId: number;
  sortOrder: number;
  descriptionSnapshot: string | null;
};

export type MaintenanceReportReviewInsertData = {
  reportId: number;
  versionId: number;
  decision: MaintenanceReportReviewDecision;
  comment: string | null;
  reviewedByAccountId: number;
  reviewedAt: Date;
};

export type MaintenanceReportSnapshot = {
  id: number;
  ownerOrganizationId: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string | null;
  maintenanceEngineerAccountId: number;
  maintenanceEngineerNameSnapshot: string;
  phaseFlowVersion: number;
  status: MaintenanceReportStatus;
  currentVersionNo: number;
  lastSubmittedAt: Date | null;
  lastReviewedAt: Date | null;
  aiUsage: MaintenanceAiUsage;
  aiSourceType: string | null;
  aiSourceId: string | null;
  aiSourceVersion: string | null;
  aiScore: number | null;
  aiCorrectness: MaintenanceAiCorrectness | null;
  aiHelpfulness: number | null;
  aiNote: string | null;
  createdByAccountId: number;
  updatedByAccountId: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MaintenanceReportAlarmSnapshot = {
  id: number;
  reportId: number;
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: MaintenancePhaseCode;
  resetResult: MaintenanceAlarmResetResult;
};

export type MaintenanceReportStepSnapshot = {
  id: number;
  reportId: number;
  stepNo: number;
  stepCode: string;
  phaseCode: MaintenancePhaseCode;
  partName: string | null;
  actionText: string;
  resultText: string | null;
  newAlarmCode: string | null;
  isValidNewBranch: boolean;
};

export type MaintenanceReportAttachmentSnapshot = {
  id: number;
  reportId: number;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string | null;
  storageBackend: MaintenanceAttachmentStorageBackend;
  storageReference: string;
  sortOrder: number;
  description: string | null;
  status: MaintenanceAttachmentStatus;
  uploadedByAccountId: number;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MaintenanceReportVersionAttachmentSnapshot = {
  versionId: number;
  attachmentId: number;
  reportId: number;
  sortOrder: number;
  descriptionSnapshot: string | null;
  publishFlag: boolean;
};

export type MaintenanceReportVersionSnapshot = {
  id: number;
  reportId: number;
  versionNo: number;
  changeKind: MaintenanceReportChangeKind;
  changeReason: string | null;
  schemaVersion: number;
  payloadSnapshot: Record<string, unknown>;
  submittedByAccountId: number;
  submittedAt: Date;
  createdAt: Date;
};

export type MaintenanceReportReviewSnapshot = {
  id: number;
  reportId: number;
  versionId: number;
  decision: MaintenanceReportReviewDecision;
  comment: string | null;
  reviewedByAccountId: number;
  reviewedAt: Date;
};

/** 工单写路径需要的最小事实（不泄露客户联系方式） */
export type RepairRequestWriteContext = {
  id: number;
  customerAccountId: number;
  acceptedEngineerAccountId: number | null;
  isAccepted: boolean;
  deprecated: boolean;
  ownerOrganizationId: number | null;
  handlingResult: string | null;
  handlingStatus: string | null;
};

export type MaintenanceReportDraftDetailView = {
  report: MaintenanceReportSnapshot;
  alarms: MaintenanceReportAlarmSnapshot[];
  steps: MaintenanceReportStepSnapshot[];
  attachments: MaintenanceReportAttachmentSnapshot[];
  latestReturnComment: string | null;
};

export type MaintenanceReportReviewDetailView = {
  report: MaintenanceReportSnapshot;
  version: MaintenanceReportVersionSnapshot;
  versionAttachments: MaintenanceReportVersionAttachmentSnapshot[];
  review: MaintenanceReportReviewSnapshot | null;
  /** 历史版本审核记录（按审核时间升序） */
  reviewHistory: MaintenanceReportReviewSnapshot[];
};

/** 完整报告详情（本人/审核共用装配；权限由 usecase 先行裁决） */
export type MaintenanceReportDetailView = {
  report: MaintenanceReportSnapshot;
  /** 工作态草稿内容（报警/步骤/当前附件） */
  alarms: MaintenanceReportAlarmSnapshot[];
  steps: MaintenanceReportStepSnapshot[];
  currentAttachments: MaintenanceReportAttachmentSnapshot[];
  latestReturnComment: string | null;
  /** 当前冻结版本；currentVersionNo=0 时为 null */
  currentVersion: MaintenanceReportVersionSnapshot | null;
  currentVersionAttachments: MaintenanceReportVersionAttachmentSnapshot[];
  currentReview: MaintenanceReportReviewSnapshot | null;
  reviewHistory: MaintenanceReportReviewSnapshot[];
  /** 是否处于可编辑状态（DRAFT/RETURNED） */
  canEdit: boolean;
};

export type MaintenanceReportSummaryView = {
  id: number;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  title: string | null;
  status: MaintenanceReportStatus;
  currentVersionNo: number;
  maintenanceDate: string | null;
  maintenanceEngineerAccountId: number;
  updatedAt: Date;
};
