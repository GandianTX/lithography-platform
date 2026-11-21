// src/usecases/maintenance-report/ports/maintenance-report-export-renderer.contract.ts
//
// 维修报告预览/导出的文档渲染 boundary contract（usecase 层拥有）。
//
// - 渲染实现（DOCX/PDF 生成）属于外部文件系统能力，装配在 infrastructure；
// - 文档模型只承载业务事实与已解析的业务文案，不含任何框架/渲染器类型；
// - 渲染必须完整输出：长文本与步骤数量不得截断，隐藏分支不进入文档模型；
// - 渲染是纯内存生成，不落盘、不写库、不登记机型（R051-01 预览/导出不写库）。

import { MaintenanceReportExportFormat } from '@app-types/models/maintenance-report.types';

export const MAINTENANCE_REPORT_EXPORT_RENDERER = Symbol('MAINTENANCE_REPORT_EXPORT_RENDERER');

export type MaintenanceReportExportAlarmLine = {
  index: number;
  code: string;
  description: string | null;
  phaseCode: string;
  resetResult: string;
};

export type MaintenanceReportExportStepLine = {
  no: number;
  phaseCode: string;
  partName: string | null;
  actionText: string;
  resultText: string | null;
  errorCode: string | null;
};

export type MaintenanceReportExportFaultLine = {
  branchLabel: string;
  /**
   * 步骤新故障对应的步骤顺序号（非步骤新故障或旧快照无关联时为 null）。
   * 预览能看出「哪一步产生的新故障」，导出必须同样可对应。
   */
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
};

export type MaintenanceReportExportAttachmentLine = {
  filename: string;
  mimeType: string;
  byteSize: number;
  description: string | null;
  /** 可嵌入正文展示的图片内容（PNG/JPEG）；其余原件只列元数据，为 null */
  embeddableImage: Buffer | null;
};

/**
 * AI 辅助评价附录（诚实展示）：
 * - NOT_USED：报告未使用 AI 辅助排查，评价不适用；
 * - EVALUATED：报告已保存真实评价（含来源标识与不可变版本）。
 * 不存在“待联调也显示已有评价”的状态；真实来源未接通时保存链路本就失败关闭。
 */
export type MaintenanceReportExportAiEvaluation = {
  status: 'NOT_USED' | 'EVALUATED';
  sourceType: string | null;
  sourceId: string | null;
  sourceVersion: string | null;
  score: number | null;
  correctness: string | null;
  helpfulness: number | null;
  note: string | null;
};

export type MaintenanceReportExportDocument = {
  title: string;
  /** 来源展示名：独立历史维修记录 / 工单维修总结 */
  sourceLabel: string;
  customerFactoryName: string;
  equipmentModelLabel: string;
  maintenanceDate: string;
  engineerName: string;
  handlingResultLabel: string;
  closureReason: string | null;
  resetResultLabel: string | null;
  alarms: MaintenanceReportExportAlarmLine[];
  steps: MaintenanceReportExportStepLine[];
  /** 仅当前有效分支；失效分支不进入导出文档 */
  faults: MaintenanceReportExportFaultLine[];
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
  ai: MaintenanceReportExportAiEvaluation;
  attachments: MaintenanceReportExportAttachmentLine[];
  /**
   * 2026-11-20 需求调整：工单总结的来源工单原件引用（仅报告作者本人导出时提供）。
   * 只是元数据引用：明确标注原件未随报告冻结，按来源工单权限读取；不嵌入文件内容。
   */
  sourceWorkOrderOriginal?: {
    filename: string;
    byteSize: number;
  } | null;
};

export type MaintenanceReportExportRenderResult = {
  content: Buffer;
  mimeType: string;
  fileExtension: string;
};

export interface MaintenanceReportExportRenderer {
  /** 按格式生成文档字节；渲染失败直接抛出，不降级、不产出空文件 */
  render(
    document: MaintenanceReportExportDocument,
    format: MaintenanceReportExportFormat,
  ): Promise<MaintenanceReportExportRenderResult>;
}
