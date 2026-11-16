// src/app/layout/app-layout.tsx

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppstoreOutlined,
  BugOutlined,
  CodeOutlined,
  ExperimentOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { Button, Segmented } from 'antd';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';

import type { ResolvedNavigationItem } from '@/app/navigation';
import {
  getNavigationItems,
  resolveActiveNavigationPath,
  resolveNavigationItems,
} from '@/app/navigation';
import { FONT_SCALE_OPTIONS, useI18n, useTheme } from '@/app/providers';
import { APP_THEME_CSS_VAR_KEY } from '@/app/theme';

import { AigcSidecar } from '@/widgets/aigc-sidecar';
import {
  AUTH_SESSION_RESTRICTED_PATH,
  type AuthSessionRole,
  isAuthSessionRestricted,
  LogoutButton,
  refreshCurrentAuthSessionIdentity,
  resolveAuthSessionAdminScope,
  resolveAuthSessionHomePath,
  useAuthSession,
} from '@/features/auth-session';

import type { AssistantRouteCandidate } from '@/entities/assistant-session';

import { LanguageSwitch } from '@/shared/ui/language-switch';

import { EngineerApprovalGate } from './engineer-approval-gate';
import { EntryAccentGlyph } from './entry-accent-glyph';
import {
  NavBookOpenIcon,
  NavChatIcon,
  NavDashboardIcon,
  NavListIcon,
  NavSettingsIcon,
  NavUserIcon,
} from './nav-icons';

// 侧栏用户卡的展示名映射：仅展示用途，角色判断一律走 auth-session 策略层。
// S5：目录与布局都只存词条键，渲染时按当前语言解析。
const ROLE_LABEL_KEYS = {
  CUSTOMER: 'layout.role.CUSTOMER',
  ENGINEER: 'layout.role.ENGINEER',
  SUPER_ADMIN: 'layout.role.SUPER_ADMIN',
} as const satisfies Record<AuthSessionRole, string>;

// 导航图标：按 id 映射，折叠态靠图标辨识目标（审查 P1-04 修复）。
// 原型已对应的五个菜单用 gkj 描边 SVG（./nav-icons）；dev 专属入口仍用 AntD 图标
//（生产不可见）；未匹配项回落通用图标——折叠态必须始终有可见目标，
// 避免后续新增菜单漏配图标时留下空白热点（外审 R2 P2-01）。
const NAV_ITEM_ICONS: Record<string, ReactNode> = {
  'account-settings': <NavSettingsIcon />,
  'admin-document-database': <NavListIcon />,
  'admin-users': <NavUserIcon />,
  'customer-repair-request-new': <NavChatIcon />,
  'customer-repair-requests': <NavListIcon />,
  'engineer-repair-requests': <NavListIcon />,
  'error-preview': <BugOutlined />,
  'game-2048-lab': <ExperimentOutlined />,
  home: <NavDashboardIcon />,
  'reference-documents': <NavBookOpenIcon />,
  'sandbox-playground': <CodeOutlined />,
  'shared-ui-gallery': <AppstoreOutlined />,
};

const FALLBACK_NAV_ICON = <AppstoreOutlined />;

function toRouteCandidate(item: ResolvedNavigationItem): AssistantRouteCandidate {
  return {
    description: item.description,
    id: item.id,
    label: item.label,
    path: item.path,
    tags: item.tags,
  };
}

type AppLayoutProps = {
  children?: ReactNode;
};

// 窄视口断点（S4）：≤1024px 时侧栏自动折叠，跨越断点时自动收敛/展开；
// 断点内用户仍可手动切换。任务书验收视口（1366×768、1440×900）不受影响。
const NARROW_VIEWPORT_QUERY = '(max-width: 1024px)';

// 知识库页精确路由（PR3 R7）：仅本页应用工作区视觉变体——
// 原型 #knowledge-base-page 纯色底 + 占满侧栏后剩余宽度；
// 其他页面继续通用渐变 + 1280px 上限（frontend/docs/gkj-visual-baseline.md 第 6 节）。
const KNOWLEDGE_BASE_PATH = '/admin/document-database';

