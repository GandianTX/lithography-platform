// src/usecases/local-runtime/local-runtime-roles.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

/**
 * 本地设置读写：仅可信 activeRole 为 SUPER_ADMIN。
 * 上传/备份的运行用例属于本地代理/调度器内部入口，不经用户 Session，
 * 也不对外暴露 GraphQL 字段（真实接收端接入前仅完成数据契约）。
 */
export function assertLocalRuntimeSettingsRole(session: UsecaseSession): void {
  const hasSuperAdminRole = session.roles.includes(IdentityTypeEnum.SUPER_ADMIN);
  const isActiveRoleSuperAdmin = session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  if (!hasSuperAdminRole || !isActiveRoleSuperAdmin) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅管理员账号可以管理本地运行设置',
    );
  }
}
