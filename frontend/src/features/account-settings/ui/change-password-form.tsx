// src/features/account-settings/ui/change-password-form.tsx

/**
 * 安全设置区块：修改登录密码表单。
 *
 * 前端只做「两次输入一致」的一致性判断，密码强度与格式策略完全以后端校验为准。
 * 后端返回的成功 notice 与 BAD_USER_INPUT errorMessage 是中文业务原文，只在
 * infrastructure 的原始响应契约中保留；本表单面向界面展示，统一按当前界面语言
 * 输出本地化操作反馈（成功／输入被拒／权限拒绝／系统失败），不直接透传后端原文。
 *
 * Token 语义（与后端 `ChangeMyPasswordUsecase` 同口径）：服务端**不**立即撤销已签发的
 * Access Token，旧 Token 按 `JWT_EXPIRES_IN` 自然过期；本链路不做 Token 黑名单、
 * tokenVersion、Refresh Token 或服务端 Session 撤销。修改成功后由**前端**清理本地会话
 * 并跳转登录页——本表单只调用 `onSucceeded`，实际的会话清理与跳转由页面装配层
 * （`pages/account-settings`）完成，本表单不发起任何后续请求。
 */

import { useState } from 'react';
import { Alert, Form, Input, message } from 'antd';

import { type MessageKey, translateNow, useI18n } from '@/shared/i18n';
import { PrimaryButton, SecondaryButton } from '@/shared/ui/buttons';

import type {
  ChangeMyPasswordFailureReason,
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

/**
 * 业务拒绝的稳定原因到界面词条的映射。
 *
 * 生产只保证 `extensions.code` 大类，BAD_USER_INPUT 无法稳定区分「当前密码错误」
 * 与各类新密码策略拒绝，因此合并为一条可操作的本地提示（不依赖后端细码，也不在
 * 前端按中文文案匹配）。禁止/系统失败复用账号命令的既有本地词条。
 */
const PASSWORD_FAILURE_MESSAGE_KEY: Record<ChangeMyPasswordFailureReason, MessageKey> = {
  forbidden: 'account.command.forbidden',
  'invalid-input': 'account.passwordRejected',
  'update-failed': 'account.command.failed',
};

/**
 * 错误状态保留「词条键」而不是已翻译字符串：渲染时按当前 `t` 取值，
 * 失败提示出现后再切换界面语言也能立即更新；transport / unhandled 路径的
 * 文案由 application 层在产生时本地化，按原字符串保留。
 */
type SubmitError = { key: MessageKey; kind: 'message-key' } | { kind: 'text'; text: string };

export function ChangePasswordForm({ onSucceeded, onSubmit, submitting }: ChangePasswordFormProps) {
  const { t } = useI18n();
  const [form] = Form.useForm<ChangePasswordFormValues>();
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

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
        setSubmitError({ kind: 'text', text: execution.message });
        clearPasswordInputs();
      }

      return;
    }

    const result = execution.result;

    if (!result.ok) {
      setSubmitError({ key: PASSWORD_FAILURE_MESSAGE_KEY[result.reason], kind: 'message-key' });
      clearPasswordInputs();

      return;
    }

    // 身份裁决先于成功提示：装配层判定「发起会话仍是当前会话」时才展示提示；
    // 迟到响应（退出重登 / 已切换账号）在装配层被忽略，这里完全静默。
    const identityStillMatches = await onSucceeded?.(result.initiatedIdentity);

    if (identityStillMatches === false) {
      return;
    }

    // 成功提示按**完成时**的界面语言翻译（请求进行中切语言也能得到当前语言文案）。
    message.success(translateNow('account.passwordUpdated'));
  };

  const submitErrorText =
    submitError === null
      ? null
      : submitError.kind === 'message-key'
        ? t(submitError.key)
        : submitError.text;

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

      {submitErrorText ? <Alert showIcon title={submitErrorText} type="error" /> : null}

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
