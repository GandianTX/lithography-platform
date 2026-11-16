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
