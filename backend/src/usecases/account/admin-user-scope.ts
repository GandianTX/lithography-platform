// src/usecases/account/admin-user-scope.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  resolveOrganizationScopedAdminScope,
  type AdminScope,
} from '@core/account/policy/admin-scope.policy';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 普通用户管理（任务 08.4）的管理员作用域断言：列表、启停与默认密码重置共用唯一实现。
 *
 * 第一层复用 `resolveOrganizationScopedAdminScope()`：
 * - `roles` 含 `SUPER_ADMIN` 且 `activeRole` 精确为 `SUPER_ADMIN`；
 * - 请求期查库得到的 `adminLevel` 必须为 1 或 2，二级必须带可信 `adminOrganizationId`；
 * - 一级归一为 `{ level: 1, organizationId: null }`，即平台全范围。
 *
 * 第二层（仅二级）复核可信组织成员事实：唯一有效成员关系的 `memberRole` 仍是
 * `SUPER_ADMIN` 且公司等于请求期可信公司；成员关系被撤销、变更或出现多组织歧义时
 * 失败关闭。一级是平台级角色，**不要求成员关系**，因此不得对一级调用
 * `resolveForAccount()` 强制解析。
 *
 * 本函数只裁决发起方的作用域；写操作对目标状态、角色与归属的复核由事务内
 * `loadWritableAdminUserTarget()` 承担，不得以本断言代替。
 */
export async function assertAdminUserManagementScope(params: {
  session: UsecaseSession;
  actionLabel: string;
  organizationContext: TrustedOrganizationContextQueryService;
  transactionContext?: PersistenceTransactionContext;
}): Promise<AdminScope> {
  const scope = resolveOrganizationScopedAdminScope(params.session, params.actionLabel);

  if (scope.level === 1) {
    return scope;
  }

  const membership = await params.organizationContext.resolveForAccount({
    accountId: params.session.accountId,
    transactionContext: params.transactionContext,
  });

  if (
    membership.memberRole !== String(IdentityTypeEnum.SUPER_ADMIN) ||
    membership.organizationId !== scope.organizationId
  ) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅所属组织的管理员可以${params.actionLabel}普通用户账号`,
    );
  }

  return scope;
}
