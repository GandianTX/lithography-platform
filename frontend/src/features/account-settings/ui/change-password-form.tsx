// src/features/account-settings/ui/change-password-form.tsx

/**
 * 安全设置区块：修改登录密码表单。
 *
 * 前端只做「两次输入一致」的一致性判断，密码强度与格式策略完全以后端校验为准，
 * 后端返回的业务文案原样展示。
 *
 * Token 语义（与后端 `ChangeMyPasswordUsecase` 同口径）：服务端**不**立即撤销已签发的
 * Access Token，旧 Token 按 `JWT_EXPIRES_IN` 自然过期；本链路不做 Token 黑名单、
 * tokenVersion、Refresh Token 或服务端 Session 撤销。修改成功后由**前端**清理本地会话
 * 并跳转登录页——本表单只调用 `onSucceeded`，实际的会话清理与跳转由页面装配层
 * （`pages/account-settings`）完成，本表单不发起任何后续请求。
 */

import { useState } from 'react';
import { Alert, Form, Input, message } from 'antd';

import { useI18n } from '@/shared/i18n';
import { PrimaryButton, SecondaryButton } from '@/shared/ui/buttons';

import type {
  ChangeMyPasswordInput,
  ChangeMyPasswordResult,
  ChangePasswordSessionIdentity,
} from '../application/account-settings.types';
import type { AccountSettingsCommandExecution } from '../application/use-account-settings';

type ChangePasswordFormProps = {
  /**
   * 修改密码成功后的会话收口（登出 + 跳转登录页），由页面装配层提供。
   * 第一参为请求发起前采样固化的会话身份：装配层与当前会话比对——只有发起改密的
   * 那个会话仍是当前会话时才清理并跳转，退出重登 / 已切换账号的迟到响应被忽略。
   *
   * 身份裁决先于成功提示：回调返回（resolved）`false` 表示装配层判定身份已不匹配，
   * 本次迟到响应被完全静默——**不展示成功提示**；返回 `true` 才由本表单展示
   * 后端固定安全提示。回调未提供时视为无裁决点，提示照常展示（表单独立可用）。
   */
  onSucceeded?: (
    initiatedIdentity: ChangePasswordSessionIdentity | null,
  ) => boolean | Promise<boolean>;
  onSubmit: (
    input: ChangeMyPasswordInput,
  ) => Promise<AccountSettingsCommandExecution<ChangeMyPasswordResult>>;
  submitting: boolean;
};

type ChangePasswordFormValues = {
  confirmNewPassword: string;
  currentPassword: string;
  newPassword: string;
};

export function ChangePasswordForm({ onSucceeded, onSubmit, submitting }: ChangePasswordFormProps) {
  const { t } = useI18n();
  const [form] = Form.useForm<ChangePasswordFormValues>();
  const [submitError, setSubmitError] = useState<string | null>(null);

  /**
   * 真实提交失败后清空三个密码输入（含校验态），只保留可见的错误提示：
   * 业务拒绝（当前密码错误 / 弱密码 / 等于默认密码等）与请求失败都不在界面上留存凭据，
   * 也避免用户重试时把旧值误当作本次输入。提交中（in-flight）不清空。
   */
  const clearPasswordInputs = () => {
    form.resetFields(['currentPassword', 'newPassword', 'confirmNewPassword']);
  };

  const handleFinish = async (values: ChangePasswordFormValues) => {
    setSubmitError(null);

    const execution = await onSubmit({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    });

    if (execution.kind !== 'ok') {
      if (execution.kind === 'unhandled-error') {
        setSubmitError(execution.message);
        clearPasswordInputs();
      }

      return;
    }

    const result = execution.result;

    if (!result.ok) {
      setSubmitError(result.message);
      clearPasswordInputs();

      return;
    }

    // 身份裁决先于成功提示：装配层判定「发起会话仍是当前会话」时才展示提示；
    // 迟到响应（退出重登 / 已切换账号）在装配层被忽略，这里完全静默。
    const identityStillMatches = await onSucceeded?.(result.initiatedIdentity);

    if (identityStillMatches === false) {
      return;
    }

    message.success(result.notice);
  };

  return (
    <Form form={form} layout="vertical" onFinish={(values) => void handleFinish(values)}>
      <Form.Item<ChangePasswordFormValues>
        label={t('account.currentPassword')}
        name="currentPassword"
        rules={[{ required: true, message: t('account.currentPasswordRequired') }]}
      >
        <Input.Password autoComplete="current-password" />
      </Form.Item>

      <Form.Item<ChangePasswordFormValues>
        extra={t('account.newPasswordExtra')}
        label={t('account.newPassword')}
        name="newPassword"
        rules={[{ required: true, message: t('account.newPasswordRequired') }]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>

      <Form.Item<ChangePasswordFormValues>
        dependencies={['newPassword']}
        label={t('account.confirmNewPassword')}
        name="confirmNewPassword"
        rules={[
          { required: true, message: t('account.confirmNewPasswordRequired') },
          ({ getFieldValue }) => ({
            validator: (_, value) =>
              value === getFieldValue('newPassword')
                ? Promise.resolve()
                : Promise.reject(new Error(t('account.passwordMismatch'))),
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>

      {submitError ? <Alert showIcon title={submitError} type="error" /> : null}

      <div className="mt-4 flex gap-2">
        <PrimaryButton htmlType="submit" loading={submitting}>
          {t('account.changePassword')}
        </PrimaryButton>
        <SecondaryButton
          disabled={submitting}
          onClick={() => {
            form.resetFields();
            setSubmitError(null);
          }}
        >
          {t('account.reset')}
        </SecondaryButton>
      </div>
    </Form>
  );
}
