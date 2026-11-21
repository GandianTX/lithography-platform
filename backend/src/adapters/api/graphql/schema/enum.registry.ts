// src/adapters/api/graphql/schema/enum.registry.ts

import {
  // 导入所有需要注册的枚举类型（仅依赖 @app-types）
  AccountStatus,
  AudienceTypeEnum,
  EmploymentStatus,
  IdentityTypeEnum,
  LoginTypeEnum,
  ThirdPartyLoginProviderEnum,
  ThirdPartyProviderEnum,
} from '@app-types/models/account.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import {
  EngineerResolutionStatus,
  RepairRequestAcceptanceViewStatus,
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import {
  CreatableVerificationRecordType,
  SubjectType,
  VerificationRecordStatus,
  VerificationRecordType,
} from '@app-types/models/verification-record.types';
import {
  MaintenancePhaseCode,
  MaintenanceReportExportFormat,
  MaintenanceReportFaultBranchKind,
  MaintenanceReportResetResult,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
  MaintenanceReportStepResult,
} from '@app-types/models/maintenance-report.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import {
  EngineerRegistrationApplicationStatus,
  EngineerRegistrationReviewAction,
  RegistrationOutcomeStatus,
} from '@app-types/models/registration.types';
import {
  AiConversationStatus,
  AiConversationDispatchStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  organizationKindValues,
  organizationStatusValues,
} from '@src/modules/lithography/organization.types';
import { AiConversationExportFormat } from '@src/adapters/api/graphql/ai-conversation/dto/ai-conversation-export.dto';
import { LocalBackupCleanupMode } from '@src/adapters/api/graphql/local-runtime/dto/local-backup.dto';
import { localRuntimeViewerRoleValues } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { syncConflictActionEnum } from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import { recordPackageResourceTypeEnum } from '@core/local-runtime/policy/record-package-export.policy';
import { registerEnumType } from '@nestjs/graphql';
import { GqlPaginationMode, GqlSortDirection } from '@src/adapters/api/graphql/pagination.enums';
import { OrderDirection } from '@app-types/common/sort.types';

export function registerEnums(): void {
  registerEnumType(AccountStatus, { name: 'AccountStatus' });
  registerEnumType(AudienceTypeEnum, { name: 'AudienceTypeEnum' });
  registerEnumType(EmploymentStatus, { name: 'EmploymentStatus' });
  registerEnumType(IdentityTypeEnum, { name: 'IdentityTypeEnum' });
  registerEnumType(LoginTypeEnum, { name: 'LoginTypeEnum' });
  registerEnumType(SessionRestriction, { name: 'SessionRestriction' });
  registerEnumType(ThirdPartyLoginProviderEnum, { name: 'ThirdPartyLoginProviderEnum' });
  registerEnumType(ThirdPartyProviderEnum, { name: 'ThirdPartyProviderEnum' });
  registerEnumType(RegisterTypeEnum, { name: 'RegisterTypeEnum' });
  registerEnumType(RegistrationOutcomeStatus, { name: 'RegistrationOutcomeStatus' });
  registerEnumType(EngineerRegistrationApplicationStatus, {
    name: 'EngineerRegistrationApplicationStatus',
  });
  registerEnumType(EngineerRegistrationReviewAction, { name: 'EngineerRegistrationReviewAction' });
  registerEnumType(Gender, { name: 'Gender' });
  registerEnumType(UserState, { name: 'UserState' });
  registerEnumType(SubjectType, { name: 'SubjectType' });
  registerEnumType(VerificationRecordStatus, { name: 'VerificationRecordStatus' });
  registerEnumType(VerificationRecordType, { name: 'VerificationRecordType' });
  registerEnumType(CreatableVerificationRecordType, { name: 'CreatableVerificationRecordType' });
  registerEnumType(EngineerResolutionStatus, { name: 'EngineerResolutionStatus' });
  registerEnumType(AiConversationStatus, { name: 'AiConversationStatus' });
  registerEnumType(AiMessageRole, { name: 'AiMessageRole' });
  registerEnumType(AiMessageAnalysisStatus, { name: 'AiMessageAnalysisStatus' });
  registerEnumType(AiConversationDispatchStatus, {
    name: 'AiConversationDispatchStatus',
  });
  registerEnumType(AiConversationExportFormat, { name: 'AiConversationExportFormat' });
  registerEnumType(RepairRequestAcceptanceViewStatus, {
    name: 'RepairRequestAcceptanceViewStatus',
  });
  registerEnumType(RepairRequestHandlingResult, { name: 'RepairRequestHandlingResult' });
  registerEnumType(RepairRequestHandlingStatus, { name: 'RepairRequestHandlingStatus' });
  registerEnumType(MaintenanceReportStatus, { name: 'MaintenanceReportStatus' });
  registerEnumType(MaintenanceReportSourceType, { name: 'MaintenanceReportSourceType' });
  registerEnumType(MaintenancePhaseCode, { name: 'MaintenancePhaseCode' });
  registerEnumType(MaintenanceReportStepResult, { name: 'MaintenanceReportStepResult' });
  registerEnumType(MaintenanceReportFaultBranchKind, { name: 'MaintenanceReportFaultBranchKind' });
  registerEnumType(MaintenanceReportResetResult, { name: 'MaintenanceReportResetResult' });
  registerEnumType(MaintenanceReportExportFormat, { name: 'MaintenanceReportExportFormat' });
  registerEnumType(OrderDirection, { name: 'OrderDirection' });
  registerEnumType(GqlPaginationMode, { name: 'PaginationMode' });
  registerEnumType(GqlSortDirection, { name: 'SortDirection' });
  registerEnumType(organizationStatusValues, { name: 'OrganizationStatus' });
  registerEnumType(organizationKindValues, { name: 'OrganizationKind' });
  registerEnumType(localRuntimeViewerRoleValues, { name: 'LocalRuntimeViewerRole' });
  registerEnumType(syncConflictActionEnum, { name: 'SyncConflictAction' });
  registerEnumType(recordPackageResourceTypeEnum, { name: 'RecordPackageResourceType' });
  registerEnumType(LocalBackupCleanupMode, { name: 'LocalBackupCleanupMode' });
}
