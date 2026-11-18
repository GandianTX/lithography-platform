// src/features/account-settings/ui/account-profile-form.tsx

/**
 * 基础资料区块：姓名（可选）、昵称（必填）、电话与联系邮箱的编辑表单。
 *
 * 公司由账号归属决定，本表单只读展示，不提供编辑控件，也不提交公司字段。
 * 联系邮箱不用于登录，与账号信息区块的「登录邮箱」严格区分；其格式校验**先 trim 再判断**，
 * 与后端「先 `@Transform(trimTextPure)` 再 `@IsEmail`」同序（trim 只作用于校验值，
 * 不改写用户输入过程中的显示值）。
 * 空输入按后端三态语义提交为 null（清空该字段），昵称没有 null 成员、
 * 由必填校验兜住；保存成功后，仅当请求期间用户没有继续输入时才回写权威值：
 * 以「编辑版本」作守卫——onValuesChange 随用户每次输入递增，提交时快照、
 * 成功响应回来时比对；请求期间的任何后续输入都不会被陈旧响应覆盖。
 * 提交前已发生的修改不受影响：提交的即用户所见值，回写仅归一空白差异。
 */

import { useRef, useState } from 'react';
import { Alert, Form, Input, message, Typography } from 'antd';

import { useI18n } from '@/shared/i18n';
import { PrimaryButton } from '@/shared/ui/buttons';

import type {
  AccountSettingsProfileDraft,
  AccountSettingsProfileUpdateResult,
  AccountSettingsView,
} from '../application/account-settings.types';
import type { AccountSettingsCommandExecution } from '../application/use-account-settings';

type AccountProfileFormProps = {
  /**
   * `full`（默认）：账号设置页，可维护姓名、昵称、电话与联系邮箱；
   * `restricted`：受限会话页，不渲染也不提交姓名，公司只读展示可信归属结果，
   * 提交草稿只含昵称、电话与联系邮箱——不得附带公司值、`null` 或其他只读字段
   * （后端白名单对越界字段整体拒绝）。
   */
  mode?: 'full' | 'restricted';
  onSubmit: (
    draft: AccountSettingsProfileDraft,
  ) => Promise<AccountSettingsCommandExecution<AccountSettingsProfileUpdateResult>>;
  settings: AccountSettingsView;
  submitting: boolean;
};

type AccountProfileFormValues = {
  contactEmail: string;
  nickname: string;
  phone: string;
  realName: string;
};

/** 表单空输入 → 三态草稿的 null（清空）；非空 trim 后设置 */
function toOptionalDraftValue(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';

  return trimmed === '' ? null : trimmed;
}

export function AccountProfileForm({
  mode = 'full',
  onSubmit,
  settings,
  submitting,
}: AccountProfileFormProps) {
  const { t } = useI18n();
  const [form] = Form.useForm<AccountProfileFormValues>();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editVersionRef = useRef(0);
  const isRestricted = mode === 'restricted';

  const handleFinish = async (values: AccountProfileFormValues) => {
    setSubmitError(null);
    const editVersionAtSubmit = editVersionRef.current;

    const draft: AccountSettingsProfileDraft = {
      contactEmail: toOptionalDraftValue(values.contactEmail),
      nickname: values.nickname.trim(),
      phone: toOptionalDraftValue(values.phone),
    };

    // 受限会话：姓名不在可维护范围内，提交草稿中不出现该键
    if (!isRestricted) {
      draft.realName = toOptionalDraftValue(values.realName);
    }

    const execution = await onSubmit(draft);

    if (execution.kind !== 'ok') {
      if (execution.kind === 'unhandled-error') {
        setSubmitError(execution.message);
      }

      return;
    }

    const result = execution.result;

    if (!result.ok) {
      setSubmitError(result.message);

      return;
    }

    message.success(result.isUpdated ? t('account.saved') : t('account.unchanged'));

    // setFieldsValue 不触发 onValuesChange，回写不会推进编辑版本
    if (editVersionRef.current === editVersionAtSubmit) {
      form.setFieldsValue({
        contactEmail: result.settings.contactEmail ?? '',
        nickname: result.settings.nickname,
        phone: result.settings.phone ?? '',
        ...(isRestricted ? {} : { realName: result.settings.realName ?? '' }),
      });
    }
  };

  return (
    <Form
      form={form}
      initialValues={{
        contactEmail: settings.contactEmail ?? '',
        nickname: settings.nickname,
        phone: settings.phone ?? '',
        ...(isRestricted ? {} : { realName: settings.realName ?? '' }),
      }}
      layout="vertical"
      onFinish={(values) => void handleFinish(values)}
      onValuesChange={() => {
        editVersionRef.current += 1;
      }}
    >
      {isRestricted ? null : (
        <Form.Item<AccountProfileFormValues> label={t('account.field.realName')} name="realName">
          <Input autoComplete="off" placeholder={t('account.realNamePlaceholder')} />
        </Form.Item>
      )}

      <Form.Item<AccountProfileFormValues>
        label={t('account.field.nickname')}
        name="nickname"
        rules={[{ required: true, whitespace: true, message: t('account.nicknameRequired') }]}
      >
        <Input autoComplete="off" placeholder={t('account.nicknamePlaceholder')} />
      </Form.Item>

      <Form.Item extra={t('account.companyExtra')} label={t('account.field.company')}>
        <Typography.Text>{settings.trustedCompanyName ?? t('common.notLinked')}</Typography.Text>
      </Form.Item>

      <Form.Item<AccountProfileFormValues> label={t('account.field.phone')} name="phone">
        <Input autoComplete="off" />
      </Form.Item>

      <Form.Item<AccountProfileFormValues>
        extra={t('account.contactEmailExtra')}
        label={t('account.field.contactEmail')}
        name="contactEmail"
        rules={[
          {
            message: t('account.contactEmailInvalid'),
            // 只转换**校验值**（与后端「先 @Transform(trimTextPure) 再 @IsEmail」同序）。
            // 刻意不用 Input 的 normalize：那会在用户输入过程中改写显示值，吞掉刚敲下的空格。
            // 纯空白 trim 后成为空串，由 async-validator 的空值短路放行，落到既有清空语义。
            transform: (value: unknown) => (typeof value === 'string' ? value.trim() : value),
            type: 'email',
          },
        ]}
      >
        <Input autoComplete="off" />
      </Form.Item>

      {submitError ? <Alert showIcon title={submitError} type="error" /> : null}

      <div className="mt-4">
        <PrimaryButton htmlType="submit" loading={submitting}>
          {t('account.save')}
        </PrimaryButton>
      </div>
    </Form>
  );
}
