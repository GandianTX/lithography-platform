// src/usecases/local-runtime/local-runtime-scope.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { ACCOUNT_ERROR, DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import {
  resolveLocalRuntimeViewerScope,
  type LocalRuntimeViewerScope,
} from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 会话 → 本地运行数据查看者范围。
 *
 * 事实来源与既有口径保持一致（对齐 `usecases/stored-file/stored-file-admin-scope.ts`）：
 * - 管理员等级取自**请求期数据库复核**（`AccountQueryService.findAdminLevelByAccountId`），
 *   不读客户端参数，也不因等级缺失而降级为一级；
 * - 二级管理员与工程师的公司取自 `TrustedOrganizationContextQueryService`（唯一有效成员关系），
 *   客户端自报公司与展示公司字段一律不参与；
 * - 非管理员/工程师身份不查库，直接交给 core 策略失败关闭。
 */
export async function resolveLocalRuntimeViewerScopeFromSession(params: {
  session: UsecaseSession;
  accountQueryService: AccountQueryService;
  trustedOrganizationContext: TrustedOrganizationContextQueryService;
}): Promise<LocalRuntimeViewerScope> {
  const { session } = params;
  const isSuperAdmin =
    session.roles.includes(IdentityTypeEnum.SUPER_ADMIN) &&
    session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  const isEngineer =
    session.roles.includes(IdentityTypeEnum.ENGINEER) &&
    session.activeRole === IdentityTypeEnum.ENGINEER;

  if (!isSuperAdmin && !isEngineer) {
    // 客户、受限会话与角色不一致：不在本层查库，交由 core 策略统一拒绝
    return resolveLocalRuntimeViewerScope({
      roles: session.roles,
      activeRole: session.activeRole,
      adminLevel: null,
      trustedOrganizationId: null,
    });
  }

  if (isSuperAdmin) {
    let adminLevel: number | null;
    try {
      adminLevel = await params.accountQueryService.findAdminLevelByAccountId(session.accountId);
    } catch (error) {
      if (error instanceof DomainError && error.code === ACCOUNT_ERROR.ACCOUNT_NOT_FOUND) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '管理员身份复核失败，不能访问本机运行数据',
        );
      }
      throw error;
    }

    // 仅二级管理员需要可信公司；一级为全局授权范围
    const trustedOrganizationId =
      adminLevel === 2
        ? (
            await params.trustedOrganizationContext.resolveForAccount({
              accountId: session.accountId,
            })
          ).organizationId
        : null;

    return resolveLocalRuntimeViewerScope({
      roles: session.roles,
      activeRole: session.activeRole,
      adminLevel,
      trustedOrganizationId,
    });
  }

  const membership = await params.trustedOrganizationContext.resolveForAccount({
    accountId: session.accountId,
  });
  return resolveLocalRuntimeViewerScope({
    roles: session.roles,
    activeRole: session.activeRole,
    adminLevel: null,
    trustedOrganizationId: membership.organizationId,
  });
}
