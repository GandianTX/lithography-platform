import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageEntity } from './entities/ai-message.entity';
import { AiReportEntity } from './entities/ai-report.entity';
import { ContentSubmissionAttachmentEntity } from './entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from './entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from './entities/content-submission-review.entity';
import { ContentSubmissionRevisionEntity } from './entities/content-submission-revision.entity';
import { EngineerRegistrationApplicationEntity } from './entities/engineer-registration-application.entity';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { EquipmentModelEntity } from './entities/equipment-model.entity';
import { FaultCaseSubmissionDetailEntity } from './entities/fault-case-submission-detail.entity';
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
import { ReferenceDocumentCaseDetailEntity } from './entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
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
import { RepairRequestQueryService } from './queries/repair-request.query.service';
import { TrustedOrganizationContextQueryService } from './queries/trusted-organization-context.query.service';
import { ContentSubmissionService } from './content-submission.service';
import { EngineerRegistrationService } from './engineer-registration.service';
import { EngineerResponseService } from './engineer-response.service';
import { LocalRuntimeService } from './local-runtime.service';
import { MaintenanceReportService } from './maintenance-report.service';
import { OrganizationMembershipService } from './organization-membership.service';
import { ReferenceDocumentCaseDetailService } from './reference-document-case-detail.service';
import { ReferenceDocumentService } from './reference-document.service';
import { RepairRequestService } from './repair-request.service';

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
] as const;

@Module({
  imports: [TypeOrmModule.forFeature([...LITHOGRAPHY_ENTITIES])],
  providers: [
    EquipmentModelQueryService,
    ReferenceDocumentQueryService,
    RepairRequestQueryService,
    AdminRepairRequestQueryService,
    AdminAiConversationQueryService,
    AdminAiMessageQueryService,
    AdminAiReportQueryService,
    RepairRequestService,
    ReferenceDocumentService,
    ReferenceDocumentCaseDetailService,
    EngineerResponseService,
    OrganizationMembershipQueryService,
    OrganizationQueryService,
    OrganizationMembershipService,
    EngineerRegistrationQueryService,
    EngineerRegistrationService,
    TrustedOrganizationContextQueryService,
    ContentSubmissionService,
    ContentSubmissionQueryService,
    MaintenanceReportService,
    MaintenanceReportQueryService,
    LocalRuntimeService,
    LocalRuntimeQueryService,
  ],
  exports: [
    TypeOrmModule,
    EquipmentModelQueryService,
    ReferenceDocumentQueryService,
    RepairRequestQueryService,
    AdminRepairRequestQueryService,
    AdminAiConversationQueryService,
    AdminAiMessageQueryService,
    AdminAiReportQueryService,
    RepairRequestService,
    ReferenceDocumentService,
    ReferenceDocumentCaseDetailService,
    EngineerResponseService,
    OrganizationMembershipQueryService,
    OrganizationQueryService,
    OrganizationMembershipService,
    EngineerRegistrationQueryService,
    EngineerRegistrationService,
    TrustedOrganizationContextQueryService,
    ContentSubmissionService,
    ContentSubmissionQueryService,
    MaintenanceReportService,
    MaintenanceReportQueryService,
    LocalRuntimeService,
    LocalRuntimeQueryService,
  ],
})
export class LithographyModule {}
