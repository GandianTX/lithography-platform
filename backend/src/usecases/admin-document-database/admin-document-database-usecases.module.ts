// src/usecases/admin-document-database/admin-document-database-usecases.module.ts

import { Module } from '@nestjs/common';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { GetAdminAiReportDetailUsecase } from './get-admin-ai-report-detail.usecase';
import { GetAdminDocumentDatabaseStatsUsecase } from './get-admin-document-database-stats.usecase';
import { GetAdminRepairRequestSummaryUsecase } from './get-admin-repair-request-summary.usecase';
import { ListAdminAiConversationsUsecase } from './list-admin-ai-conversations.usecase';
import { ListAdminAiMessagesUsecase } from './list-admin-ai-messages.usecase';
import { ListAdminAiReportsUsecase } from './list-admin-ai-reports.usecase';
import { ListAdminRepairRequestsUsecase } from './list-admin-repair-requests.usecase';

/**
 * 管理员文档数据库（PR3 只读聚合）用例装配。
 * 只读用例集合：不包含任何写入路径；跨账户域富集统一经 AccountQueryService 契约；
 * 参考资料统计的组织范围（A-PR0 §4.3）由 LithographyModule 导出的可信组织上下文查询服务提供。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule],
  providers: [
    ListAdminRepairRequestsUsecase,
    GetAdminRepairRequestSummaryUsecase,
    ListAdminAiConversationsUsecase,
    ListAdminAiMessagesUsecase,
    ListAdminAiReportsUsecase,
    GetAdminAiReportDetailUsecase,
    GetAdminDocumentDatabaseStatsUsecase,
  ],
  exports: [
    ListAdminRepairRequestsUsecase,
    GetAdminRepairRequestSummaryUsecase,
    ListAdminAiConversationsUsecase,
    ListAdminAiMessagesUsecase,
    ListAdminAiReportsUsecase,
    GetAdminAiReportDetailUsecase,
    GetAdminDocumentDatabaseStatsUsecase,
  ],
})
export class AdminDocumentDatabaseUsecasesModule {}
