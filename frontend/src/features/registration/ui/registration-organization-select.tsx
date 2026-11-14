// src/features/registration/ui/registration-organization-select.tsx

/**
 * 注册公司选择器（客户 / 工程师注册页共用）。
 *
 * - 公开请求按名称搜索、按页加载；滚动到底或点击「加载更多」追加下一页；
 * - 键盘操作沿用 Ant Design Select 原生能力（聚焦、输入、方向键、回车选择）；
 * - 对外只暴露所选公司 `{ id, name }`，提交时由表单决定是否采用该分支；
 * - 允许清除已选公司（`allowClear`）：客户注册需要能从「选名单公司」切回
 *   「手填自家公司」，清除后回调 `onChange(null)`；
 * - 空名单、加载失败与追加失败均给出可操作的重试入口，重试按钮可键盘触达。
 */

import { useEffect, useMemo } from 'react';
import { Button, Select } from 'antd';
import type { LabeledValue, SelectProps } from 'antd/es/select';

import type {
  RegistrationOrganizationOption,
  RegistrationOrganizationSelection,
} from '../application/registration.types';
import { useRegistrationOrganizations } from '../application/use-registration-organizations';

type OrganizationSelectOption = {
  label: string;
  value: number;
};

export type RegistrationOrganizationSelectProps = {
  value?: RegistrationOrganizationSelection | null;
  onChange?: (value: RegistrationOrganizationSelection | null) => void;
  /** 当前已加载候选变化时回调（供表单做同名提示，不参与选择逻辑） */
  onCandidatesChange?: (items: RegistrationOrganizationOption[]) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
};

export function RegistrationOrganizationSelect({
  ariaLabel,
  disabled,
  id,
  onCandidatesChange,
  onChange,
  placeholder = '搜索并选择公司',
  value,
}: RegistrationOrganizationSelectProps) {
  const { loadMore, retry, search, state } = useRegistrationOrganizations();

  // 候选列表只在上游 ready 时变化；回调需由调用方保持稳定引用
  useEffect(() => {
    if (state.status === 'ready') {
      onCandidatesChange?.(state.items);
    }
  }, [onCandidatesChange, state]);

  const options = useMemo<OrganizationSelectOption[]>(
    () =>
      state.status === 'ready'
        ? state.items.map((item) => ({ label: item.name, value: item.id }))
        : [],
    [state],
  );

  const notFoundContent = (() => {
    if (state.status === 'loading') {
      return '加载中…';
    }
    if (state.status === 'failed') {
      return '公司名单加载失败';
    }
    return '未找到符合条件的公司';
  })();

  const handlePopupScroll: SelectProps['onPopupScroll'] = (event) => {
    const target = event.target as HTMLElement;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 8) {
      loadMore();
    }
  };

  return (
    <div className="flex w-full flex-col items-start gap-1">
      <Select<LabeledValue, OrganizationSelectOption>
        allowClear
        aria-label={ariaLabel}
        disabled={disabled}
        id={id}
        labelInValue
        loading={state.status === 'loading'}
        notFoundContent={notFoundContent}
        onChange={(next) => {
          if (!next) {
            onChange?.(null);
            return;
          }
          onChange?.({ id: Number(next.value), name: String(next.label ?? '') });
        }}
        onPopupScroll={handlePopupScroll}
        options={options}
        placeholder={placeholder}
        showSearch={{ filterOption: false, onSearch: search }}
        style={{ width: '100%' }}
        value={value ? { label: value.name, value: value.id } : undefined}
      />
      {state.status === 'failed' ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-red-500">{state.message}</span>
          <Button onClick={retry} size="small" type="link">
            重试
          </Button>
        </div>
      ) : null}
      {state.status === 'ready' && state.loadMoreFailed ? (
        <Button onClick={loadMore} size="small" type="link">
          加载更多失败，重试
        </Button>
      ) : null}
      {state.status === 'ready' && !state.loadMoreFailed && state.hasMore ? (
        <Button loading={state.loadingMore} onClick={loadMore} size="small" type="link">
          加载更多
        </Button>
      ) : null}
    </div>
  );
}
