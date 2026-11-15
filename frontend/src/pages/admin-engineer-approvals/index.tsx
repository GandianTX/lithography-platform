// src/pages/admin-engineer-approvals/index.tsx

import { AdminEngineerApprovalPanel } from '@/features/admin-engineer-approval';
import { useAuthSession } from '@/features/auth-session';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 工程师注册审批页：只负责标题、布局与组合 feature 公开 UI。
 *
 * 会话等级只用于呈现可见范围提示；授权真源在服务端，
 * 一级全范围、二级仅本公司均由服务端按请求期查库结果独立裁决。
 */
export function AdminEngineerApprovalsPage() {
  const sessionState = useAuthSession();
  const adminLevel = sessionState.session?.adminLevel ?? null;

  return (
    <div className="page-stack">
      <PageHeader
        description="审核工程师注册申请：批准后开通账号与公司成员关系，拒绝时需填写原因。"
        eyebrow="Engineer Approval"
        title="工程师注册审批"
      />

      <AdminEngineerApprovalPanel adminLevel={adminLevel} />
    </div>
  );
}
