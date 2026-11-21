// src/app/navigation/catalog.ts

import {
  type AuthSessionAdminScope,
  type AuthSessionRole,
  isAuthSessionAdminPathAllowedAt,
} from '@/features/auth-session';

import { type AppEnv, getAppEnv } from '@/shared/env';
import type { Translate } from '@/shared/i18n';

import type { NavigationItem, ResolvedNavigationItem } from './types';

// PR1 S3 角色菜单：落点与 auth-session 角色路径表逐项对账
//（docs/plan/薛-PR1-S1现状与设计映射-20260914.md 第 2 节菜单—路由表）。
// 「AI 故障诊断」入口在任务05 S3 随 /engineer/ai 工作区落地后加入目录（此前无正式路由，
// 按负责人红线不保留无效菜单/死链接）。
// 文案只存词条键（S5）：渲染时按当前语言解析，tags 仍保留中文关键词供 AI 检索匹配。
const STABLE_NAVIGATION_ITEMS: NavigationItem[] = [
  {
    descriptionKey: 'nav.home.description',
    id: 'home',
    kind: 'stable',
    labelKey: 'nav.home.label',
    path: '/',
    tags: ['home', 'workbench', 'dashboard', '工作台', '首页'],
  },
  {
    descriptionKey: 'nav.customer-repair-request-new.description',
    id: 'customer-repair-request-new',
    kind: 'stable',
    labelKey: 'nav.customer-repair-request-new.label',
    path: '/customer/repair-requests/new',
    roles: ['CUSTOMER'],
    tags: ['customer', 'repair', 'create', '发起申请', '新建'],
  },
  {
    descriptionKey: 'nav.customer-repair-requests.description',
    id: 'customer-repair-requests',
    kind: 'stable',
    labelKey: 'nav.customer-repair-requests.label',
    path: '/customer/repair-requests',
    roles: ['CUSTOMER'],
    tags: ['customer', 'repair', 'list', '我的申请', '进度'],
  },
  {
    descriptionKey: 'nav.engineer-repair-requests.description',
    id: 'engineer-repair-requests',
    kind: 'stable',
    labelKey: 'nav.engineer-repair-requests.label',
    path: '/engineer/repair-requests',
    roles: ['ENGINEER'],
    tags: ['engineer', 'repair', 'list', '维修申请', '接单'],
  },
  {
    descriptionKey: 'nav.engineer-ai.description',
    id: 'engineer-ai',
    kind: 'stable',
    labelKey: 'nav.engineer-ai.label',
    // 任务05 S3：/engineer/ai 路由与工作区已落地，方可进入目录（不留死链接）。
    // 角色可见性与后端一致：获批工程师与管理员可读；客户由路由层拒绝。
    path: '/engineer/ai',
    roles: ['ENGINEER', 'SUPER_ADMIN'],
    tags: ['engineer', 'ai', 'chat', 'diagnosis', 'AI', '诊断', '对话', '问答'],
  },
  {
    // 2026-11-21 需求调整：导航与首页入口直达「新建记录」页（列表由新建页
    // 的「我的历史记录」入口与 /engineer/maintenance-records 列表路由承接）
    descriptionKey: 'nav.engineer-maintenance-records.description',
    id: 'engineer-maintenance-records',
    kind: 'stable',
    labelKey: 'nav.engineer-maintenance-records.label',
    path: '/engineer/maintenance-records/new',
    roles: ['ENGINEER'],
    tags: ['engineer', 'maintenance', 'record', '历史维修记录', '独立报告'],
  },
  {
    descriptionKey: 'nav.engineer-work-order-summaries.description',
    id: 'engineer-work-order-summaries',
    kind: 'stable',
    labelKey: 'nav.engineer-work-order-summaries.label',
    path: '/engineer/work-order-summaries',
    roles: ['ENGINEER'],
    tags: ['engineer', 'work', 'order', 'summary', '工单维修总结', '只读核对'],
  },
  {
    descriptionKey: 'nav.my-records.description',
    id: 'my-records',
    kind: 'stable',
    labelKey: 'nav.my-records.label',
    // 任务 07（2026-11-21 页面口径确认）：工程师与管理员均保留入口；页面只展示
    // 本人创建记录（后端按作者 + 本组织谓词收敛，管理员无本人记录时展示暂无记录），
    // 管理员查看他人正式资料走参考资料库/文档数据库，不经过本页面
    path: '/engineer/records',
    roles: ['ENGINEER', 'SUPER_ADMIN'],
    tags: ['records', 'reports', 'drafts', '我的资料记录', '草稿', '历史报告'],
  },
  {
    descriptionKey: 'nav.reference-documents.description',
    id: 'reference-documents',
    kind: 'stable',
    labelKey: 'nav.reference-documents.label',
    // 与 auth-session 角色路径表同口径：工程师/管理员可读，客户禁入不可见
    path: '/reference-documents',
    roles: ['ENGINEER', 'SUPER_ADMIN'],
    tags: ['reference', 'documents', 'knowledge', '参考资料', '知识库', '手册'],
  },
  {
    descriptionKey: 'nav.admin-users.description',
    id: 'admin-users',
    kind: 'stable',
    labelKey: 'nav.admin-users.label',
    // 仅对 SUPER_ADMIN 展示；ENGINEER / CUSTOMER 与未登录用户不显示管理员导航入口。
    // 展示过滤不替代路由守卫：未授权角色直达 /admin/users 仍由路由层拒绝。
    // 二级管理员仅可操作本可信公司的普通账号。
    path: '/admin/users',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'users', 'management', '管理员', '用户管理'],
  },
  {
    descriptionKey: 'nav.admin-companies.description',
    id: 'admin-companies',
    kind: 'stable',
    labelKey: 'nav.admin-companies.label',
    // 仅对 SUPER_ADMIN 展示；二级管理员进入后只读名称名单，服务端独立裁决写权限。
    // 展示过滤不替代路由守卫：未授权角色直达 /admin/companies 仍由路由层拒绝。
    path: '/admin/companies',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'companies', 'organization', '管理员', '公司档案', '维修服务'],
  },
  {
    descriptionKey: 'nav.admin-engineer-registrations.description',
    id: 'admin-engineer-registrations',
    kind: 'stable',
    labelKey: 'nav.admin-engineer-registrations.label',
    // 仅对 SUPER_ADMIN 展示；可见范围由服务端按请求期等级与可信公司独立裁决。
    // 展示过滤不替代路由守卫：未授权角色直达 /admin/engineer-registrations 仍由路由层拒绝。
    path: '/admin/engineer-registrations',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'registration', 'engineer', 'approval', '管理员', '注册审批', '工程师'],
  },
  {
    descriptionKey: 'nav.admin-ai-conversations.description',
    id: 'admin-ai-conversations',
    kind: 'stable',
    labelKey: 'nav.admin-ai-conversations.label',
    // 任务 05 S4.1：AI 会话只读入口。一级跨公司、二级本公司（服务端裁决范围），
    // 因此对两级管理员均展示；文档数据库整体页仍为一级专属。
    path: '/admin/ai-conversations',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'ai', 'conversation', 'readonly', 'AI 会话', '问答记录'],
  },
  {
    descriptionKey: 'nav.admin-document-database.description',
    id: 'admin-document-database',
    kind: 'stable',
    labelKey: 'nav.admin-document-database.label',
    // PR3 S3 已交付真实聚合页；仅对 SUPER_ADMIN 展示，未授权直达由 /admin/** 路由层拒绝。
    // 同为全域能力，仅 1 级管理员可见（S1）。
    path: '/admin/document-database',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'database', 'documents', 'aggregation', '文档数据库', '数据聚合'],
  },
  {
    descriptionKey: 'nav.admin-reference-ownership.description',
    id: 'admin-reference-ownership',
    kind: 'stable',
    labelKey: 'nav.admin-reference-ownership.label',
    // 归属待核实（任务 07 R061-01）：与普通资料库分开的一级管理员专用清单入口；
    // 展示过滤不替代路由守卫：/admin/reference-ownership 直达由管理路径策略按
    // GLOBAL 范围拒绝二级，服务端按一级身份与 PENDING 谓词独立裁决。
    path: '/admin/reference-ownership',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'ownership', 'pending', 'reference', '归属待核实', '归属核实', '资料'],
  },
  {
    descriptionKey: 'nav.admin-orders.description',
    id: 'admin-orders',
    kind: 'stable',
    labelKey: 'nav.admin-orders.label',
    // 复用文档数据库的维修申请列表/详情/修订能力；未授权直达由 /admin/** 路由层拒绝。
    path: '/admin/orders',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'orders', 'repair', 'workbench', '管理员', '工单管理', '维修申请'],
  },
  {
    descriptionKey: 'nav.account-settings.description',
    id: 'account-settings',
    kind: 'stable',
    labelKey: 'nav.account-settings.label',
    // 稳定入口置底（设置类惯例）；全部登录角色可见（/account 根路径对三种角色同时放行）
    path: '/account/settings',
    roles: ['CUSTOMER', 'ENGINEER', 'SUPER_ADMIN'],
    tags: ['account', 'settings', 'profile', 'password', '账号设置', '资料', '密码'],
  },
  {
    descriptionKey: 'nav.local-backup.description',
    id: 'local-backup',
    kind: 'stable',
    labelKey: 'nav.local-backup.label',
    // 任务 09 S3/S4：备份与恢复页（自动备份设置、手动备份、备份记录、恢复预检）。
    // 放在本地设置之前，保持「本地设置」为导航末项的既定口径。
    path: '/local-backup',
    roles: ['ENGINEER', 'SUPER_ADMIN'],
    tags: ['local', 'backup', 'restore', 'data-center', '本地', '备份', '恢复', '数据'],
  },
  {
    descriptionKey: 'nav.local-settings.description',
    id: 'local-settings',
    kind: 'stable',
    labelKey: 'nav.local-settings.label',
    // 任务 09 R064：导航最后一项、只读；工程师与管理员的"本机本公司"入口。
    // 客户禁入（角色路径表同口径拒绝），可见公司范围由服务端按 Session 裁决。
    path: '/local-settings',
    roles: ['ENGINEER', 'SUPER_ADMIN'],
    tags: ['local', 'settings', 'device', 'backup', '本地设置', '本机', '存储位置', '备份'],
  },
];

