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
import {
  ManagementAuditBusinessOperation,
  ManagementAuditResult,
} from '@app-types/models/management-audit.types';
