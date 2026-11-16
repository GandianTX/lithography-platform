// src/core/account/policy/admin-scope.policy.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

/**
 * 管理员可信作用域（单一口径，任务 08 各级管理用例共用）。
 *
 * - `level = 1`：一级管理员，可查看全部公司；`organizationId` 仅为请求期解析出的
 *   唯一有效管理员成员公司，可能为 `null`，不参与全范围授权；
 * - `level = 2`：二级管理员，必须同时具备可信公司归属，`organizationId` 一定为正整数，
 *   跨公司只读最小名单、本公司写操作均以该值为准，绝不接受客户端自报。
 */
export type AdminScope =
  | { readonly level: 1; readonly organizationId: number | null }
  | { readonly level: 2; readonly organizationId: number };

/**
 * 解析当前请求的管理员作用域，失败关闭。
 *
 * 判定依据（负责人 2026-11-15 答复）：
 * 1. 会话精确管理员身份：`roles` 含 `SUPER_ADMIN` 且 `activeRole` 精确为 `SUPER_ADMIN`；
 * 2. `adminLevel` 必须为 1 或 2——该值来自 `ValidateAccessTokenSessionUsecase` 的
 *    请求期数据库复核（`request.user.adminLevel`），不是 JWT 声明，也不是客户端入参；
 * 3. 二级管理员必须带有请求期解析出的唯一有效 `adminOrganizationId`；
 *    等级缺失、非法或二级缺少可信公司一律拒绝（`FORBIDDEN`）。
 *
 * 本函数只裁决请求期身份事实，不代替写操作事务内对目标状态与归属的复核。
 *
 * @param session 当前会话身份快照（须由 `mapJwtToUsecaseSession()` 映射）
 * @param actionLabel 管理动作文案（如「查看公司名称名单」），仅用于拒绝提示
 */
export function resolveAdminScope(session: UsecaseSession, actionLabel: string): AdminScope {
  const hasSuperAdminRole = session.roles.includes(IdentityTypeEnum.SUPER_ADMIN);
  const isActiveRoleSuperAdmin = session.activeRole === IdentityTypeEnum.SUPER_ADMIN;

  if (!hasSuperAdminRole || !isActiveRoleSuperAdmin) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅管理员账号可以${actionLabel}`,
    );
  }

  if (session.adminLevel !== 1 && session.adminLevel !== 2) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `管理员等级缺失或非法，无法${actionLabel}`,
    );
  }

  if (session.adminLevel === 2) {
    const organizationId = session.adminOrganizationId;
    if (
      typeof organizationId !== 'number' ||
      !Number.isInteger(organizationId) ||
      organizationId <= 0
    ) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        `二级管理员缺少可信公司归属，无法${actionLabel}`,
      );
    }
    return { level: 2, organizationId };
  }

  const organizationId = session.adminOrganizationId;
  return {
    level: 1,
    organizationId:
      typeof organizationId === 'number' && Number.isInteger(organizationId) && organizationId > 0
        ? organizationId
        : null,
  };
}

/**
 * 一级全范围 / 二级本公司的管理员作用域解析（任务 08.3 工程师注册审批）。
 *
 * 与 `resolveAdminScope` 的唯一差异：一级管理员归一为 `organizationId: null`。
 * 一级是平台级角色，即使请求期解析出了某个成员公司，也不得把审批与读取范围
 * 收窄到该公司；二级仍然只使用请求期查库得到的可信公司。
 */
export function resolveOrganizationScopedAdminScope(
  session: UsecaseSession,
  actionLabel: string,
): AdminScope {
  const scope = resolveAdminScope(session, actionLabel);

  if (scope.level === 2) {
    return { level: 2, organizationId: scope.organizationId };
  }

  return { level: 1, organizationId: null };
}

/**
 * 仅放行一级管理员的作用域解析（任务 08.2 公司档案完整读写）。
 *
 * 先复用 `resolveAdminScope` 的等级与可信归属裁决，再要求 `level === 1`；
 * 二级管理员即使带有可信公司也一律 `FORBIDDEN`——公司档案的完整视图、详情、
 * 新增与编辑只对一级开放，二级只能使用最小名称名单。
 */
export function resolveLevelOneAdminScope(
  session: UsecaseSession,
  actionLabel: string,
): { readonly level: 1; readonly organizationId: number | null } {
  const scope = resolveAdminScope(session, actionLabel);

  if (scope.level !== 1) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅一级管理员可以${actionLabel}`,
    );
  }

  return scope;
}
