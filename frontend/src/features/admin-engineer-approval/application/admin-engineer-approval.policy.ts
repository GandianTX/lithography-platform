// src/features/admin-engineer-approval/application/admin-engineer-approval.policy.ts

/**
 * 工程师注册审批的展示策略与输入边界。
 *
 * 权限真源在服务端（请求期查库判定等级与可信公司归属，一级全范围、二级仅本公司）；
 * 本文件只决定**前端呈现口径**与拒绝原因的前置校验。
 */

import type { AdminEngineerRegistrationStatus } from './admin-engineer-approval.types';

/** 审核意见长度上限与后端 `registration-input.normalize.ts` 的 2000 保持一致 */
export const ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH = 2000;

export const ADMIN_ENGINEER_STATUS_OPTIONS: readonly AdminEngineerRegistrationStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
];

export const ADMIN_ENGINEER_STATUS_LABELS: Record<AdminEngineerRegistrationStatus, string> = {
  PENDING: '待审核',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
};

export const ADMIN_ENGINEER_STATUS_COLORS: Record<AdminEngineerRegistrationStatus, string> = {
  PENDING: 'processing',
  APPROVED: 'success',
  REJECTED: 'default',
};

/** 只有待审申请允许出现决定动作；终态一律只读 */
export function canDecide(status: AdminEngineerRegistrationStatus): boolean {
  return status === 'PENDING';
}

/** 拒绝原因：trim 后必须非空，且不超过后端列上限；返回错误文案或 null */
export function findRejectCommentIssue(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === '') {
    return '请填写拒绝原因';
  }

  return trimmed.length > ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH
    ? `拒绝原因最多 ${ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH} 个字符`
    : null;
}

/**
 * 可见范围提示：等级只用于文案，不是授权依据。
 * 等级缺失或非法时不承诺任何范围，避免误导为「全部公司」。
 */
export function resolveAdminEngineerScopeHint(adminLevel: number | null): string {
  if (adminLevel === 1) {
    return '当前账号可查看并审批全部公司的工程师注册申请。';
  }

  if (adminLevel === 2) {
    return '当前账号仅可查看并审批本公司的工程师注册申请。';
  }

  return '当前账号的管理范围以服务端判定为准。';
}
