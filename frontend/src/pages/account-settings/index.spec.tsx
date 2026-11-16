// src/pages/account-settings/index.spec.tsx
// @vitest-environment jsdom

/**
 * 账号设置页装配层单测。
 *
 * 页面只负责页头、feature 公开 UI 组合，以及两条会话侧写接线：
 * 1. 改密成功后使既有会话失效：仅当「发起改密的那个会话」仍是当前会话（同账号且同
 *    会话代次）时清理 auth-session 的唯一会话真源并跳转登录页；退出重登 / 已切换
 * 账号的迟到响应被忽略——不清理、不跳转，并以返回值 false 告知表单**完全静默
 * （不展示成功提示）**；缓存清理失败不阻断跳转（该口径已下沉到 auth-session 的
 * clearSessionAfterPasswordChange 工厂，由 usecase 单测覆盖）。
 * 2. 资料保存成功后把权威昵称经窄入口回写会话真源：accountId 在**请求发起前**
 *    经 sampleAccountId 采样固化，迟到响应携带发起者身份，由 store 与当前会话
 *    比对拒绝——A 发起保存后切换 B 的场景不会把 A 的昵称写进 B 的会话。
 * feature 之间禁止互相引用，因此这里 mock 面板与 auth-session 的条件登出出口来
 * 验证接线；会话代次本身的裁决语义由 auth-session 的 store / usecase 单测覆盖。
 */

import { useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountSettingsView } from '@/features/account-settings';

const { condLogoutMock, navigateMock, panelState, refreshIdentityMock } = vi.hoisted(() => ({
  condLogoutMock: vi.fn(),
  navigateMock: vi.fn(),
  panelState: {
    capturedAccountId: null as number | null,
    identityToDeliver: null as { accountId: number; epoch: number } | null,
    sampledIdentity: 'unsampled' as 'unsampled' | { accountId: number; epoch: number } | null,
    // 装配层回调的 resolved 返回值（true=身份匹配已清理跳转 / false=迟到响应静默）
    deliveredResult: 'unset' as 'unset' | boolean,
    // 页面按会话事实注入的补录资格（由面板 mock 捕获）
    canSupplementCompany: null as boolean | null,
    // 会话视图桩：`null` 表示匿名会话
    authSession: null as null | { restriction: string; role: string },
  },
  refreshIdentityMock: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/features/account-settings', () => ({
  AccountSettingsPanel: ({
    canSupplementCompany,
    onCompanySupplemented,
    onPasswordChangeSucceeded,
    onProfileSaveSucceeded,
    sampleAccountId,
    sampleSessionIdentity,
  }: {
    canSupplementCompany?: boolean;
    onCompanySupplemented?: () => void | Promise<void>;
    onPasswordChangeSucceeded?: (
      initiatedIdentity: { accountId: number; epoch: number } | null,
    ) => boolean | Promise<boolean>;
    onProfileSaveSucceeded?: (
      settings: { nickname: string },
      expectedAccountId: number | null,
    ) => void;
    sampleAccountId?: () => number | null;
    sampleSessionIdentity?: () => { accountId: number; epoch: number } | null;
  }) => {
    // 捕获页面按会话事实注入的补录资格，供断言透传口径
    panelState.canSupplementCompany = canSupplementCompany ?? null;

    return (
      <>
        <button
          onClick={() => {
            void onCompanySupplemented?.();
          }}
          type="button"
        >
          模拟公司补录成功
        </button>
        <button
          onClick={() => {
            // 模拟改密成功链路：装配层裁决返回值由表单消费（false=完全静默）
            void Promise.resolve(onPasswordChangeSucceeded?.(panelState.identityToDeliver)).then(
              (resolved) => {
                panelState.deliveredResult = resolved === undefined ? 'unset' : resolved;
              },
            );
          }}
          type="button"
        >
          模拟改密成功
        </button>
        <button
          onClick={() => {
            // 模拟改密请求发起前的会话代次采样（hook 在发起前调用 sampleSessionIdentity）
            panelState.sampledIdentity = sampleSessionIdentity?.() ?? null;
          }}
          type="button"
        >
          模拟改密发起采样
        </button>
        <button
          onClick={() => {
            // 模拟 hook 契约：请求发起前采样账号身份
            panelState.capturedAccountId = sampleAccountId?.() ?? null;
          }}
          type="button"
        >
          模拟资料保存发起
        </button>
        <button
          onClick={() => {
            onProfileSaveSucceeded?.({ nickname: 'A 保存的昵称' }, panelState.capturedAccountId);
          }}
          type="button"
        >
          模拟资料保存迟到成功
        </button>
      </>
    );
  },
}));

