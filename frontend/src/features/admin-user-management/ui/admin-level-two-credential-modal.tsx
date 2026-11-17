// src/features/admin-user-management/ui/admin-level-two-credential-modal.tsx

/**
 * 一级专用「二级管理员凭据」弹窗（三步：选择目标 → 核对并填写原因 → 展示本次口令）。
 *
 * - 候选只来自一级专用窄查询（已绑定二级管理员），不影响普通用户列表的过滤规则；
 * - 核对区展示公司名称/编号、完整登录名、昵称与账号 ID，原因是必填项（≤200）；
 * - 成功口令只来自本次成功响应，关闭、切换目标、面板卸载即销毁；
 * - 弹窗侧提交代次守卫保证迟到回包不会写进已切换或已关闭的会话。
 */

import { useCallback, useState } from 'react';
import { Alert, Button, Descriptions, Input, message, Modal, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useStaleSubmitGuard } from '@/shared/ui/dialog-session';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { LoadingState } from '@/shared/ui/loading-state';

import type {
  AdminBoundLevelTwoAdmin,
  AdminLevelTwoCredentialView,
} from '../application/admin-user-management.types';
import { useAdminBoundLevelTwoAdmins } from '../application/use-admin-bound-level-two-admins';

export const ADMIN_LEVEL_TWO_REASON_MAX_LENGTH = 200;

export type AdminLevelTwoResetInput = {
  adminAccountId: number;
  companyName: string;
  organizationId: number;
  reason: string;
};

export type AdminLevelTwoResetOutcome = { ok: true } | { ok: false; message: string };

type AdminLevelTwoCredentialModalProps = {
  credential: AdminLevelTwoCredentialView | null;
  open: boolean;
  submitting: boolean;
  /** 关闭整个入口：宿主负责同时清空口令 state */
  onClose: () => void;
  onSubmit: (input: AdminLevelTwoResetInput) => Promise<AdminLevelTwoResetOutcome>;
};

async function copyCredentialText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success('临时密码已复制。');
  } catch {
    message.error('复制失败，请手动选择文本复制。');
  }
}

function renderOptionalText(value: string | null): string {
  return value ?? '—';
}

