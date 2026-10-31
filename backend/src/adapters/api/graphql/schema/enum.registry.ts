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
} from '@app-types/models/repair-request.types';
import {
  CreatableVerificationRecordType,
  SubjectType,
  VerificationRecordStatus,
  VerificationRecordType,
} from '@app-types/models/verification-record.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import {
  EngineerRegistrationApplicationStatus,
  EngineerRegistrationReviewAction,
  RegistrationOutcomeStatus,
} from '@app-types/models/registration.types';
import { AiConversationStatus, AiMessageRole } from '@app-types/models/ai-conversation.types';
import { registerEnumType } from '@nestjs/graphql';
import { GqlPaginationMode, GqlSortDirection } from '@src/adapters/api/graphql/pagination.enums';
import { OrderDirection } from '@app-types/common/sort.types';

export function registerEnums(): void {
  registerEnumType(AccountStatus, { name: 'AccountStatus' });
  registerEnumType(AudienceTypeEnum, { name: 'AudienceTypeEnum' });
  registerEnumType(EmploymentStatus, { name: 'EmploymentStatus' });
  registerEnumType(IdentityTypeEnum, { name: 'IdentityTypeEnum' });
  registerEnumType(LoginTypeEnum, { name: 'LoginTypeEnum' });
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
  registerEnumType(RepairRequestAcceptanceViewStatus, {
    name: 'RepairRequestAcceptanceViewStatus',
  });
  registerEnumType(OrderDirection, { name: 'OrderDirection' });
  registerEnumType(GqlPaginationMode, { name: 'PaginationMode' });
  registerEnumType(GqlSortDirection, { name: 'SortDirection' });
}
