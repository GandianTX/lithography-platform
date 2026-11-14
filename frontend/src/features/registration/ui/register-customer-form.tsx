// src/features/registration/ui/register-customer-form.tsx

/**
 * 客户注册表单。
 *
 * - 公司归属两条互斥分支：从名单选择（只提交 organizationId）或手填自家公司
 *   名称（只提交 organizationName）；两者都空时前端先给出可操作提示，服务端仍二次校验；
 * - 手填名称与已加载候选同名时只提示、不阻止提交，也不做自动合并；
 * - 提交中防重复；失败保留非敏感输入并清空密码；成功后切结果区，引导前往登录。
 */

import { useCallback, useRef, useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { useNavigate } from 'react-router';

import {
  resolveRegisterCustomerErrorMessage,
  submitRegisterCustomer,
} from '../application/register-customer';
import type {
  RegistrationOrganizationOption,
  RegistrationOrganizationSelection,
} from '../application/registration.types';

import {
  LOGIN_EMAIL_RULES,
  LOGIN_PASSWORD_RULES,
  OPTIONAL_LOGIN_NAME_RULES,
  OPTIONAL_NICKNAME_RULES,
} from './registration-form-rules';
import { RegistrationOrganizationSelect } from './registration-organization-select';

type RegisterCustomerFormValues = {
  loginEmail: string;
  loginPassword: string;
  loginName?: string;
  nickname?: string;
  organizationName?: string;
};

type RegisterFeedback = {
  message: string;
  type: 'error';
};

const ORGANIZATION_NAME_MAX_LENGTH = 200;

function normalizeCompanyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function RegisterCustomerForm() {
  const [form] = Form.useForm<RegisterCustomerFormValues>();
  const navigate = useNavigate();
  const submittingRef = useRef(false);
  const [organization, setOrganization] = useState<RegistrationOrganizationSelection | null>(null);
  const [candidates, setCandidates] = useState<RegistrationOrganizationOption[]>([]);
  const [feedback, setFeedback] = useState<RegisterFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const organizationNameValue = Form.useWatch('organizationName', form);

  const handleCandidatesChange = useCallback((items: RegistrationOrganizationOption[]) => {
    setCandidates(items);
  }, []);

  const normalizedTypedName = normalizeCompanyName(organizationNameValue ?? '');
  const hasSameNameCandidate =
    !organization &&
    normalizedTypedName.length > 0 &&
    candidates.some((item) => normalizeCompanyName(item.name) === normalizedTypedName);

  async function handleFinish(values: RegisterCustomerFormValues) {
    if (submittingRef.current) {
      return;
    }

    const organizationName = values.organizationName?.trim() ?? '';
    const loginName = values.loginName?.trim() ?? '';
    const nickname = values.nickname?.trim() ?? '';

    if (!organization && !organizationName) {
      setFeedback({ message: '请选择所属公司，或填写自家公司名称。', type: 'error' });
      return;
    }

    submittingRef.current = true;
    setFeedback(null);
    setIsSubmitting(true);

    try {
      await submitRegisterCustomer({
        loginEmail: values.loginEmail,
        loginPassword: values.loginPassword,
        loginName: loginName || null,
        nickname: nickname || null,
        organizationId: organization ? organization.id : null,
        organizationName: organization ? null : organizationName || null,
      });

      form.setFieldValue('loginPassword', '');
      setRegisteredEmail(values.loginEmail.trim());
    } catch (error) {
      // 失败统一清空密码，其余输入保留，便于修正后重试
      form.setFieldValue('loginPassword', '');
      setFeedback({ message: resolveRegisterCustomerErrorMessage(error), type: 'error' });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (registeredEmail) {
    return (
      <div className="register-success">
        <Alert showIcon title="账号已开通，请使用登录邮箱与密码登录。" type="success" />
        <p className="register-success-email">{registeredEmail}</p>
        <Button block type="primary" onClick={() => navigate('/login')}>
          前往登录
        </Button>
      </div>
    );
  }

  return (
    <Form<RegisterCustomerFormValues>
      form={form}
      layout="vertical"
      name="customer-registration"
      requiredMark
      onFinish={handleFinish}
    >
      {feedback ? (
        <div className="mb-4">
          <Alert showIcon title={feedback.message} type={feedback.type} />
        </div>
      ) : null}

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

      <Form.Item label="所属公司">
        <RegistrationOrganizationSelect
          ariaLabel="所属公司"
          disabled={isSubmitting}
          id="customer-registration-organization"
          onCandidatesChange={handleCandidatesChange}
          onChange={setOrganization}
          value={organization}
        />
      </Form.Item>

      {organization ? null : (
        <Form.Item
          extra={
            hasSameNameCandidate
              ? '发现同名公司，可从名单选择。手填名称不会自动合并。'
              : '名单中没有自家公司时填写；同名公司不会自动合并。'
          }
          label="自家公司名称"
          name="organizationName"
          rules={[
            {
              message: `公司名称最多 ${ORGANIZATION_NAME_MAX_LENGTH} 个字符。`,
              max: ORGANIZATION_NAME_MAX_LENGTH,
            },
          ]}
        >
          <Input disabled={isSubmitting} placeholder="填写自家公司名称" />
        </Form.Item>
      )}

      <div className="register-actions">
        <Button htmlType="submit" loading={isSubmitting} type="primary">
          注册并开通
        </Button>
        <Button onClick={() => navigate('/login')}>返回登录</Button>
      </div>
    </Form>
  );
}
