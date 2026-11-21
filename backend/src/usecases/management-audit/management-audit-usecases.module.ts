// src/usecases/management-audit/management-audit-usecases.module.ts

import { Module } from '@nestjs/common';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { ListManagementAuditEventsUsecase } from './list-management-audit-events.usecase';

/**
 * 关键操作记录（任务 10）用例装配。
 *
 * 只读用例集合：本模块不提供任何写入路径。三类管理事实的写入属于 07（资料删除、
 * 归属更正）与 09（本地业务恢复）各自的业务事务，本任务只统一查询与消费契约。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule],
  providers: [ListManagementAuditEventsUsecase],
  exports: [ListManagementAuditEventsUsecase],
})
export class ManagementAuditUsecasesModule {}