const TRIGGER_LABEL = '模拟改密成功';

async function renderAccountSettingsPage() {
  vi.doMock('@/features/auth-session', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/features/auth-session')>();

    return {
      ...actual,
      clearSessionAfterPasswordChange: condLogoutMock,
      refreshCurrentAuthSessionIdentity: refreshIdentityMock,
      useAuthSession: () => ({
        session: panelState.authSession,
        status: panelState.authSession === null ? 'anonymous' : 'authenticated',
      }),
    };
  });
  const { AccountSettingsPage } = await import('./index');

  return render(<AccountSettingsPage />);
}

async function currentAuthSession() {
  return (await import('@/features/auth-session')).getCurrentAuthSession();
}
const STORAGE_KEY = 'lithography-platform.auth-session.v1';

// 测试在模块初始化前写入 sessionStorage；随后动态 import 页面，使唯一会话真源按生产
// 启动语义从持久化恢复，不需要测试专用的公共恢复 API。
function establishSession(accountId: number, nickname: string): void {
  window.sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      accessToken: `token-${accountId}`,
      accountId,
      role: 'CUSTOMER',
      userInfo: { accessGroup: ['CUSTOMER'], nickname },
      version: 3,
    }),
  );
}

function readStoredNickname(): string | null {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  return (
    (JSON.parse(raw) as { userInfo?: { nickname?: string } | null }).userInfo?.nickname ?? null
  );
}

beforeEach(() => {
  condLogoutMock.mockReset();
  navigateMock.mockReset();
  refreshIdentityMock.mockReset();
  condLogoutMock.mockResolvedValue(true);
  refreshIdentityMock.mockResolvedValue({ status: 'unchanged' });
  panelState.capturedAccountId = null;
  panelState.identityToDeliver = null;
  panelState.sampledIdentity = 'unsampled';
  panelState.deliveredResult = 'unset';
  panelState.canSupplementCompany = null;
  panelState.authSession = null;
  window.sessionStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  vi.resetModules();
});

