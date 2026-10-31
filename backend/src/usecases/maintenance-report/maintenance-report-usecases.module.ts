// src/usecases/maintenance-report/maintenance-report-usecases.module.ts

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { UnavailableAnalysisOutputReader } from '@src/infrastructure/ai/unavailable-analysis-output-reader';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { Module } from '@nestjs/common';
import { AddMaintenanceReportAttachmentUsecase } from './add-maintenance-report-attachment.usecase';
import { ApproveMaintenanceReportUsecase } from './approve-maintenance-report.usecase';
import { CreateMaintenanceReportDraftUsecase } from './create-maintenance-report-draft.usecase';
import { GetMaintenanceReportReviewDetailUsecase } from './get-maintenance-report-review-detail.usecase';
import { GetMyMaintenanceReportUsecase } from './get-my-maintenance-report.usecase';
import { ListMaintenanceReportReviewQueueUsecase } from './list-maintenance-report-review-queue.usecase';
import { ListMyMaintenanceReportsUsecase } from './list-my-maintenance-reports.usecase';
import { RecordRepairRequestHandlingResultUsecase } from './record-repair-request-handling-result.usecase';
import { RemoveMaintenanceReportAttachmentUsecase } from './remove-maintenance-report-attachment.usecase';
import { ReorderMaintenanceReportAttachmentsUsecase } from './reorder-maintenance-report-attachments.usecase';
import { ReturnMaintenanceReportUsecase } from './return-maintenance-report.usecase';
import { SubmitMaintenanceReportUsecase } from './submit-maintenance-report.usecase';
import { UpdateMaintenanceReportDraftUsecase } from './update-maintenance-report-draft.usecase';
import { ANALYSIS_OUTPUT_READER } from './ports/analysis-output-reader.contract';

/**
 * 维修报告与工单处理结果用例装配（S3）。
 *
 * - 组织范围由 LithographyModule 导出的可信组织上下文查询服务提供；
 * - 事务边界由全局 TypeOrmTransactionModule 提供的 TRANSACTION_RUNNER 注入；
 * - 分析结果读取抽象绑定「明确不可用」实现：正式 AI 模块未接入前，
 *   标记使用 AI 的写入一律失败关闭；测试通过装配注入内存模拟实现，
 *   不增加公开模拟接口、生产开关或模拟专用表。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule],
  providers: [
    CreateMaintenanceReportDraftUsecase,
    UpdateMaintenanceReportDraftUsecase,
    SubmitMaintenanceReportUsecase,
    ReturnMaintenanceReportUsecase,
    ApproveMaintenanceReportUsecase,
    GetMyMaintenanceReportUsecase,
    GetMaintenanceReportReviewDetailUsecase,
    ListMyMaintenanceReportsUsecase,
    ListMaintenanceReportReviewQueueUsecase,
    AddMaintenanceReportAttachmentUsecase,
    RemoveMaintenanceReportAttachmentUsecase,
    ReorderMaintenanceReportAttachmentsUsecase,
    RecordRepairRequestHandlingResultUsecase,
    { provide: ANALYSIS_OUTPUT_READER, useClass: UnavailableAnalysisOutputReader },
  ],
  exports: [
    CreateMaintenanceReportDraftUsecase,
    UpdateMaintenanceReportDraftUsecase,
    SubmitMaintenanceReportUsecase,
    ReturnMaintenanceReportUsecase,
    ApproveMaintenanceReportUsecase,
    GetMyMaintenanceReportUsecase,
    GetMaintenanceReportReviewDetailUsecase,
    ListMyMaintenanceReportsUsecase,
    ListMaintenanceReportReviewQueueUsecase,
    AddMaintenanceReportAttachmentUsecase,
    RemoveMaintenanceReportAttachmentUsecase,
    ReorderMaintenanceReportAttachmentsUsecase,
    RecordRepairRequestHandlingResultUsecase,
  ],
})
export class MaintenanceReportUsecasesModule {}
