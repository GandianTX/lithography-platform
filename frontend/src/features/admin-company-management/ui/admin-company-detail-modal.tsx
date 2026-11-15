// src/features/admin-company-management/ui/admin-company-detail-modal.tsx

/**
 * 公司档案详情弹窗（一级管理员只读视图）。
 *
 * 详情按主键单独读取，加载中 / 失败（含重试）/ 就绪三态齐全；
 * 数据由 `useAdminCompanyDetail` 持有，本组件只负责渲染，不自行发起请求。
 */

import { Button, Descriptions, Modal, Tag } from 'antd';

import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';

import {
  ADMIN_COMPANY_KIND_LABELS,
  ADMIN_COMPANY_STATUS_LABELS,
} from '../application/admin-company-management.policy';
import type { AdminCompanyDetailState } from '../application/use-admin-company-detail';

type AdminCompanyDetailModalProps = {
  onClose: () => void;
  onRetry: () => void;
  state: AdminCompanyDetailState;
};

function renderText(value: string | null): string {
  return value ?? '—';
}

export function AdminCompanyDetailModal({ onClose, onRetry, state }: AdminCompanyDetailModalProps) {
  const company = state.status === 'ready' ? state.organization : null;

  return (
    <Modal
      cancelButtonProps={{ style: { display: 'none' } }}
      okText="关闭"
      open={state.status !== 'idle'}
      title={company ? `公司详情：${company.name}` : '公司详情'}
      onCancel={onClose}
      onOk={onClose}
    >
      {state.status === 'loading' ? <LoadingState label="正在加载公司详情…" /> : null}

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

      {company ? (
        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="公司编号">{company.organizationCode}</Descriptions.Item>
          <Descriptions.Item label="公司全称">{company.name}</Descriptions.Item>
          <Descriptions.Item label="公司简称">{renderText(company.shortName)}</Descriptions.Item>
          <Descriptions.Item label="联系人姓名">
            {renderText(company.contactName)}
          </Descriptions.Item>
          <Descriptions.Item label="联系电话">{renderText(company.contactPhone)}</Descriptions.Item>
          <Descriptions.Item label="公司邮箱">{renderText(company.contactEmail)}</Descriptions.Item>
          <Descriptions.Item label="地址">{renderText(company.address)}</Descriptions.Item>
          <Descriptions.Item label="备注">{renderText(company.remark)}</Descriptions.Item>
          <Descriptions.Item label="公司启用">
            <Tag color={company.status === 'ACTIVE' ? 'success' : 'default'}>
              {ADMIN_COMPANY_STATUS_LABELS[company.status]}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="提供维修服务">
            <Tag color={company.isServiceProvider ? 'blue' : 'default'}>
              {company.isServiceProvider ? '是' : '否'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="公司类别">
            {ADMIN_COMPANY_KIND_LABELS[company.kind]}
          </Descriptions.Item>
          <Descriptions.Item label="管理名单">
            {company.isManagedCompany ? '受管公司' : '非受管（客户手填）'}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {formatDateTimeText(company.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label="最近更新">
            {formatDateTimeText(company.updatedAt)}
          </Descriptions.Item>
        </Descriptions>
      ) : null}
    </Modal>
  );
}
