// src/features/account-settings/ui/account-profile-form.tsx

/**
 * 基础资料区块：昵称（必填）、公司名称、电话与联系邮箱的编辑表单。
 *
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
import { Alert, Form, Input, message } from 'antd';

import { PrimaryButton } from '@/shared/ui/buttons';

import type {
  AccountSettingsProfileDraft,
  AccountSettingsProfileUpdateResult,
  AccountSettingsView,
} from '../application/account-settings.types';
import type { AccountSettingsCommandExecution } from '../application/use-account-settings';

type AccountProfileFormProps = {
  /**
   * `full`（默认）：账号设置页，可维护公司名称；
   * `restricted`：受限会话页，公司名称只读展示可信申请结果，提交草稿只含昵称、电话与
   * 联系邮箱——不得附带旧公司值、`null` 或其他只读字段（后端白名单对越界字段整体拒绝）。
   */
  mode?: 'full' | 'restricted';
  onSubmit: (
    draft: AccountSettingsProfileDraft,
  ) => Promise<AccountSettingsCommandExecution<AccountSettingsProfileUpdateResult>>;
  settings: AccountSettingsView;
  submitting: boolean;
};

type AccountProfileFormValues = {
  companyName: string;
  contactEmail: string;
  nickname: string;
  phone: string;
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

    // 受限会话：公司名称由注册申请审核结果决定，提交草稿中不出现该键
    if (!isRestricted) {
      draft.companyName = toOptionalDraftValue(values.companyName);
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

    message.success(result.isUpdated ? '基础资料已保存。' : '基础资料未发生变化。');

    // setFieldsValue 不触发 onValuesChange，回写不会推进编辑版本
    if (editVersionRef.current === editVersionAtSubmit) {
      form.setFieldsValue({
        companyName: result.settings.companyName ?? '',
        contactEmail: result.settings.contactEmail ?? '',
        nickname: result.settings.nickname,
        phone: result.settings.phone ?? '',
      });
    }
  };

  return (
    <Form
      form={form}
      initialValues={{
        companyName: settings.companyName ?? '',
        contactEmail: settings.contactEmail ?? '',
        nickname: settings.nickname,
        phone: settings.phone ?? '',
      }}
      layout="vertical"
      onFinish={(values) => void handleFinish(values)}
      onValuesChange={() => {
        editVersionRef.current += 1;
      }}
    >
      <Form.Item<AccountProfileFormValues>
        label="昵称"
        name="nickname"
        rules={[{ required: true, whitespace: true, message: '请输入昵称' }]}
      >
        <Input autoComplete="off" placeholder="昵称允许重复" />
      </Form.Item>

      <Form.Item<AccountProfileFormValues>
        extra={isRestricted ? '公司名称由注册申请审核结果决定，如需变更请联系管理员。' : undefined}
        label="公司名称"
        name="companyName"
      >
        <Input autoComplete="off" disabled={isRestricted} />
      </Form.Item>

      <Form.Item<AccountProfileFormValues> label="电话" name="phone">
        <Input autoComplete="off" />
      </Form.Item>

      <Form.Item<AccountProfileFormValues>
        extra="联系邮箱不用于登录，仅作联系方式。"
        label="联系邮箱（非登录凭据）"
        name="contactEmail"
        rules={[
          {
            message: '联系邮箱格式不正确',
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
          保存
        </PrimaryButton>
      </div>
    </Form>
  );
}
