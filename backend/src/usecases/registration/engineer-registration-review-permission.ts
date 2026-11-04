// src/usecases/registration/engineer-registration-review-permission.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { OrganizationMembershipFact } from '@src/modules/lithography/organization.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 会话级管理员精确权限断言（注册审核专用）。
 *
 * 与 `src/usecases/account/admin-user-permission.ts` 的
 * `assertAdminUserManagementPermission()` 同口径：仅 roles 含 SUPER_ADMIN 且可信 JWT
 * `activeRole` 精确为 SUPER_ADMIN 放行；缺失、矛盾或其他角色一律失败关闭。
 *
 * 为什么本地实现而不是直接 import：`local-architecture/no-cross-domain-usecases-imports`
 * 禁止 `registration` 用例域依赖 `account` 用例域；仓库既有 `content-submission` 的
 * 角色断言同样以本地对称实现 + 注释指向管理员断言的方式处理，本文件沿用该先例。
 * 两处口径必须同步演进，改动任一侧都需要复核另一侧。
 *
 * 错误口径沿用 `PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS`（对外 FORBIDDEN），
 * `details` 不携带角色列表、组织编码等身份信息。
 */
export function assertRegistrationAdminSession(session: UsecaseSession, actionLabel: string): void {
  const hasSuperAdminRole = session.roles.includes(IdentityTypeEnum.SUPER_ADMIN);
  const isActiveRoleSuperAdmin = session.activeRole === IdentityTypeEnum.SUPER_ADMIN;

  if (!hasSuperAdminRole || !isActiveRoleSuperAdmin) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅所属组织管理员可以${actionLabel}工程师注册申请`,
    );
  }
}

/**
 * 工程师注册审核权限断言（队列、详情、决策共用唯一实现）。
 *
 * 两层同时成立才放行：
 * 1. 管理员精确权限：roles 含 SUPER_ADMIN 且 activeRole 精确为 SUPER_ADMIN
 *    （复用本地 `assertRegistrationAdminSession()`）；
 * 2. 可信组织管理员身份：账号当前唯一有效成员关系的 `memberRole` 必须是 SUPER_ADMIN。
 *
 * 组织范围只取可信解析结果（`TrustedOrganizationContextQueryService.resolveForAccount()`），
 * 绝不接受客户端自报 organizationId；无有效成员关系、多组织歧义均由该解析失败关闭
 * （FORBIDDEN）。返回的组织事实供调用方限定申请可见范围与写入归属。
 *
 * @param params.session 当前会话身份快照
 * @param params.actionLabel 动作文案（如「查看」「审核」），仅用于拒绝提示
 * @param params.organizationContext 可信组织解析服务
 * @param params.transactionContext 可选事务上下文（决策流程在同一事务连接上读最新成员事实）
 */
export async function assertEngineerRegistrationReviewPermission(params: {
  session: UsecaseSession;
  actionLabel: string;
  organizationContext: TrustedOrganizationContextQueryService;
  transactionContext?: PersistenceTransactionContext;
}): Promise<OrganizationMembershipFact> {
  assertRegistrationAdminSession(params.session, params.actionLabel);

  const membership = await params.organizationContext.resolveForAccount({
    accountId: params.session.accountId,
    transactionContext: params.transactionContext,
  });

  if (membership.memberRole !== String(IdentityTypeEnum.SUPER_ADMIN)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅所属组织管理员可以${params.actionLabel}工程师注册申请`,
    );
  }

  return membership;
}
