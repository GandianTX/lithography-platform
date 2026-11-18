// src/app/navigation/catalog.ts

import type { AuthSessionRole } from '@/features/auth-session';

import { type AppEnv, getAppEnv } from '@/shared/env';

import type { NavigationItem } from './types';

// PR1 S3 角色菜单：落点与 auth-session 角色路径表逐项对账
// （docs/plan/薛-PR1-S1现状与设计映射-20260914.md 第 2 节）。
// 「AI 故障诊断」尚无正式路由，按负责人红线（不得保留无效菜单/死链接）
// 暂不进入目录：AI 诊断待路由 owner 落定后加入。
const STABLE_NAVIGATION_ITEMS: NavigationItem[] = [
  {
    description: '按角色进入各自的工作台首页。',
    id: 'home',
    kind: 'stable',
    label: '首页',
    path: '/',
    tags: ['home', 'workbench', 'dashboard', '工作台', '首页'],
  },
  {
    description: '客户提交新的维修申请。',
    id: 'customer-repair-request-new',
    kind: 'stable',
    label: '发起申请',
    path: '/customer/repair-requests/new',
    roles: ['CUSTOMER'],
    tags: ['customer', 'repair', 'create', '发起申请', '新建'],
  },
  {
    description: '查看客户自己的维修申请与处理进度。',
    id: 'customer-repair-requests',
    kind: 'stable',
    label: '我的申请',
    path: '/customer/repair-requests',
    roles: ['CUSTOMER'],
    tags: ['customer', 'repair', 'list', '我的申请', '进度'],
  },
  {
    description: '工程师的维修申请列表：待接单、我的接单与他人已接单。',
    id: 'engineer-repair-requests',
    kind: 'stable',
    label: '维修申请',
    path: '/engineer/repair-requests',
    roles: ['ENGINEER'],
    tags: ['engineer', 'repair', 'list', '维修申请', '接单'],
  },
  {
    description: '查阅光刻机维护知识库：错误代码手册、维护指南、安全规范与检查表。',
    id: 'reference-documents',
    kind: 'stable',
    label: '参考资料',
    // 与 auth-session 角色路径表同口径：工程师/管理员可读，客户禁入不可见
    path: '/reference-documents',
    roles: ['ENGINEER', 'SUPER_ADMIN'],
    tags: ['reference', 'documents', 'knowledge', '参考资料', '知识库', '手册'],
  },
  {
    description: 'SUPER_ADMIN 的用户管理页面。',
    id: 'admin-users',
    kind: 'stable',
    label: '用户管理',
    // 仅对 SUPER_ADMIN 展示；ENGINEER / CUSTOMER 与未登录用户不显示管理员导航入口。
    // 展示过滤不替代路由守卫：未授权角色直达 /admin/users 仍由路由层拒绝。
    path: '/admin/users',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'users', 'management', '管理员', '用户管理'],
  },
  {
    description: 'SUPER_ADMIN 的公司档案维护：完整名单、详情、新增与编辑（含启停与维修资格）。',
    id: 'admin-companies',
    kind: 'stable',
    label: '公司档案',
    // 仅对 SUPER_ADMIN 展示；二级管理员进入后只读名称名单，服务端独立裁决写权限。
    // 展示过滤不替代路由守卫：未授权角色直达 /admin/companies 仍由路由层拒绝。
    path: '/admin/companies',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'companies', 'organization', '管理员', '公司档案', '维修服务'],
  },
  {
    description: 'SUPER_ADMIN 的工程师注册审批：一级全范围、二级仅本公司，可批准或填写原因拒绝。',
    id: 'admin-engineer-registrations',
    kind: 'stable',
    label: '注册审批',
    // 仅对 SUPER_ADMIN 展示；可见范围由服务端按请求期等级与可信公司独立裁决。
    // 展示过滤不替代路由守卫：未授权角色直达 /admin/engineer-registrations 仍由路由层拒绝。
    path: '/admin/engineer-registrations',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'registration', 'engineer', 'approval', '管理员', '注册审批', '工程师'],
  },
  {
    description: 'SUPER_ADMIN 的数据聚合视图：参考资料、维修申请、AI 会话与 AI 报告。',
    id: 'admin-document-database',
    kind: 'stable',
    label: '文档数据库',
    // PR3 S3 已交付真实聚合页；仅对 SUPER_ADMIN 展示，未授权直达由 /admin/** 路由层拒绝。
    path: '/admin/document-database',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'database', 'documents', 'aggregation', '文档数据库', '数据聚合'],
  },
  {
    description: 'SUPER_ADMIN 的工单直达入口：查看全部维修工单的接单、处理与结单状态。',
    id: 'admin-orders',
    kind: 'stable',
    label: '工单管理',
    // 复用文档数据库的维修申请列表/详情/修订能力；未授权直达由 /admin/** 路由层拒绝。
    path: '/admin/orders',
    roles: ['SUPER_ADMIN'],
    tags: ['admin', 'orders', 'repair', 'workbench', '管理员', '工单管理', '维修申请'],
  },
  {
    description: '维护登录凭据、基础资料与登录密码；修改密码成功后需重新登录。',
    id: 'account-settings',
    kind: 'stable',
    label: '账号设置',
    // 稳定入口置底（设置类惯例）；全部登录角色可见（/account 根路径对三种角色同时放行）
    path: '/account/settings',
    roles: ['CUSTOMER', 'ENGINEER', 'SUPER_ADMIN'],
    tags: ['account', 'settings', 'profile', 'password', '账号设置', '资料', '密码'],
  },
];

