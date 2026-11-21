// src/core/stored-file/policy/stored-file-permission.policy.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { StoredFileBusinessType } from '@app-types/models/stored-file.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { DomainError, PERMISSION_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';

/**
 * 共用业务原件权限策略（纯函数，供上传/绑定/下载用例复用）。
 *
 * 写入口径按用途分开，都失败关闭、都不依赖客户端自报组织：
 * - `REPAIR_PROCESS`（任务 04 工程师内部维修过程）：roles 含 ENGINEER 且可信 JWT
 *   activeRole 精确为 ENGINEER（管理员不自动继承工程师写权限）；
 * - `REPAIR_REQUEST`（任务 03 客户报修原件）：角色集合含 CUSTOMER，与客户创建维修
 *   申请的既有准入口径保持一致（同一入口气质，不在这里比创建用例更严）。
 *
 * 读/下载按 roleHierarchy 展开（SUPER_ADMIN 继承 ENGINEER 读能力），
 * 资源归属与组织范围仍由 QueryService 依据可信事实裁决。
 */

/**
 * 上传资格：先核对用途有真实接入方，再核对该用途的写身份。
 * 任何无接入方的用途一律拒绝，不落库、不触盘。
 */
export function assertStoredFileUploadQualification(
  session: UsecaseSession,
  businessType: string,
): void {
  assertStoredFileBusinessTypeSupported(businessType);

  if (isRepairRequestBusinessType(businessType)) {
    assertRepairRequestOriginalWritePermission(session, '仅客户账号可以上传报修原件');

    return;
  }

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
 * 绑定资格（任务 03 提交报修时调用）：客户本人把暂存原件绑定到自己的报修原稿。
 * 口径与「客户创建维修申请」一致：角色集合含 CUSTOMER。
 */
export function assertRepairRequestOriginalBindPermission(session: UsecaseSession): void {
  assertRepairRequestOriginalWritePermission(session, '仅客户账号可以绑定报修原件');
}

/**
 * 下载/元数据读取角色兜底：ENGINEER（含按 roleHierarchy 继承的 SUPER_ADMIN）与
 * CUSTOMER 可进入读链路；具体归属由 QueryService 依据可信事实裁决。
 *
 * 任务 03 第三段起开通客户读链路：客户仅能读取「真实绑定到本人原稿」的
 * BOUND + REPAIR_REQUEST 原件（`StoredFileQueryService.canAccessBoundRepairRequestOriginal`），
 * 内部维修过程原件（REPAIR_PROCESS）与暂存原件仍对客户关闭；
 * 工程师链路口径不变。
 */
export function assertStoredFileReadRole(session: UsecaseSession): void {
  const isEngineerReader = hasRole(session.roles, IdentityTypeEnum.ENGINEER);
  const isCustomerReader = hasRole(session.roles, IdentityTypeEnum.CUSTOMER);
  if (!isEngineerReader && !isCustomerReader) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅客户、工程师与管理员账号可以访问业务原件',
    );
  }
}

/**
 * 用途判定：客户报修原件（任务 03）。
 *
 * 用例拿到的用途是已归一化字符串（可能来自 REST 文本字段），
 * 用本函数与枚举比较，避免各处直接拿字符串和枚举成员比较而失去类型收敛。
 */
export function isRepairRequestBusinessType(businessType: string): boolean {
  // 用例拿到的是已归一化字符串；用 String(枚举) 比较，既保留枚举为唯一真源，
  // 又避免「字符串 vs 枚举成员」的跨类型比较
  return businessType === String(StoredFileBusinessType.REPAIR_REQUEST);
}

/** 当前已有真实接入方的用途白名单（任务 03/06 在各自任务扩展） */
const SUPPORTED_BUSINESS_TYPES: readonly string[] = [
  StoredFileBusinessType.REPAIR_PROCESS,
  StoredFileBusinessType.REPAIR_REQUEST,
  // 任务 06 维修报告原件：上传暂存后由报告附件挂接用例在同一事务内核验并绑定
  StoredFileBusinessType.MAINTENANCE_REPORT,
];

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

/** 客户写身份：与创建维修申请的既有准入口径一致（角色集合含 CUSTOMER） */
function assertRepairRequestOriginalWritePermission(
  session: UsecaseSession,
  message: string,
): void {
  if (!hasRole(session.roles, IdentityTypeEnum.CUSTOMER)) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, message);
  }
}
