// src/features/admin-company-management/ui/admin-company-credential-modal.tsx

/**
 * 二级管理员凭据弹窗（两个独立导出，避免一个组件承担两种会话语义）。
 *
 * - 确认弹窗：补发前的二次确认，只展示公司名与脱敏登录名，提交由宿主命令 hook 执行；
 * - 展示弹窗：只展示**本次**成功响应里的临时密码，允许受控复制；
 *   回放或口令缺失时只给安全信息与「仍待首次改密可补发」提示。
 *
 * 口令不写入 DOM 之外的任何持久化位置；`destroyOnHidden` 保证关闭后节点与文本一并移除。
 */

import { Alert, Button, Descriptions, Input, message, Modal, Space, Tag } from 'antd';

import type { AdminCompanyCredentialView } from '../application/admin-company-management.types';

export type AdminCompanyReissueTarget = {
  organizationId: number;
  companyName: string;
  loginNameMasked: string | null;
};

type AdminCompanyCredentialConfirmModalProps = {
  errorMessage: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
  target: AdminCompanyReissueTarget | null;
};

export function AdminCompanyCredentialConfirmModal({
  errorMessage,
  onCancel,
  onConfirm,
  submitting,
  target,
}: AdminCompanyCredentialConfirmModalProps) {
  return (
    <Modal
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      okText="确认补发"
      open={target !== null}
      title="补发二级管理员临时密码"
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <div className="flex flex-col gap-3">
        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="目标公司">{target?.companyName ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="管理员账号">{target?.loginNameMasked ?? '—'}</Descriptions.Item>
        </Descriptions>

        <Alert
          showIcon
          type="warning"
          message="补发会立即作废旧口令与旧登录会话"
          description="仅当该账号仍待首次改密时可用；本次生成的新临时口令只在成功弹窗中显示一次。"
        />

        {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}
      </div>
    </Modal>
  );
}

async function copyCredentialText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success('临时密码已复制。');
  } catch {
    message.error('复制失败，请手动选择文本复制。');
  }
}

type AdminCompanyCredentialModalProps = {
  credential: AdminCompanyCredentialView | null;
  onClose: () => void;
};

export function AdminCompanyCredentialModal({
  credential,
  onClose,
}: AdminCompanyCredentialModalProps) {
  const temporaryPassword = credential?.temporaryPassword ?? null;

  return (
    <Modal
      cancelButtonProps={{ style: { display: 'none' } }}
      destroyOnHidden
      okText="我已记录并关闭"
      open={credential !== null}
      title="二级管理员账号凭据"
      onCancel={onClose}
      onOk={onClose}
    >
      <div className="flex flex-col gap-3">
        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="目标公司">
            {credential?.organizationName ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="管理员账号">{credential?.loginName ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="昵称">{credential?.nickname ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="账号状态">
            {credential?.mustChangePassword ? (
              <Tag color="warning">待首次改密</Tag>
            ) : (
              <Tag color="success">已改密</Tag>
            )}
          </Descriptions.Item>
        </Descriptions>

        {temporaryPassword !== null ? (
          <>
            <Alert
              showIcon
              type="warning"
              message="本次临时密码只显示一次"
              description="请现在交付给对应管理员；关闭、刷新或离开本页后无法再次查看。账号下次登录会被要求立即改密。"
            />

            <div className="flex flex-col gap-2">
              <span className="text-text-secondary text-sm">临时密码</span>
              <Space.Compact style={{ width: '100%' }}>
                <Input readOnly value={temporaryPassword} />
                <Button onClick={() => void copyCredentialText(temporaryPassword)}>复制</Button>
              </Space.Compact>
            </div>
          </>
        ) : (
          <Alert
            showIcon
            type="info"
            message="本次未返回新的临时密码"
            description={
              credential?.replayed
                ? '该响应为已提交结果回放，只提供安全信息。若该账号仍待首次改密，可在公司详情中补发一次新的临时密码。'
                : '服务端未返回可用口令。若该账号仍待首次改密，可在公司详情中补发。'
            }
          />
        )}
      </div>
    </Modal>
  );
}