describe('AccountSettingsPage', () => {
  it('渲染页头并组合 feature 公开的账号设置面板', async () => {
    await renderAccountSettingsPage();

    expect(screen.getByText('账号设置')).toBeInTheDocument();
    expect(screen.getByText('查看账号信息、维护基础资料与登录密码。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeInTheDocument();
    expect(condLogoutMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('改密成功且身份仍匹配：先条件清理唯一会话真源（携带发起时身份），再跳转登录页', async () => {
    const order: string[] = [];
    condLogoutMock.mockImplementation(async (identity: unknown) => {
      order.push(`logout:${JSON.stringify(identity)}`);

      return true;
    });
    navigateMock.mockImplementation(() => {
      order.push('navigate');
    });
    panelState.identityToDeliver = { accountId: 900201, epoch: 1 };
    await renderAccountSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: TRIGGER_LABEL }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
    expect(condLogoutMock).toHaveBeenCalledTimes(1);
    // 发起时采样的会话身份原样交给条件登出做裁决
    expect(condLogoutMock).toHaveBeenCalledWith({ accountId: 900201, epoch: 1 });
    expect(navigateMock).toHaveBeenCalledWith('/login');
    expect(order).toEqual(['logout:{"accountId":900201,"epoch":1}', 'navigate']);
    // 返回值接线：身份匹配 → true → 表单展示成功提示
    await waitFor(() => expect(panelState.deliveredResult).toBe(true));
  });

  it('身份不匹配（退出重登 / 已切换账号的迟到响应）：不清理会话、不跳转、返回值 false（表单完全静默）', async () => {
    condLogoutMock.mockResolvedValue(false);
    panelState.identityToDeliver = { accountId: 900201, epoch: 1 };
    establishSession(900202, '用户B');
    await renderAccountSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: TRIGGER_LABEL }));

    await waitFor(() => expect(condLogoutMock).toHaveBeenCalledTimes(1));
    expect(navigateMock).not.toHaveBeenCalled();
    // 当前会话（用户B）原样保留
    expect((await currentAuthSession())?.accountId).toBe(900202);
    // 返回值接线：身份不匹配 → false → 表单不展示成功提示
    await waitFor(() => expect(panelState.deliveredResult).toBe(false));
  });

  it('清理未完成前不提前跳转：跳转发生在会话收口 promise 之后', async () => {
    let releaseLogout: () => void = () => {};
    condLogoutMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseLogout = () => resolve(true);
        }),
    );
    panelState.identityToDeliver = { accountId: 900201, epoch: 1 };
    await renderAccountSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: TRIGGER_LABEL }));
    await waitFor(() => expect(condLogoutMock).toHaveBeenCalledTimes(1));
    expect(navigateMock).not.toHaveBeenCalled();

    releaseLogout();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login'));
  });

  it('改密发起采样接线：登录会话下采样到 accountId + 会话代次，退出重登后代次推进', async () => {
    establishSession(900201, '用户A');
    await renderAccountSettingsPage();

    // 生产启动语义：provider 挂载时从持久化恢复会话（恢复建立首个代次）
    const { authSessionStore } = await import('@/features/auth-session/auth-session-entry');
    authSessionStore.restoreSession();

    fireEvent.click(screen.getByRole('button', { name: '模拟改密发起采样' }));
    expect(panelState.sampledIdentity).toEqual({ accountId: 900201, epoch: 1 });

    // 退出后同一账号重新登录：新会话新代次（窄身份不含 Token）
    authSessionStore.clearSession();
    authSessionStore.establishSession({
      accessToken: 'token-900201-again',
      accountId: 900201,
      role: 'CUSTOMER',
      userInfo: { accessGroup: ['CUSTOMER'], avatarUrl: null, nickname: '用户A' },
    });

    fireEvent.click(screen.getByRole('button', { name: '模拟改密发起采样' }));
    // 恢复(1) → 清除(2) → 重新建立(3)：退出重登后的新代次
    expect(panelState.sampledIdentity).toEqual({ accountId: 900201, epoch: 3 });
  });

  it('资料保存成功：把请求发起前采样的账号与权威昵称回写会话真源（内存 + sessionStorage）', async () => {
    establishSession(900201, '用户A');
    await renderAccountSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: '模拟资料保存发起' }));
    fireEvent.click(screen.getByRole('button', { name: '模拟资料保存迟到成功' }));

    expect((await currentAuthSession())?.userInfo?.nickname).toBe('A 保存的昵称');
    expect(readStoredNickname()).toBe('A 保存的昵称');
  });

  it('A 发起保存后切换到 B：A 的迟到响应不得修改 B 的会话（内存 + sessionStorage 均保持 B）', async () => {
    establishSession(900201, '用户A');
    await renderAccountSettingsPage();

    // A 在会话仍是自己时发起保存（采样固化为 900201）
    fireEvent.click(screen.getByRole('button', { name: '模拟资料保存发起' }));
    expect(panelState.capturedAccountId).toBe(900201);

    // 会话切换为 B（如登出后另账登录）：使用已有 store 装配，不新增公共测试 API。
    const { authSessionStore } = await import('@/features/auth-session/auth-session-entry');
    authSessionStore.establishSession({
      accessToken: 'token-900202',
      accountId: 900202,
      role: 'CUSTOMER',
      userInfo: { accessGroup: ['CUSTOMER'], avatarUrl: null, nickname: '用户B' },
    });

    // A 的迟到保存成功响应：携带发起者身份，store 与当前会话比对拒绝
    fireEvent.click(screen.getByRole('button', { name: '模拟资料保存迟到成功' }));

    expect((await currentAuthSession())?.accountId).toBe(900202);
    expect((await currentAuthSession())?.userInfo?.nickname).toBe('用户B');
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null') as {
      accountId?: number;
      userInfo?: { nickname?: string } | null;
    };
    expect(stored?.accountId).toBe(900202);
    expect(stored?.userInfo?.nickname).toBe('用户B');
  });

  it('匿名会话下采样为 null：不触发回写，也不抛错', async () => {
    await renderAccountSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: '模拟资料保存发起' }));
    expect(panelState.capturedAccountId).toBeNull();
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: '模拟资料保存迟到成功' })),
    ).not.toThrow();
    expect(await currentAuthSession()).toBeNull();
  });
});

