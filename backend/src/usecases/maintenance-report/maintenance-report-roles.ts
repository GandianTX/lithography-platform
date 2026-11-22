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

/**
 * 「我的资料记录」读入口（任务 07 R052，页面 V6.5 §9.2）：工程师或管理员均可进入。
 *
 * - 管理员（SUPER_ADMIN）保留本人记录查询，无工程师报告新建入口；
 * - 「不显示他人创建的记录」不在角色层实现：列表/详情的归属谓词
 *   （作者本人 + 本组织资源授权，2026-11-21 页面设计确认）在 usecase 内统一收敛——
 *   他人草稿/待审/正式记录对本页面统一 NOT_FOUND 或空列表；
 * - 新建/提交/续填等写入口仍走 assertMaintenanceReportAuthorRole（仅工程师），
 *   不要把本断言扩大到写路径。
 */
export function assertMyMaintenanceReportReadEntryRole(session: UsecaseSession): void {
  const allowed =
    session.activeRole === IdentityTypeEnum.ENGINEER ||
    session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  if (!allowed) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '当前账号无权访问本人资料记录',
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
