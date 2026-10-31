// src/usecases/account/visible-user-info-organization.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { ACCOUNT_ERROR, DomainError } from '@core/common/errors/domain-error';
import type { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 旧账号资料接口（`userInfo` / `updateUserInfo`）非本人目标的组织范围校验。
 *
 * 两个用例共用同一实现（不各写一份），只做非本人路径：
 * - 本人路径保留原有自查/自改权限与字段白名单，不强制历史无组织账号先加入组织；
 * - 非本人路径要求操作者存在**唯一且有效**的可信组织（无成员关系 / 多条关系由
 *   `TrustedOrganizationContextQueryService` 失败关闭为 `ORGANIZATION_*`，对外 FORBIDDEN），
 *   且目标账号在该组织内有有效成员关系；
 * - 组织事实只来自服务端成员关系，绝不采信客户端自报组织、账号 `company_name`
 *   或角色名称推断；
 * - 目标不在同一有效组织（跨组织、无成员关系、成员关系已 LEFT）与目标不存在
 *   **使用同一拒绝码与同一文案**，不泄露目标存在性；
 * - 刻意不套用 `admin*` 接口的 `assertWritableAdminUserTargetRole()`：旧接口对
 *   SUPER_ADMIN 目标的同组织访问仍合法，本函数只裁决组织归属。
 */

/**
 * 非本人目标的统一拒绝：跨组织 / 无有效成员关系 / 不存在，对外均为 `NOT_FOUND`。
 *
 * 不复用 `ACCOUNT_ERROR.ACCOUNT_NOT_FOUND`：其码值与 `AUTH_ERROR.ACCOUNT_NOT_FOUND`
 * 相同，会被全局过滤器映射为 `UNAUTHENTICATED`，让前端把「目标不可见」误判为会话失效。
 */
export function throwVisibleUserInfoTargetUnavailable(): never {
  throw new DomainError(ACCOUNT_ERROR.USER_INFO_NOT_FOUND, '目标用户不存在');
}

/**
 * 断言操作者与目标属于同一有效组织。
 *
 * 调用顺序约定（写路径强制）：必须已先取得目标账号行锁，再调用本函数；否则组织解析与
 * 成员关系读取会在锁前建立事务快照，并发方提交后仍按旧组织事实授权。
 *
 * @param params.operatorAccountId 操作者账号 ID（必须来自可信 Session）
 * @param params.targetAccountId 目标账号 ID（非本人路径）
 * @param params.transactionContext 写路径必须传入当前事务上下文；读路径可省略
 */
export async function assertVisibleUserInfoTargetOrganization(params: {
  readonly organizationContextQueryService: TrustedOrganizationContextQueryService;
  readonly organizationMembershipQueryService: OrganizationMembershipQueryService;
  readonly operatorAccountId: number;
  readonly targetAccountId: number;
  readonly transactionContext?: PersistenceTransactionContext;
}): Promise<void> {
  const operatorOrganization = await params.organizationContextQueryService.resolveForAccount({
    accountId: params.operatorAccountId,
    transactionContext: params.transactionContext,
  });

  const targetMembership = await params.organizationMembershipQueryService.findActiveMembership({
    accountId: params.targetAccountId,
    organizationId: operatorOrganization.organizationId,
    transactionContext: params.transactionContext,
  });
  if (targetMembership === null) {
    throwVisibleUserInfoTargetUnavailable();
  }
}