/**
 * 公司补录接线：补录资格按**会话事实**判定（客户角色 + 正常会话），页面只做透传；
 * 补录成功后刷新会话身份，使客户首页 / 报修页按新的 customerOrganizationId 渲染；
 * 刷新失败只提示，不回滚面板已写入的权威视图（不抛错给卡片）。
 */
describe('AccountSettingsPage 公司补录接线', () => {
  it('客户角色 + 正常会话：向面板注入补录资格 true', async () => {
    panelState.authSession = { restriction: 'NONE', role: 'CUSTOMER' };
    await renderAccountSettingsPage();

    expect(panelState.canSupplementCompany).toBe(true);
  });

  it.each([
    ['ENGINEER', 'NONE', '非客户角色'],
    ['CUSTOMER', 'PASSWORD_RESET_REQUIRED', '受限会话'],
    ['SUPER_ADMIN', 'NONE', '管理员角色'],
  ])('角色 %s / 限制 %s（%s）：不注入补录资格', async (role, restriction) => {
    panelState.authSession = { restriction, role };
    await renderAccountSettingsPage();

    expect(panelState.canSupplementCompany).toBe(false);
  });

  it('匿名会话：不注入补录资格', async () => {
    await renderAccountSettingsPage();

    expect(panelState.canSupplementCompany).toBe(false);
  });

  it('补录成功：触发一次会话身份刷新（使新的公司归属生效）', async () => {
    panelState.authSession = { restriction: 'NONE', role: 'CUSTOMER' };
    await renderAccountSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: '模拟公司补录成功' }));

    await waitFor(() => expect(refreshIdentityMock).toHaveBeenCalledTimes(1));
    expect(refreshIdentityMock).toHaveBeenCalledWith();
  });

  it('会话复核 stale（迟到 / 被并发覆盖）：不作为当前会话结论，提示刷新', async () => {
    panelState.authSession = { restriction: 'NONE', role: 'CUSTOMER' };
    refreshIdentityMock.mockResolvedValue({ status: 'stale' });
    const warningSpy = vi.spyOn(message, 'warning').mockImplementation(() => undefined as never);
    await renderAccountSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: '模拟公司补录成功' }));

    await waitFor(() =>
      expect(warningSpy).toHaveBeenCalledWith(
        '公司信息已更新，但会话信息刷新失败，请刷新页面查看最新归属。',
      ),
    );
    expect(refreshIdentityMock).toHaveBeenCalledTimes(1);
  });

  it('会话刷新失败：只以 warning 提示，不向卡片抛错（权威视图不回滚）', async () => {
    panelState.authSession = { restriction: 'NONE', role: 'CUSTOMER' };
    refreshIdentityMock.mockRejectedValue(new Error('refresh failed'));
    const warningSpy = vi.spyOn(message, 'warning').mockImplementation(() => undefined as never);
    await renderAccountSettingsPage();

    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: '模拟公司补录成功' })),
    ).not.toThrow();

    await waitFor(() =>
      expect(warningSpy).toHaveBeenCalledWith(
        '公司信息已更新，但会话信息刷新失败，请刷新页面查看最新归属。',
      ),
    );
    expect(refreshIdentityMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * 页面装配级失败时序（复核修正轮补充）：渲染**真实面板**（真实 hook + 真实表单 +
 * 真实装配层会话侧写），仅 mock infrastructure adapter 与条件登出出口，把
 * 「改密失败（业务 / 网络）→ 不产生任何会话动作 → 随后资料保存成功 → 权威昵称
 * 回写内存会话与 sessionStorage」串在同一用例中断言——覆盖分层面测之外的端到端
 * 装配语义。此链路中 hook 的失败分支不调用 form 的 onSucceeded，因此装配层的
 * 条件登出绝不应被触发。
 */
describe('AccountSettingsPage 页面装配：改密失败时序（真实面板 + mock adapter）', () => {
  const STORAGE_KEY = 'lithography-platform.auth-session.v1';
  const BASE_SETTINGS: AccountSettingsView = {
    adminLevel: null,
    loginEmail: 'alpha@example.com',
    loginName: 'mock_customer_alpha',
    nickname: '用户A',
    companyName: null,
    contactEmail: null,
    phone: null,
    realName: null,
    role: 'CUSTOMER',
    status: 'ACTIVE',
    trustedCompanyName: null,
    updatedAt: '2026-09-21T00:00:00.000Z',
  };
  const SAVED_SETTINGS: AccountSettingsView = { ...BASE_SETTINGS, nickname: '保存后的昵称' };

  const FAILURE_CASES = [
    {
      expectedAlert: '当前密码不正确，请重试。',
      changeBehavior: () =>
        Promise.resolve({
          message: '当前密码不正确，请重试。',
          ok: false,
          reason: 'invalid-input',
        }),
      label: '业务失败',
    },
    {
      expectedAlert: '操作失败，请稍后重试。',
      changeBehavior: () => Promise.reject(new Error('network interrupted')),
      label: '网络失败',
    },
  ] as const;

  function establishSession(accountId: number, nickname: string): void {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        accessToken: `token-${accountId}`,
        accountId,
        role: 'CUSTOMER',
        userInfo: { accessGroup: ['CUSTOMER'], nickname },
        version: 3,
      }),
    );
  }

  function readStoredSession(): { accountId?: number; userInfo?: { nickname?: string } } {
    return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}');
  }

  async function renderRealPanelPage(
    changeMyPassword: () => Promise<unknown>,
    updateMyAccountSettingsProfile: () => Promise<unknown>,
  ) {
    vi.doMock('@/features/account-settings', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
    }));
    vi.doMock('@/features/account-settings/infrastructure/account-settings-adapter', () => ({
      changeMyPassword,
      fetchMyAccountSettings: vi.fn().mockResolvedValue(BASE_SETTINGS),
      searchManagedCompanies: vi.fn().mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      }),
      supplementMyCustomerCompany: vi.fn(),
      updateMyAccountSettingsProfile,
    }));
    vi.doMock('@/features/auth-session', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      clearSessionAfterPasswordChange: condLogoutMock,
      refreshCurrentAuthSessionIdentity: refreshIdentityMock,
      // 本组用例聚焦改密/资料保存时序：以匿名会话桩使补录卡片保持只读、不触发检索
      useAuthSession: () => ({ session: null, status: 'anonymous' }),
    }));

    const { AccountSettingsPage } = await import('./index');

    return render(<AccountSettingsPage />);
  }

  beforeEach(() => {
    condLogoutMock.mockReset();
    navigateMock.mockReset();
    window.sessionStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    vi.resetModules();
  });

  it.each(FAILURE_CASES)(
    '改密$label：装配层零会话动作（无清理、无跳转、无成功提示），随后的资料保存成功照常回写内存与 sessionStorage 昵称',
    async ({ changeBehavior, expectedAlert }) => {
      const messageSuccessSpy = vi
        .spyOn(message, 'success')
        .mockImplementation(() => undefined as never);
      establishSession(900201, '用户A');
      await renderRealPanelPage(
        changeBehavior,
        vi.fn().mockResolvedValue({ isUpdated: true, ok: true, settings: SAVED_SETTINGS }),
      );

      // 面板 ready：真实 hook 初始加载完成
      await screen.findByText('账号信息');
      expect(screen.getByLabelText('昵称')).toHaveValue('用户A');

      // 同一会话内先发起改密（会失败）：切到改密标签，填三个密码字段并提交
      fireEvent.click(screen.getByRole('tab', { name: '修改密码' }));
      fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'Old#Pass2026' } });
      fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'Str0ng#Pass2026' } });
      fireEvent.change(screen.getByLabelText('确认新密码'), {
        target: { value: 'Str0ng#Pass2026' },
      });
      fireEvent.click(screen.getByRole('button', { name: /修\s*改\s*密\s*码/ }));

      // 失败文案原样展示；装配层零参与：条件登出未调用、无跳转、无改密成功提示
      expect(await screen.findByRole('alert')).toHaveTextContent(expectedAlert);
      expect(condLogoutMock).not.toHaveBeenCalled();
      expect(navigateMock).not.toHaveBeenCalled();
      expect(messageSuccessSpy).not.toHaveBeenCalledWith(expect.stringContaining('密码已更新'));
      expect(readStoredSession()).toMatchObject({ accountId: 900201 });

      // 随后资料保存成功：切回个人资料标签，昵称经权威视图回写内存会话与 sessionStorage（侧栏数据源）
      fireEvent.click(screen.getByRole('tab', { name: '个人资料' }));
      fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '保存后的昵称' } });
      const profileForm = screen.getByLabelText('昵称').closest('form');
      fireEvent.click(within(profileForm as HTMLElement).getByRole('button', { name: /保\s*存/ }));

      await waitFor(() => expect(screen.getByLabelText('昵称')).toHaveValue('保存后的昵称'));
      expect(
        (await import('@/features/auth-session')).getCurrentAuthSession()?.userInfo?.nickname,
      ).toBe('保存后的昵称');
      expect(readStoredSession()).toMatchObject({
        accountId: 900201,
        userInfo: { nickname: '保存后的昵称' },
      });
      // 失败的改密自始至终不产生会话动作
      expect(condLogoutMock).not.toHaveBeenCalled();
      expect(navigateMock).not.toHaveBeenCalled();
      expect(messageSuccessSpy).not.toHaveBeenCalledWith(expect.stringContaining('密码已更新'));
    },
  );
});

