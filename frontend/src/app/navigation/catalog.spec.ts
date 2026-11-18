// src/app/navigation/catalog.spec.ts

import { describe, expect, it } from 'vitest';

import { getNavigationItems } from './catalog';

// 期望集合来自 docs/plan/薛-PR1-S1现状与设计映射-20260914.md 第 2 节菜单—路由表。
describe('navigation catalog（S1 菜单表对账）', () => {
  it('CUSTOMER 仅见首页、发起申请、我的申请', () => {
    const paths = getNavigationItems('prod', 'CUSTOMER').map((item) => item.path);

    expect(paths).toEqual([
      '/',
      '/customer/repair-requests/new',
      '/customer/repair-requests',
      '/account/settings',
    ]);
  });

  it('ENGINEER 仅见首页、维修申请、参考资料（AI 故障诊断无正式路由不入菜单）', () => {
    const paths = getNavigationItems('prod', 'ENGINEER').map((item) => item.path);

    expect(paths).toEqual([
      '/',
      '/engineer/repair-requests',
      '/reference-documents',
      '/account/settings',
    ]);
  });

  it('SUPER_ADMIN 见首页、参考资料、用户管理、公司档案、注册审批、文档数据库、工单管理与账号设置', () => {
    const paths = getNavigationItems('prod', 'SUPER_ADMIN').map((item) => item.path);

    expect(paths).toEqual([
      '/',
      '/reference-documents',
      '/admin/users',
      '/admin/companies',
      '/admin/engineer-registrations',
      '/admin/document-database',
      '/admin/orders',
      '/account/settings',
    ]);
  });

  it('匿名只见不受角色限制的入口', () => {
    const paths = getNavigationItems('prod', null).map((item) => item.path);

    expect(paths).toEqual(['/']);
  });

  it('生产环境不暴露开发入口（错误预览/实验/沙盒）', () => {
    const paths = getNavigationItems('prod', 'SUPER_ADMIN').map((item) => item.path);

    expect(paths).not.toContain('/error-preview');
    expect(paths).not.toContain('/labs/game-2048');
    expect(paths).not.toContain('/sandbox/playground');
  });

  it('dev 环境暴露开发入口', () => {
    const paths = getNavigationItems('dev', 'SUPER_ADMIN').map((item) => item.path);

    expect(paths).toContain('/error-preview');
    expect(paths).toContain('/labs/game-2048');
    expect(paths).toContain('/sandbox/playground');
  });

  it('全部正式菜单项均为中文标签（前端主语言为中文）', () => {
    const items = getNavigationItems('prod', 'SUPER_ADMIN');

    for (const item of items) {
      expect(item.label).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
