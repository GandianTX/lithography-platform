// src/modules/lithography/engineer-registration.mapper.ts

import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { DomainError } from '@core/common/errors';
import { ENGINEER_REGISTRATION_ERROR } from '@core/common/errors/domain-error';
import { EngineerRegistrationApplicationEntity } from './entities/engineer-registration-application.entity';
import { EngineerRegistrationApplicationSnapshot } from './engineer-registration.types';

/**
 * 数据库状态值 → 稳定枚举：白名单映射，未知值 fail-closed。
 * 不直接用 `as` 断言，避免脏数据绕过 CHECK 后静默穿透到 API 契约。
 */
const KNOWN_APPLICATION_STATUSES: readonly string[] = Object.values(
  EngineerRegistrationApplicationStatus,
);

const toApplicationStatus = (value: string): EngineerRegistrationApplicationStatus => {
  if (!KNOWN_APPLICATION_STATUSES.includes(value)) {
    throw new DomainError(ENGINEER_REGISTRATION_ERROR.READ_FAILED, '注册申请状态无效', undefined, {
      diagnostic: 'UNKNOWN_APPLICATION_STATUS',
      status: value,
    });
  }
  return value as EngineerRegistrationApplicationStatus;
};

/** 实体 → 安全视图（不暴露 ORM Entity 给上层） */
export const toEngineerRegistrationApplicationSnapshot = (
  entity: EngineerRegistrationApplicationEntity,
): EngineerRegistrationApplicationSnapshot => ({
  id: entity.id,
  accountId: entity.accountId,
  organizationId: entity.organizationId,
  status: toApplicationStatus(entity.status),
  applicationNote: entity.applicationNote,
  submittedAt: entity.submittedAt,
  reviewedByAccountId: entity.reviewedByAccountId,
  reviewedAt: entity.reviewedAt,
  reviewComment: entity.reviewComment,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
});
