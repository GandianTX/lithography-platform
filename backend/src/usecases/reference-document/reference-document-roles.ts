// src/usecases/reference-document/reference-document-roles.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import { hasRole } from '@core/account/policy/role-access.policy';
import { assertFirstLevelAdminWriteAccess } from '@core/account/policy/admin-write-access.policy';

/**
 * 读角色兜底决策：ENGINEER 可读，SUPER_ADMIN 按角色继承规则准入（hasRole 层级展开），
 * CUSTOMER 一律拒绝（负责人 0907.docx 任务二角色权限建议）。
 * 守卫层 @Roles(ENGINEER, SUPER_ADMIN) 已拦截，此处兜底防止守卫被绕过或角色数据漂移。
 */
export function assertReferenceDocumentReadRole(roles: readonly string[]): void {
  if (!hasRole(roles, IdentityTypeEnum.ENGINEER)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师与管理员账号可以访问参考资料',
      { roles: [...roles] },
    );
  }
}

/**
 * 写角色兜底决策：仅真实 SUPER_ADMIN 可写（精确匹配，不层级展开——
 * docx 第一版工程师不负责增删资料，避免任何工程师污染 AI 知识来源）。
 * 与维修申请删除用例的精确角色口径一致：session.roles 已在 adapter 边界归一化为大写。
 */
export function assertReferenceDocumentWriteRole(roles: readonly string[]): void {
  const requiredRole = String(IdentityTypeEnum.SUPER_ADMIN);
  if (!roles.includes(requiredRole)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅管理员账号可以维护参考资料',
      { roles: [...roles] },
    );
  }
}

/** 管理修订/下架/管理删除/归属更正（R058–R061）的账号等级读取契约 */
export interface ReferenceDocumentAdminLevelReader {
  findAdminLevelByAccountId(accountId: number): Promise<number | null>;
}

/**
 * 一级管理员决策（任务 07 R058–R061，页面 §9.3「2级及工程师不能下架」）：
 *
 * - 仅可信 activeRole 为 SUPER_ADMIN 且账号当前事实 admin_level = 1 放行；
 * - 等级取自账号当前事实（不信任 JWT 静态等级），与读侧范围决议同口径；
 * - 二级管理员（level=2）、缺等级与工程师一律 INSUFFICIENT_PERMISSIONS——
 *   这是权限拒绝而非资源不可见，必须与 NOT_FOUND 区分，防止越权探测被掩盖。
 */
export async function assertReferenceDocumentFirstLevelAdmin(params: {
  session: UsecaseSession;
  accountQueryService: ReferenceDocumentAdminLevelReader;
}): Promise<void> {
  assertReferenceDocumentWriteRole(params.session.roles);
  const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(
    params.session.accountId,
  );
  // 身份与等级判定走 core 单一口径（任务 09 第 05 项的「保留本地」资料分支共用同一判定，
  // 避免两套写权口径漂移）；本域只负责读取等级当前事实。
  assertFirstLevelAdminWriteAccess(
    {
      roles: params.session.roles,
      activeRole: params.session.activeRole,
      adminLevel,
    },
    {
      roleDeniedMessage: '仅管理员账号可以维护参考资料',
      levelDeniedMessage: '仅一级管理员可以执行资料管理操作',
    },
  );
}

/**
 * 原作者删除本人正式资料（任务 07 R053）读入决策：
 * 工程师与管理员（作为原作者）都可删除本人条目；CUSTOMER 拒绝。
 * 「仅本人条目」的归属裁决在 usecase 内按 AUTHOR 范围（createdByAccountId）执行。
 */
export function assertReferenceDocumentAuthorDeleteRole(
  roles: readonly string[],
  activeRole: string,
): void {
  if (activeRole === String(IdentityTypeEnum.SUPER_ADMIN)) {
    return;
  }
  if (
    activeRole === String(IdentityTypeEnum.ENGINEER) &&
    roles.includes(String(IdentityTypeEnum.ENGINEER))
  ) {
    return;
  }
  throw new DomainError(
    PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    '仅原作者本人可以删除其正式资料',
    { roles: [...roles] },
  );
}

/**
 * 下载角色兜底决策：ENGINEER + SUPER_ADMIN（负责人 0910 裁定收窄，与 GraphQL 读口径一致——
 * 客户无页面访问权限，下载入口不对其暴露；不按上传者或所属用户限制）。
 * 守卫层 @Roles(ENGINEER, SUPER_ADMIN) 已拦截，此处兜底防止守卫被绕过或角色数据漂移。
 */
export function assertReferenceDocumentDownloadRole(roles: readonly string[]): void {
  if (!hasRole(roles, IdentityTypeEnum.ENGINEER)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师与管理员账号可以下载参考资料文件',
      { roles: [...roles] },
    );
  }
}

/** 资料 ID 输入校验：必须为正整数 */
export function assertDocumentIdValid(documentId: number): void {
  if (!Number.isInteger(documentId) || documentId <= 0) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '参考资料 ID 无效', {
      documentId,
    });
  }
}

/** 设备型号 ID 输入校验：必须为正整数（调用方保证已区分「未提供/清空」与「提供」） */
export function assertEquipmentModelIdValid(equipmentModelId: number): void {
  if (!Number.isInteger(equipmentModelId) || equipmentModelId <= 0) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '设备型号 ID 无效', {
      equipmentModelId,
    });
  }
}
