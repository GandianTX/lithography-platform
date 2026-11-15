// src/features/account-settings/application/use-account-settings.spec.ts
// @vitest-environment jsdom

/**
 * 账号设置 application Hook 单测。
 *
 * 走真实 Hook，只 mock infrastructure adapter。覆盖：挂载即加载与加载失败收敛、
 * 写命令的 in-flight 去重（同类拒绝 / 异类不阻塞）、陈旧响应防护（序列推进即整体丢弃）、
 * 未分类错误的兜底文案，以及日志安全边界（改密失败日志不得携带明文密码）。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import * as accountSettingsAdapter from '../infrastructure/account-settings-adapter';

import type {
  AccountSettingsProfileDraft,
  AccountSettingsProfileUpdateResult,
  AccountSettingsView,
  ChangeMyPasswordOutcome,
  ChangeMyPasswordResult,
  CustomerCompanySupplementDraft,
  CustomerCompanySupplementResult,
} from './account-settings.types';
import type { AccountSettingsCommandExecution } from './use-account-settings';
import { useAccountSettings } from './use-account-settings';

type ProfileExecution = AccountSettingsCommandExecution<AccountSettingsProfileUpdateResult>;
type PasswordExecution = AccountSettingsCommandExecution<ChangeMyPasswordResult>;
type SupplementExecution = AccountSettingsCommandExecution<CustomerCompanySupplementResult>;

vi.mock('../infrastructure/account-settings-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof accountSettingsAdapter>();

  return {
    ...actual,
    changeMyPassword: vi.fn(),
    fetchMyAccountSettings: vi.fn(),
    supplementMyCustomerCompany: vi.fn(),
    updateMyAccountSettingsProfile: vi.fn(),
  };
});

const fetchMock = vi.mocked(accountSettingsAdapter.fetchMyAccountSettings);
const updateProfileMock = vi.mocked(accountSettingsAdapter.updateMyAccountSettingsProfile);
const updatePasswordMock = vi.mocked(accountSettingsAdapter.changeMyPassword);
const supplementMock = vi.mocked(accountSettingsAdapter.supplementMyCustomerCompany);

const SETTINGS: AccountSettingsView = {
  adminLevel: 2,
  companyName: '示例公司',
  contactEmail: 'contact@example.com',
  loginEmail: 'self@example.com',
  loginName: 'self_user',
  nickname: '陈工',
  phone: '13800000000',
  realName: '张三',
  role: 'ENGINEER',
  status: 'ACTIVE',
  trustedCompanyName: '可信公司',
  updatedAt: '2026-01-01T08:00:00.000Z',
};

const RELOADED_SETTINGS: AccountSettingsView = {
  ...SETTINGS,
  nickname: '重新加载的昵称',
  updatedAt: '2026-02-02T08:00:00.000Z',
};

const LOAD_FAILED_MESSAGE = '账号设置加载失败，请稍后重试。';
const UNHANDLED_FALLBACK_MESSAGE = '操作失败，请稍后重试。';

function deferred<T>() {
  let reject: (error: unknown) => void = () => {};
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    reject = rej;
    resolve = res;
  });

  return { promise, reject, resolve };
}

beforeEach(() => {
  fetchMock.mockReset();
  updateProfileMock.mockReset();
  updatePasswordMock.mockReset();
  supplementMock.mockReset();
  fetchMock.mockResolvedValue(SETTINGS);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAccountSettings 读取状态机', () => {
  it('挂载即加载：先 loading，成功后进入 ready 并暴露后端权威视图', async () => {
    const { result } = renderHook(() => useAccountSettings());

    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('transport / auth 类加载失败收敛为 failed 与兜底文案，不额外打印日志', async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'network', message: 'fetch failed' }),
    );
    const { result } = renderHook(() => useAccountSettings());

    await waitFor(() =>
      expect(result.current.state).toEqual({
        message: LOAD_FAILED_MESSAGE,
        status: 'failed',
      }),
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('mapper 守卫抛出的未分类错误同样收敛为 failed，但原始错误保留在控制台', async () => {
    const guardError = new Error('账号设置返回了无法识别的角色。');
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(guardError);
    const { result } = renderHook(() => useAccountSettings());

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toEqual({
      message: LOAD_FAILED_MESSAGE,
      status: 'failed',
    });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), guardError);
  });

  it('enabled=false 时不发起读取，reload 亦不触发；重新启用后按当前事实加载', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAccountSettings({ enabled }),
      { initialProps: { enabled: false } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'loading' });

    act(() => {
      result.current.reload();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reload 可从 failed 恢复到 ready', async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new GraphQLIngressError({ type: 'http', message: '500' }));
    fetchMock.mockResolvedValueOnce(RELOADED_SETTINGS);
    const { result } = renderHook(() => useAccountSettings());

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.isPending('update-profile')).toBe(false);

    act(() => {
      result.current.reload();
    });

    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

const DRAFT: AccountSettingsProfileDraft = { nickname: '新昵称' };

describe('useAccountSettings 资料更新命令', () => {
  it('成功时把 adapter 返回的权威视图写回状态（后端归一结果成为新事实）', async () => {
    const updated: AccountSettingsView = { ...SETTINGS, nickname: '新昵称' };
    updateProfileMock.mockResolvedValue({ isUpdated: true, ok: true, settings: updated });
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: ProfileExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updateProfile(DRAFT);
    });

    expect(execution).toEqual({
      kind: 'ok',
      result: { isUpdated: true, ok: true, settings: updated },
    });
    expect(updateProfileMock).toHaveBeenCalledTimes(1);
    expect(updateProfileMock).toHaveBeenCalledWith(DRAFT);
    expect(result.current.state).toEqual({ settings: updated, status: 'ready' });
    // 写结果自带权威视图，不再触发第二次读取
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('后端判定同值（isUpdated=false）时同样写回权威视图，并原样透传结果', async () => {
    updateProfileMock.mockResolvedValue({ isUpdated: false, ok: true, settings: SETTINGS });
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: ProfileExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updateProfile(DRAFT);
    });

    expect(execution).toEqual({
      kind: 'ok',
      result: { isUpdated: false, ok: true, settings: SETTINGS },
    });
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });
  });

  it('业务拒绝（ok=false）原样透传，不改写已加载的视图', async () => {
    const failure = {
      message: '登录名或登录邮箱已被占用，请更换后重试。',
      ok: false as const,
      reason: 'duplicate-credential' as const,
    };
    updateProfileMock.mockResolvedValue(failure);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: ProfileExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updateProfile(DRAFT);
    });

    expect(execution).toEqual({ kind: 'ok', result: failure });
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('同类命令进行中重复提交被拒，adapter 只被调用一次', async () => {
    const gate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let first: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });
    let second: ProfileExecution = { kind: 'in-flight' };

    await act(async () => {
      first = result.current.updateProfile({ nickname: '第一次' });
      second = await result.current.updateProfile({ nickname: '第二次' });
    });

    expect(second).toEqual({ kind: 'in-flight' });
    expect(updateProfileMock).toHaveBeenCalledTimes(1);
    expect(updateProfileMock).toHaveBeenCalledWith({ nickname: '第一次' });
    expect(result.current.isPending('update-profile')).toBe(true);

    const updated: AccountSettingsView = { ...SETTINGS, nickname: '第一次' };

    await act(async () => {
      gate.resolve({ isUpdated: true, ok: true, settings: updated });
      expect(await first).toEqual({
        kind: 'ok',
        result: { isUpdated: true, ok: true, settings: updated },
      });
    });
    expect(result.current.isPending('update-profile')).toBe(false);
  });
});

describe('useAccountSettings onProfileSaved 回调（页面装配层回写会话昵称）', () => {
  it('资料保存成功且结果未过期时，以权威视图与请求发起前采样的账号 ID 触发一次回调', async () => {
    const onProfileSaved = vi.fn();
    const sampleAccountId = vi.fn(() => 900201);
    const updated: AccountSettingsView = { ...SETTINGS, nickname: '侧栏新昵称' };
    updateProfileMock.mockResolvedValue({ isUpdated: true, ok: true, settings: updated });
    const { result } = renderHook(() => useAccountSettings({ onProfileSaved, sampleAccountId }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: ProfileExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updateProfile({ nickname: '侧栏新昵称' });
    });

    expect(execution).toMatchObject({ kind: 'ok' });
    expect(sampleAccountId).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledWith(updated, 900201);
  });

  it('身份采样固化在请求发起前：发起后切换账号，迟到响应仍携带发起者身份而非当前账号', async () => {
    const onProfileSaved = vi.fn();
    // 请求发起时会话是 A（900201）；响应返回前会话切到 B（900202）
    let currentAccountId = 900201;
    const sampleAccountId = vi.fn(() => currentAccountId);
    const updated: AccountSettingsView = { ...SETTINGS, nickname: 'A 保存的昵称' };
    const gate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useAccountSettings({ onProfileSaved, sampleAccountId }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let first: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });

    await act(async () => {
      first = result.current.updateProfile({ nickname: 'A 保存的昵称' });
    });
    // 请求已在途，此时切换会话到 B
    currentAccountId = 900202;

    await act(async () => {
      gate.resolve({ isUpdated: true, ok: true, settings: updated });
      await first;
    });

    // 采样只发生在请求发起前：迟到响应不得把 B 的账号 ID 当作本次保存的身份
    expect(sampleAccountId).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledWith(updated, 900201);
  });

  it('过期写结果（序列已推进）不触发回调', async () => {
    const onProfileSaved = vi.fn();
    const gate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(gate.promise);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(SETTINGS).mockResolvedValueOnce(RELOADED_SETTINGS);
    const { result } = renderHook(() =>
      useAccountSettings({ onProfileSaved, sampleAccountId: () => 900201 }),
    );
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );

    let first: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });

    await act(async () => {
      first = result.current.updateProfile({ nickname: '过期写入' });
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' }),
    );

    await act(async () => {
      gate.resolve({
        isUpdated: true,
        ok: true,
        settings: { ...SETTINGS, nickname: '过期写入' },
      });
      await first;
    });

    // 写结果被整体丢弃：会话真源同样不得被过期昵称覆盖
    expect(onProfileSaved).not.toHaveBeenCalled();
  });

  it('业务拒绝（ok=false）不触发回调', async () => {
    const onProfileSaved = vi.fn();
    updateProfileMock.mockResolvedValue({
      message: '登录名或登录邮箱已被占用，请更换后重试。',
      ok: false as const,
      reason: 'duplicate-credential' as const,
    });
    const { result } = renderHook(() =>
      useAccountSettings({ onProfileSaved, sampleAccountId: () => 900201 }),
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      await result.current.updateProfile(DRAFT);
    });

    expect(onProfileSaved).not.toHaveBeenCalled();
  });

  it('改密成功不触发回调：凭据更新不参与昵称同步，会话字段无从改写', async () => {
    const onProfileSaved = vi.fn();
    updatePasswordMock.mockResolvedValue({ notice: '密码已更新', ok: true });
    const { result } = renderHook(() =>
      useAccountSettings({ onProfileSaved, sampleAccountId: () => 900201 }),
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });

    expect(onProfileSaved).not.toHaveBeenCalled();
  });
});

describe('useAccountSettings 陈旧响应与并发边界', () => {
  it('写命令进行中发起 reload 后，过期写结果被整体丢弃', async () => {
    const gate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(gate.promise);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(SETTINGS).mockResolvedValueOnce(RELOADED_SETTINGS);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );

    let first: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });

    await act(async () => {
      first = result.current.updateProfile({ nickname: '过期写入' });
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' }),
    );

    await act(async () => {
      gate.resolve({
        isUpdated: true,
        ok: true,
        settings: { ...SETTINGS, nickname: '过期写入' },
      });
      expect(await first).toMatchObject({ kind: 'ok' });
    });

    // 序列已推进：过期写结果不得覆盖 reload 后的新事实
    expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' });
  });

  it('资料更新进行中不阻塞改密命令（两类命令各持独立 in-flight 键）', async () => {
    const gate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(gate.promise);
    updatePasswordMock.mockResolvedValue({ notice: '密码已更新', ok: true });
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let profileExecution: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });
    let passwordExecution: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      profileExecution = result.current.updateProfile(DRAFT);
      passwordExecution = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });

    expect(passwordExecution).toEqual({
      kind: 'ok',
      result: { initiatedIdentity: null, notice: '密码已更新', ok: true },
    });
    expect(result.current.isPending('update-profile')).toBe(true);
    expect(result.current.isPending('change-password')).toBe(false);

    await act(async () => {
      gate.resolve({ isUpdated: true, ok: true, settings: SETTINGS });
      await profileExecution;
    });
  });

  it('改密进行中重复提交被拒，adapter 只被调用一次', async () => {
    const gate = deferred<ChangeMyPasswordOutcome>();
    updatePasswordMock.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let first: Promise<PasswordExecution> = Promise.resolve({ kind: 'in-flight' });
    let second: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      first = result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
      second = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Another#Pass2026',
      });
    });

    expect(second).toEqual({ kind: 'in-flight' });
    expect(updatePasswordMock).toHaveBeenCalledTimes(1);
    expect(result.current.isPending('change-password')).toBe(true);

    await act(async () => {
      gate.resolve({ notice: '密码已更新，请使用新密码重新登录', ok: true });
      expect(await first).toMatchObject({ kind: 'ok' });
    });
    expect(result.current.isPending('change-password')).toBe(false);
  });

  it('P3 解耦：改密成功不丢弃在途的资料保存结果（改密不推进设置视图序号）', async () => {
    const profileGate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(profileGate.promise);
    updatePasswordMock.mockResolvedValue({ notice: '密码已更新', ok: true });
    const onProfileSaved = vi.fn();
    const { result } = renderHook(() =>
      useAccountSettings({ onProfileSaved, sampleAccountId: () => 900201 }),
    );
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );

    let profileExecution: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });
    let passwordExecution: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      // 资料保存在途；随后发起改密并等它完成（旧实现：改密推进序号会把资料保存判旧丢弃）
      profileExecution = result.current.updateProfile({ nickname: '并发保存的昵称' });
    });
    await act(async () => {
      passwordExecution = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });
    expect(passwordExecution).toMatchObject({ kind: 'ok' });

    const updated: AccountSettingsView = { ...SETTINGS, nickname: '并发保存的昵称' };

    await act(async () => {
      profileGate.resolve({ isUpdated: true, ok: true, settings: updated });
      await profileExecution;
    });

    // 改密与资料保存序号解耦：资料保存的权威视图照常落盘，昵称照常回写会话真源
    expect(result.current.state).toEqual({ settings: updated, status: 'ready' });
    expect(onProfileSaved).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledWith(updated, 900201);
  });

  it('P3 失败时序：资料保存在途 + 改密业务失败——资料保存结果照常落盘并触发回写', async () => {
    const profileGate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(profileGate.promise);
    // 改密被后端业务拒绝（BAD_USER_INPUT 大类，如当前密码错误）
    updatePasswordMock.mockResolvedValue({
      message: '当前密码不正确，请重试。',
      ok: false,
      reason: 'invalid-input',
    });
    const onProfileSaved = vi.fn();
    const { result } = renderHook(() =>
      useAccountSettings({ onProfileSaved, sampleAccountId: () => 900201 }),
    );
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );

    let profileExecution: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });
    let passwordExecution: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      profileExecution = result.current.updateProfile({ nickname: '并发保存的昵称' });
    });
    await act(async () => {
      passwordExecution = await result.current.updatePassword({
        currentPassword: 'Wrong#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });
    // 业务失败收敛为显式失败结果，不产生任何设置视图事实
    expect(passwordExecution).toEqual({
      kind: 'ok',
      result: {
        message: '当前密码不正确，请重试。',
        ok: false,
        reason: 'invalid-input',
      },
    });
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });

    const updated: AccountSettingsView = { ...SETTINGS, nickname: '并发保存的昵称' };

    await act(async () => {
      profileGate.resolve({ isUpdated: true, ok: true, settings: updated });
      await profileExecution;
    });

    // 改密失败同样不推进设置视图序号：在途资料保存的权威视图照常写回，
    // onProfileSaved 照常触发（装配层借此回写侧栏昵称 + sessionStorage 会话真源）
    expect(result.current.state).toEqual({ settings: updated, status: 'ready' });
    expect(onProfileSaved).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledWith(updated, 900201);
  });

  it('P3 失败时序：资料保存在途 + 改密网络失败——资料保存结果照常落盘并触发回写', async () => {
    const profileGate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(profileGate.promise);
    // transport 类失败（网络中断等）由 adapter reject 上抛，hook 收敛为
    // unhandled-error + 兜底文案（非 ingress 错误走 UNHANDLED_FALLBACK_MESSAGE）
    updatePasswordMock.mockRejectedValue(new Error('network interrupted'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onProfileSaved = vi.fn();
    const { result } = renderHook(() =>
      useAccountSettings({ onProfileSaved, sampleAccountId: () => 900201 }),
    );
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );

    let profileExecution: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });
    let passwordExecution: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      profileExecution = result.current.updateProfile({ nickname: '并发保存的昵称' });
    });
    await act(async () => {
      passwordExecution = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });
    expect(passwordExecution).toEqual({
      kind: 'unhandled-error',
      message: '操作失败，请稍后重试。',
    });
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });

    const updated: AccountSettingsView = { ...SETTINGS, nickname: '并发保存的昵称' };

    await act(async () => {
      profileGate.resolve({ isUpdated: true, ok: true, settings: updated });
      await profileExecution;
    });

    // 网络失败路径同样不推进设置视图序号：资料保存结果照常写回并触发回写回调
    expect(result.current.state).toEqual({ settings: updated, status: 'ready' });
    expect(onProfileSaved).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledWith(updated, 900201);
    consoleErrorSpy.mockRestore();
  });

  it('P3 解耦：改密在途不干扰 reload 读取（读取结果照常呈现）', async () => {
    const gate = deferred<ChangeMyPasswordOutcome>();
    updatePasswordMock.mockReturnValue(gate.promise);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(SETTINGS).mockResolvedValueOnce(RELOADED_SETTINGS);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );

    let passwordExecution: Promise<PasswordExecution> = Promise.resolve({ kind: 'in-flight' });

    await act(async () => {
      passwordExecution = result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' }),
    );

    await act(async () => {
      gate.resolve({ notice: '密码已更新，请使用新密码重新登录', ok: true });
      await passwordExecution;
    });

    // 改密完成不推翻 reload 已呈现的视图（改密本就不写设置视图）
    expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' });
  });
});

describe('useAccountSettings 改密会话代次采样（迟到响应裁决依据）', () => {
  it('改密成功结果携带请求发起前采样的会话身份，采样只发生一次', async () => {
    const sampleSessionIdentity = vi.fn(() => ({ accountId: 900201, epoch: 1 }));
    updatePasswordMock.mockResolvedValue({ notice: '密码已更新', ok: true });
    const { result } = renderHook(() => useAccountSettings({ sampleSessionIdentity }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });

    expect(sampleSessionIdentity).toHaveBeenCalledTimes(1);
    expect(execution).toEqual({
      kind: 'ok',
      result: {
        initiatedIdentity: { accountId: 900201, epoch: 1 },
        notice: '密码已更新',
        ok: true,
      },
    });
  });

  it('身份固化在请求发起前：响应在途期间切换会话，迟到结果仍携带发起时身份', async () => {
    let currentIdentity: { accountId: number; epoch: number } | null = {
      accountId: 900201,
      epoch: 1,
    };
    const sampleSessionIdentity = vi.fn(() => currentIdentity);
    const gate = deferred<ChangeMyPasswordOutcome>();
    updatePasswordMock.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useAccountSettings({ sampleSessionIdentity }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let first: Promise<PasswordExecution> = Promise.resolve({ kind: 'in-flight' });

    await act(async () => {
      first = result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });
    // 请求已在途，此时退出重登（同账号新代次）或切换账号：采样面返回新身份
    currentIdentity = { accountId: 900202, epoch: 3 };

    await act(async () => {
      gate.resolve({ notice: '密码已更新，请使用新密码重新登录', ok: true });
      await first;
    });

    // 采样只发生在请求发起前：迟到响应不得把切换后的会话身份当作本次改密的身份
    expect(sampleSessionIdentity).toHaveBeenCalledTimes(1);
    expect(await first).toEqual({
      kind: 'ok',
      result: {
        initiatedIdentity: { accountId: 900201, epoch: 1 },
        notice: '密码已更新，请使用新密码重新登录',
        ok: true,
      },
    });
  });

  it('装配层未接入采样时成功结果携带 null 身份，业务拒绝结果不携带身份', async () => {
    updatePasswordMock
      .mockResolvedValueOnce({ notice: '密码已更新', ok: true })
      .mockResolvedValueOnce({ message: '当前密码不正确', ok: false, reason: 'invalid-input' });
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let success: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      success = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });

    expect(success).toEqual({
      kind: 'ok',
      result: { initiatedIdentity: null, notice: '密码已更新', ok: true },
    });

    let failure: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      failure = await result.current.updatePassword({
        currentPassword: 'Wrong#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });

    expect(failure).toEqual({
      kind: 'ok',
      result: { message: '当前密码不正确', ok: false, reason: 'invalid-input' },
    });
  });
});

describe('useAccountSettings 错误收敛与日志安全边界', () => {
  it('资料更新的未分类错误返回兜底文案，日志只带 error 对象不带命令入参', async () => {
    const boom = new TypeError('unexpected');
    updateProfileMock.mockRejectedValue(boom);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: ProfileExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updateProfile({ realName: 'sensitive_real_name' });
    });

    expect(execution).toEqual({
      kind: 'unhandled-error',
      message: UNHANDLED_FALLBACK_MESSAGE,
    });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), boom);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'sensitive_real_name',
    );
    expect(result.current.isPending('update-profile')).toBe(false);
  });

  it('资料更新的 ingress 错误使用共享 userMessage，且不额外打印日志', async () => {
    updateProfileMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'network', message: 'fetch failed' }),
    );
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: ProfileExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updateProfile(DRAFT);
    });

    expect(execution).toEqual({
      kind: 'unhandled-error',
      message: '网络连接异常，请稍后重试。',
    });
    expect(console.error).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });
  });

  it('改密的未分类错误只记录 error 对象，日志与结果中都不出现明文密码', async () => {
    const boom = new TypeError('unexpected');
    updatePasswordMock.mockRejectedValue(boom);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });

    expect(execution).toEqual({
      kind: 'unhandled-error',
      message: UNHANDLED_FALLBACK_MESSAGE,
    });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), boom);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);

    expect(logged).not.toContain('Old#Pass2026');
    expect(logged).not.toContain('Str0ng#Pass2026');
  });

  it('改密的 ingress 错误使用共享 userMessage，且不额外打印日志', async () => {
    updatePasswordMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'auth', message: 'token invalid' }),
    );
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: PasswordExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.updatePassword({
        currentPassword: 'Old#Pass2026',
        newPassword: 'Str0ng#Pass2026',
      });
    });

    expect(execution).toEqual({
      kind: 'unhandled-error',
      message: '登录状态已失效，请重新登录后再试。',
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});

const EXISTING_DRAFT: CustomerCompanySupplementDraft = { kind: 'existing', organizationId: 11 };

describe('useAccountSettings 公司补录命令', () => {
  it('成功时把 adapter 返回的权威视图写回状态，并原样透传结果', async () => {
    const bound: AccountSettingsView = {
      ...SETTINGS,
      role: 'CUSTOMER',
      trustedCompanyName: '受管公司甲',
    };
    const success: CustomerCompanySupplementResult = {
      isUpdated: true,
      ok: true,
      sameNamedCompanyName: null,
      settings: bound,
    };
    supplementMock.mockResolvedValue(success);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: SupplementExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.supplementCompany(EXISTING_DRAFT);
    });

    expect(execution).toEqual({ kind: 'ok', result: success });
    expect(supplementMock).toHaveBeenCalledTimes(1);
    expect(supplementMock).toHaveBeenCalledWith(EXISTING_DRAFT);
    expect(result.current.state).toEqual({ settings: bound, status: 'ready' });
    // 写结果自带权威视图，不再触发第二次读取
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.isPending('supplement-company')).toBe(false);
  });

  it('幂等命中（isUpdated=false）同样写回权威视图并透传结果', async () => {
    const success: CustomerCompanySupplementResult = {
      isUpdated: false,
      ok: true,
      sameNamedCompanyName: null,
      settings: SETTINGS,
    };
    supplementMock.mockResolvedValue(success);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: SupplementExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.supplementCompany(EXISTING_DRAFT);
    });

    expect(execution).toEqual({ kind: 'ok', result: success });
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });
  });

  it('业务拒绝（ok=false，如已被补录的并发场景）原样透传，不改写已加载的视图', async () => {
    const failure = {
      message: '当前账号已有公司归属，不能重复补录或更换。',
      ok: false as const,
      reason: 'already-bound' as const,
    };
    supplementMock.mockResolvedValue(failure);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: SupplementExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.supplementCompany(EXISTING_DRAFT);
    });

    expect(execution).toEqual({ kind: 'ok', result: failure });
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('同类命令进行中重复提交被拒，adapter 只被调用一次', async () => {
    const gate = deferred<CustomerCompanySupplementResult>();
    supplementMock.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let first: Promise<SupplementExecution> = Promise.resolve({ kind: 'in-flight' });
    let second: SupplementExecution = { kind: 'in-flight' };

    await act(async () => {
      first = result.current.supplementCompany({ kind: 'existing', organizationId: 11 });
      second = await result.current.supplementCompany({
        kind: 'self-filled',
        organizationName: '第二次',
      });
    });

    expect(second).toEqual({ kind: 'in-flight' });
    expect(supplementMock).toHaveBeenCalledTimes(1);
    expect(supplementMock).toHaveBeenCalledWith({ kind: 'existing', organizationId: 11 });
    expect(result.current.isPending('supplement-company')).toBe(true);

    await act(async () => {
      gate.resolve({
        isUpdated: true,
        ok: true,
        sameNamedCompanyName: null,
        settings: SETTINGS,
      });
      expect(await first).toMatchObject({ kind: 'ok' });
    });
    expect(result.current.isPending('supplement-company')).toBe(false);
  });

  it('未分类错误返回兜底文案，日志只带 error 对象不带草稿内容', async () => {
    const boom = new TypeError('unexpected');
    supplementMock.mockRejectedValue(boom);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: SupplementExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.supplementCompany({
        kind: 'self-filled',
        organizationName: 'sensitive_company_name',
      });
    });

    expect(execution).toEqual({ kind: 'unhandled-error', message: UNHANDLED_FALLBACK_MESSAGE });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), boom);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'sensitive_company_name',
    );
    expect(result.current.isPending('supplement-company')).toBe(false);
  });

  it('ingress 错误使用共享 userMessage，且不额外打印日志', async () => {
    supplementMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'network', message: 'fetch failed' }),
    );
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let execution: SupplementExecution = { kind: 'in-flight' };

    await act(async () => {
      execution = await result.current.supplementCompany(EXISTING_DRAFT);
    });

    expect(execution).toEqual({
      kind: 'unhandled-error',
      message: '网络连接异常，请稍后重试。',
    });
    expect(console.error).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' });
  });

  it('补录进行中发起 reload 后，过期补录结果被整体丢弃（不覆盖 reload 的新事实）', async () => {
    const gate = deferred<CustomerCompanySupplementResult>();
    supplementMock.mockReturnValue(gate.promise);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(SETTINGS).mockResolvedValueOnce(RELOADED_SETTINGS);
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: SETTINGS, status: 'ready' }),
    );

    let first: Promise<SupplementExecution> = Promise.resolve({ kind: 'in-flight' });

    await act(async () => {
      first = result.current.supplementCompany(EXISTING_DRAFT);
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' }),
    );

    const bound: AccountSettingsView = { ...SETTINGS, trustedCompanyName: '受管公司甲' };

    await act(async () => {
      gate.resolve({
        isUpdated: true,
        ok: true,
        sameNamedCompanyName: null,
        settings: bound,
      });
      expect(await first).toMatchObject({ kind: 'ok' });
    });

    expect(result.current.state).toEqual({ settings: RELOADED_SETTINGS, status: 'ready' });
  });

  it('资料更新进行中不阻塞公司补录（两类命令各持独立 in-flight 键）', async () => {
    const profileGate = deferred<AccountSettingsProfileUpdateResult>();
    updateProfileMock.mockReturnValue(profileGate.promise);
    supplementMock.mockResolvedValue({
      isUpdated: true,
      ok: true,
      sameNamedCompanyName: null,
      settings: SETTINGS,
    });
    const { result } = renderHook(() => useAccountSettings());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let profileExecution: Promise<ProfileExecution> = Promise.resolve({ kind: 'in-flight' });
    let supplementExecution: SupplementExecution = { kind: 'in-flight' };

    await act(async () => {
      profileExecution = result.current.updateProfile(DRAFT);
      supplementExecution = await result.current.supplementCompany(EXISTING_DRAFT);
    });

    expect(supplementExecution).toMatchObject({ kind: 'ok' });
    expect(result.current.isPending('update-profile')).toBe(true);
    expect(result.current.isPending('supplement-company')).toBe(false);

    await act(async () => {
      profileGate.resolve({ isUpdated: true, ok: true, settings: SETTINGS });
      await profileExecution;
    });
  });
});
