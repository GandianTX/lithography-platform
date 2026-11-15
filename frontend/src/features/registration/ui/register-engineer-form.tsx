// src/features/registration/ui/register-engineer-form.tsx

/**
 * 工程师注册表单。
 *
 * - 姓名、联系电话、登录邮箱、密码与所属公司必填；登录名、昵称、申请说明选填；
 * - 字段顺序按 V44：登录邮箱 → 密码 → 登录名 → 昵称 → 姓名 → 联系电话 → 公司 → 申请说明；
 * - 公司只能从名单选择（只提交 organizationId），不提供手填分支；
 * - 提交中防重复；失败保留非敏感输入并清空密码；
 * - 成功切待审结果区：不创建会话、不跳工作台，只引导前往登录。
 */

import { useCallback, useRef, useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';

import {
  resolveRegisterEngineerErrorMessage,
  submitRegisterEngineer,
} from '../application/register-engineer';
import type { RegistrationOrganizationSelection } from '../application/registration.types';

import {
  createLoginEmailRules,
  createLoginPasswordRules,
  createOptionalLoginNameRules,
  createOptionalNicknameRules,
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
  const { t } = useI18n();
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
      setFeedback({ message: t('register.engineerNeedCompany'), type: 'error' });
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
      setFeedback({ message: resolveRegisterEngineerErrorMessage(error, t), type: 'error' });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (registeredEmail) {
    return (
      <div className="register-success">
        <Alert showIcon title={t('register.engineerSuccess')} type="success" />
        <p className="register-success-email [overflow-wrap:anywhere]">{registeredEmail}</p>
        <Button block type="primary" onClick={() => navigate('/login')}>
          {t('common.goLogin')}
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

      <Form.Item
        label={t('register.realName')}
        name="realName"
        rules={[
          {
            message: t('register.realNameRequired'),
            required: true,
            whitespace: true,
          },
          {
            message: t('register.realNameMax', { max: REAL_NAME_MAX_LENGTH }),
            max: REAL_NAME_MAX_LENGTH,
          },
        ]}
      >
        <Input
          autoComplete="name"
          disabled={isSubmitting}
          placeholder={t('register.realNamePlaceholder')}
        />
      </Form.Item>

      <Form.Item
        label={t('register.phone')}
        name="phone"
        rules={[
          {
            message: t('register.phoneRequired'),
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
                throw new Error(t('register.phoneInvalid'));
              }
            },
          },
          {
            message: t('register.phoneMax', { max: PHONE_MAX_LENGTH }),
            max: PHONE_MAX_LENGTH,
          },
        ]}
      >
        <Input
          autoComplete="tel"
          disabled={isSubmitting}
          placeholder={t('register.phonePlaceholder')}
        />
      </Form.Item>

      <Form.Item label={t('register.company')} required>
        <RegistrationOrganizationSelect
          ariaLabel={t('register.company')}
          disabled={isSubmitting}
          id="engineer-registration-organization"
          onCandidatesChange={handleCandidatesChange}
          onChange={setOrganization}
          value={organization}
        />
      </Form.Item>

      <Form.Item
        label={t('register.applicationNote')}
        name="applicationNote"
        rules={[
          {
            message: t('register.applicationNoteMax', { max: APPLICATION_NOTE_MAX_LENGTH }),
            max: APPLICATION_NOTE_MAX_LENGTH,
          },
        ]}
      >
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={isSubmitting}
          maxLength={APPLICATION_NOTE_MAX_LENGTH}
          placeholder={t('register.applicationNotePlaceholder')}
        />
      </Form.Item>

      <div className="register-actions">
        <Button htmlType="submit" loading={isSubmitting} type="primary">
          {t('register.submitEngineer')}
        </Button>
        <Button onClick={() => navigate('/login')}>{t('register.backLogin')}</Button>
      </div>
    </Form>
  );
}
