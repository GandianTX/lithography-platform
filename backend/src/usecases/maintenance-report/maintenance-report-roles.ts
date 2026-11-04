// src/usecases/maintenance-report/maintenance-report-roles.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  DomainError,
  MAINTENANCE_REPORT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';

/** 总结/报告作者：仅 roles 含 ENGINEER 且可信 activeRole 精确为 ENGINEER */
export function assertMaintenanceReportAuthorRole(session: UsecaseSession): void {
  const hasEngineerRole = session.roles.includes(IdentityTypeEnum.ENGINEER);
  const isActiveRoleEngineer = session.activeRole === IdentityTypeEnum.ENGINEER;
  if (!hasEngineerRole || !isActiveRoleEngineer) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师账号可以创建或提交维修报告',
    );
  }
}

/** 总结审核：仅 roles 含 SUPER_ADMIN 且可信 activeRole 精确为 SUPER_ADMIN */
export function assertMaintenanceReportReviewRole(session: UsecaseSession): void {
  const hasSuperAdminRole = session.roles.includes(IdentityTypeEnum.SUPER_ADMIN);
  const isActiveRoleSuperAdmin = session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  if (!hasSuperAdminRole || !isActiveRoleSuperAdmin) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅管理员账号可以审核维修报告',
    );
  }
}

/**
 * 读取：ENGINEER / SUPER_ADMIN 可进入链路；精确归属在 usecase 内裁决。
 *
 * 与写/审核断言（roles + activeRole 双重确认）的区别是有意为之：读入口只要求可信
 * `activeRole` 落在允许集合，写入口才额外要求该角色确在账号 roles 内。改写入口时
 * 不要顺手把两者统一成同一口径。
 */
export function assertMaintenanceReportReadRole(session: UsecaseSession): void {
  const allowed =
    session.activeRole === IdentityTypeEnum.ENGINEER ||
    session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  if (!allowed) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '当前账号无权查看维修报告');
  }
}

export function assertMaintenanceReportId(reportId: number): void {
  if (!Number.isInteger(reportId) || reportId <= 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '维修报告 ID 无效', {
      reportId,
    });
  }
}
