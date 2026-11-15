// src/usecases/stored-file/stored-file-admin-scope.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { resolveAdminOrganizationScopeFromFacts } from '@core/repair-request/policy/repair-request-admin-scope.policy';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/** 工单原件读取的管理员工单组织范围（organizationId = null 为一级全公司） */
export type StoredFileAdminReadScope = {
  organizationId: number | null;
};

/**
 * 管理员工单原件读取范围（仅 BOUND + REPAIR_PROCESS 使用）。
 *
 * - 仅当前身份精确为 SUPER_ADMIN（roles 含 SUPER_ADMIN 且 activeRole 为 SUPER_ADMIN）
 *   进入管理员分支；工程师会话返回 undefined，继续既有工程师口径；
 * - 层级与组织范围复用 `resolveAdminOrganizationScopeFromFacts` 与既有管理员工单
 *   授权策略，组织只来自可信成员事实，不接受客户端公司参数；
 * - 层级非法、二级管理员缺少可信组织等异常统一失败关闭为既有 NOT_FOUND，
 *   不泄露原件存在性，也不回退全库。
 */
export async function resolveStoredFileAdminScope(params: {
  session: UsecaseSession;
  accountQueryService: AccountQueryService;
  trustedOrganizationContext: TrustedOrganizationContextQueryService;
}): Promise<StoredFileAdminReadScope | undefined> {
  if (
    !params.session.roles.includes(IdentityTypeEnum.SUPER_ADMIN) ||
    params.session.activeRole !== IdentityTypeEnum.SUPER_ADMIN
  ) {
    return undefined;
  }

  try {
    const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(
      params.session.accountId,
    );
    const membership =
      adminLevel === 2
        ? await params.trustedOrganizationContext.resolveForAccount({
            accountId: params.session.accountId,
          })
        : null;
    const scope = resolveAdminOrganizationScopeFromFacts({
      adminLevel,
      trustedOrganizationId: membership?.organizationId ?? null,
    });
    return { organizationId: scope.organizationId };
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权访问');
    }
    throw error;
  }
}

/**
 * 读取上下文中的「可信当前公司」。
 *
 * - 管理员只使用管理员工单组织范围：二级为本公司，一级为 null；不借用工程师成员解析，
 *   避免一级管理员多组织时被暂存上下文判定拖累正式读取；
 * - 工程师沿用既有可选组织解析（缺失为 null，歧义仍由既有错误口径拒绝）；
 * - 该值只影响暂存读取与既有工程师口径，管理员组织范围由 `adminOrganizationId` 单独传递。
 */
export async function resolveStoredFileViewerOrganizationId(params: {
  session: UsecaseSession;
  adminScope: StoredFileAdminReadScope | undefined;
  trustedOrganizationContext: TrustedOrganizationContextQueryService;
}): Promise<number | null> {
  if (params.adminScope) {
    return params.adminScope.organizationId;
  }
  const membership = await params.trustedOrganizationContext.tryResolveForAccount({
    accountId: params.session.accountId,
  });
  return membership?.organizationId ?? null;
}
