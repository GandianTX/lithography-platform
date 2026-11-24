import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocalReferenceDocumentStorageModule } from '@src/infrastructure/file-storage/local-reference-document-storage.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageEntity } from './entities/ai-message.entity';
import { AiMessageAnalysisEntity } from './entities/ai-message-analysis.entity';
import { AiReportEntity } from './entities/ai-report.entity';
import { BackupAssetEntity } from './entities/backup-asset.entity';
import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { ContentSubmissionAttachmentEntity } from './entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from './entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from './entities/content-submission-review.entity';
import { ContentSubmissionRevisionEntity } from './entities/content-submission-revision.entity';
import { EngineerRegistrationApplicationEntity } from './entities/engineer-registration-application.entity';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { EquipmentModelEntity } from './entities/equipment-model.entity';
import { AdminOrganizationProvisioningRequestEntity } from './entities/admin-organization-provisioning-request.entity';
import { FaultCaseSubmissionDetailEntity } from './entities/fault-case-submission-detail.entity';
import { IntakeAnalysisAttemptEntity } from './entities/intake-analysis-attempt.entity';
import { LocalAccountAuthorizationEntity } from './entities/local-account-authorization.entity';
import { BackupRestoreAcceptanceService } from './backup-restore-acceptance.service';
import { LocalRestoreExecutionService } from './local-restore-execution.service';
import { LocalRestoreIncidentReleaseService } from './local-restore-incident-release.service';
import { LocalRestoreExecutionCapabilityProbe } from './local-restore-execution-capability.probe';
import { LocalRestoreRecordWriterService } from './local-restore-record.writer';
import { LOCAL_RESTORE_RECORD_WRITER } from '@usecases/common/ports/local-restore-record-writer.contract';
import { SYNC_CONFLICT_LOCAL_VIEW_WRITER } from '@usecases/common/ports/sync-conflict-local-view-writer.contract';
import { SYNC_CONFLICT_LOCAL_RESOLUTION_WRITER } from '@usecases/common/ports/sync-conflict-local-resolution-writer.contract';
import { SyncConflictLocalResolutionWriterService } from './sync-conflict-local-resolution.writer';
import { LocalWriteHoldService } from './local-write-hold.service';
import { LocalWriteScopeLockService } from './local-write-scope-lock.service';
import { RestoreScopeWriteGuardService } from './restore-scope-write-guard.service';
import { LocalBackupPlanService } from './local-backup-plan.service';
import { LocalCompanySettingEntity } from './entities/local-company-setting.entity';
import { ManagementAuditEventEntity } from './entities/management-audit-event.entity';
import { MaintenanceReportFaultEntity } from './entities/maintenance-report-fault.entity';
import { MaterialSubmissionDetailEntity } from './entities/material-submission-detail.entity';
import { LocalBackupRunEntity } from './entities/local-backup-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalWriteHoldEntity } from './entities/local-write-hold.entity';
import { LocalWriteScopeLockEntity } from './entities/local-write-scope-lock.entity';
import { LocalUploadTaskEntity } from './entities/local-upload-task.entity';
import { MaintenanceReportAlarmEntity } from './entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import { MaintenanceReportReviewEntity } from './entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from './entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from './entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { OrganizationMembershipEntity } from './entities/organization-membership.entity';
import { RecordPackageImportEntity } from './entities/record-package-import.entity';
import { RecordPackageItemEntity } from './entities/record-package-item.entity';
import { ReferenceDocumentCaseDetailEntity } from './entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { ReferenceDocumentRevisionEntity } from './entities/reference-document-revision.entity';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairRequestDiagnosticStepEntity } from './entities/repair-request-diagnostic-step.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestFaultPanelEntity } from './entities/repair-request-fault-panel.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from './entities/repair-request-revision.entity';
import { StoredFileEntity } from './entities/stored-file.entity';
import { SyncConflictEntity } from './entities/sync-conflict.entity';
import { SyncConflictQueryService } from './queries/sync-conflict.query.service';
import { SyncSourceRecordQueryService } from './queries/sync-source-record.query.service';
import { SyncStatusQueryService } from './queries/sync-status.query.service';
import { SyncConflictService } from './sync-conflict.service';
import { RecordPackageImportService } from './record-package-import.service';
import { RecordPackageImportQueryService } from './queries/record-package-import.query.service';
import { RecordPackageExportService } from './record-package-export.service';
import { ProtectedBackupService } from './protected-backup.service';
import { LocalBackupCleanupService } from './local-backup-cleanup.service';
import { BackupRestorePrecheckService } from './backup-restore-precheck.service';
import { SyncReceiptEntity } from './entities/sync-receipt.entity';
import { AdminAiConversationQueryService } from './queries/admin-ai-conversation.query.service';
import { AiConversationQueryService } from './queries/ai-conversation.query.service';
import { ContentSubmissionQueryService } from './queries/content-submission.query.service';
import { AdminAiMessageQueryService } from './queries/admin-ai-message.query.service';
import { AdminAiReportQueryService } from './queries/admin-ai-report.query.service';
import { AdminRepairRequestQueryService } from './queries/admin-repair-request.query.service';
import { EngineerRegistrationQueryService } from './queries/engineer-registration.query.service';
import { EngineerRepairRevisionQueryService } from './queries/engineer-repair-revision.query.service';
import { EquipmentModelQueryService } from './queries/equipment-model.query.service';
import { EquipmentModelService } from './equipment-model.service';
import { LocalCompanySettingQueryService } from './queries/local-company-setting.query.service';
import { LocalBackupAssetQueryService } from './queries/local-backup-asset.query.service';
import { LocalRuntimeQueryService } from './queries/local-runtime.query.service';
import { MaintenanceReportQueryService } from './queries/maintenance-report.query.service';
import { ManagementAuditEventQueryService } from './queries/management-audit-event.query.service';
import { OrganizationMembershipQueryService } from './queries/organization-membership.query.service';
import { OrganizationQueryService } from './queries/organization.query.service';
import { ReferenceDocumentQueryService } from './queries/reference-document.query.service';
import { RepairProcessEntryQueryService } from './queries/repair-process-entry.query.service';
import { RepairRequestMaintenanceQueryService } from './queries/repair-request-maintenance.query.service';
import { RepairRequestQueryService } from './queries/repair-request.query.service';
import { StoredFileQueryService } from './queries/stored-file.query.service';
import { TrustedOrganizationContextQueryService } from './queries/trusted-organization-context.query.service';
import { AiConversationService } from './ai-conversation.service';
import { ContentSubmissionService } from './content-submission.service';
import { AdminOrganizationProvisioningService } from './admin-organization-provisioning.service';
import { EngineerRegistrationService } from './engineer-registration.service';
import { EngineerResponseService } from './engineer-response.service';
import { LocalRuntimeService } from './local-runtime.service';
import { BusinessSyncReceiptService } from './business-sync-receipt.service';
import { BusinessSyncSourceService } from './business-sync-source.service';
import { MaintenanceReportService } from './maintenance-report.service';
import { ManagementAuditService } from './management-audit.service';
import { OrganizationMembershipService } from './organization-membership.service';
import { OrganizationService } from './organization.service';
import { ReferenceDocumentCaseDetailService } from './reference-document-case-detail.service';
import { ReferenceDocumentEffectiveContentService } from './reference-document-effective-content.service';
import { ReferenceDocumentRevisionService } from './reference-document-revision.service';
import { ReferenceDocumentService } from './reference-document.service';
import { RepairProcessEntryService } from './repair-process-entry.service';
import { IntakeAnalysisService } from './intake-analysis.service';
import { RepairRequestIntakeService } from './repair-request-intake.service';
import { RepairRequestMaintenanceService } from './repair-request-maintenance.service';
import { RepairRequestRevisionService } from './repair-request-revision.service';
import { SyncConflictLocalViewWriterService } from './sync-conflict-local-view.writer';
import { RepairRequestService } from './repair-request.service';
import { StoredFileService } from './stored-file.service';