// 开发/试验入口：仅 dev/test 环境暴露。负责人 0914 裁定：error-preview 属生产的
// 「无效菜单」，与 labs/sandbox 同策略收进环境门控；/error-preview 路由本身保留
// （仍是真实的错误反馈预览功能）。
const DEV_ONLY_NAVIGATION_ITEMS: NavigationItem[] = [
  {
    descriptionKey: 'nav.error-preview.description',
    id: 'error-preview',
    kind: 'stable',
    labelKey: 'nav.error-preview.label',
    path: '/error-preview',
    tags: ['error', 'feedback', '404', '500', 'route', '错误页', '异常反馈'],
  },
  {
    descriptionKey: 'nav.game-2048-lab.description',
    id: 'game-2048-lab',
    kind: 'labs',
    labelKey: 'nav.game-2048-lab.label',
    path: '/labs/game-2048',
    tags: ['lab', '2048', 'game', 'experiment', '游戏', '实验'],
  },
  {
    descriptionKey: 'nav.sandbox-playground.description',
    id: 'sandbox-playground',
    kind: 'sandbox',
    labelKey: 'nav.sandbox-playground.label',
    path: '/sandbox/playground',
    tags: ['sandbox', 'prototype', 'playground', 'token', 'theme', '沙盒', '主题'],
  },
  {
    descriptionKey: 'nav.shared-ui-gallery.description',
    id: 'shared-ui-gallery',
    kind: 'stable',
    labelKey: 'nav.shared-ui-gallery.label',
    path: '/dev/shared-ui',
    tags: ['shared', 'ui', 'gallery', 'primitives', '组件', '组合', '验收'],
  },
];

