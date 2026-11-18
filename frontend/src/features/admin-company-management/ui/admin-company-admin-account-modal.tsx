// src/features/admin-company-management/ui/admin-company-admin-account-modal.tsx

/**
 * 二级管理员账号弹窗（一级管理员按需窄查询）。
 *
 * 列表读面只保留状态与脱敏登录名；本弹窗展示完整登录名与开通状态，
 * 并且是**唯一**的补发入口：只有唯一合法绑定、公司启用、账号未停用且
 * 服务端明确返回 `mustChangePassword=true` 时才出现写操作。
 *
 * 弹窗不接收、不保存任何口令；口令只由成功后的凭据弹窗持有。
 */

import { Alert, Button, Descriptions, Modal, Tag } from 'antd';

import { ErrorState } from '@/shared/ui/error-state';
import { LoadingState } from '@/shared/ui/loading-state';

import {
  ADMIN_COMPANY_BINDING_STATUS_COLORS,
  ADMIN_COMPANY_BINDING_STATUS_LABELS,
  ADMIN_COMPANY_STATUS_LABELS,
  canReissueCompanyAdminCredentialFromDetail,
} from '../application/admin-company-management.policy';
import type { AdminCompanyAdminAccountDetail } from '../application/admin-company-management.types';
import type { AdminCompanyAdminAccountDetailState } from '../application/use-admin-company-admin-account-detail';

type AdminCompanyAdminAccountModalProps = {
  onClose: () => void;
  /** 仅在可补发时提供；宿主负责确认弹窗、代次与身份快照 */
  onReissue?: (detail: AdminCompanyAdminAccountDetail) => void;
  onRetry: () => void;
  state: AdminCompanyAdminAccountDetailState;
};

function renderText(value: string | null): string {
  return value ?? '—';
}

/** 按绑定状态给出可执行的归属说明：不猜账号名，也不提供代建入口 */
function renderStatusHint(detail: AdminCompanyAdminAccountDetail) {
  if (!detail.isManagedCompany) {
    return (
      <Alert
        showIcon
        type="info"
        title="该公司不在受管名单内"
        description="非受管公司不配置二级管理员账号，无需补发或核对。"
      />
    );
  }

  switch (detail.status) {
    case 'UNCONFIGURED':
      return (
        <Alert
          showIcon
          type="warning"
          title="尚未配置二级管理员账号"
          description="请先在用户管理中核对开通情况；本页不提供代建或猜测账号。"
        />
      );
    case 'CONFLICT':
      return (
        <Alert
          showIcon
          type="error"
          title={`归属存在冲突（候选 ${detail.candidateCount} 个）`}
          description="当前无法确定唯一的二级管理员账号，请先在用户管理核对归属；本页不展示任何具体账号。"
        />
      );
    case 'COMPANY_DISABLED':
      return (
        <Alert
          showIcon
          type="warning"
          title="公司已停用，不可补发"
          description="停用公司下的管理员账号不能重置或补发凭据，请先启用公司。"
        />
      );
    case 'BOUND':
      if (detail.accountDisabled) {
        return (
          <Alert
            showIcon
            type="warning"
            title="绑定账号已停用"
            description="停用账号不可补发凭据，请先在用户管理确认账号状态。"
          />
        );
      }
      if (detail.mustChangePassword === false) {
        return (
          <Alert
            showIcon
            type="info"
            title="该账号已完成首次改密"
            description="已改密账号不能补发临时密码；如确需重置，请走用户管理的二级管理员重置流程。"
          />
        );
      }
      if (detail.mustChangePassword === null) {
        return (
          <Alert
            showIcon
            type="info"
            title="无法读取开通状态"
            description="账号记录缺失或暂不可读，请稍后重试；本页不展示补发入口。"
          />
        );
      }
      return null;
    default:
      return null;
  }
}

export function AdminCompanyAdminAccountModal({
  onClose,
  onReissue,
  onRetry,
  state,
}: AdminCompanyAdminAccountModalProps) {
  const detail = state.status === 'ready' ? state.detail : null;
  const showReissue =
    detail !== null &&
    onReissue !== undefined &&
    canReissueCompanyAdminCredentialFromDetail(detail);

  return (
    <Modal
      cancelButtonProps={{ style: { display: 'none' } }}
      destroyOnHidden
      okText="关闭"
      open={state.status !== 'idle'}
      title={detail ? `二级管理员账号：${detail.companyName}` : '二级管理员账号'}
      onCancel={onClose}
      onOk={onClose}
    >
      {state.status === 'loading' ? <LoadingState label="正在读取账号详情…" /> : null}

      {state.status === 'failed' ? (
        <ErrorState
          action={
            <Button size="small" onClick={onRetry}>
              重试
            </Button>
          }
          title={state.message}
        />
      ) : null}

      {detail ? (
        <div className="flex flex-col gap-3">
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="公司编号">{detail.organizationCode}</Descriptions.Item>
            <Descriptions.Item label="公司全称">{detail.companyName}</Descriptions.Item>
            <Descriptions.Item label="公司状态">
              <Tag color={detail.companyStatus === 'ACTIVE' ? 'success' : 'default'}>
                {ADMIN_COMPANY_STATUS_LABELS[detail.companyStatus]}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="绑定状态">
              <Tag color={ADMIN_COMPANY_BINDING_STATUS_COLORS[detail.status]}>
                {ADMIN_COMPANY_BINDING_STATUS_LABELS[detail.status]}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="管理员账号">{renderText(detail.loginName)}</Descriptions.Item>
            <Descriptions.Item label="昵称">{renderText(detail.nickname)}</Descriptions.Item>
            <Descriptions.Item label="开通状态">
              {detail.mustChangePassword === null
                ? '—'
                : detail.mustChangePassword
                  ? '待首次改密'
                  : '已改密'}
            </Descriptions.Item>
          </Descriptions>

          {renderStatusHint(detail)}

          {showReissue ? (
            <div className="flex justify-end">
              <Button onClick={() => onReissue(detail)}>补发临时密码</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
