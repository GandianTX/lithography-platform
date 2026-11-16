// src/usecases/registration/engineer-registration-review-permission.ts

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
 * 工程师注册审核的管理员作用域断言（队列、详情、决策共用唯一实现）。
 *
 * 第一层：会话级管理员身份与等级，复用 `resolveOrganizationScopedAdminScope()`：
 * `roles` 含 `SUPER_ADMIN`、`activeRole` 精确为 `SUPER_ADMIN`，且请求期查库得到的
 * `adminLevel` 为 1 或 2；等级缺失、非法或二级缺少可信公司一律 `FORBIDDEN`。
 *
 * 第二层（仅二级）：事务内（或读取时）复核可信组织成员事实，要求唯一有效成员关系
 * 的 `memberRole` 仍是 `SUPER_ADMIN` 且公司等于请求期解析出的可信公司；成员关系
 * 被撤销、变更或出现多组织歧义时失败关闭。一级是平台级角色，不要求成员关系。
 *
 * 返回的作用域是调用方限定读取范围与写入归属的唯一依据：
 * - `level = 1`：全范围，`organizationId` 恒为 `null`；
 * - `level = 2`：只允许 `organizationId` 对应公司的申请。
 * 绝不接受客户端自报 organizationId。
 */
export async function assertEngineerRegistrationReviewPermission(params: {
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
      `仅所属组织管理员可以${params.actionLabel}工程师注册申请`,
    );
  }

  return scope;
}

/**
 * 判断某个申请目标公司是否落在管理员作用域内。
 *
 * 一级全范围恒为真；二级必须与可信公司完全一致。跨公司与不存在在对外口径上
 * 统一按 NOT_FOUND 处理，避免通过错误差异探测其他公司的申请主键。
 */
export function isApplicationInAdminScope(scope: AdminScope, organizationId: number): boolean {
  return scope.level === 1 || scope.organizationId === organizationId;
}
