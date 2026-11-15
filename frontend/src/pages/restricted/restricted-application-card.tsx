// src/pages/restricted/restricted-application-card.tsx

/**
 * 受限页的「我的工程师申请」卡片。
 *
 * 只读展示本人最新申请：目标公司、状态、提交/审核时间、申请说明与拒绝原因；
 * 数据来自可信会话入口 `myEngineerRegistration`（服务端按会话账号定位，不接受
 * 任何账号或申请 ID）。没有申请记录是正常态，不报错。
 */

import { Descriptions, Typography } from 'antd';

import {
  ENGINEER_REGISTRATION_STATUS_LABELS,
  type EngineerRegistrationStatus,
  useMyEngineerRegistration,
} from '@/features/registration';

import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { StatusPill, type StatusPillTone } from '@/shared/ui/status-pill';

const STATUS_TONES: Record<EngineerRegistrationStatus, StatusPillTone> = {
  APPROVED: 'ok',
  PENDING: 'warn',
  REJECTED: 'critical',
};

export function RestrictedApplicationCard() {
  const { retry, state } = useMyEngineerRegistration();

  if (state.status === 'loading') {
    return (
      <DataCard title="我的工程师申请">
        <LoadingState label="申请信息加载中…" />
      </DataCard>
    );
  }

  if (state.status === 'failed') {
    return (
      <DataCard title="我的工程师申请">
        <ErrorState
          action={<PrimaryButton onClick={retry}>重试</PrimaryButton>}
          description={state.message}
          title="申请信息加载失败"
        />
      </DataCard>
    );
  }

  const { application } = state;
  if (application === null) {
    return (
      <DataCard title="我的工程师申请">
        <Typography.Text type="secondary">当前账号没有工程师注册申请记录。</Typography.Text>
      </DataCard>
    );
  }

  return (
    <DataCard
      extra={
        <StatusPill tone={STATUS_TONES[application.status]}>
          {ENGINEER_REGISTRATION_STATUS_LABELS[application.status]}
        </StatusPill>
      }
      title="我的工程师申请"
    >
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="申请公司">
          {application.organizationName ?? `公司 ID ${application.organizationId}`}
        </Descriptions.Item>
        <Descriptions.Item label="申请说明">{application.applicationNote ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="提交时间">
          {formatDateTimeText(application.submittedAt)}
        </Descriptions.Item>
        <Descriptions.Item label="审核时间">
          {application.reviewedAt === null ? '—' : formatDateTimeText(application.reviewedAt)}
        </Descriptions.Item>
        {application.reviewComment ? (
          <Descriptions.Item label="审核意见">{application.reviewComment}</Descriptions.Item>
        ) : null}
      </Descriptions>
    </DataCard>
  );
}