// 开发/试验入口：仅 dev/test 环境暴露。负责人 0914 裁定：error-preview 属生产的
// 「无效菜单」，与 labs/sandbox 同策略收进环境门控；/error-preview 路由本身保留
// （仍是真实的错误反馈预览功能）。
const DEV_ONLY_NAVIGATION_ITEMS: NavigationItem[] = [
  {
    description: '预览通用路由和运行时错误反馈。',
    id: 'error-preview',
    kind: 'stable',
    label: '错误预览',
    path: '/error-preview',
    tags: ['error', 'feedback', '404', '500', 'route', '错误页', '异常反馈'],
  },
  {
    description: '受控开放的 2048 交互实验。',
    id: 'game-2048-lab',
    kind: 'labs',
    label: '实验',
    path: '/labs/game-2048',
    tags: ['lab', '2048', 'game', 'experiment', '游戏', '实验'],
  },
  {
    description: '用于一次性检查主题 token 的开发试验台。',
    id: 'sandbox-playground',
    kind: 'sandbox',
    label: '沙盒',
    path: '/sandbox/playground',
    tags: ['sandbox', 'prototype', 'playground', 'token', 'theme', '沙盒', '主题'],
  },
  {
    description: '共享视觉 primitives 的真实渲染组合，供截图与 computed-style 取证。',
    id: 'shared-ui-gallery',
    kind: 'stable',
    label: '组件组合',
    path: '/dev/shared-ui',
    tags: ['shared', 'ui', 'gallery', 'primitives', '组件', '组合', '验收'],
  },
];

function canExposeDevItems(env: AppEnv) {
  return env === 'dev' || env === 'test';
}

/**
 * 导航目录出口：环境暴露 + 角色可见性统一过滤。
 * activeRole 为会话活动角色；匿名（null）只见无 roles 限制的入口。
 */
export function getNavigationItems(
  env: AppEnv = getAppEnv(),
  activeRole: AuthSessionRole | null = null,
): NavigationItem[] {
  const environmentItems = [
    ...STABLE_NAVIGATION_ITEMS,
    ...(canExposeDevItems(env) ? DEV_ONLY_NAVIGATION_ITEMS : []),
  ];

  return environmentItems.filter(
    (item) => item.roles === undefined || (activeRole !== null && item.roles.includes(activeRole)),
  );
}
