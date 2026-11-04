// src/types/models/maintenance-report.types.ts
// 维修报告共享稳定枚举与契约类型：
// GraphQL adapter 注册正式枚举、Entity / Usecase / DTO 共用，不复制第二套。
// 阶段编码本期固定为 PHASE_01—PHASE_10（流程含义由 phase_flow_version 固定，
// 标签映射待业务确认后只在类型层补文案，不改已冻结报告）。

export enum MaintenanceReportSourceType {
  HISTORICAL_CASE = 'HISTORICAL_CASE',
  WORK_ORDER_SUMMARY = 'WORK_ORDER_SUMMARY',
}

export enum MaintenanceReportStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  RETURNED = 'RETURNED',
  APPROVED = 'APPROVED',
}

export enum MaintenanceReportChangeKind {
  SUBMIT = 'SUBMIT',
  FORMAL_CORRECTION = 'FORMAL_CORRECTION',
}

export enum MaintenanceReportReviewDecision {
  APPROVE = 'APPROVE',
  RETURN = 'RETURN',
}

export enum MaintenanceAiUsage {
  USED = 'USED',
  NOT_USED = 'NOT_USED',
}

export enum MaintenanceAiCorrectness {
  CORRECT = 'CORRECT',
  PARTIAL = 'PARTIAL',
  INCORRECT = 'INCORRECT',
}

export enum MaintenancePhaseCode {
  PHASE_01 = 'PHASE_01',
  PHASE_02 = 'PHASE_02',
  PHASE_03 = 'PHASE_03',
  PHASE_04 = 'PHASE_04',
  PHASE_05 = 'PHASE_05',
  PHASE_06 = 'PHASE_06',
  PHASE_07 = 'PHASE_07',
  PHASE_08 = 'PHASE_08',
  PHASE_09 = 'PHASE_09',
  PHASE_10 = 'PHASE_10',
}

export const MAINTENANCE_PHASE_CODES: readonly MaintenancePhaseCode[] =
  Object.values(MaintenancePhaseCode);

export enum MaintenanceAlarmResetResult {
  RESET_OK = 'RESET_OK',
  RESET_FAILED = 'RESET_FAILED',
  NOT_ATTEMPTED = 'NOT_ATTEMPTED',
}

export enum MaintenanceAttachmentStatus {
  CURRENT = 'CURRENT',
  RETIRED = 'RETIRED',
}

export enum MaintenanceAttachmentStorageBackend {
  LOCAL = 'LOCAL',
  OBJECT = 'OBJECT',
}

/** 报告冻结快照 schema 版本；v1 为 PR0 投稿空扩展，不在此扩键 */
export const MAINTENANCE_REPORT_SNAPSHOT_SCHEMA_VERSION = 2;

/** 单个附件上限 20 MiB；应用配置、服务端字节统计与接口同口径 */
export const MAINTENANCE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** 当前有效附件数量上限 */
export const MAINTENANCE_ATTACHMENT_MAX_COUNT = 10;

/** 当前有效附件总字节上限 100 MiB（只能应用层校验） */
export const MAINTENANCE_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * 分析结果生成状态（最小读取抽象的一部分）。
 * 只有 GENERATED 可作为“已使用 AI”的评价对象；FAILED/PARTIAL 明确拒绝。
 */
export enum AnalysisOutputGenerationStatus {
  GENERATED = 'GENERATED',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

/**
 * 后端最小分析结果读取结果（不复制负责人内部表结构）。
 * 稳定 ID + 版本 + 所属组织 + 关联工单 + 生成状态 + 正文。
 */
export type AnalysisOutputSnapshot = {
  sourceType: string;
  sourceId: string;
  sourceVersion: string;
  ownerOrganizationId: number | null;
  repairRequestId: number | null;
  generationStatus: AnalysisOutputGenerationStatus;
  content: string;
};
