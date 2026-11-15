// src/app/layout/app-layout.spec.tsx

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, ThemeProvider } from '@/app/providers';

import { AppLayout } from './app-layout';

// 会话事实源以桩替换：壳层测试只关心展示与导航结构，会话链路由 feature 自身测试覆盖。
const useAuthSessionMock = vi.fn();

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    // 壳层测试不触网：启动期会话复核固定返回「无变化」
    refreshCurrentAuthSessionIdentity: vi.fn().mockResolvedValue(false),
    useAuthSession: () => useAuthSessionMock(),
  };
});

// sidecar 是重量级组件（会话/GraphQL 依赖），壳层测试中置空。
vi.mock('@/widgets/aigc-sidecar', () => ({
  AigcSidecar: () => null,
}));

// setup.ts 的 matchMedia 是静态 shim；S4 自动折叠用例需要可控的 matches 状态，
// 在测试内覆盖并在 afterEach 还原，避免污染 AntD 自身的响应式查询。
const originalMatchMedia = window.matchMedia;

type QueryListener = (event: { matches: boolean }) => void;

function stubNarrowViewport(initialMatches: boolean) {
  const listeners = new Set<QueryListener>();
  const narrowQuery = {
    matches: initialMatches,
    media: '(max-width: 1024px)',
  };
  const mediaQueryList = {
    ...narrowQuery,
    addEventListener: (_type: string, listener: QueryListener) => {
      listeners.add(listener);
    },
    addListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
    removeEventListener: (_type: string, listener: QueryListener) => {
      listeners.delete(listener);
    },
    removeListener: () => {},
  };

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) =>
      query === '(max-width: 1024px)' ? mediaQueryList : originalMatchMedia(query),
  });

  return {
    setMatches(matches: boolean) {
      narrowQuery.matches = matches;
      mediaQueryList.matches = matches;

      for (const listener of listeners) {
        listener({ matches });
      }
    },
  };
}

function renderLayout(pathname: string) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <MemoryRouter initialEntries={[pathname]}>
          <Routes>
            <Route element={<AppLayout>页面内容</AppLayout>} path="*" />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </I18nProvider>,
  );
}

// 收口跳转的观察面：探针读取实际路径名，避免用 DOM 结构反推导航结果。
function LocationProbe() {
  const location = useLocation();

  return <div data-testid="current-pathname">{location.pathname}</div>;
}

function renderLayoutWithLocationProbe(pathname: string) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <MemoryRouter initialEntries={[pathname]}>
          <LocationProbe />
          <Routes>
            <Route element={<AppLayout>页面内容</AppLayout>} path="*" />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </I18nProvider>,
  );
}

// 管理员默认按 1 级（全域）构造会话；2 级/未知等级用例显式覆盖等级事实。
function sessionFor(
  role: 'CUSTOMER' | 'ENGINEER' | 'SUPER_ADMIN',
  adminLevel: number | null = role === 'SUPER_ADMIN' ? 1 : null,
  adminOrganizationId: number | null = role === 'SUPER_ADMIN' ? 910003 : null,
) {
  return {
    session: {
      accessToken: 'token',
      accountId: 1,
      adminLevel,
      adminOrganizationId,
      role,
      userInfo: { accessGroup: [role], avatarUrl: null, nickname: `用户-${role}` },
    },
    status: 'authenticated',
  } as const;
}

