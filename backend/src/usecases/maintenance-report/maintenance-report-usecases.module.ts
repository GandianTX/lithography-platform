// src/usecases/maintenance-report/maintenance-report-usecases.module.ts

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { DocumentExportModule } from '@src/infrastructure/document-export/document-export.module';
import { UnavailableAnalysisOutputReader } from '@src/infrastructure/ai/unavailable-analysis-output-reader';
import { UnavailableMaintenanceReportSyncStatusReader } from '@src/infrastructure/sync/unavailable-maintenance-report-sync-status-reader';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LOCAL_SYNC_STATUS_READER } from '@src/usecases/common/ports/local-sync-status-reader.contract';
import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AddMaintenanceReportAttachmentUsecase } from './add-maintenance-report-attachment.usecase';
import { ApproveMaintenanceReportUsecase } from './approve-maintenance-report.usecase';
import { CreateMaintenanceReportDraftUsecase } from './create-maintenance-report-draft.usecase';
import { ExportMaintenanceReportUsecase } from './export-maintenance-report.usecase';
import { GetMaintenanceReportReviewDetailUsecase } from './get-maintenance-report-review-detail.usecase';
import { GetMyMaintenanceReportUsecase } from './get-my-maintenance-report.usecase';
import { GetMyWorkOrderSummaryUsecase } from './get-my-work-order-summary.usecase';
import { ListMaintenanceReportReviewQueueUsecase } from './list-maintenance-report-review-queue.usecase';
import { ListMyMaintenanceReportsUsecase } from './list-my-maintenance-reports.usecase';
import { ListMyWorkOrderSummaryCandidatesUsecase } from './list-my-work-order-summary-candidates.usecase';
import { ListWorkOrderSummaryAiConversationsUsecase } from './list-work-order-summary-ai-conversations.usecase';
import { RecordRepairRequestHandlingResultUsecase } from './record-repair-request-handling-result.usecase';
import { RemoveMaintenanceReportAttachmentUsecase } from './remove-maintenance-report-attachment.usecase';
import { ReorderMaintenanceReportAttachmentsUsecase } from './reorder-maintenance-report-attachments.usecase';
import { ReturnMaintenanceReportUsecase } from './return-maintenance-report.usecase';
import { SubmitMaintenanceReportFormalUsecase } from './submit-maintenance-report-formal.usecase';
import { SubmitMaintenanceReportUsecase } from './submit-maintenance-report.usecase';
import { UpdateMaintenanceReportDraftUsecase } from './update-maintenance-report-draft.usecase';
import { ANALYSIS_OUTPUT_READER } from './ports/analysis-output-reader.contract';
import {
  MAINTENANCE_REPORT_SYNC_STATUS_READER,
  type MaintenanceReportSyncStatusReader,
} from './ports/maintenance-report-sync-status-reader.contract';
import { RECORD_PACKAGE_ITEM_WRITER } from '@usecases/common/ports/record-package-item-writer.contract';

import { MaintenanceReportRecordPackageItemWriter } from './record-package-item-writer';
import { RecordPackageSourceIdentityVerifier } from './record-package-source-identity.verifier';

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
  imports: [LithographyModule, AccountInstallerModule, DocumentExportModule],
  providers: [
    CreateMaintenanceReportDraftUsecase,
    UpdateMaintenanceReportDraftUsecase,
    SubmitMaintenanceReportUsecase,
    SubmitMaintenanceReportFormalUsecase,
    ExportMaintenanceReportUsecase,
    ReturnMaintenanceReportUsecase,
    ApproveMaintenanceReportUsecase,
    GetMyMaintenanceReportUsecase,
    GetMyWorkOrderSummaryUsecase,
    GetMaintenanceReportReviewDetailUsecase,
    ListMyMaintenanceReportsUsecase,
    ListMyWorkOrderSummaryCandidatesUsecase,
    ListWorkOrderSummaryAiConversationsUsecase,
    ListMaintenanceReportReviewQueueUsecase,
    AddMaintenanceReportAttachmentUsecase,
    RemoveMaintenanceReportAttachmentUsecase,
    ReorderMaintenanceReportAttachmentsUsecase,
    RecordRepairRequestHandlingResultUsecase,
    { provide: ANALYSIS_OUTPUT_READER, useClass: UnavailableAnalysisOutputReader },
    // 任务 07 预留：任务 09 同步状态提供方未接入，默认绑定零 I/O 的不可用实现，
    // 调用方把同步状态展示为 NOT_CONNECTED。
    //
    // 接入方式：任务 09 侧注册 `LOCAL_SYNC_STATUS_READER`（中立令牌，见
    // usecases/common/ports/local-sync-status-reader.contract.ts）后，这里在**调用期**
    // 惰性查找并使用真实实现。惰性查找的三点理由：
    // 1. 任务 07 侧不产生对任务 09 实现的编译期依赖（两边只依赖中立令牌）；
    // 2. 查找发生在请求期，全部模块已实例化，避开初始化顺序问题；
    // 3. 未注册或查找异常一律回落不可用实现（失败关闭，展示 NOT_CONNECTED，
    //    绝不据"保存成功"推断已同步）。
    // 记录包导入的受控写入实现（任务 09 S3.2）：
    // 由**来源域**提供实现并注册中立令牌，任务 09 在调用期按令牌查找，
    // 不产生跨域编译期依赖；未注册时任务 09 逐条失败关闭。
    //
    // 来源身份核验器（S3 补丁 P4）：把「包内来源账号在本机是否可信可写」的
    // 裁决留在来源域——账号状态、资料状态、组织成员关系都由来源域读取，
    // 任务 09 只向受控写入端口请求结论。
    RecordPackageSourceIdentityVerifier,
    {
      provide: RECORD_PACKAGE_ITEM_WRITER,
      useClass: MaintenanceReportRecordPackageItemWriter,
    },
    {
      provide: MAINTENANCE_REPORT_SYNC_STATUS_READER,
      useFactory: (moduleRef: ModuleRef): MaintenanceReportSyncStatusReader => {
        const fallback = new UnavailableMaintenanceReportSyncStatusReader();

        return {
          fetchStatuses: (session, queries) => {
            try {
              const reader = moduleRef.get<MaintenanceReportSyncStatusReader>(
                LOCAL_SYNC_STATUS_READER,
                { strict: false },
              );

              return reader.fetchStatuses(session, queries);
            } catch {
              // 未注册真实实现：回落"明确不可用"
              return fallback.fetchStatuses(session, queries);
            }
          },
        };
      },
      inject: [ModuleRef],
    },
  ],
  exports: [
    CreateMaintenanceReportDraftUsecase,
    UpdateMaintenanceReportDraftUsecase,
    SubmitMaintenanceReportUsecase,
    SubmitMaintenanceReportFormalUsecase,
    ExportMaintenanceReportUsecase,
    ReturnMaintenanceReportUsecase,
    ApproveMaintenanceReportUsecase,
    GetMyMaintenanceReportUsecase,
    GetMyWorkOrderSummaryUsecase,
    GetMaintenanceReportReviewDetailUsecase,
    ListMyMaintenanceReportsUsecase,
    ListMyWorkOrderSummaryCandidatesUsecase,
    ListWorkOrderSummaryAiConversationsUsecase,
    ListMaintenanceReportReviewQueueUsecase,
    AddMaintenanceReportAttachmentUsecase,
    RemoveMaintenanceReportAttachmentUsecase,
    ReorderMaintenanceReportAttachmentsUsecase,
    RecordRepairRequestHandlingResultUsecase,
  ],
})
export class MaintenanceReportUsecasesModule {}
