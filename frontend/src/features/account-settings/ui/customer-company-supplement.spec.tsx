// src/features/account-settings/ui/customer-company-supplement.spec.tsx
// @vitest-environment jsdom

/**
 * 「公司信息」补录卡片组件单测。
 *
 * 只 mock 候选检索 hook 与 antd message，覆盖：已归属只读（无任何补录控件）、
 * 无资格只读说明、二选一切换清空另一侧、提交前互斥与长度校验、候选与手填两种草稿、
 * 同名提示、业务拒绝 already-bound 触发上层重载、in-flight 到按钮 loading。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccountSettingsView,
  CustomerCompanySupplementDraft,
  CustomerCompanySupplementResult,
} from '../application/account-settings.types';
import type { ManagedCompanySearchState } from '../application/use-managed-company-search';
import * as managedCompanySearchModule from '../application/use-managed-company-search';

import { CustomerCompanySupplement } from './customer-company-supplement';

vi.mock('../application/use-managed-company-search', () => ({
  useManagedCompanySearch: vi.fn(),
}));

const useManagedCompanySearchMock = vi.mocked(managedCompanySearchModule.useManagedCompanySearch);

function makeSettings(overrides: Partial<AccountSettingsView> = {}): AccountSettingsView {
  return {
    adminLevel: null,
    companyName: null,
    contactEmail: null,
    loginEmail: 'customer@example.com',
    loginName: 'customer_alpha',
    nickname: '客户甲',
    phone: null,
    realName: null,
    role: 'CUSTOMER',
    status: 'ACTIVE',
    trustedCompanyName: null,
    updatedAt: '2026-11-01T08:00:00.000Z',
    ...overrides,
  };
}

function mockSearchState(state: ManagedCompanySearchState) {
  useManagedCompanySearchMock.mockReturnValue({
    keyword: '',
    retry: vi.fn(),
    setKeyword: vi.fn(),
    state,
  });
}

function renderCard(
  props: {
    canSupplement?: boolean;
    onSubmit?: (
      draft: CustomerCompanySupplementDraft,
    ) => Promise<
      | { kind: 'ok'; result: CustomerCompanySupplementResult }
      | { kind: 'in-flight' }
      | { kind: 'unhandled-error'; message: string }
    >;
    onSupplemented?: () => void;
    settings?: AccountSettingsView;
    submitting?: boolean;
  } = {},
) {
  const onRefresh = vi.fn();
  const onSubmit = vi.fn(props.onSubmit ?? (async () => ({ kind: 'in-flight' as const })));
  const view = render(
    <CustomerCompanySupplement
      canSupplement={props.canSupplement ?? true}
      onRefresh={onRefresh}
      onSubmit={onSubmit}
      onSupplemented={props.onSupplemented}
      settings={props.settings ?? makeSettings()}
      submitting={props.submitting ?? false}
    />,
  );

  return { onRefresh, onSubmit, view };
}

beforeEach(() => {
  useManagedCompanySearchMock.mockReset();
  mockSearchState({
    options: [
      { id: 11, name: '受管公司甲' },
      { id: 12, name: '受管公司乙' },
    ],
    status: 'ready',
    total: 2,
  });
  vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
  vi.spyOn(message, 'info').mockImplementation(() => undefined as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CustomerCompanySupplement 只读口径', () => {
  it('已归属时只读展示公司，不渲染任何补录控件', () => {
    renderCard({ settings: makeSettings({ trustedCompanyName: '可信公司' }) });

    expect(screen.getByText('可信公司')).toBeInTheDocument();
    expect(screen.getByText('公司由账号归属决定，如需变更请联系管理员。')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存公司信息/ })).toBeNull();
  });

  it('缺归属但无补录资格时只说明联系管理员，不渲染表单', () => {
    renderCard({ canSupplement: false });

    expect(screen.getByText('未关联')).toBeInTheDocument();
    expect(screen.getByText('当前账号不能自助补录公司，请联系管理员处理。')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存公司信息/ })).toBeNull();
  });

  it('缺归属但无资格时不启用候选检索', () => {
    renderCard({ canSupplement: false });

    expect(useManagedCompanySearchMock).toHaveBeenCalledWith(false);
  });
});

describe('CustomerCompanySupplement 二选一与校验', () => {
  it('默认「从名单选择」渲染检索框；切到手填后清空候选侧并渲染输入框', () => {
    renderCard();

    expect(screen.getByRole('combobox')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: '手填公司名称' }));

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByPlaceholderText('请输入公司名称（最多 100 个字符）')).toBeInTheDocument();
  });

  it('未选择公司直接提交时本地拦截，不发命令', async () => {
    const { onSubmit } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /保存公司信息/ }));

    expect(await screen.findByText('请选择一个公司。')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('手填空白名称提交时本地拦截，不发命令', async () => {
    const { onSubmit } = renderCard();

    fireEvent.click(screen.getByRole('radio', { name: '手填公司名称' }));
    fireEvent.change(screen.getByPlaceholderText('请输入公司名称（最多 100 个字符）'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存公司信息/ }));

    expect(await screen.findByText('请输入公司名称。')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('CustomerCompanySupplement 提交结果', () => {
  it('选择候选后提交 existing 草稿，成功展示提示并回调权威视图', async () => {
    const settings = makeSettings({ trustedCompanyName: '受管公司甲' });
    const onSupplemented = vi.fn();
    const { onSubmit } = renderCard({
      onSupplemented,
      onSubmit: async () => ({
        kind: 'ok',
        result: { isUpdated: true, ok: true, sameNamedCompanyName: null, settings },
      }),
    });

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('受管公司甲'));
    fireEvent.click(screen.getByRole('button', { name: /保存公司信息/ }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ kind: 'existing', organizationId: 11 }),
    );
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('公司信息已补充。'));
    expect(message.info).not.toHaveBeenCalled();
    expect(onSupplemented).toHaveBeenCalledWith(settings);
  });

  it('手填公司名去首尾空格后提交，命中同名时追加提示', async () => {
    const onSupplemented = vi.fn();
    const { onSubmit } = renderCard({
      onSupplemented,
      onSubmit: async () => ({
        kind: 'ok',
        result: {
          isUpdated: true,
          ok: true,
          sameNamedCompanyName: '受管公司甲',
          settings: makeSettings({ trustedCompanyName: '甲公司' }),
        },
      }),
    });

    fireEvent.click(screen.getByRole('radio', { name: '手填公司名称' }));
    fireEvent.change(screen.getByPlaceholderText('请输入公司名称（最多 100 个字符）'), {
      target: { value: '  甲公司  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存公司信息/ }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ kind: 'self-filled', organizationName: '甲公司' }),
    );
    expect(message.success).toHaveBeenCalledWith('公司信息已补充。');
    expect(message.info).toHaveBeenCalledWith(
      '已有同名受管公司，本次已单独建档；如需并入该公司，请改从候选列表选择。',
    );
    expect(onSupplemented).toHaveBeenCalledTimes(1);
  });

  it('幂等命中（isUpdated=false）展示「无需重复补充」', async () => {
    renderCard({
      onSubmit: async () => ({
        kind: 'ok',
        result: {
          isUpdated: false,
          ok: true,
          sameNamedCompanyName: null,
          settings: makeSettings({ trustedCompanyName: '受管公司甲' }),
        },
      }),
    });

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('受管公司甲'));
    fireEvent.click(screen.getByRole('button', { name: /保存公司信息/ }));

    await waitFor(() =>
      expect(message.success).toHaveBeenCalledWith('公司信息已存在，无需重复补充。'),
    );
  });

  it('业务拒绝 already-bound 展示后端文案并触发上层重载，不回调成功', async () => {
    const onSupplemented = vi.fn();
    const { onRefresh } = renderCard({
      onSupplemented,
      onSubmit: async () => ({
        kind: 'ok',
        result: {
          message: '当前账号已有公司归属，不能重复补录或更换。',
          ok: false,
          reason: 'already-bound',
        },
      }),
    });

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('受管公司甲'));
    fireEvent.click(screen.getByRole('button', { name: /保存公司信息/ }));

    expect(
      await screen.findByText('当前账号已有公司归属，不能重复补录或更换。'),
    ).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onSupplemented).not.toHaveBeenCalled();
    expect(message.success).not.toHaveBeenCalled();
  });

  it('未分类错误以兜底文案展示，不触发重载', async () => {
    const { onRefresh } = renderCard({
      onSubmit: async () => ({ kind: 'unhandled-error', message: '操作失败，请稍后重试。' }),
    });

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('受管公司甲'));
    fireEvent.click(screen.getByRole('button', { name: /保存公司信息/ }));

    expect(await screen.findByText('操作失败，请稍后重试。')).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('候选加载失败时展示错误与重试入口', () => {
    const retry = vi.fn();
    useManagedCompanySearchMock.mockReturnValue({
      keyword: '',
      retry,
      setKeyword: vi.fn(),
      state: { message: '公司候选加载失败，请稍后重试。', status: 'failed' },
    });
    renderCard();

    expect(screen.getByText('公司候选加载失败，请稍后重试。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('提交中时保存按钮进入 loading', () => {
    renderCard({ submitting: true });

    expect(screen.getByRole('button', { name: /保存公司信息/ })).toHaveClass('ant-btn-loading');
  });
});