describe('AppLayout（S3 壳层）', () => {
  afterEach(() => {
    cleanup();
    useAuthSessionMock.mockReset();
    // 一次性批准提示按账号写入 localStorage：用例之间必须清空，避免串场
    window.localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it('CUSTOMER 仅见首页、发起申请、我的申请', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('CUSTOMER'));
    renderLayout('/customer');

    expect(screen.getByRole('link', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '发起申请' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '我的申请' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '维修申请' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '参考资料' })).not.toBeInTheDocument();
  });

  it('SUPER_ADMIN 见首页、参考资料、用户管理与文档数据库（PR3 S3）', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN'));
    renderLayout('/admin/users');

    expect(screen.getByRole('link', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '用户管理' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '参考资料' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '文档数据库' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '发起申请' })).not.toBeInTheDocument();
  });

  // S1：全域管理入口只对 1 级管理员出现；2 级（本公司）与未知等级不出现，
  // 与直达路由守卫同一范围判定。
  it('2 级与未知等级管理员侧栏不出现全域管理入口', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN', 2, 910004));
    const view = renderLayout('/admin');

    expect(screen.getByRole('link', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '参考资料' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '文档数据库' })).not.toBeInTheDocument();

    view.unmount();
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN', null));
    renderLayout('/admin');

    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '文档数据库' })).not.toBeInTheDocument();
  });

  it('业务子路由刷新后选中态按前缀恢复（/admin/users 选中用户管理而非首页）', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN'));
    renderLayout('/admin/users');

    expect(screen.getByRole('link', { name: '用户管理' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '首页' })).not.toHaveAttribute('aria-current', 'page');
  });

  // PR5 S1-3：客户从菜单进入主页（/customer）或我的申请子路由，刷新后选中态正确；
  // 客户主页无同名业务菜单项，按既有回落规则选中「首页」。
  it('客户主页刷新后选中「首页」，我的申请子路由按前缀选中「我的申请」', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('CUSTOMER'));
    const view = renderLayout('/customer');

    expect(screen.getByRole('link', { name: '首页' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '我的申请' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );

    view.unmount();
    renderLayout('/customer/repair-requests');

    expect(screen.getByRole('link', { name: '我的申请' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '首页' })).not.toHaveAttribute('aria-current', 'page');
  });

  it('文档数据库路由应用知识库工作区变体，其他页面保持通用基准（PR3 R7）', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN'));
    const view = renderLayout('/admin/document-database');

    expect(document.querySelector('main.app-workspace--knowledge-base')).not.toBeNull();
    expect(document.querySelector('.app-main--knowledge-base')).not.toBeNull();

    view.unmount();
    renderLayout('/admin/users');

    // 变体按精确路由开启：其他页面不得继承纯色铺满（防前缀匹配误伤）
    expect(document.querySelector('.app-workspace--knowledge-base')).toBeNull();
    expect(document.querySelector('.app-main--knowledge-base')).toBeNull();
  });

  // PR5 整页视觉计划 S0-3：独立资料列表是第二个工作区变体，同样按**精确**路由开启；
  // 新增（/reference-documents/new）与详情（/reference-documents/:id）必须保持通用基准。
  it('参考资料精确列表路由应用 reference-library 工作区变体，新增/详情不继承（PR5 整页）', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN'));
    const view = renderLayout('/reference-documents');

    expect(document.querySelector('main.app-workspace--reference-library')).not.toBeNull();
    expect(document.querySelector('.app-main--reference-library')).not.toBeNull();
    // 两个变体互不借用：列表路由不得出现知识库 modifier
    expect(document.querySelector('.app-workspace--knowledge-base')).toBeNull();
    expect(document.querySelector('.app-main--knowledge-base')).toBeNull();

    view.unmount();
    renderLayout('/reference-documents/new');

    expect(document.querySelector('.app-workspace--reference-library')).toBeNull();
    expect(document.querySelector('.app-main--reference-library')).toBeNull();

    view.unmount();
    renderLayout('/reference-documents/501');

    expect(document.querySelector('.app-workspace--reference-library')).toBeNull();
    expect(document.querySelector('.app-main--reference-library')).toBeNull();
  });

  it('底部展示真实当前用户卡与退出入口', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('ENGINEER'));
    renderLayout('/engineer/repair-requests');

    expect(screen.getByText('用户-ENGINEER')).toBeInTheDocument();
    expect(screen.getByText('工程师')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /退出登录/ })).toBeInTheDocument();
  });

  it('匿名会话仅展示不受角色限制的入口，不渲染用户卡', () => {
    useAuthSessionMock.mockReturnValue({ session: null, status: 'anonymous' });
    // 登录页已改为无侧栏独立壳层（PR6），匿名会话的通用侧栏在这里以业务路由取样
    renderLayout('/admin');

    expect(screen.getByRole('link', { name: '首页' })).toBeInTheDocument();
    expect(screen.queryByText(/退出登录/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
  });

  it('登录路由渲染独立壳层：只保留整页登录区与左上角品牌，不渲染工作台侧栏与用户卡（PR6）', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN'));
    renderLayout('/login');

    expect(document.querySelector('.app-shell.login-shell')).not.toBeNull();
    expect(document.querySelector('.login-brand')).not.toBeNull();
    expect(screen.getByText('光刻维护平台')).toBeInTheDocument();
    // 品牌结构：LF 标记 + 细竖分隔线 + 项目名；不显示英文副标题（PR6 本轮）
    expect(document.querySelector('.login-brand .brand-mark')?.textContent).toBe('LF');
    expect(document.querySelector('.login-brand-divider')).not.toBeNull();
    expect(screen.queryByText('Service Platform')).not.toBeInTheDocument();
    // 登录页不得出现与登录无关的已登录侧栏菜单与用户卡
    expect(document.querySelector('.app-sidebar')).toBeNull();
    expect(screen.queryByRole('link', { name: '首页' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
    expect(screen.queryByText(/退出登录/)).not.toBeInTheDocument();

    // 变体按精确路由开启：其他页面不得继承无侧栏壳层（防前缀匹配误伤）
    cleanup();
    renderLayout('/admin/users');
    expect(document.querySelector('.app-shell.login-shell')).toBeNull();
    expect(document.querySelector('.app-sidebar')).not.toBeNull();
  });

  it('每个菜单项都有可见图标（折叠态辨识兜底，R2 P2-01）', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN'));
    renderLayout('/admin/users');

    const navLinks = document.querySelectorAll('nav[aria-label="主导航"] a.app-nav-item');

    expect(navLinks.length).toBeGreaterThan(0);

    for (const link of navLinks) {
      // 图标实现双轨：原型描边 SVG（.nav-icon）与 dev 专属 AntD 图标（.anticon）
      expect(link.querySelector('.nav-icon, .anticon')).not.toBeNull();
    }
  });

  it('窄视口（≤1024px）挂载时侧栏自动折叠（S4 P2-03）', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('CUSTOMER'));
    stubNarrowViewport(true);
    renderLayout('/customer');

    expect(screen.getByRole('button', { name: '展开导航' })).toBeInTheDocument();
  });

  it('跨越窄视口断点时自动收敛/展开，宽屏恢复展开态', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('CUSTOMER'));
    const narrowViewport = stubNarrowViewport(false);
    renderLayout('/customer');

    expect(screen.getByRole('button', { name: '折叠导航' })).toBeInTheDocument();

    act(() => narrowViewport.setMatches(true));
    expect(screen.getByRole('button', { name: '展开导航' })).toBeInTheDocument();

    act(() => narrowViewport.setMatches(false));
    expect(screen.getByRole('button', { name: '折叠导航' })).toBeInTheDocument();
  });

  // S1.4：会话限制状态由服务端每请求复核，壳层按快照做导航裁决（策略函数在
  // auth-session-policy 单测覆盖，这里只验证壳层的落点）。
  it('受限会话停留在业务路由时收回 /restricted', async () => {
    useAuthSessionMock.mockReturnValue({
      session: { ...sessionFor('ENGINEER').session, restriction: 'ENGINEER_PENDING' },
      status: 'authenticated',
    });
    renderLayoutWithLocationProbe('/engineer/repair-requests');

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname')).toHaveTextContent('/restricted');
    });
  });

  it('非受限会话访问 /restricted 时回到角色主页', async () => {
    useAuthSessionMock.mockReturnValue(sessionFor('CUSTOMER'));
    renderLayoutWithLocationProbe('/restricted');

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname')).toHaveTextContent('/customer');
    });
  });

  // S3：资格生效后会话从受限态变为 NONE，一次性批准提示常驻布局层，
  // 不依赖 /restricted 页面本身（该页会立即被收口跳转卸载）。
  it('工程师资格生效后在工作区顶部展示一次性批准提示', () => {
    useAuthSessionMock.mockReturnValue({
      session: { ...sessionFor('ENGINEER').session, restriction: 'ENGINEER_PENDING' },
      status: 'authenticated',
    });
    const view = renderLayout('/engineer');

    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
    view.unmount();

    useAuthSessionMock.mockReturnValue({
      session: { ...sessionFor('ENGINEER').session, restriction: 'NONE' },
      status: 'authenticated',
    });
    renderLayout('/engineer');

    expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
  });

  // S5：语言切换入口唯一（展开态只在字号区上方出现一组），切语言只换文案，
  // 不改变路由、导航结构与选中态。
  it('展开态侧栏只提供一个语言入口，切换英文后文案变化而路由与选中态不变', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('SUPER_ADMIN'));
    renderLayout('/admin/users');

    const groups = screen.getAllByRole('group', { name: '界面语言' });
    expect(groups).toHaveLength(1);
    expect(within(groups[0]).getAllByRole('button')).toHaveLength(2);

    const usersLink = screen.getByRole('link', { name: '用户管理' });
    const href = usersLink.getAttribute('href');

    fireEvent.click(within(groups[0]).getByRole('button', { name: 'English' }));

    expect(screen.getByText('Lithography Service Platform')).toBeInTheDocument();
    const englishUsersLink = screen.getByRole('link', { name: 'User management' });
    expect(englishUsersLink).toHaveAttribute('href', href);
    expect(englishUsersLink).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('group', { name: 'Interface language' })).toBeInTheDocument();
  });

  it('折叠态侧栏以图标入口保留语言切换，可访问名称随语言变化', () => {
    useAuthSessionMock.mockReturnValue(sessionFor('CUSTOMER'));
    stubNarrowViewport(true);
    renderLayout('/customer');

    fireEvent.click(screen.getByRole('button', { name: '切换到英文' }));

    // 切到英文后按钮的可访问名称随界面语言本地化
    expect(screen.getByRole('button', { name: 'Switch to Chinese' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('刷新后按已存语言偏好恢复英文界面', () => {
    window.localStorage.setItem('ui-language', 'en');
    useAuthSessionMock.mockReturnValue(sessionFor('CUSTOMER'));
    renderLayout('/customer');

    expect(screen.getByText('Lithography Service Platform')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New request' })).toBeInTheDocument();
  });
});