export function AdminLevelTwoCredentialModal({
  credential,
  open,
  submitting,
  onClose,
  onSubmit,
}: AdminLevelTwoCredentialModalProps) {
  const [target, setTarget] = useState<AdminBoundLevelTwoAdmin | null>(null);
  const [reason, setReason] = useState('');
  const showingCredential = credential !== null;
  const confirming = !showingCredential && target !== null;
  const guard = useStaleSubmitGuard(open ? (target?.accountId ?? 'select') : null);
  const candidates = useAdminBoundLevelTwoAdmins({ enabled: open && !showingCredential });

  const handleClose = useCallback(() => {
    setTarget(null);
    setReason('');
    guard.invalidateInFlightSubmit();
    candidates.reset();
    onClose();
  }, [candidates, guard, onClose]);

  const selectTarget = (row: AdminBoundLevelTwoAdmin) => {
    setReason('');
    guard.invalidateInFlightSubmit();
    setTarget(row);
  };

  const backToSelect = () => {
    setReason('');
    guard.invalidateInFlightSubmit();
    setTarget(null);
  };

  const submitReset = async () => {
    if (target === null) {
      return;
    }

    const trimmedReason = reason.trim();

    if (trimmedReason === '') {
      guard.setSubmitError('请填写重置原因。');
      return;
    }

    const submitSeq = guard.captureSubmitSeq();
    const outcome = await onSubmit({
      adminAccountId: target.accountId,
      companyName: target.companyName,
      organizationId: target.organizationId,
      reason: trimmedReason,
    });

    if (!guard.isCurrentSubmitSeq(submitSeq)) {
      return;
    }

    if (!outcome.ok) {
      // 空消息表示宿主判定本次结果已不属于当前会话（如 in-flight），不覆盖错误区
      if (outcome.message) {
        guard.setSubmitError(outcome.message);
      }

      return;
    }

    // 成功：宿主已把本次口令挂到展示态；清掉本地选择，避免下次打开残留上一个目标与原因
    guard.setSubmitError(null);
    setReason('');
    setTarget(null);
  };

  const columns: ColumnsType<AdminBoundLevelTwoAdmin> = [
    {
      dataIndex: 'companyName',
      ellipsis: true,
      render: (_, row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-bold text-text">{row.companyName}</span>
          <span className="truncate text-text-tertiary text-xs">{row.organizationCode}</span>
        </div>
      ),
      title: '公司',
    },
    {
      dataIndex: 'loginName',
      ellipsis: true,
      render: (_, row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-text">{row.loginName}</span>
          <span className="truncate text-text-tertiary text-xs">
            {renderOptionalText(row.nickname)}
          </span>
        </div>
      ),
      title: '二级管理员',
    },
    {
      dataIndex: 'accountDisabled',
      render: (accountDisabled: boolean) =>
        accountDisabled ? <Tag color="default">账号停用</Tag> : <Tag color="success">正常</Tag>,
      title: '账号状态',
      width: 100,
    },
    {
      fixed: 'right',
      render: (_, row) => (
        <Button
          disabled={row.accountDisabled}
          size="small"
          type="link"
          onClick={() => selectTarget(row)}
        >
          选择
        </Button>
      ),
      title: '操作',
      width: 80,
    },
  ];

  const listState = candidates.state;

  return (
    <Modal
      cancelButtonProps={{ style: { display: 'none' } }}
      destroyOnHidden
      footer={
        showingCredential ? (
          <Button type="primary" onClick={handleClose}>
            我已记录并关闭
          </Button>
        ) : confirming ? (
          <Space>
            <Button disabled={submitting} onClick={backToSelect}>
              上一步
            </Button>
            <Button loading={submitting} type="primary" onClick={() => void submitReset()}>
              确认重置
            </Button>
          </Space>
        ) : (
          <Button onClick={handleClose}>关闭</Button>
        )
      }
      open={open || showingCredential}
      title={
        showingCredential
          ? '二级管理员临时密码'
          : confirming
            ? '核对目标与重置原因'
            : '选择已绑定的二级管理员'
      }
      onCancel={handleClose}
    >
      {showingCredential ? (
        <div className="flex flex-col gap-3">
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="目标公司">{credential.companyName}</Descriptions.Item>
            <Descriptions.Item label="管理员账号">{credential.loginName}</Descriptions.Item>
            <Descriptions.Item label="昵称">
              {renderOptionalText(credential.nickname)}
            </Descriptions.Item>
            <Descriptions.Item label="账号 ID">{credential.adminAccountId}</Descriptions.Item>
            <Descriptions.Item label="重置原因">{credential.reason}</Descriptions.Item>
            <Descriptions.Item label="账号状态">
              <Tag color="warning">待首次改密</Tag>
            </Descriptions.Item>
          </Descriptions>

          <Alert
            showIcon
            type="warning"
            message="本次临时密码只显示一次"
            description="请现在交付给对应管理员；关闭、刷新或离开本页后无法再次查看。旧口令与旧登录会话已作废，账号下次登录会被要求立即改密。"
          />

          <div className="flex flex-col gap-2">
            <span className="text-text-secondary text-sm">临时密码</span>
            <Space.Compact style={{ width: '100%' }}>
              <Input readOnly value={credential.temporaryPassword} />
              <Button onClick={() => void copyCredentialText(credential.temporaryPassword)}>
                复制
              </Button>
            </Space.Compact>
          </div>
        </div>
      ) : confirming ? (
        <div className="flex flex-col gap-3">
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="公司名称">{target.companyName}</Descriptions.Item>
            <Descriptions.Item label="公司编号">{target.organizationCode}</Descriptions.Item>
            <Descriptions.Item label="登录名">{target.loginName}</Descriptions.Item>
            <Descriptions.Item label="昵称">
              {renderOptionalText(target.nickname)}
            </Descriptions.Item>
            <Descriptions.Item label="账号 ID">{target.accountId}</Descriptions.Item>
          </Descriptions>

          <Alert
            showIcon
            type="warning"
            message="重置会立即作废旧口令与旧登录会话"
            description="新临时口令只在成功弹窗中显示一次；请确保目标准确后再提交。"
          />

          <div className="flex flex-col gap-2">
            <span className="text-text-secondary text-sm">
              重置原因（必填，写入审计，最多 {ADMIN_LEVEL_TWO_REASON_MAX_LENGTH} 字）
            </span>
            <Input.TextArea
              maxLength={ADMIN_LEVEL_TWO_REASON_MAX_LENGTH}
              placeholder="例如：管理员遗忘密码，经电话核实后重置"
              rows={3}
              showCount
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          {guard.submitError ? <Alert message={guard.submitError} showIcon type="error" /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            allowClear
            placeholder="搜索公司全称 / 编号 / 登录名 / 昵称"
            value={candidates.keywordDraft}
            onChange={(event) => candidates.setKeywordDraft(event.target.value)}
          />

          {listState.status === 'failed' ? (
            <ErrorState
              action={
                <Button size="small" onClick={candidates.retry}>
                  重试
                </Button>
              }
              title={listState.message}
            />
          ) : null}

          {listState.status === 'loading' || listState.status === 'idle' ? (
            <LoadingState label="正在加载已绑定二级管理员…" />
          ) : null}

          {listState.status === 'ready' && listState.page.items.length > 0 ? (
            <Table<AdminBoundLevelTwoAdmin>
              columns={columns}
              dataSource={listState.page.items}
              pagination={{
                current: listState.page.page,
                onChange: candidates.goToPage,
                pageSize: listState.page.pageSize,
                showSizeChanger: false,
                showTotal: (total) => `共 ${total} 条`,
                total: listState.page.total,
              }}
              rowKey="accountId"
              scroll={{ x: 640 }}
              size="small"
            />
          ) : null}

          {listState.status === 'ready' && listState.page.items.length === 0 ? (
            <EmptyState title="暂无可选已绑定二级管理员。" />
          ) : null}
        </div>
      )}
    </Modal>
  );
}