/**
 * 语言切换与账号设置表单的隔离（S5）：切语言只替换界面文案，不卸载/重建面板，
 * 已输入但未保存的字段保持；账号设置查询只发生在首次挂载（零新增 GraphQL 请求）。
 *
 * 本文件根级 `beforeEach` 会 `vi.resetModules()`，因此 i18n 运行时与面板都在重置后
 * 动态导入，保证 Context 与消费方引用同一模块实例（否则 Provider 对面板不可见）。
 */
describe('AccountSettingsPage 装配：切换语言保持未保存表单', () => {
  const SETTINGS: AccountSettingsView = {
    adminLevel: null,
    companyName: null,
    contactEmail: null,
    loginEmail: 'alpha@example.com',
    loginName: 'mock_customer_alpha',
    nickname: '用户A',
    phone: null,
    realName: null,
    role: 'CUSTOMER',
    status: 'ACTIVE',
    trustedCompanyName: null,
    updatedAt: '2026-09-21T00:00:00.000Z',
  };

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('切换语言后已输入昵称保持不变，账号设置只查询一次', async () => {
    const fetchMyAccountSettings = vi.fn().mockResolvedValue(SETTINGS);
    vi.doMock('@/features/account-settings', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
    }));
    vi.doMock('@/features/account-settings/infrastructure/account-settings-adapter', () => ({
      changeMyPassword: vi.fn(),
      fetchMyAccountSettings,
      searchManagedCompanies: vi.fn().mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      }),
      supplementMyCustomerCompany: vi.fn(),
      updateMyAccountSettingsProfile: vi.fn(),
    }));
    vi.doMock('@/features/auth-session', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      // 本用例聚焦表单保持：匿名会话让补录卡片保持只读、不触发检索
      useAuthSession: () => ({ session: null, status: 'anonymous' }),
    }));

    const { I18nContext, createTranslator } = await import('@/shared/i18n');
    const { LanguageSwitch } = await import('@/shared/ui/language-switch');
    const { AccountSettingsPanel } = await import('@/features/account-settings');

    function Harness() {
      const [language, setLanguage] = useState<'zh-CN' | 'en'>('zh-CN');
      const t = useMemo(() => createTranslator(language), [language]);
      const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);

      return (
        <I18nContext.Provider value={value}>
          <LanguageSwitch />
          <AccountSettingsPanel />
        </I18nContext.Provider>
      );
    }

    render(<Harness />);

    await screen.findByText('账号信息');
    const nicknameInput = screen.getByLabelText('昵称');
    fireEvent.change(nicknameInput, { target: { value: '未保存的昵称' } });
    expect(nicknameInput).toHaveValue('未保存的昵称');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    expect(screen.getByLabelText('Nickname')).toHaveValue('未保存的昵称');
    expect(fetchMyAccountSettings).toHaveBeenCalledTimes(1);
  });
});
