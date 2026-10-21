// src/usecases/content-submission/content-submission-roles.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import {
  CONTENT_SUBMISSION_ERROR,
  DomainError,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';

/**
 * 投稿人角色兜底决策（A-PR0 §2.1）：仅 roles 含 ENGINEER 且可信 JWT
 * activeRole 精确为 ENGINEER 可使用投稿人链路（创建/更新草稿、本人列表/详情）。
 *
 * 与管理员精确断言对称（admin-user-permission 的 superAdmin 口径）：activeRole
 * 缺失、与 roles 矛盾或为其他角色（如 SUPER_ADMIN）时一律拒绝（失败关闭）——
 * 管理员审核链路走 S5 的独立入口，不自动继承本写入口，避免同一账号
 * 以管理员身份绕过投稿人归属规则。
 * UsecaseSession.roles 已大写归一，直接精确匹配，不使用角色继承展开。
 * 错误 details 不携带角色列表等身份信息，避免不必要的身份暴露。
 */
export function assertContentSubmissionAuthorRole(session: UsecaseSession): void {
  const hasEngineerRole = session.roles.includes(IdentityTypeEnum.ENGINEER);
  const isActiveRoleEngineer = session.activeRole === IdentityTypeEnum.ENGINEER;
  if (!hasEngineerRole || !isActiveRoleEngineer) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师账号可以使用投稿功能',
    );
  }
}

/** 投稿 ID 输入校验：必须为正整数 */
export function assertSubmissionIdValid(submissionId: number): void {
  if (!Number.isInteger(submissionId) || submissionId <= 0) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '投稿 ID 无效', {
      submissionId,
    });
  }
}

/** 设备型号 ID 输入校验：必须为正整数（调用方保证已区分「未提供/清空」与「提供」） */
export function assertEquipmentModelIdValid(equipmentModelId: number): void {
  if (!Number.isInteger(equipmentModelId) || equipmentModelId <= 0) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '设备型号 ID 无效', {
      equipmentModelId,
    });
  }
}

/** 附件 ID 输入校验：必须为正整数 */
export function assertAttachmentIdValid(attachmentId: number): void {
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '附件 ID 无效', {
      attachmentId,
    });
  }
}

/** 送审版本号输入校验：必须为正整数（版本从 1 开始） */
export function assertRevisionNoValid(revisionNo: number): void {
  if (!Number.isInteger(revisionNo) || revisionNo <= 0) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '送审版本号无效', {
      revisionNo,
    });
  }
}

/** 送审版本 ID 输入校验：必须为正整数 */
export function assertRevisionIdValid(revisionId: number): void {
  if (!Number.isInteger(revisionId) || revisionId <= 0) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '送审版本 ID 无效', {
      revisionId,
    });
  }
}

/**
 * 审核角色决策（A-PR0 §2.1：审核队列/退回/通过仅本组织管理员）：
 * 仅 roles 含 SUPER_ADMIN 且可信 JWT activeRole 精确为 SUPER_ADMIN
 * （与管理员管理/文档库的精确断言同口径）；ENGINEER、CUSTOMER 一律拒绝——
 * 组织范围（本组织）由 usecase 用可信成员事实另行裁决。
 * 错误 details 不携带角色列表等身份信息。
 */
export function assertContentSubmissionReviewRole(session: UsecaseSession): void {
  const hasSuperAdminRole = session.roles.includes(IdentityTypeEnum.SUPER_ADMIN);
  const isActiveRoleSuperAdmin = session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  if (!hasSuperAdminRole || !isActiveRoleSuperAdmin) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅管理员账号可以使用审核功能',
    );
  }
}

/**
 * 「本组织管理员可读」判定（A-PR0 §4.1/§4.2 读取链路：本人或本组织管理员）：
 * 仅 roles 含 SUPER_ADMIN 且 activeRole 精确为 SUPER_ADMIN 视为管理员读取者，
 * 与审核链路（assertContentSubmissionReviewRole）同口径——管理员兼工程师账号
 * 以工程师身份操作时不得读取同组织他人投稿/私有附件（失败关闭：读取他人
 * 私有数据必须有明确的当前管理员身份）。组织范围（本组织）由 usecase 用
 * 可信成员事实另行裁决。错误 details 不携带角色列表等身份信息。
 */
export function isActiveSuperAdmin(session: UsecaseSession): boolean {
  return (
    session.roles.includes(IdentityTypeEnum.SUPER_ADMIN) &&
    session.activeRole === IdentityTypeEnum.SUPER_ADMIN
  );
}

/**
 * 附件下载角色兜底决策（A-PR0 §4.2：「本人或本组织授权审核员下载指定原件」）：
 * ENGINEER / SUPER_ADMIN 可进入下载链路（hasRole 层级展开，与参考资料下载
 * 口径一致），CUSTOMER 一律拒绝；「本人 / 本组织」的资源归属精确裁决在
 * usecase 内用可信事实完成（同组织其他工程师的投稿附件不是公开数据）。
 * 守卫层 @Roles(ENGINEER, SUPER_ADMIN) 已拦截，此处兜底防止守卫被绕过。
 */
export function assertContentSubmissionAttachmentDownloadRole(session: UsecaseSession): void {
  if (!hasRole(session.roles, IdentityTypeEnum.ENGINEER)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师与管理员账号可以下载投稿附件',
    );
  }
}

/**
 * 冻结版本读取角色兜底决策（A-PR0 §4.1：「本人或本组织管理员可读」）：
 * ENGINEER / SUPER_ADMIN 可进入读取链路（hasRole 层级展开，与附件下载同口径），
 * CUSTOMER 一律拒绝；「本人 / 本组织」归属精确裁决在 usecase 内用可信事实完成。
 */
export function assertContentSubmissionRevisionReadRole(session: UsecaseSession): void {
  if (!hasRole(session.roles, IdentityTypeEnum.ENGINEER)) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅工程师与管理员账号可以查看投稿版本',
    );
  }
}
