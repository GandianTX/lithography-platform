// src/features/registration/ui/register-engineer-form.tsx

/**
 * 工程师注册表单。
 *
 * - 姓名、联系电话、登录邮箱、密码与所属公司必填；登录名、昵称、申请说明选填；
 * - 公司只能从名单选择（只提交 organizationId），不提供手填分支；
 * - 提交中防重复；失败保留非敏感输入并清空密码；
 * - 成功切待审结果区：不创建会话、不跳工作台，只引导前往登录。
 */

import { useCallback, useRef, useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { Link, useNavigate } from 'react-router';

import {
  resolveRegisterEngineerErrorMessage,
  submitRegisterEngineer,
} from '../application/register-engineer';
import type { RegistrationOrganizationSelection } from '../application/registration.types';

import {
  LOGIN_EMAIL_RULES,
  LOGIN_PASSWORD_RULES,
  OPTIONAL_LOGIN_NAME_RULES,
  OPTIONAL_NICKNAME_RULES,
} from './registration-form-rules';
import { RegistrationOrganizationSelect } from './registration-organization-select';

type RegisterEngineerFormValues = {
  realName: string;
  phone: string;
  loginEmail: string;
  loginPassword: string;
  loginName?: string;
  nickname?: string;
  applicationNote?: string;
};

type RegisterFeedback = {
  message: string;
  type: 'error';
};

const REAL_NAME_MAX_LENGTH = 200;
const PHONE_MAX_LENGTH = 20;
const APPLICATION_NOTE_MAX_LENGTH = 2000;

export function RegisterEngineerForm() {
  const [form] = Form.useForm<RegisterEngineerFormValues>();
  const navigate = useNavigate();
  const submittingRef = useRef(false);
  const [organization, setOrganization] = useState<RegistrationOrganizationSelection | null>(null);
  const [feedback, setFeedback] = useState<RegisterFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  const handleCandidatesChange = useCallback(() => undefined, []);

  async function handleFinish(values: RegisterEngineerFormValues) {
    if (submittingRef.current) {
      return;
    }

    const loginName = values.loginName?.trim() ?? '';
    const nickname = values.nickname?.trim() ?? '';
    const applicationNote = values.applicationNote?.trim() ?? '';

    if (!organization) {
      setFeedback({ message: '请选择所属公司。', type: 'error' });
      return;
    }

    submittingRef.current = true;
    setFeedback(null);
    setIsSubmitting(true);

    try {
      await submitRegisterEngineer({
        realName: values.realName,
        phone: values.phone,
        loginEmail: values.loginEmail,
        loginPassword: values.loginPassword,
        loginName: loginName || null,
        nickname: nickname || null,
        organizationId: organization.id,
        applicationNote: applicationNote || null,
      });

      form.setFieldValue('loginPassword', '');
      setRegisteredEmail(values.loginEmail.trim());
    } catch (error) {
      // 失败统一清空密码，其余输入保留，便于修正后重试
      form.setFieldValue('loginPassword', '');
      setFeedback({ message: resolveRegisterEngineerErrorMessage(error), type: 'error' });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (registeredEmail) {
    return (
      <div className="register-success">
        <Alert showIcon title="注册申请已提交，等待所属公司管理员审核。" type="success" />
        <p className="register-success-email">{registeredEmail}</p>
        <Button block type="primary" onClick={() => navigate('/login')}>
          前往登录
        </Button>
      </div>
    );
  }

  return (
    <Form<RegisterEngineerFormValues>
      form={form}
      layout="vertical"
      name="engineer-registration"
      requiredMark
      onFinish={handleFinish}
    >
      {feedback ? (
        <div className="mb-4">
          <Alert showIcon title={feedback.message} type={feedback.type} />
        </div>
      ) : null}

      <Form.Item
        label="姓名"
        name="realName"
        rules={[
          {
            message: '请输入姓名。',
            required: true,
            whitespace: true,
          },
          {
            message: `姓名最多 ${REAL_NAME_MAX_LENGTH} 个字符。`,
            max: REAL_NAME_MAX_LENGTH,
          },
        ]}
      >
        <Input autoComplete="name" disabled={isSubmitting} placeholder="填写真实姓名" />
      </Form.Item>

      <Form.Item
        label="联系电话"
        name="phone"
        rules={[
          {
            message: '请输入联系电话。',
            required: true,
            whitespace: true,
          },
          {
            validator: async (_rule, value: string | undefined) => {
              // 空值交给 required 规则提示，避免同一次校验叠加两条错误
              if (!value?.trim()) {
                return;
              }
              const compact = value.replace(/[\s-]/g, '');
              if (!/^\+?\d{6,20}$/.test(compact)) {
                throw new Error('联系电话格式不正确，请填写 6–20 位数字。');
              }
            },
          },
          {
            message: `联系电话最多 ${PHONE_MAX_LENGTH} 个字符。`,
            max: PHONE_MAX_LENGTH,
          },
        ]}
      >
        <Input autoComplete="tel" disabled={isSubmitting} placeholder="用于审核联系" />
      </Form.Item>

      <Form.Item label="登录邮箱" name="loginEmail" rules={LOGIN_EMAIL_RULES}>
        <Input
          autoCapitalize="none"
          autoComplete="email"
          disabled={isSubmitting}
          placeholder="用于登录与接收通知"
        />
      </Form.Item>

      <Form.Item label="密码" name="loginPassword" rules={LOGIN_PASSWORD_RULES}>
        <Input.Password
          autoComplete="new-password"
          disabled={isSubmitting}
          placeholder="8–128 位，需包含小写字母、数字与特殊字符"
        />
      </Form.Item>

      <Form.Item label="登录名（选填）" name="loginName" rules={OPTIONAL_LOGIN_NAME_RULES}>
        <Input
          autoCapitalize="none"
          autoComplete="username"
          disabled={isSubmitting}
          placeholder="仅支持英文字母、数字、下划线和短横线"
        />
      </Form.Item>

      <Form.Item
        extra="2–20 个字符，支持中英文、数字与 _ - · ."
        label="昵称（选填）"
        name="nickname"
        rules={OPTIONAL_NICKNAME_RULES}
      >
        <Input disabled={isSubmitting} placeholder="用于界面展示" />
      </Form.Item>

      <Form.Item label="所属公司" required>
        <RegistrationOrganizationSelect
          ariaLabel="所属公司"
          disabled={isSubmitting}
          id="engineer-registration-organization"
          onCandidatesChange={handleCandidatesChange}
          onChange={setOrganization}
          value={organization}
        />
      </Form.Item>

      <Form.Item
        extra={`选填，最多 ${APPLICATION_NOTE_MAX_LENGTH} 个字符，供管理员审核参考`}
        label="申请说明（选填）"
        name="applicationNote"
        rules={[
          {
            message: `申请说明最多 ${APPLICATION_NOTE_MAX_LENGTH} 个字符。`,
            max: APPLICATION_NOTE_MAX_LENGTH,
          },
        ]}
      >
        <Input.TextArea disabled={isSubmitting} placeholder="说明加入原因或工作背景" rows={3} />
      </Form.Item>

      <Form.Item>
        <Button block htmlType="submit" loading={isSubmitting} type="primary">
          提交注册申请
        </Button>
      </Form.Item>

      <div className="register-back-login">
        <span>已有账号？</span>
        <Link to="/login">返回登录</Link>
      </div>
    </Form>
  );
}
