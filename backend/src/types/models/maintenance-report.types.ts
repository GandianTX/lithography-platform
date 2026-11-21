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
  /** R051 新入口正式提交后的冻结态（旧审核流仍保留 PENDING_REVIEW/RETURNED/APPROVED） */
  SUBMITTED = 'SUBMITTED',
  PENDING_REVIEW = 'PENDING_REVIEW',
  RETURNED = 'RETURNED',
  APPROVED = 'APPROVED',
}

/** 报告根复位结果（与任务 04 工单复位口径一致） */
export enum MaintenanceReportResetResult {
  NORMAL = 'NORMAL',
  SAME_FAULT = 'SAME_FAULT',
  NEW_FAULT = 'NEW_FAULT',
}

/**
 * 报告故障分支：初始故障、复位后新故障、步骤新故障各自独立，
 * 与前端编辑器面板类型、任务 04 工单面板类型字符串保持一致。
 */
export enum MaintenanceReportFaultBranchKind {
  INITIAL = 'INITIAL',
  RESET_NEW_FAULT = 'RESET_NEW_FAULT',
  STEP_NEW_FAULT = 'STEP_NEW_FAULT',
}

/** 排查步骤结果（与前端步骤结果、工单步骤结果口径一致） */
export enum MaintenanceReportStepResult {
  RESOLVED = 'RESOLVED',
  UNRESOLVED = 'UNRESOLVED',
  NEW_FAULT = 'NEW_FAULT',
}

export enum MaintenanceReportChangeKind {
  SUBMIT = 'SUBMIT',
  FORMAL_CORRECTION = 'FORMAL_CORRECTION',
}

/** R051 导出格式：Word 可编辑（DOCX）/ 中文多页 PDF */
export enum MaintenanceReportExportFormat {
  DOCX = 'DOCX',
  PDF = 'PDF',
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

/** 单个附件上限 20,000,000 字节；与 stored_file 上传/DB CHECK（byte_size <= 20000000）同口径 */
export const MAINTENANCE_ATTACHMENT_MAX_BYTES = 20_000_000;

/**
 * 当前有效附件数量上限（2026-11-20 产品裁决：功能 V5.6 R062-01 统一口径，
 * 单份报告最多保留 1 份有效原件；历史多附件行只读保留，不迁移不隐藏）。
 */
export const MAINTENANCE_ATTACHMENT_MAX_COUNT = 1;

/** 当前有效附件总字节上限；数量上限为 1 后与单文件上限同口径 20,000,000 字节（只能应用层校验） */
export const MAINTENANCE_ATTACHMENT_MAX_TOTAL_BYTES = 20_000_000;

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