// 参考资料列表精确路由（PR5 整页视觉计划 20260929）：仅精确列表页应用工作区变体——
// 纯色工作区底 + 占满侧栏后剩余宽度；新增（/reference-documents/new）与详情
// （/reference-documents/:id）继续通用渐变 + 1280px 上限。
// 有意与知识库变体分开命名：两者取值同源但不互相扩散，便于独立登记与回归。
const REFERENCE_LIBRARY_PATH = '/reference-documents';

// 登录页精确路由（PR6）：登录页不展示工作台侧栏、字号档位与 AI 入口，
// 改为整页灰蓝底 + 左上角品牌 + 居中登录卡的独立壳层。仅本路由生效，
// 其他页面继续通用侧栏；不用前缀匹配，避免误伤其他页面。
const LOGIN_PATH = '/login';

// 注册页（S3/S4）与登录页共用同一独立壳层；按注册路径前缀匹配，
// 覆盖 /register/customer、/register/engineer 等后续注册页。
const REGISTER_PATH_PREFIX = '/register/';

export function AppLayout({ children }: AppLayoutProps = {}) {
  const [isNavCollapsed, setIsNavCollapsed] = useState(false);
  const [isSidecarOpen, setIsSidecarOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);
  const wasSidecarOpenRef = useRef(isSidecarOpen);
  const [showShortcutHint, setShowShortcutHint] = useState(() =>
    typeof document === 'undefined'
      ? false
      : document.hasFocus() && document.visibilityState === 'visible',
  );
  const { fontScale, setFontScale } = useTheme();
  const { t } = useI18n();
  const { session } = useAuthSession();
  const location = useLocation();
  const navigate = useNavigate();
  const activeRole = session?.role ?? null;
  // 知识库页工作区变体按精确路由开启（PR3 R7），不用前缀匹配避免误伤其他页面
  const isKnowledgeBasePage = location.pathname === KNOWLEDGE_BASE_PATH;
  // 参考资料列表工作区变体同样按精确路由开启（PR5 整页计划）：新增/详情路由不继承
  const isReferenceLibraryPage = location.pathname === REFERENCE_LIBRARY_PATH;
  // 登录 / 注册页共用独立壳层（注册页按 /register/ 前缀）
  const isAuthLandingPage =
    location.pathname === LOGIN_PATH || location.pathname.startsWith(REGISTER_PATH_PREFIX);
  const adminScope = session ? resolveAuthSessionAdminScope(session) : 'NONE';
  const navigationItems = useMemo(
    () => resolveNavigationItems(getNavigationItems(undefined, activeRole, adminScope), t),
    [activeRole, adminScope, t],
  );
  const activeNavigationPath = useMemo(
    () => resolveActiveNavigationPath(location.pathname, navigationItems),
    [location.pathname, navigationItems],
  );
  const routeCandidates = useMemo(
    () => navigationItems.map((item) => toRouteCandidate(item)),
    [navigationItems],
  );

  useEffect(() => {
    const narrowQuery = window.matchMedia(NARROW_VIEWPORT_QUERY);

    function syncCollapsedFromViewport() {
      setIsNavCollapsed(narrowQuery.matches);
    }

    syncCollapsedFromViewport();
    narrowQuery.addEventListener('change', syncCollapsedFromViewport);

    return () => {
      narrowQuery.removeEventListener('change', syncCollapsedFromViewport);
    };
  }, []);

  useEffect(() => {
    if (wasSidecarOpenRef.current && !isSidecarOpen) {
      triggerRef.current?.focus();
    }

    wasSidecarOpenRef.current = isSidecarOpen;
  }, [isSidecarOpen]);

  useEffect(() => {
    function syncPageFocus() {
      setShowShortcutHint(document.hasFocus() && document.visibilityState === 'visible');
    }

    syncPageFocus();
    window.addEventListener('focus', syncPageFocus);
    window.addEventListener('blur', syncPageFocus);
    document.addEventListener('visibilitychange', syncPageFocus);

    return () => {
      window.removeEventListener('focus', syncPageFocus);
      window.removeEventListener('blur', syncPageFocus);
      document.removeEventListener('visibilitychange', syncPageFocus);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsSidecarOpen((previousValue) => !previousValue);
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // 启动 / 刷新时按服务端复核结果校对会话限制状态：账号在别处被要求改密、
  // 工程师申请在别处被审批等变化会同步到路由落地，避免停留在过期页面。
  // 认证失效由全局 GraphQL ingress 统一收口，这里只静默失败。
  useEffect(() => {
    void refreshCurrentAuthSessionIdentity().catch(() => {});
  }, []);

  // 限制状态与当前路径的一致性兜底：受限会话只允许停留 /restricted，限制解除后
  // 从 /restricted 回到对应角色主页。正常导航由 route-guards 在进入前决定，
  // 这里只覆盖「页面停留期间会话状态被服务端刷新」的场景。
  useEffect(() => {
    if (!session) {
      return;
    }

    const restricted = isAuthSessionRestricted(session);

    if (restricted && location.pathname !== AUTH_SESSION_RESTRICTED_PATH) {
      navigate(AUTH_SESSION_RESTRICTED_PATH, { replace: true });
      return;
    }

    if (!restricted && location.pathname === AUTH_SESSION_RESTRICTED_PATH) {
      navigate(resolveAuthSessionHomePath(session.role), { replace: true });
    }
  }, [location.pathname, navigate, session]);

  const workspaceClassName = isKnowledgeBasePage
    ? 'app-workspace app-workspace--knowledge-base'
    : isReferenceLibraryPage
      ? 'app-workspace app-workspace--reference-library'
      : 'app-workspace';
  const mainClassName = isKnowledgeBasePage
    ? 'app-main app-main--knowledge-base'
    : isReferenceLibraryPage
      ? 'app-main app-main--reference-library'
      : 'app-main';

  // 登录 / 注册页壳层：白底工作台侧栏、字号档位与 AI 入口都不渲染，只保留整页灰蓝底、
  // 固定在左上角的项目品牌与双栏主体（品牌沿用侧栏同一个 .brand-mark 与同一组
  // 颜色 Token；标识与名称之间只加一条细竖分隔线，不出现英文副标题）。
  if (isAuthLandingPage) {
    return (
      <div className={`app-shell login-shell ${APP_THEME_CSS_VAR_KEY}`}>
        <div className="login-brand">
          <span aria-hidden="true" className="brand-mark">
            LF
          </span>
          <span aria-hidden="true" className="login-brand-divider" />
          <span className="login-brand-name">{t('layout.brand')}</span>
          {/* 生产补齐原型缺口的唯一语言入口：登录 / 注册页也可切换语言 */}
          <LanguageSwitch />
        </div>
        <main className="login-workspace">{children ?? <Outlet />}</main>
      </div>
    );
  }

  return (
    <div className={`app-shell ${APP_THEME_CSS_VAR_KEY}`}>
      <aside className={`app-sidebar${isNavCollapsed ? ' app-sidebar--collapsed' : ''}`}>
        <div className="app-sidebar-brand">
          <Link className="app-sidebar-brand-link" to="/">
            {/* LF 标记：32×32、圆角 8px、深板岩底白色粗体，对齐原型品牌标识（色值见
                index.css 的 --brand-mark-* Token 与基准表）；文字为装饰性字形
                （aria-hidden），项目真名由右侧两级文字承担 */}
            <span aria-hidden="true" className="brand-mark">
              LF
            </span>
            {isNavCollapsed ? null : (
              <span className="app-sidebar-brand-text">
                <span className="app-sidebar-brand-name">{t('layout.brand')}</span>
                {/* 品牌辅行：装饰性英文小字，对齐基准品牌区两级文字层级 */}
                <span className="app-sidebar-brand-subname">Service Platform</span>
              </span>
            )}
          </Link>
          <span className="app-sidebar-collapse-button">
            <Button
              aria-label={isNavCollapsed ? t('layout.expandNav') : t('layout.collapseNav')}
              icon={isNavCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              size="small"
              type="text"
              onClick={() => setIsNavCollapsed((previousValue) => !previousValue)}
            />
          </span>
        </div>

        <nav aria-label={t('layout.mainNav')} className="app-sidebar-nav">
          {navigationItems.map((item) => (
            <Link
              key={item.id}
              aria-current={item.path === activeNavigationPath ? 'page' : undefined}
              className={`app-nav-item${
                item.path === activeNavigationPath ? ' app-nav-item--active' : ''
              }`}
              title={item.description}
              to={item.path}
            >
              <span aria-hidden="true">{NAV_ITEM_ICONS[item.id] ?? FALLBACK_NAV_ICON}</span>
              <span className="app-nav-item-label">{item.label}</span>
            </Link>
          ))}
        </nav>

        {/* 字号档位控件：有意偏差，安置在用户区上方独立行，不占用 footer 几何
            （逐条复核报告 20260916 修复建议 3；基准偏差登记见 gkj-visual-baseline.md） */}
        {isNavCollapsed ? null : (
          <div className="app-font-scale-area">
            {/* 唯一语言切换入口（展开态）：与字号档位同区，位于其上方一行 */}
            <div className="app-language-row">
              <LanguageSwitch />
            </div>
            <div className="app-font-scale-control">
              <Segmented
                onChange={(value) => {
                  if (value === 'compact' || value === 'standard' || value === 'comfortable') {
                    setFontScale(value);
                  }
                }}
                options={FONT_SCALE_OPTIONS}
                size="small"
                value={fontScale}
              />
            </div>
          </div>
        )}

        <div className="app-sidebar-footer">
          {/* 折叠态（含 ≤1024px 窄屏默认折叠）：语言入口收敛为图标按钮，保证可达 */}
          {isNavCollapsed ? (
            <div className="app-language-row">
              <LanguageSwitch variant="icon" />
            </div>
          ) : null}
          {session ? (
            <div className="app-user-card">
              {!isNavCollapsed ? (
                /* 头像取真实会话昵称首字符（装饰性，aria-hidden）；无假身份信息。
                   视觉配方来自公共 .user-avatar（基准表 2.2/2.4），尺寸档 --md = 38×38 */
                <span
                  aria-hidden="true"
                  className="app-user-card-avatar user-avatar user-avatar--md"
                >
                  {(session.userInfo?.nickname ?? t('layout.userFallback'))
                    .trim()
                    .charAt(0)
                    .toUpperCase()}
                </span>
              ) : null}
              <div className="app-user-card-info">
                <span className="app-user-card-name">
                  {session.userInfo?.nickname ?? t('layout.currentUser')}
                </span>
                <span className="app-user-card-role">{t(ROLE_LABEL_KEYS[session.role])}</span>
              </div>
              <div className="app-user-card-actions">
                <LogoutButton iconOnly={isNavCollapsed} />
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      {/* 工作区先占余宽（原型 workspace-page：渐变+22px 上距），内容再入 1280px 内层；
          知识库页按精确路由切换纯色铺满变体，其余页面保持通用基准（PR3 R7） */}
      <main className={workspaceClassName}>
        <div className={mainClassName}>
          {/* 资格生效的批准结果门：在工作台内容挂载前用服务端事实确认本人批准结果，
              确认后由用户显式「进入工作台」；门本身不改变路由授权。 */}
          <EngineerApprovalGate>{children ?? <Outlet />}</EngineerApprovalGate>
        </div>
      </main>

      {!isSidecarOpen ? (
        <div className="entry-trigger-shell" data-entry-open="false">
          <Button
            ref={triggerRef}
            aria-keyshortcuts="Alt+K"
            shape="round"
            size="large"
            type="primary"
            onClick={() => setIsSidecarOpen(true)}
          >
            <div className="flex items-center gap-2">
              <EntryAccentGlyph inverse />
              <span>AI</span>
              {showShortcutHint ? <span className="entry-trigger-shortcut">Alt+K</span> : null}
            </div>
          </Button>
        </div>
      ) : null}

      <AigcSidecar
        onClose={() => setIsSidecarOpen(false)}
        onNavigate={(path) => {
          navigate(path);
          setIsSidecarOpen(false);
        }}
        open={isSidecarOpen}
        routeCandidates={routeCandidates}
      />
    </div>
  );
}
