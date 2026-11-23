// src/core/local-runtime/policy/record-package-export-authorization.policy.ts

import type { LocalRuntimeViewerScope } from './local-runtime-viewer-scope.policy';
import type { RecordPackageResourceType } from './record-package-manifest.policy';

/**
 * 记录包导出的**逐条记录级授权**（任务 09 S1-3）。
 *
 * 背景：此前导出服务只按**公司范围**过滤（`assertRecordOrganization`），
 * 导出命令里的账号参数完全没被使用。结果是**同公司他人**的记录也能被导出，
 * 且与导入侧不对称：导入侧对工程师严格限制"本人记录"，导出侧却放开公司范围，
 * 等于给工程师留了一条"导出他人记录再自己导入"的越权路径。
 *
 * 口径来源（**来源域真实读取权限**，不是本任务自创）：
 * - 任务 07「我的资料记录」：报告与资料的页面谓词＝**作者本人 ＋ 本公司**；
 * - 工单：工程师在来源域可查看**本公司全部工单**（scope=ALL 列表），按公司范围；
 * - 管理员：二级按本公司、一级按全局授权范围（任务书「一级按当前授权范围」）。
 *
 * 纯函数：会话账号、查看者范围、记录归属与关联账号由上层从数据库／会话取得。
 */

/** 裁决所需的记录事实（由来源域读取层提供） */
export type RecordPackageExportRecordFacts = {
  /** 记录归属公司；null 表示归属未知（存量无证据，不猜测） */
  readonly ownerOrganizationId: number | null;
  /** 与该记录关联的账号（作者／客户／受理工程师等） */
  readonly relatedAccountIds: readonly number[];
};

export type RecordPackageExportAuthorizationReason =
  | 'ADMIN_GLOBAL'
  | 'COMPANY_SCOPE'
  | 'AUTHOR_SELF'
  | 'DENIED_UNKNOWN_OWNER'
  | 'DENIED_COMPANY'
  | 'DENIED_NOT_AUTHOR';

export type RecordPackageExportAuthorizationOutcome = {
  readonly allowed: boolean;
  readonly reason: RecordPackageExportAuthorizationReason;
};

/**
 * 工程师导出时的资源级口径：哪些资源类型要求"作者本人"。
 *
 * - 报告／资料：来源域「我的资料记录」页面谓词＝作者本人 ⇒ 要求本人；
 * - 工单：来源域工程师列表可见**本公司全部工单** ⇒ 按公司范围。
 */
const AUTHOR_SCOPED_RESOURCE_TYPES: readonly RecordPackageResourceType[] = [
  'REFERENCE_DOCUMENT',
  'MAINTENANCE_REPORT',
];

/**
 * 导出逐条授权裁决（纯函数）。
 *
 * 判定顺序：
 * 1. 一级管理员 → 全局授权范围，放行；
 * 2. 归属未知 → 拒绝（宁可不出条目，也不猜归属）；
 * 3. 归属公司与查看方公司不一致 → 拒绝（跨公司直接请求）；
 * 4. 二级管理员 → 本公司范围，放行；
 * 5. 工程师：报告／资料必须是作者本人；工单按本公司范围。
 */
export function resolveRecordPackageExportAuthorization(input: {
  sessionAccountId: number;
  scope: LocalRuntimeViewerScope;
  resourceType: RecordPackageResourceType;
  record: RecordPackageExportRecordFacts;
}): RecordPackageExportAuthorizationOutcome {
  if (input.scope.role === 'ADMIN_LEVEL_1') {
    return { allowed: true, reason: 'ADMIN_GLOBAL' };
  }

  if (input.record.ownerOrganizationId === null) {
    return { allowed: false, reason: 'DENIED_UNKNOWN_OWNER' };
  }

  if (input.scope.organizationId === null) {
    return { allowed: false, reason: 'DENIED_COMPANY' };
  }

  if (input.record.ownerOrganizationId !== input.scope.organizationId) {
    return { allowed: false, reason: 'DENIED_COMPANY' };
  }

  if (input.scope.role === 'ADMIN_LEVEL_2') {
    return { allowed: true, reason: 'COMPANY_SCOPE' };
  }

  if (AUTHOR_SCOPED_RESOURCE_TYPES.includes(input.resourceType)) {
    if (!input.record.relatedAccountIds.includes(input.sessionAccountId)) {
      return { allowed: false, reason: 'DENIED_NOT_AUTHOR' };
    }
    return { allowed: true, reason: 'AUTHOR_SELF' };
  }

  return { allowed: true, reason: 'COMPANY_SCOPE' };
}

/** 授权结论 → 逐条可读的拒绝原因（导出明细展示用） */
export function describeRecordPackageExportDenial(
  reason: RecordPackageExportAuthorizationReason,
): string {
  switch (reason) {
    case 'DENIED_UNKNOWN_OWNER':
      return '记录归属公司未知，无法确认导出授权，该条未导出';
    case 'DENIED_COMPANY':
      return '记录属于其他公司数据区，该条未导出';
    case 'DENIED_NOT_AUTHOR':
      return '工程师只能导出本人创建且本人有权访问的记录，该条未导出';
    default:
      return '记录不在导出授权范围内，该条未导出';
  }
}
