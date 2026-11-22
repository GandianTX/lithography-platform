// src/core/local-runtime/policy/local-runtime-viewer-scope.policy.ts
//
// 本地运行数据（本地设置 / 待传清单 / 备份清单 / 恢复任务）的查看者范围判定。
//
// 口径来源（任务 09 需求）：
// - R063／R064：工程师与管理员按「本机本公司」访问；一级管理员为全局授权范围；
// - R081：工程师与二级管理员限本公司，一级管理员全局；
// - R083／R085：过期清理与恢复不开放工程师。
//
// 只做纯裁决：事实（角色、管理员等级、可信公司）必须由上层从数据库/会话取得，
// 不接受客户端传入的公司参数。任何缺失或不合法一律失败关闭，不静默降级为全局。

import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { IdentityTypeEnum } from '@app-types/models/account.types';

/** 本地运行数据查看者角色；与 GraphQL 枚举 `LocalRuntimeViewerRole` 同一值域。 */
export const localRuntimeViewerRoleValues = {
  ADMIN_LEVEL_1: 'ADMIN_LEVEL_1',
  ADMIN_LEVEL_2: 'ADMIN_LEVEL_2',
  ENGINEER: 'ENGINEER',
} as const;
export type LocalRuntimeViewerRole =
  (typeof localRuntimeViewerRoleValues)[keyof typeof localRuntimeViewerRoleValues];

export type LocalRuntimeViewerScope = {
  readonly role: LocalRuntimeViewerRole;
  /**
   * 可读取/可操作的公司数据区。
   * 一级管理员为 `null`，表示"全局授权范围"而非"无公司"。
   */
  readonly organizationId: number | null;
  readonly adminLevel: 1 | 2 | null;
};

export type LocalRuntimeViewerFacts = {
  /** 会话角色组（已规范化为大写角色编码） */
  readonly roles: readonly string[];
  /** 当前使用角色；缺失或异常值不得补齐 */
  readonly activeRole?: IdentityTypeEnum;
  /** 请求期复核得到的管理员等级；非管理员为 null */
  readonly adminLevel: number | null;
  /** 请求期复核得到的唯一可信成员公司；无成员关系为 null */
  readonly trustedOrganizationId: number | null;
};

const isSuperAdminSession = (facts: LocalRuntimeViewerFacts): boolean =>
  facts.roles.includes(IdentityTypeEnum.SUPER_ADMIN) &&
  facts.activeRole === IdentityTypeEnum.SUPER_ADMIN;

const isEngineerSession = (facts: LocalRuntimeViewerFacts): boolean =>
  facts.roles.includes(IdentityTypeEnum.ENGINEER) && facts.activeRole === IdentityTypeEnum.ENGINEER;

/**
 * 解析本地运行数据查看者范围。
 *
 * - 管理员：必须同时具备 `SUPER_ADMIN` 角色与 `activeRole`，并按等级取值：
 *   1 级 → 全局（organizationId = null）；2 级 → 必须提供可信公司，否则失败关闭；
 * - 工程师：必须同时具备 `ENGINEER` 角色与 `activeRole`，且必须提供可信公司；
 * - **按当前激活角色取最小权限**：同时具备管理员与工程师角色的账号，
 *   当 `activeRole` 为工程师时只拿到本公司范围，不继承管理员等级；
 * - 其余（客户、受限会话、等级缺失、`roles` 与 `activeRole` 不互为支撑）一律拒绝。
 */
export function resolveLocalRuntimeViewerScope(
  facts: LocalRuntimeViewerFacts,
): LocalRuntimeViewerScope {
  if (isSuperAdminSession(facts)) {
    if (facts.adminLevel === 1) {
      return { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 };
    }
    if (facts.adminLevel === 2) {
      if (facts.trustedOrganizationId === null) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '二级管理员缺少可信公司范围，不能访问本地运行数据',
        );
      }
      return {
        role: 'ADMIN_LEVEL_2',
        organizationId: facts.trustedOrganizationId,
        adminLevel: 2,
      };
    }
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '管理员等级缺失或不合法，不能访问本地运行数据',
    );
  }

  if (isEngineerSession(facts)) {
    if (facts.trustedOrganizationId === null) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '工程师缺少可信公司范围，不能访问本地运行数据',
      );
    }
    return {
      role: 'ENGINEER',
      organizationId: facts.trustedOrganizationId,
      adminLevel: null,
    };
  }

  throw new DomainError(
    PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    '仅工程师或管理员可以访问本机运行数据',
  );
}

/**
 * 本机级设置（现场名称、备份周期等设备维度字段）的写入准入。
 *
 * 这些字段不属于任何公司数据区，只有一级管理员的全局授权范围可以修改；
 * 二级管理员与工程师一律只读。R064 明确本地设置页为只读说明页，
 * 因此该断言只服务于内部/后续维护入口，不对应任何面向用户的编辑入口。
 */
export function assertInstallationSettingsWritable(scope: LocalRuntimeViewerScope): void {
  if (scope.role !== 'ADMIN_LEVEL_1') {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '仅一级管理员可以修改本机级设置',
    );
  }
}

/**
 * 公司维度备份计划开关的写入准入（任务 09 S4）。
 *
 * - 工程师一律拒绝：备份开关决定数据是否离开本机，交给管理员；
 * - 一级管理员（全局授权范围）可改任意公司；
 * - 二级管理员只能改**本公司**。
 */
export function assertBackupPlanWritable(
  scope: LocalRuntimeViewerScope,
  organizationId: number,
): void {
  if (scope.role === 'ENGINEER') {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '备份计划开关仅管理员可修改');
  }
  if (scope.adminLevel === 1) {
    return;
  }
  if (scope.organizationId !== organizationId) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '只能修改本公司的备份计划');
  }
}

/** 管理员专属动作（过期清理、恢复）的准入；工程师一律拒绝。 */
export function assertLocalRuntimeAdministrator(scope: LocalRuntimeViewerScope): void {
  if (scope.role === 'ENGINEER') {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '该操作仅管理员可执行');
  }
}
