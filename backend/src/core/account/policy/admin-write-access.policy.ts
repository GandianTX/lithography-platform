// src/core/account/policy/admin-write-access.policy.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

/**
 * 管理员写动作的**身份与等级**裁决（单一口径，core 纯策略）。
 *
 * 为什么放 core：同一个写权事实（"只有一级管理员能写资料正文"）被两个域需要：
 * - 资料域的管理修订入口（任务 07 R058）；
 * - 同步冲突裁决的「保留本地」资料分支（任务 09 第 05 项）。
 * 两边各写一份就会变成两套口径（等级来源、角色判定、拒绝语义都可能漂移），
 * 所以裁决逻辑只留在这里，**各域只负责读取可信事实**（等级取账号当前事实，
 * 不信 JWT 静态等级）。
 *
 * 判定：
 * - 身份：`roles` 精确含 `SUPER_ADMIN` 且可信 `activeRole` 精确为 `SUPER_ADMIN`；
 * - 等级：`adminLevel` 必须为 1（一级管理员）；
 * - 任一不成立 ⇒ `PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS`（对外大类 FORBIDDEN），
 *   与"资源不可见"区分，避免越权探测被掩盖。
 *
 * 拒绝文案由调用方给出（各域场景文案不同），但**判定逻辑与错误码只有一份**。
 */
export type AdminWriteAccessFacts = {
  /** 会话角色集合（可信 JWT 归一化后的大写角色名） */
  roles: readonly string[];
  /** 可信 activeRole（缺失即视为不是管理员） */
  activeRole: string | undefined;
  /** 管理员等级（账号当前事实；null＝缺失或未映射） */
  adminLevel: number | null;
};

export type AdminWriteAccessMessages = {
  /** 角色不符时的拒绝文案 */
  roleDeniedMessage: string;
  /** 等级不足（或 activeRole 不符）时的拒绝文案 */
  levelDeniedMessage: string;
};

/**
 * 断言"一级管理员"写权（资料正文修订等场景的**唯一**判定口径）。
 */
export function assertFirstLevelAdminWriteAccess(
  facts: AdminWriteAccessFacts,
  messages: AdminWriteAccessMessages,
): void {
  const hasSuperAdminRole = facts.roles.includes(IdentityTypeEnum.SUPER_ADMIN);
  const isActiveRoleSuperAdmin = facts.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  if (!hasSuperAdminRole) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, messages.roleDeniedMessage);
  }
  if (!isActiveRoleSuperAdmin || facts.adminLevel !== 1) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, messages.levelDeniedMessage);
  }
}