/** 全量光刻业务实体集合（Worker 备份执行链等跨模块装配复用） */
export const LITHOGRAPHY_ENTITIES = [
  EquipmentModelEntity,
  RepairRequestEntity,
  AiConversationEntity,
  AiMessageEntity,
  AiReportEntity,
  EngineerResponseEntity,
  ReferenceDocumentEntity,
  OrganizationEntity,
  OrganizationMembershipEntity,
  EngineerRegistrationApplicationEntity,
  ContentSubmissionEntity,
  MaterialSubmissionDetailEntity,
  FaultCaseSubmissionDetailEntity,
  ContentSubmissionAttachmentEntity,
  ContentSubmissionRevisionEntity,
  ContentSubmissionReviewEntity,
  ReferenceDocumentCaseDetailEntity,
  MaintenanceReportEntity,
  MaintenanceReportAlarmEntity,
  MaintenanceReportStepEntity,
  MaintenanceReportAttachmentEntity,
  MaintenanceReportVersionEntity,
  MaintenanceReportVersionAttachmentEntity,
  MaintenanceReportReviewEntity,
  LocalInstallationEntity,
  LocalWriteHoldEntity,
  LocalWriteScopeLockEntity,
  LocalUploadTaskEntity,
  LocalBackupRunEntity,
  StoredFileEntity,
  RepairRequestIntakeEntity,
  IntakeAnalysisAttemptEntity,
  RepairProcessEntryEntity,
  AiMessageAnalysisEntity,
  MaintenanceReportFaultEntity,
  RepairRequestRevisionEntity,
  RepairRequestDiagnosticStepEntity,
  RepairRequestFaultPanelEntity,
  ReferenceDocumentRevisionEntity,
  LocalAccountAuthorizationEntity,
  LocalCompanySettingEntity,
  SyncReceiptEntity,
  SyncConflictEntity,
  RecordPackageImportEntity,
  RecordPackageItemEntity,
  BackupAssetEntity,
  BackupRestoreRunEntity,
  ManagementAuditEventEntity,
  AdminOrganizationProvisioningRequestEntity,
] as const;

