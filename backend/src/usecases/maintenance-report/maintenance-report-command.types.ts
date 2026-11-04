// src/usecases/maintenance-report/maintenance-report-command.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { MaintenanceReportDraftWriteData } from '@src/modules/lithography/maintenance-report.types';

export type MaintenanceReportAlarmInput = {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription?: string | null;
  phaseCode: string;
  resetResult: string;
};

export type MaintenanceReportStepInput = {
  stepCode: string;
  phaseCode: string;
  partName?: string | null;
  actionText: string;
  resultText?: string | null;
  newAlarmCode?: string | null;
  isValidNewBranch?: boolean;
};

export type MaintenanceReportDraftInput = {
  title?: string | null;
  customerFactoryName?: string | null;
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  maintenanceDate?: string | null;
  alarms?: MaintenanceReportAlarmInput[];
  steps?: MaintenanceReportStepInput[];
  aiUsage?: string;
  aiSourceType?: string | null;
  aiSourceId?: string | null;
  aiSourceVersion?: string | null;
  aiScore?: number | null;
  aiCorrectness?: string | null;
  aiHelpfulness?: number | null;
  aiNote?: string | null;
};

export type CreateMaintenanceReportCommand = {
  session: UsecaseSession;
  sourceType: string;
  repairRequestId?: number | null;
  draft: MaintenanceReportDraftInput;
};

export type UpdateMaintenanceReportDraftCommand = {
  session: UsecaseSession;
  reportId: number;
  draft: MaintenanceReportDraftInput;
};

export type SubmitMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
};

export type ReviewMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
  comment?: string | null;
};

export type ApproveMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
  comment?: string | null;
  publishedAttachmentIds?: number[];
};

export type MaintenanceReportDraftWriteResult = {
  reportId: number;
  draft: MaintenanceReportDraftWriteData;
};

export type MaintenanceReportPagination = {
  page: number;
  pageSize: number;
  withTotal?: boolean;
};

export type GetMaintenanceReportCommand = {
  session: UsecaseSession;
  reportId: number;
};

export type ListMyMaintenanceReportsCommand = {
  session: UsecaseSession;
  pagination?: MaintenanceReportPagination;
};

export type ListMaintenanceReportReviewQueueCommand = {
  session: UsecaseSession;
  pagination?: MaintenanceReportPagination;
};

export type MaintenanceReportDraftMutationResult = {
  reportId: number;
  status: string;
  currentVersionNo: number;
  updatedAt: Date;
};

export type MaintenanceReportSubmitResult = {
  reportId: number;
  versionId: number;
  versionNo: number;
  status: string;
};

export type MaintenanceReportReviewResult = {
  reportId: number;
  reviewId: number;
  decision: string;
  status: string;
  reviewedAt: Date;
};

export type MaintenanceReportAttachmentFileInput = {
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256?: string | null;
  storageBackend: string;
  storageReference: string;
  description?: string | null;
  sortOrder?: number | null;
};

export type AddMaintenanceReportAttachmentCommand = {
  session: UsecaseSession;
  reportId: number;
  file: MaintenanceReportAttachmentFileInput;
};

export type RemoveMaintenanceReportAttachmentCommand = {
  session: UsecaseSession;
  reportId: number;
  attachmentId: number;
};

export type ReorderMaintenanceReportAttachmentsCommand = {
  session: UsecaseSession;
  reportId: number;
  orderedAttachmentIds: number[];
};

export type MaintenanceReportAttachmentMutationResult = {
  reportId: number;
  attachmentIds: number[];
  currentBytes: number;
};

export type RecordRepairRequestHandlingCommand = {
  session: UsecaseSession;
  repairRequestId: number;
  handlingResult: string;
};

export type RecordRepairRequestHandlingResult = {
  repairRequestId: number;
  handlingResult: string;
  handlingStatus: string;
  handlingRecordedAt: Date;
  handlingEndedAt: Date | null;
};
