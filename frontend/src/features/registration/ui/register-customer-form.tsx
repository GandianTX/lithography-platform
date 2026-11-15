// src/features/registration/ui/register-customer-form.tsx

/**
 * 客户注册表单。
 *
 * - 公司归属两条互斥分支：从名单选择（只提交 organizationId）或手填自家公司
 *   名称（只提交 organizationName）；两者都空时前端先给出可操作提示，服务端仍二次校验；
 * - 手填名称与已加载候选同名时只提示、不阻止提交，也不做自动合并；同名提示使用
 *   独立精确查询，不受候选首屏或已加载分页影响；
 * - 提交中防重复；失败保留非敏感输入并清空密码；成功后切结果区，引导前往登录。
 */

import { useRef, useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';

import {
  resolveRegisterCustomerErrorMessage,
  submitRegisterCustomer,
} from '../application/register-customer';
import type { RegistrationOrganizationSelection } from '../application/registration.types';
import { useRegistrationOrganizationNameCheck } from '../application/use-registration-organization-name-check';

import {
  createLoginEmailRules,
  createLoginPasswordRules,
  createOptionalLoginNameRules,
  createOptionalNicknameRules,
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

export function RegisterCustomerForm() {
  const { t } = useI18n();
  const [form] = Form.useForm<RegisterCustomerFormValues>();
  const navigate = useNavigate();
  const submittingRef = useRef(false);
  const [organization, setOrganization] = useState<RegistrationOrganizationSelection | null>(null);
  const [feedback, setFeedback] = useState<RegisterFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const organizationNameValue = Form.useWatch('organizationName', form);

  const hasSameNameCompany = useRegistrationOrganizationNameCheck({
    enabled: organization === null,
    name: organizationNameValue,
  });

  async function handleFinish(values: RegisterCustomerFormValues) {
    if (submittingRef.current) {
      return;
    }

    const organizationName = values.organizationName?.trim() ?? '';
    const loginName = values.loginName?.trim() ?? '';
    const nickname = values.nickname?.trim() ?? '';

    if (!organization && !organizationName) {
      setFeedback({ message: t('register.customerNeedCompany'), type: 'error' });
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
      setFeedback({ message: resolveRegisterCustomerErrorMessage(error, t), type: 'error' });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (registeredEmail) {
    return (
      <div className="register-success">
        <Alert showIcon title={t('register.customerSuccess')} type="success" />
        <p className="register-success-email [overflow-wrap:anywhere]">{registeredEmail}</p>
        <Button block type="primary" onClick={() => navigate('/login')}>
          {t('common.goLogin')}
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

      <Form.Item
        label={t('register.loginEmail')}
        name="loginEmail"
        rules={createLoginEmailRules(t)}
      >
        <Input
          autoCapitalize="none"
          autoComplete="email"
          disabled={isSubmitting}
          placeholder={t('register.loginEmailPlaceholder')}
        />
      </Form.Item>

      <Form.Item
        label={t('register.password')}
        name="loginPassword"
        rules={createLoginPasswordRules(t)}
      >
        <Input.Password
          autoComplete="new-password"
          disabled={isSubmitting}
          placeholder={t('register.passwordPlaceholder')}
        />
      </Form.Item>

      <Form.Item
        label={t('register.loginName')}
        name="loginName"
        rules={createOptionalLoginNameRules(t)}
      >
        <Input
          autoCapitalize="none"
          autoComplete="username"
          disabled={isSubmitting}
          placeholder={t('register.loginNamePlaceholder')}
        />
      </Form.Item>

      <Form.Item
        label={t('register.nickname')}
        name="nickname"
        rules={createOptionalNicknameRules(t)}
      >
        <Input disabled={isSubmitting} placeholder={t('register.nicknamePlaceholder')} />
      </Form.Item>

      <Form.Item label={t('register.company')}>
        <RegistrationOrganizationSelect
          ariaLabel={t('register.company')}
          disabled={isSubmitting}
          id="customer-registration-organization"
          onChange={setOrganization}
          value={organization}
        />
      </Form.Item>

      {organization ? null : (
        <Form.Item
          extra={hasSameNameCompany ? t('register.sameNameHint') : undefined}
          label={t('register.companyOwn')}
          name="organizationName"
          rules={[
            {
              message: t('register.companyNameMax', { max: ORGANIZATION_NAME_MAX_LENGTH }),
              max: ORGANIZATION_NAME_MAX_LENGTH,
            },
          ]}
        >
          <Input disabled={isSubmitting} placeholder={t('register.companyOwnPlaceholder')} />
        </Form.Item>
      )}

      <div className="register-actions">
        <Button htmlType="submit" loading={isSubmitting} type="primary">
          {t('register.submitCustomer')}
        </Button>
        <Button onClick={() => navigate('/login')}>{t('register.backLogin')}</Button>
      </div>
    </Form>
  );
}
