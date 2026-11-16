// src/usecases/admin-document-database/admin-document-database-permission.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

/**
 * 管理员文档数据库（PR3 只读聚合）精确权限断言。
 *
 * 业务规则与 `@core/account/policy/admin-scope.policy` 的管理员等级裁决同源：
 * 仅 roles 含 SUPER_ADMIN 且可信 JWT activeRole 精确为 SUPER_ADMIN 可执行；
 * activeRole 缺失、与 roles 矛盾或为非管理员角色时一律拒绝（失败关闭），
 * ENGINEER / CUSTOMER 即使直接调用管理员 operation 也被拒绝。
 *
 * 刻意不直接复用用户管理断言：后者的拒绝文案锚定「用户账号」场景
 * （「仅超级管理员账号可以${actionLabel}用户账号」），文档数据库场景复用会产出
 * 「……查看维修申请数据用户账号」这类病句；错误语义（错误码、失败关闭规则）保持一致，
 * 仅文案按本场景组织。
 *
 * 错误口径：`PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS` → 对外大类 `FORBIDDEN`；
 * 未登录由既有 JWT 认证链路映射为 `UNAUTHENTICATED`，不由本断言表达。
 * details 刻意留空，不携带任何身份事实。
 *
 * 前置依赖与用户管理断言相同：本断言只裁决可信 JWT 声明，停用/降级账号的
 * 即时失效由 `ValidateAccessTokenSessionUsecase`（P0-7）在每个受保护请求上复核。
 *
 * @param session 当前会话身份快照
 * @param actionLabel 管理动作文案（如「查看维修申请数据」），仅用于拒绝提示
 */
export function assertAdminDocumentDatabasePermission(
  session: UsecaseSession,
  actionLabel: string,
): void {
  const hasSuperAdminRole = session.roles.includes(IdentityTypeEnum.SUPER_ADMIN);
  const isActiveRoleSuperAdmin = session.activeRole === IdentityTypeEnum.SUPER_ADMIN;

  if (!hasSuperAdminRole || !isActiveRoleSuperAdmin) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅超级管理员可以${actionLabel}`,
    );
  }
}

/** 等级读取依赖（只暴露本断言需要的方法，便于用例单测注入替身）。 */
export interface AdminLevelReader {
  findAdminLevelByAccountId(accountId: number): Promise<number | null>;
}

/** 可信组织上下文依赖（组织/成员事实只能来自服务端读取，不接受客户端参数）。 */
export interface TrustedOrganizationReader {
  resolveForAccount(params: { accountId: number }): Promise<{ organizationId: number }>;
}

/**
 * 管理员文档数据库全域入口的完整授权断言（等级 + 可信组织）。
 *
 * 与前端 `resolveAuthSessionAdminScope() === 'GLOBAL'` 同口径：仅
 * `admin_level === 1` 且存在单一有效组织成员关系（成员 ACTIVE、组织 ACTIVE）的
 * SUPER_ADMIN 可读全域文档数据库。缺等级、非法等级、二级管理员、成员停用/丢失、
 * 多关系歧义一律失败关闭（`FORBIDDEN`），不做降级或回退全库。
 *
 * 顺序约束（报告 F1）：等级与成员事实必须在任何受保护业务读取之前完成。
 * 等级取自 `base_user_account.admin_level` 的当前事实（不信任 JWT 静态等级/客户端参数），
 * 成员事实取自 `TrustedOrganizationContextQueryService`。
 *
 * @returns 已解析的可信组织事实（统计入口复用，避免同一请求重复读取）
 */
export async function assertAdminDocumentDatabaseGlobalAccess(params: {
  session: UsecaseSession;
  accountQueryService: AdminLevelReader;
  organizationContextService: TrustedOrganizationReader;
  actionLabel: string;
}): Promise<{ organizationId: number }> {
  assertAdminDocumentDatabasePermission(params.session, params.actionLabel);

  const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(
    params.session.accountId,
  );
  if (adminLevel !== 1) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅一级管理员可以${params.actionLabel}`,
    );
  }

  return params.organizationContextService.resolveForAccount({
    accountId: params.session.accountId,
  });
}
