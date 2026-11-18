import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { LocalCompanySettingEntity } from './entities/local-company-setting.entity';
import { ManagementAuditEventEntity } from './entities/management-audit-event.entity';
import { MaintenanceReportFaultEntity } from './entities/maintenance-report-fault.entity';
import { MaterialSubmissionDetailEntity } from './entities/material-submission-detail.entity';
import { LocalBackupRunEntity } from './entities/local-backup-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
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
import { SyncReceiptEntity } from './entities/sync-receipt.entity';
import { AdminAiConversationQueryService } from './queries/admin-ai-conversation.query.service';
import { ContentSubmissionQueryService } from './queries/content-submission.query.service';
import { AdminAiMessageQueryService } from './queries/admin-ai-message.query.service';
import { AdminAiReportQueryService } from './queries/admin-ai-report.query.service';
import { AdminRepairRequestQueryService } from './queries/admin-repair-request.query.service';
import { EngineerRegistrationQueryService } from './queries/engineer-registration.query.service';
import { EquipmentModelQueryService } from './queries/equipment-model.query.service';
import { LocalRuntimeQueryService } from './queries/local-runtime.query.service';
import { MaintenanceReportQueryService } from './queries/maintenance-report.query.service';
import { OrganizationMembershipQueryService } from './queries/organization-membership.query.service';
import { OrganizationQueryService } from './queries/organization.query.service';
import { ReferenceDocumentQueryService } from './queries/reference-document.query.service';
import { RepairProcessEntryQueryService } from './queries/repair-process-entry.query.service';
import { RepairRequestQueryService } from './queries/repair-request.query.service';
import { StoredFileQueryService } from './queries/stored-file.query.service';
import { TrustedOrganizationContextQueryService } from './queries/trusted-organization-context.query.service';
import { ContentSubmissionService } from './content-submission.service';
import { AdminOrganizationProvisioningService } from './admin-organization-provisioning.service';
import { EngineerRegistrationService } from './engineer-registration.service';
import { EngineerResponseService } from './engineer-response.service';
import { LocalRuntimeService } from './local-runtime.service';
import { MaintenanceReportService } from './maintenance-report.service';
import { ManagementAuditService } from './management-audit.service';
import { OrganizationMembershipService } from './organization-membership.service';
import { OrganizationService } from './organization.service';
import { ReferenceDocumentCaseDetailService } from './reference-document-case-detail.service';
import { ReferenceDocumentService } from './reference-document.service';
import { RepairProcessEntryService } from './repair-process-entry.service';
import { RepairRequestRevisionService } from './repair-request-revision.service';
import { RepairRequestService } from './repair-request.service';
import { StoredFileService } from './stored-file.service';

const LITHOGRAPHY_ENTITIES = [
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
  imports: [TypeOrmModule.forFeature([...LITHOGRAPHY_ENTITIES])],
  providers: [
    EquipmentModelQueryService,
    ReferenceDocumentQueryService,
    RepairRequestQueryService,
    RepairProcessEntryQueryService,
    AdminRepairRequestQueryService,
    AdminAiConversationQueryService,
    AdminAiMessageQueryService,
    AdminAiReportQueryService,
    RepairRequestService,
    RepairRequestRevisionService,
    RepairProcessEntryService,
    StoredFileService,
    StoredFileQueryService,
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
    ManagementAuditService,
  ],
  exports: [
    TypeOrmModule,
    EquipmentModelQueryService,
    ReferenceDocumentQueryService,
    RepairRequestQueryService,
    RepairProcessEntryQueryService,
    AdminRepairRequestQueryService,
    AdminAiConversationQueryService,
    AdminAiMessageQueryService,
    AdminAiReportQueryService,
    RepairRequestService,
    RepairRequestRevisionService,
    RepairProcessEntryService,
    StoredFileService,
    StoredFileQueryService,
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
    ManagementAuditService,
  ],
})
export class LithographyModule {}
