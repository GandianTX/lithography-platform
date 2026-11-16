// src/usecases/account/admin-user-permission.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import type {
  AdminUserListRoleFilter,
  AdminUserListStatusFilter,
  AdminUserVisibleRole,
  AdminUserWritableRole,
  AdminUserWritableStatus,
} from '@src/modules/account/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

/**
 * 管理员用户管理的角色与状态白名单（单一运行时真源）。
 *
 * 类型口径由 `src/modules/account/account.types.ts` 声明，本文件只持有运行时值域，
 * 供管理员场景的权限断言与输入规范化共同引用，避免各 Usecase 各写一份：
 * - `ADMIN_USER_WRITABLE_ROLES`：普通用户可写的单一业务角色，只接受 ENGINEER / CUSTOMER；
 * - `ADMIN_USER_LIST_ROLE_FILTERS`：列表查看筛选值域，任务 08.4 起只允许普通账号；
 * - `ADMIN_USER_VISIBLE_ROLES`：列表读面强制下推的可见角色范围（服务端语义，非调用方动作），
 *   与筛选值域刻意各自持有；
 * - `ADMIN_USER_WRITABLE_STATUSES`：管理员可写账号状态，只接受 ACTIVE / INACTIVE；
 * - `ADMIN_USER_LIST_STATUS_FILTERS`：列表状态筛选值域，当前成员与可写状态相同，
 *   但刻意独立持有（与角色的读/写拆分对称）：读筛选值域与写入值域一旦共用同一数组，
 *   任何一侧的合理演进都会静默改变另一侧，属于授权面被动扩大。两份数组必须各自显式修改。
 *
 * 白名单属于业务授权决策，只存在于 Usecase 层；不得复制进 GraphQL DTO、Resolver
 * 或 modules(service)，也不得由前端策略代替（前端只控制展示，后端是权限真源）。
 *
 * 刻意不加 `Object.freeze`：`ReadonlyArray<T>` 提供编译期约束，而本仓对授权值域的既有
 * precedent（`core/account/policy/role-access.policy.ts` 的 `roleHierarchy`）同样只用 `Readonly<>`
 * 而未 freeze；`Object.freeze` 在本仓仅用于 `domain-error.ts` 的错误码表。单方面加固会与
 * 同层授权值域风格分裂，且无法防住「新增一份重复白名单」这类真正的漂移风险。
 */
export const ADMIN_USER_WRITABLE_ROLES: ReadonlyArray<AdminUserWritableRole> = [
  IdentityTypeEnum.ENGINEER,
  IdentityTypeEnum.CUSTOMER,
];

export const ADMIN_USER_LIST_ROLE_FILTERS: ReadonlyArray<AdminUserListRoleFilter> = [
  IdentityTypeEnum.ENGINEER,
  IdentityTypeEnum.CUSTOMER,
];

export const ADMIN_USER_VISIBLE_ROLES: ReadonlyArray<AdminUserVisibleRole> = [
  IdentityTypeEnum.ENGINEER,
  IdentityTypeEnum.CUSTOMER,
];

export const ADMIN_USER_WRITABLE_STATUSES: ReadonlyArray<AdminUserWritableStatus> = [
  AccountStatus.ACTIVE,
  AccountStatus.INACTIVE,
];

export const ADMIN_USER_LIST_STATUS_FILTERS: ReadonlyArray<AdminUserListStatusFilter> = [
  AccountStatus.ACTIVE,
  AccountStatus.INACTIVE,
];

/**
 * 管理员写目标角色保护断言：SUPER_ADMIN 账号在本功能内全部只读。
 *
 * - 不允许通过本功能创建、删除、降级、编辑资料、修改状态或重置 SUPER_ADMIN 密码；
 * - 由于所有 SUPER_ADMIN 均只读，任何针对管理员账号的写操作都在服务端统一拒绝，
 *   其中也包含「管理员停用自己」；
 * - 入参是目标账号已经收敛出的单一业务角色；目标角色数据缺失、矛盾或不能表达
 *   同一个唯一角色时，由调用方 Usecase 先行失败关闭，不把异常数据传入本断言；
 * - 判定按可写白名单正向匹配，未来新增角色默认不可写（失败关闭）。
 *
 * 错误口径：与管理员权限拒绝同为 `PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS`
 * （`FORBIDDEN`），不使用 `NOT_FOUND` 伪装管理员账号不存在。
 *
 * @param targetRole 目标账号当前的单一业务角色
 * @param actionLabel 管理动作文案（如「编辑资料」「修改状态」「重置密码」），仅用于拒绝提示
 */
export function assertWritableAdminUserTargetRole(
  targetRole: IdentityTypeEnum,
  actionLabel: string,
): void {
  const isWritableTargetRole = ADMIN_USER_WRITABLE_ROLES.some((role) => role === targetRole);

  if (!isWritableTargetRole) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `管理员账号只读，不可被${actionLabel}`,
    );
  }
}
