// src/features/account-settings/ui/customer-company-supplement.tsx

/**
 * 「公司信息」卡片：缺归属客户的受控自助补录入口。
 *
 * - 已归属（`trustedCompanyName` 非空）：只读展示，不渲染任何补录控件；
 * - 缺归属且具备补录资格（客户角色 + 正常会话）：Radio 二选一——
 *   「从名单选择」检索受管公司，「手填公司名称」按注册侧同口径建档；
 * - 缺归属但无资格：只说明须联系管理员，不渲染表单；
 * - 切换方式时清空另一侧的已选值，提交前再校验一次互斥与长度（后端仍会裁决）；
 * - 成功后由上层把权威视图写回设置状态（本卡片随之变为只读）；手填命中同名受管
 *   公司时追加提示「已单独建档，如需并入请从候选列表选择」（不自动合并）；
 * - 业务拒绝 `already-bound`（并发下已被补录）只提示并触发上层重载，不自行改写视图。
 *
 * 候选资格（ACTIVE 且受管）与补录授权完全由服务端决定，本层不做业务判定。
 */

import { useState } from 'react';
import { Alert, Input, message, Radio, Select, Space, Typography } from 'antd';

import { useI18n } from '@/shared/i18n';
import { PrimaryButton, SecondaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';

import type {
  AccountSettingsView,
  CustomerCompanySupplementDraft,
  CustomerCompanySupplementResult,
} from '../application/account-settings.types';
import type { AccountSettingsCommandExecution } from '../application/use-account-settings';
import { useManagedCompanySearch } from '../application/use-managed-company-search';

/** 与后端 `organization.name` 列长对齐；修改需同步后端契约 */
const COMPANY_NAME_MAX_LENGTH = 100;

type SupplementMode = 'existing' | 'self-filled';

export type CustomerCompanySupplementProps = {
  /** 是否允许自助补录（客户角色 + 正常会话）；由页面装配层按会话事实注入 */
  canSupplement: boolean;
  /** 业务拒绝 `already-bound` 时触发上层按当前事实重载（本卡片不自行改写视图） */
  onRefresh: () => void;
  onSubmit: (
    draft: CustomerCompanySupplementDraft,
  ) => Promise<AccountSettingsCommandExecution<CustomerCompanySupplementResult>>;
  /** 补录成功且结果已写回设置视图后的回调（页面装配层借此刷新会话归属事实） */
  onSupplemented?: (settings: AccountSettingsView) => void | Promise<void>;
  settings: AccountSettingsView;
  submitting: boolean;
};

/** 只读事实行：标签 + 值 */
function ReadonlyCompany({ name }: { name: string | null }) {
  const { t } = useI18n();

  return (
    <Space size={4}>
      <Typography.Text type="secondary">{t('account.field.company')}</Typography.Text>
      <Typography.Text>{name ?? t('common.notLinked')}</Typography.Text>
    </Space>
  );
}

export function CustomerCompanySupplement({
  canSupplement,
  onRefresh,
  onSubmit,
  onSupplemented,
  settings,
  submitting,
}: CustomerCompanySupplementProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<SupplementMode>('existing');
  const [organizationId, setOrganizationId] = useState<number | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const needsSupplement = settings.trustedCompanyName === null;
  const search = useManagedCompanySearch(needsSupplement && canSupplement && mode === 'existing');

  if (!needsSupplement) {
    return (
      <DataCard title={t('account.companyCard')}>
        <div className="flex flex-col gap-2">
          <ReadonlyCompany name={settings.trustedCompanyName} />
          <Typography.Text type="secondary">{t('account.companyReadonly')}</Typography.Text>
        </div>
      </DataCard>
    );
  }

  if (!canSupplement) {
    return (
      <DataCard title={t('account.companyCard')}>
        <div className="flex flex-col gap-2">
          <ReadonlyCompany name={null} />
          <Typography.Text type="secondary">{t('account.companyNoSupplement')}</Typography.Text>
        </div>
      </DataCard>
    );
  }

  const handleModeChange = (nextMode: SupplementMode) => {
    setMode(nextMode);
    setInputError(null);

    // 互斥第一层（UI）：切换即清空另一侧已选值
    if (nextMode === 'existing') {
      setCompanyName('');
    } else {
      setOrganizationId(null);
    }
  };

  const handleSubmit = async () => {
    setInputError(null);

    let draft: CustomerCompanySupplementDraft;

    if (mode === 'existing') {
      if (organizationId === null) {
        setInputError(t('account.companyRequired'));

        return;
      }

      draft = { kind: 'existing', organizationId };
    } else {
      const trimmedName = companyName.trim();

      if (trimmedName === '') {
        setInputError(t('account.companyNameRequired'));

        return;
      }

      if (trimmedName.length > COMPANY_NAME_MAX_LENGTH) {
        setInputError(t('account.companyNameMax', { max: COMPANY_NAME_MAX_LENGTH }));

        return;
      }

      draft = { kind: 'self-filled', organizationName: trimmedName };
    }

    const execution = await onSubmit(draft);

    if (execution.kind === 'unhandled-error') {
      setInputError(execution.message);

      return;
    }

    if (execution.kind === 'in-flight') {
      return;
    }

    const result = execution.result;

    if (!result.ok) {
      setInputError(result.message);

      // 并发下已被补录：提示后按当前事实重载，由后端权威视图决定下一步展示
      if (result.reason === 'already-bound') {
        onRefresh();
      }

      return;
    }

    message.success(result.isUpdated ? t('account.companySaved') : t('account.companyExists'));

    if (result.sameNamedCompanyName !== null) {
      message.info(t('account.sameNamedCompany'));
    }

    void onSupplemented?.(result.settings);
  };

  return (
    <DataCard title={t('account.companyCard')}>
      <div className="flex flex-col gap-4">
        <Typography.Text type="secondary">{t('account.companySupplementIntro')}</Typography.Text>

        <Radio.Group
          onChange={(event) => handleModeChange(event.target.value as SupplementMode)}
          optionType="button"
          options={[
            { label: t('account.companyModeExisting'), value: 'existing' },
            { label: t('account.companyModeSelfFilled'), value: 'self-filled' },
          ]}
          value={mode}
        />

        {mode === 'existing' ? (
          <div className="flex flex-col gap-2">
            <Select
              loading={search.state.status === 'loading'}
              notFoundContent={
                search.state.status === 'loading'
                  ? t('common.loading')
                  : search.state.status === 'ready'
                    ? t('account.companySearchNoMatch')
                    : null
              }
              onChange={(value: number) => {
                setOrganizationId(value);
                setInputError(null);
              }}
              options={
                search.state.status === 'ready'
                  ? search.state.options.map((option) => ({
                      label: option.name,
                      value: option.id,
                    }))
                  : []
              }
              placeholder={t('account.companySearchPlaceholder')}
              showSearch={{ filterOption: false, onSearch: search.setKeyword }}
              value={organizationId ?? undefined}
            />
            {search.state.status === 'failed' ? (
              <Alert
                action={
                  <SecondaryButton onClick={search.retry}>{t('common.retry')}</SecondaryButton>
                }
                title={search.state.message}
                showIcon
                type="error"
              />
            ) : null}
          </div>
        ) : (
          <Input
            maxLength={COMPANY_NAME_MAX_LENGTH}
            onChange={(event) => {
              setCompanyName(event.target.value);
              setInputError(null);
            }}
            placeholder={t('account.companyNamePlaceholder', { max: COMPANY_NAME_MAX_LENGTH })}
            showCount
            value={companyName}
          />
        )}

        {inputError ? <Alert showIcon title={inputError} type="error" /> : null}

        <div>
          <PrimaryButton loading={submitting} onClick={() => void handleSubmit()}>
            {t('account.saveCompany')}
          </PrimaryButton>
        </div>
      </div>
    </DataCard>
  );
}
