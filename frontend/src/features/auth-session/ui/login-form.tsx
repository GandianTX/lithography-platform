// src/features/auth-session/ui/login-form.tsx

import { type ReactNode, useRef, useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';

import type { AuthSessionView } from '../application/auth-session.types';
import { resolveLoginErrorMessage } from '../application/login-error';
import { loginWithPassword } from '../auth-session-entry';

type LoginFormValues = {
  loginName: string;
  loginPassword: string;
};

export type LoginFormProps = {
  onAuthenticated?: (session: AuthSessionView) => void;
  // 与登录按钮同组的次要入口（注册链接）。由页面注入，保持认证特性不依赖注册模块。
  secondaryActions?: ReactNode;
};

type LoginFeedback =
  | {
      message: string;
      type: 'error';
    }
  | {
      message: string;
      type: 'success';
    };

export function LoginForm({ onAuthenticated, secondaryActions }: LoginFormProps) {
  const [form] = Form.useForm<LoginFormValues>();
  const submittingRef = useRef(false);
  const [feedback, setFeedback] = useState<LoginFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleFinish(values: LoginFormValues) {
    if (submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setFeedback(null);
    setIsSubmitting(true);

    let authenticatedSession: AuthSessionView | null = null;

    try {
      authenticatedSession = await loginWithPassword(values);
    } catch (error) {
      // 所有登录失败都保留登录名并清空密码，避免失败凭据继续留在表单中；
      // 认证错误与安全文案契约见 backend/docs/api/auth-session-current.md。
      form.setFieldValue('loginPassword', '');

      setFeedback({
        message: resolveLoginErrorMessage(error),
        type: 'error',
      });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }

    if (!authenticatedSession) {
      return;
    }

    form.setFieldValue('loginPassword', '');
    setFeedback({
      message: '登录成功，会话已建立。',
      type: 'success',
    });
    onAuthenticated?.(authenticatedSession);
  }

  return (
    <Form<LoginFormValues>
      form={form}
      layout="vertical"
      name="auth-login"
      requiredMark
      onFinish={handleFinish}
    >
      {feedback ? (
        <div className="mb-4">
          <Alert showIcon title={feedback.message} type={feedback.type} />
        </div>
      ) : null}

      <Form.Item
        label="账号或邮箱"
        name="loginName"
        rules={[
          {
            message: '请输入账号或邮箱。',
            required: true,
            whitespace: true,
          },
        ]}
      >
        <Input
          autoCapitalize="none"
          autoComplete="username"
          disabled={isSubmitting}
          placeholder="请输入账号或邮箱"
        />
      </Form.Item>

      <Form.Item
        label="密码"
        name="loginPassword"
        rules={[
          {
            message: '请输入密码。',
            required: true,
            whitespace: true,
          },
        ]}
      >
        <Input.Password
          autoComplete="current-password"
          disabled={isSubmitting}
          placeholder="请输入密码"
        />
      </Form.Item>

      <Form.Item>
        <div className="login-actions">
          <Button htmlType="submit" loading={isSubmitting} type="primary">
            登录
          </Button>
          {secondaryActions}
        </div>
      </Form.Item>
    </Form>
  );
}
