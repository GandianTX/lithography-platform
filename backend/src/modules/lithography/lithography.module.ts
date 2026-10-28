import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageEntity } from './entities/ai-message.entity';
import { AiReportEntity } from './entities/ai-report.entity';
import { ContentSubmissionAttachmentEntity } from './entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from './entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from './entities/content-submission-review.entity';
import { ContentSubmissionRevisionEntity } from './entities/content-submission-revision.entity';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { EquipmentModelEntity } from './entities/equipment-model.entity';
import { FaultCaseSubmissionDetailEntity } from './entities/fault-case-submission-detail.entity';
import { MaterialSubmissionDetailEntity } from './entities/material-submission-detail.entity';
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
import { EquipmentModelQueryService } from './queries/equipment-model.query.service';
import { OrganizationMembershipQueryService } from './queries/organization-membership.query.service';
import { ReferenceDocumentQueryService } from './queries/reference-document.query.service';
import { RepairRequestQueryService } from './queries/repair-request.query.service';
import { TrustedOrganizationContextQueryService } from './queries/trusted-organization-context.query.service';
import { ContentSubmissionService } from './content-submission.service';
import { EngineerResponseService } from './engineer-response.service';
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
  ContentSubmissionEntity,
  MaterialSubmissionDetailEntity,
  FaultCaseSubmissionDetailEntity,
  ContentSubmissionAttachmentEntity,
  ContentSubmissionRevisionEntity,
  ContentSubmissionReviewEntity,
  ReferenceDocumentCaseDetailEntity,
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
    OrganizationMembershipService,
    TrustedOrganizationContextQueryService,
    ContentSubmissionService,
    ContentSubmissionQueryService,
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
    OrganizationMembershipService,
    TrustedOrganizationContextQueryService,
    ContentSubmissionService,
    ContentSubmissionQueryService,
  ],
})
export class LithographyModule {}
