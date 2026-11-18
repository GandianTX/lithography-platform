// src/app/navigation/types.ts

import type { AuthSessionRole } from '@/features/auth-session';

import type { MessageKey } from '@/shared/i18n';

export type NavigationItemKind = 'stable' | 'labs' | 'sandbox';

/**
 * 导航目录项：数据层只存词条键，渲染时由 `resolveNavigationItems` 用当前语言的
 * 翻译函数解析，目录本身不依赖 React 或具体语言。
 */
export type NavigationItem = {
  descriptionKey: MessageKey;
  id: string;
  kind: NavigationItemKind;
  labelKey: MessageKey;
  path: string;
  /**
   * 可选角色白名单：声明该项仅对哪些当前活动角色展示，并按当前会话 activeRole 做展示过滤。
   * 缺省表示不按角色限制（匿名或任意角色均可见）；只做展示过滤，不替代路由守卫。
   * 类型直接引用 auth-session 的 AuthSessionRole，角色值漂移在编译期报错，
   * 不在此建立第二份角色映射。
   */
  roles?: readonly AuthSessionRole[];
  tags: readonly string[];
};

/** 解析后的导航项：保留目录事实，并按当前语言解析出展示文案 */
export type ResolvedNavigationItem = NavigationItem & {
  description: string;
  label: string;
};