function canExposeDevItems(env: AppEnv) {
  return env === 'dev' || env === 'test';
}

/**
 * 导航目录出口：环境暴露 + 角色可见性 + 管理范围统一过滤。
 * activeRole 为会话活动角色；匿名（null）只见无 roles 限制的入口。
 * adminScope 缺省 NONE：全域管理入口只在 1 级管理员（GLOBAL）时出现。
 */
export function getNavigationItems(
  env: AppEnv = getAppEnv(),
  activeRole: AuthSessionRole | null = null,
  adminScope: AuthSessionAdminScope = 'NONE',
): NavigationItem[] {
  const environmentItems = [
    ...STABLE_NAVIGATION_ITEMS,
    ...(canExposeDevItems(env) ? DEV_ONLY_NAVIGATION_ITEMS : []),
  ];

  return environmentItems.filter((item) => {
    const roleVisible =
      item.roles === undefined || (activeRole !== null && item.roles.includes(activeRole));

    if (!roleVisible) {
      return false;
    }

    return isAuthSessionAdminPathAllowedAt(adminScope, item.path, activeRole);
  });
}

/**
 * 按当前语言解析导航文案：目录只存键，解析结果供侧栏与 AI 侧车路由候选共用，
 * 保证两处标签同源、切换语言后同时更新。
 */
export function resolveNavigationItems(
  items: readonly NavigationItem[],
  t: Translate,
): ResolvedNavigationItem[] {
  return items.map((item) => ({
    ...item,
    description: t(item.descriptionKey),
    label: t(item.labelKey),
  }));
}
