// src/app/navigation/catalog.spec.ts

import { describe, expect, it } from 'vitest';

import { createTranslator } from '@/shared/i18n';

import { getNavigationItems, resolveNavigationItems } from './catalog';

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

  it('一级管理员见任务 08 管理入口和全域文档数据库', () => {
    const paths = getNavigationItems('prod', 'SUPER_ADMIN', 'GLOBAL').map((item) => item.path);

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

  it('2 级管理员与未知等级不出现全域管理入口（S1 范围收敛）', () => {
    // 2 级管理员（有可信公司）与缺等级/非法等级一律不出全域入口；
    // 本公司入口尚无正式路由，因此只保留角色通用入口。
    for (const scope of ['ORGANIZATION', 'NONE'] as const) {
      const paths = getNavigationItems('prod', 'SUPER_ADMIN', scope).map((item) => item.path);

      expect(paths).toEqual(['/', '/reference-documents', '/account/settings']);
    }

    // 第三参缺省为 NONE：未传管理范围的调用方不会意外获得全域入口
    expect(getNavigationItems('prod', 'SUPER_ADMIN').map((item) => item.path)).toEqual([
      '/',
      '/reference-documents',
      '/account/settings',
    ]);
  });

  it('匿名只见不受角色限制的入口', () => {
    const paths = getNavigationItems('prod', null).map((item) => item.path);

    expect(paths).toEqual(['/']);
  });

  it('生产环境不暴露开发入口（错误预览/实验/沙盒）', () => {
    const paths = getNavigationItems('prod', 'SUPER_ADMIN', 'GLOBAL').map((item) => item.path);

    expect(paths).not.toContain('/error-preview');
    expect(paths).not.toContain('/labs/game-2048');
    expect(paths).not.toContain('/sandbox/playground');
  });

  it('dev 环境暴露开发入口', () => {
    const paths = getNavigationItems('dev', 'SUPER_ADMIN', 'GLOBAL').map((item) => item.path);

    expect(paths).toContain('/error-preview');
    expect(paths).toContain('/labs/game-2048');
    expect(paths).toContain('/sandbox/playground');
  });

  it('全部正式菜单项均为中文标签（前端主语言为中文）', () => {
    const items = resolveNavigationItems(
      getNavigationItems('prod', 'SUPER_ADMIN', 'GLOBAL'),
      createTranslator('zh-CN'),
    );

    for (const item of items) {
      expect(item.label).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