@Module({
  imports: [
    TypeOrmModule.forFeature([...LITHOGRAPHY_ENTITIES]),
    // 记录包导出（R070）与受保护备份（S3.1）经存储契约读写；显式引入保证离线装配可解析
    LocalReferenceDocumentStorageModule,
    LocalRuntimeStorageModule,
  ],
  providers: [
    AiConversationService,
    AiConversationQueryService,
    EquipmentModelService,
    RepairRequestIntakeService,
    IntakeAnalysisService,
    EquipmentModelQueryService,
    SyncConflictQueryService,
    SyncConflictService,
    SyncSourceRecordQueryService,
    SyncStatusQueryService,
    RecordPackageImportService,
    RecordPackageImportQueryService,
    RecordPackageExportService,
    LocalBackupPlanService,
    BackupRestoreAcceptanceService,
    // 恢复期写入冻结守卫（任务 09 新计划第 04 项）：按"被写行所属公司数据区"判定，
    // 与备份/恢复范围同列 ⇒ 恢复期间落到该数据区的写入一律被拒。
    RestoreScopeWriteGuardService,
    // 写入/同步冻结闸门（任务 09 S5-2／S5-3）：恢复期冻结目标公司数据区的写入与同步
    LocalWriteHoldService,
    // 写入/同步的**范围锁**（任务 09 独立验收 P1-1）：业务写入（共享锁）与恢复建立冻结
    // （排他锁）共用同一把"同安装×公司"数据库行锁 ⇒ 互斥且持有到业务事务提交/回滚
    LocalWriteScopeLockService,
    // 恢复执行编排（任务 09 S5-2／S5-3）：冻结 → 按清单恢复 → 核验 → 解除冻结
    LocalRestoreExecutionService,
    // 恢复**故障现场**的受控解冻（任务 09 独立验收 P2-2）：管理员处置入口的裁决面
    LocalRestoreIncidentReleaseService,
    // 恢复执行能力的真实探测（review 遗留 L1：此前该端口无 provider，
    // 能力查询恒报「不可用」而执行链本身可用 ⇒ 页面恒显假阴性）
    LocalRestoreExecutionCapabilityProbe,
    // 恢复的业务数据受控写入实现（任务 09 S2-2）：按端口令牌注册，
    // 恢复编排在调用期查找（未注册＝逐项失败关闭，不静默跳过）
    LocalRestoreRecordWriterService,
    {
      provide: LOCAL_RESTORE_RECORD_WRITER,
      useExisting: LocalRestoreRecordWriterService,
    },
    // 「使用云端」的本地视图对齐写入实现（任务 09 R068）：按端口令牌注册，
    // 冲突编排在调用期查找（未注册＝失败关闭，不静默降级为"只改冲突事实"）
    SyncConflictLocalViewWriterService,
    {
      provide: SYNC_CONFLICT_LOCAL_VIEW_WRITER,
      useExisting: SyncConflictLocalViewWriterService,
    },
    // 「保留本地」的来源域受控写入实现（任务 09 第 05 项）：按契约令牌注册，
    // 冲突编排在调用期查找（未注册＝失败关闭，不静默降级为"只改冲突事实"）
    SyncConflictLocalResolutionWriterService,
    {
      provide: SYNC_CONFLICT_LOCAL_RESOLUTION_WRITER,
      useExisting: SyncConflictLocalResolutionWriterService,
    },
    ProtectedBackupService,
    BackupRestorePrecheckService,
    LocalBackupCleanupService,
    ReferenceDocumentQueryService,
    RepairRequestQueryService,
    RepairProcessEntryQueryService,
    RepairRequestMaintenanceQueryService,
    EngineerRepairRevisionQueryService,
    AdminRepairRequestQueryService,
    AdminAiConversationQueryService,
    AdminAiMessageQueryService,
    AdminAiReportQueryService,
    RepairRequestService,
    RepairRequestRevisionService,
    RepairRequestMaintenanceService,
    RepairProcessEntryService,
    StoredFileService,
    StoredFileQueryService,
    ReferenceDocumentRevisionService,
    ReferenceDocumentEffectiveContentService,
    ReferenceDocumentService,
    ReferenceDocumentCaseDetailService,
    EngineerResponseService,
    OrganizationMembershipQueryService,
    OrganizationQueryService,
    OrganizationMembershipService,
    OrganizationService,
    AdminOrganizationProvisioningService,
    EngineerRegistrationQueryService,
    EngineerRegistrationService,
    TrustedOrganizationContextQueryService,
    ContentSubmissionService,
    ContentSubmissionQueryService,
    MaintenanceReportService,
    MaintenanceReportQueryService,
    LocalRuntimeService,
    LocalRuntimeQueryService,
    LocalCompanySettingQueryService,
    LocalBackupAssetQueryService,
    BusinessSyncSourceService,
    BusinessSyncReceiptService,
    ManagementAuditEventQueryService,
    ManagementAuditService,
  ],
  exports: [
    TypeOrmModule,
    LocalBackupPlanService,
    BackupRestoreAcceptanceService,
    LocalWriteHoldService,
    LocalWriteScopeLockService,
    RestoreScopeWriteGuardService,
    LocalRestoreExecutionService,
    LocalRestoreIncidentReleaseService,
    LocalRestoreExecutionCapabilityProbe,
    ProtectedBackupService,
    BackupRestorePrecheckService,
    LocalBackupCleanupService,
    AiConversationService,
    AiConversationQueryService,
    EquipmentModelService,
    RepairRequestIntakeService,
    IntakeAnalysisService,
    SyncConflictQueryService,
    SyncSourceRecordQueryService,
    SyncStatusQueryService,
    SyncConflictService,
    RecordPackageImportService,
    RecordPackageImportQueryService,
    RecordPackageExportService,
    EquipmentModelQueryService,
    ReferenceDocumentQueryService,
    RepairRequestQueryService,
    RepairProcessEntryQueryService,
    RepairRequestMaintenanceQueryService,
    EngineerRepairRevisionQueryService,
    AdminRepairRequestQueryService,
    AdminAiConversationQueryService,
    AdminAiMessageQueryService,
    AdminAiReportQueryService,
    RepairRequestService,
    RepairRequestRevisionService,
    RepairRequestMaintenanceService,
    RepairProcessEntryService,
    StoredFileService,
    StoredFileQueryService,
    ReferenceDocumentRevisionService,
    ReferenceDocumentEffectiveContentService,
    ReferenceDocumentService,
    ReferenceDocumentCaseDetailService,
    EngineerResponseService,
    OrganizationMembershipQueryService,
    OrganizationQueryService,
    OrganizationMembershipService,
    OrganizationService,
    AdminOrganizationProvisioningService,
    EngineerRegistrationQueryService,
    EngineerRegistrationService,
    TrustedOrganizationContextQueryService,
    ContentSubmissionService,
    ContentSubmissionQueryService,
    MaintenanceReportService,
    MaintenanceReportQueryService,
    LocalRuntimeService,
    LocalRuntimeQueryService,
    LocalCompanySettingQueryService,
    LocalBackupAssetQueryService,
    BusinessSyncSourceService,
    BusinessSyncReceiptService,
    ManagementAuditEventQueryService,
    ManagementAuditService,
    // 「使用云端」的本地视图对齐写入（任务 09 R068）：按端口令牌导出，
    // 冲突编排（本地运行域模块）按令牌注入；未注册即失败关闭
    SyncConflictLocalViewWriterService,
    SYNC_CONFLICT_LOCAL_VIEW_WRITER,
    // 「保留本地」的来源域受控写入（任务 09 第 05 项）：按契约令牌导出，
    // 冲突编排（管理员文档库域用例）按令牌注入；未注册即失败关闭
    SyncConflictLocalResolutionWriterService,
    SYNC_CONFLICT_LOCAL_RESOLUTION_WRITER,
  ],
})
export class LithographyModule {}
