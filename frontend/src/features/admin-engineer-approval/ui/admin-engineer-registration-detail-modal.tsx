// src/features/admin-engineer-approval/ui/admin-engineer-registration-detail-modal.tsx

/**
 * 工程师注册申请详情弹窗（只读）。
 *
 * 详情按主键单独读取，加载中 / 失败（含重试）/ 就绪三态齐全；
 * 只展示审批决策所需的公开资料与申请事实，不出现凭据或不相关账号字段。
 */

import { Button, Descriptions, Modal, Tag } from 'antd';

import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';

import {
  ADMIN_ENGINEER_STATUS_COLORS,
  ADMIN_ENGINEER_STATUS_LABELS,
} from '../application/admin-engineer-approval.policy';
import type { AdminEngineerRegistrationDetailState } from '../application/use-admin-engineer-registration-detail';

type AdminEngineerRegistrationDetailModalProps = {
  onClose: () => void;
  onRetry: () => void;
  state: AdminEngineerRegistrationDetailState;
};

function renderText(value: string | null): string {
  return value ?? '—';
}

export function AdminEngineerRegistrationDetailModal({
  onClose,
  onRetry,
  state,
}: AdminEngineerRegistrationDetailModalProps) {
  const registration = state.status === 'ready' ? state.registration : null;

  return (
    <Modal
      cancelButtonProps={{ style: { display: 'none' } }}
      okText="关闭"
      open={state.status !== 'idle'}
      title={registration ? `注册申请详情：${registration.applicant.nickname}` : '注册申请详情'}
      onCancel={onClose}
      onOk={onClose}
    >
      {state.status === 'loading' ? <LoadingState label="正在加载注册申请详情…" /> : null}

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

      {registration ? (
        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="申请人">{registration.applicant.nickname}</Descriptions.Item>
          <Descriptions.Item label="登录名">
            {renderText(registration.applicant.loginName)}
          </Descriptions.Item>
          <Descriptions.Item label="联系电话">
            {renderText(registration.applicant.phone)}
          </Descriptions.Item>
          <Descriptions.Item label="联系邮箱">
            {renderText(registration.applicant.contactEmail)}
          </Descriptions.Item>
          <Descriptions.Item label="申请公司">
            {renderText(registration.organizationName)}
          </Descriptions.Item>
          <Descriptions.Item label="申请说明">
            {renderText(registration.applicationNote)}
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={ADMIN_ENGINEER_STATUS_COLORS[registration.status]}>
              {ADMIN_ENGINEER_STATUS_LABELS[registration.status]}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="提交时间">
            {formatDateTimeText(registration.submittedAt)}
          </Descriptions.Item>
          <Descriptions.Item label="决定时间">
            {renderText(
              registration.reviewedAt ? formatDateTimeText(registration.reviewedAt) : null,
            )}
          </Descriptions.Item>
          <Descriptions.Item label="审核意见">
            {renderText(registration.reviewComment)}
          </Descriptions.Item>
        </Descriptions>
      ) : null}
    </Modal>
  );
}
