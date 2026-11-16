// src/features/admin-engineer-approval/application/admin-engineer-approval.policy.spec.ts

/**
 * 审批策略单测：只有 PENDING 可决定；拒绝原因 trim 后必填且有长度上限；
 * 范围提示随会话等级变化，但等级缺失时不承诺全范围。
 */

import { describe, expect, it } from 'vitest';

import {
  ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH,
  canDecide,
  findRejectCommentIssue,
  resolveAdminEngineerScopeHint,
} from './admin-engineer-approval.policy';

describe('canDecide', () => {
  it('仅待审申请允许决定', () => {
    expect(canDecide('PENDING')).toBe(true);
    expect(canDecide('APPROVED')).toBe(false);
    expect(canDecide('REJECTED')).toBe(false);
  });
});

describe('findRejectCommentIssue', () => {
  it('空串与纯空白视为未填写', () => {
    expect(findRejectCommentIssue('')).toBe('请填写拒绝原因');
    expect(findRejectCommentIssue('   \n\t ')).toBe('请填写拒绝原因');
  });

  it('正常原因通过校验', () => {
    expect(findRejectCommentIssue('资料不完整，请补充授权证明')).toBeNull();
    // 首尾空白不计入有效内容，trim 后非空即可
    expect(findRejectCommentIssue('  资料不足  ')).toBeNull();
  });

  it('超过上限时拒绝，并在上限内接受', () => {
    expect(
      findRejectCommentIssue('好'.repeat(ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH)),
    ).toBeNull();
    expect(findRejectCommentIssue('好'.repeat(ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH + 1))).toBe(
      `拒绝原因最多 ${ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH} 个字符`,
    );
  });
});

describe('resolveAdminEngineerScopeHint', () => {
  it('一级与二级分别提示全范围与本公司范围', () => {
    expect(resolveAdminEngineerScopeHint(1)).toContain('全部公司');
    expect(resolveAdminEngineerScopeHint(2)).toContain('本公司');
  });

  it('等级缺失或非法时不承诺任何范围', () => {
    expect(resolveAdminEngineerScopeHint(null)).toBe('当前账号的管理范围以服务端判定为准。');
    expect(resolveAdminEngineerScopeHint(3)).toBe('当前账号的管理范围以服务端判定为准。');
  });
});
