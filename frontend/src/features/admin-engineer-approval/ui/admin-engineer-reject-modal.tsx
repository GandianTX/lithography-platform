// src/features/admin-engineer-approval/ui/admin-engineer-reject-modal.tsx

/**
 * 拒绝申请弹窗：拒绝原因 trim 后必填。
 *
 * 前端校验只负责即时反馈；服务端仍会独立校验并返回 BAD_USER_INPUT。
 * 提交代次守卫以目标申请主键为会话身份：切换目标、关闭后重开都会推进代次，
 * 旧续体晚到时不得把失败文案写进新会话。
 */

import { Alert, Form, Input, Modal } from 'antd';

import { useStaleSubmitGuard } from '@/shared/ui/dialog-session';

import {
  ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH,
  findRejectCommentIssue,
} from '../application/admin-engineer-approval.policy';
import type {
  AdminEngineerRegistrationRow,
  AdminEngineerReviewResult,
} from '../application/admin-engineer-approval.types';

type RejectFormValues = { reviewComment: string };

type AdminEngineerRejectModalProps = {
  onCancel: () => void;
  onSubmit: (reviewComment: string) => Promise<AdminEngineerReviewResult>;
  submitting: boolean;
  target: AdminEngineerRegistrationRow | null;
};

export function AdminEngineerRejectModal({
  onCancel,
  onSubmit,
  submitting,
  target,
}: AdminEngineerRejectModalProps) {
  const [form] = Form.useForm<RejectFormValues>();
  const {
    captureSubmitSeq,
    invalidateInFlightSubmit,
    isCurrentSubmitSeq,
    setSubmitError,
    submitError,
  } = useStaleSubmitGuard(target?.applicationId ?? null);

  const handleFinish = async (values: RejectFormValues) => {
    const submitSeq = captureSubmitSeq();

    setSubmitError(null);

    const result = await onSubmit(values.reviewComment);

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
      okText="确认拒绝"
      open={target !== null}
      title={target ? `拒绝申请：${target.applicant.nickname}` : '拒绝申请'}
      onCancel={() => {
        invalidateInFlightSubmit();
        onCancel();
      }}
      onOk={() => void form.submit()}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        onFinish={(values) => void handleFinish(values)}
      >
        <Form.Item<RejectFormValues>
          extra="拒绝原因会展示给申请人，用于其修改后重新提交。"
          label="拒绝原因"
          name="reviewComment"
          rules={[
            {
              validator: (_: unknown, value: string | undefined) => {
                const issue = findRejectCommentIssue(value ?? '');

                return issue === null ? Promise.resolve() : Promise.reject(new Error(issue));
              },
            },
          ]}
        >
          <Input.TextArea
            autoSize={{ maxRows: 5, minRows: 3 }}
            maxLength={ADMIN_ENGINEER_REVIEW_COMMENT_MAX_LENGTH}
            placeholder="填写拒绝原因"
          />
        </Form.Item>

        {submitError ? <Alert message={submitError} showIcon type="error" /> : null}
      </Form>
    </Modal>
  );
}
