// src/core/stored-file/policy/stored-file-permission.policy.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { StoredFileBusinessType } from '@app-types/models/stored-file.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { DomainError, PERMISSION_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';

/**
 * 共用业务原件权限策略（纯函数，供上传/绑定/下载用例复用）。
 *
 * 与投稿/维修写入口径一致：写操作只认 roles 含 ENGINEER 且可信 JWT
 * activeRole 精确为 ENGINEER（失败关闭，管理员不自动继承工程师写权限）；
 * 读/下载按 roleHierarchy 展开（SUPER_ADMIN 继承 ENGINEER 读能力），
 * 资源归属与组织范围仍由 QueryService 依据可信事实裁决。
 */

/**
 * 上传资格：先核对用途有真实接入方，再核对工程师写身份。
 * 任何无接入方的用途一律拒绝，不落库、不触盘。
 */
export function assertStoredFileUploadQualification(
  session: UsecaseSession,
  businessType: string,
): void {
  assertStoredFileBusinessTypeSupported(businessType);

  if (!isExactActiveEngineer(session)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师账号可以上传业务原件',
    );
  }
}

/**
 * 绑定资格（任务 04 保存内部维修过程时调用）：
 * 绑定属于写操作，仅当前身份精确为 ENGINEER 可执行。
 */
export function assertRepairProcessOriginalBindPermission(session: UsecaseSession): void {
  if (!isExactActiveEngineer(session)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师账号可以绑定维修过程原件',
    );
  }
}

/**
 * 下载/元数据读取角色兜底：ENGINEER 与 SUPER_ADMIN 可进入读链路，
 * CUSTOMER 一律拒绝；具体归属由 QueryService 裁决。
 */
export function assertStoredFileReadRole(session: UsecaseSession): void {
  if (!hasRole(session.roles, IdentityTypeEnum.ENGINEER)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师与管理员账号可以访问业务原件',
    );
  }
}

/** 当前唯一有真实接入方的用途白名单（任务 03/06 在各自任务扩展） */
const SUPPORTED_BUSINESS_TYPES: readonly string[] = [StoredFileBusinessType.REPAIR_PROCESS];

export function assertStoredFileBusinessTypeSupported(businessType: string): void {
  if (!SUPPORTED_BUSINESS_TYPES.includes(businessType)) {
    throw new DomainError(STORED_FILE_ERROR.PURPOSE_NOT_SUPPORTED, '当前暂不支持该业务原件用途', {
      businessType,
    });
  }
}

/** 精确工程师写身份：roles 与 activeRole 同时精确匹配，缺失/矛盾一律拒绝 */
function isExactActiveEngineer(session: UsecaseSession): boolean {
  return (
    session.roles.includes(IdentityTypeEnum.ENGINEER) &&
    session.activeRole === IdentityTypeEnum.ENGINEER
  );
}
