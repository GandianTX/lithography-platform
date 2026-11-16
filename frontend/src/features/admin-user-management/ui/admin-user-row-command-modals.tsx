// src/features/admin-user-management/ui/admin-user-row-command-modals.tsx

/**
 * 行级写命令弹窗：启停、重置为默认密码。
 * 两个弹窗共用同一提交契约：onSubmit 返回显式业务结果，ok 时由父组件关闭弹窗并刷新列表；
 * 业务失败展示在弹窗内（不关闭、不清空已选状态）。重置弹窗不收集任何密码字段：
 * 默认密码只来自服务端运行期配置，回包也只展示固定安全提示。
 *
 * 两个弹窗都恒定挂载在 panel 中、只切换 `row`，因此每一个都接入 `useStaleSubmitGuard`：
 * 会话在提交续体回来之前被推进过（切换目标行、关闭后重新打开，含同一个 accountId），
 * 在途提交的续体就属于上一代会话，不得写进当前弹窗的错误区。
 * 注：antd 6.4.3 的 `Modal.handleCancel` 在 `confirmLoading` 为真时会直接 `return`，
 * 而 `submitting` 由宿主传入；守卫不依赖宿主的 loading 接线，详见
 * `shared/ui/dialog-session/use-stale-submit-guard.ts`。
 */

import { Alert, Form, Modal, Radio } from 'antd';

import { useStaleSubmitGuard } from '@/shared/ui/dialog-session';

import type {
  AdminUserCommandResult,
  AdminUserRow,
  AdminUserStatusFilter,
} from '../application/admin-user-management.types';
import {
  ADMIN_USER_STATUS_FILTER_OPTIONS,
  ADMIN_USER_STATUS_LABELS,
  isAdminUserStatusWritable,
} from '../application/admin-user-management-policy';

// 弹窗内表单以行 accountId 为 key：快速切换行时强制重挂载，
// 避免 initialValues 在 Form 未卸载时不生效导致字段残留上一行草稿
function toRowFormKey(row: AdminUserRow | null): string {
  return row === null ? 'none' : `row-${row.accountId}`;
}

type SubmittingModalProps = {
  submitting: boolean;
};

// ---- 启停 ----

type AdminUserStatusModalProps = SubmittingModalProps & {
  onCancel: () => void;
  onSubmit: (input: {
    accountId: number;
    status: AdminUserStatusFilter;
  }) => Promise<AdminUserCommandResult>;
  row: AdminUserRow | null;
};

type StatusFormValues = {
  status: AdminUserStatusFilter;
};

export function AdminUserStatusModal({
  onCancel,
  onSubmit,
  row,
  submitting,
}: AdminUserStatusModalProps) {
  const [form] = Form.useForm<StatusFormValues>();
  const {
    captureSubmitSeq,
    invalidateInFlightSubmit,
    isCurrentSubmitSeq,
    setSubmitError,
    submitError,
  } = useStaleSubmitGuard(row === null ? null : row.accountId);

  const handleFinish = async (values: StatusFormValues) => {
    if (!row) {
      return;
    }

    const submitSeq = captureSubmitSeq();

    setSubmitError(null);

    const result = await onSubmit({ accountId: row.accountId, status: values.status });

    if (!isCurrentSubmitSeq(submitSeq)) {
      return;
    }

    if (!result.ok && result.message) {
      setSubmitError(result.message);
    }
  };

  return (
    <Modal
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      okText="确认"
      open={row !== null}
      title={`启用 / 停用：${row?.nickname ?? ''}`}
      onCancel={() => {
        // 同步推进代次：关闭与「立刻重开同一个 accountId」可能落在同一个事件循环窗口内
        invalidateInFlightSubmit();
        onCancel();
      }}
      onOk={() => void form.submit()}
    >
      {row ? (
        <p>
          当前状态：
          {isAdminUserStatusWritable(row.status)
            ? ADMIN_USER_STATUS_LABELS[row.status]
            : row.status}
          。停用后，目标用户的下一次受保护请求将立即失效。
        </p>
      ) : null}

      <Form
        form={form}
        initialValues={{
          status: row && isAdminUserStatusWritable(row.status) ? row.status : undefined,
        }}
        key={toRowFormKey(row)}
        layout="vertical"
        preserve={false}
        onFinish={(values) => void handleFinish(values)}
      >
        <Form.Item<StatusFormValues>
          label="目标状态"
          name="status"
          rules={[{ required: true, message: '请选择目标状态' }]}
        >
          <Radio.Group
            options={ADMIN_USER_STATUS_FILTER_OPTIONS.map((status) => ({
              value: status,
              label: ADMIN_USER_STATUS_LABELS[status],
            }))}
          />
        </Form.Item>

        {submitError ? <Alert message={submitError} showIcon type="error" /> : null}
      </Form>
    </Modal>
  );
}

// ---- 重置为默认密码 ----

type AdminUserResetPasswordModalProps = SubmittingModalProps & {
  onCancel: () => void;
  onSubmit: (input: { accountId: number }) => Promise<AdminUserCommandResult>;
  row: AdminUserRow | null;
};

/**
 * 重置确认弹窗：不渲染任何密码输入，也不能在客户端指定新密码。
 * 提交只发送目标 `accountId`，服务端读取配置的默认密码并在同一事务里置强制改密。
 */
export function AdminUserResetPasswordModal({
  onCancel,
  onSubmit,
  row,
  submitting,
}: AdminUserResetPasswordModalProps) {
  const {
    captureSubmitSeq,
    invalidateInFlightSubmit,
    isCurrentSubmitSeq,
    setSubmitError,
    submitError,
  } = useStaleSubmitGuard(row === null ? null : row.accountId);

  const handleConfirm = async () => {
    if (!row) {
      return;
    }

    const submitSeq = captureSubmitSeq();

    setSubmitError(null);

    const result = await onSubmit({ accountId: row.accountId });

    if (!isCurrentSubmitSeq(submitSeq)) {
      return;
    }

    if (!result.ok && result.message) {
      setSubmitError(result.message);
    }
  };

  return (
    <Modal
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      okText="重置为默认密码"
      open={row !== null}
      title={`重置密码：${row?.nickname ?? ''}`}
      onCancel={() => {
        // 同步推进代次：关闭与「立刻重开同一个 accountId」可能落在同一个事件循环窗口内
        invalidateInFlightSubmit();
        onCancel();
      }}
      onOk={() => void handleConfirm()}
    >
      {row ? (
        <div className="flex flex-col gap-3">
          <p>
            目标账号：{row.nickname}（账号 ID：{row.accountId}）。
          </p>
          <p>
            确认后，该账号密码将重置为系统默认密码，并要求用户下次登录后立即修改密码；
            已签发的登录态不会立即失效，将在 Access Token 过期后自然退出。
          </p>
        </div>
      ) : null}

      {submitError ? <Alert message={submitError} showIcon type="error" /> : null}
    </Modal>
  );
}
