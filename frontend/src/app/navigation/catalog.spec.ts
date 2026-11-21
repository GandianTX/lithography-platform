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

  it('ENGINEER 见首页、维修申请、AI 对话、历史维修记录（直达新建页）、工单维修总结、我的资料记录、参考资料（任务05 S3 与任务 06/07 入口并存）', () => {
    const paths = getNavigationItems('prod', 'ENGINEER').map((item) => item.path);

    expect(paths).toEqual([
      '/',
      '/engineer/repair-requests',
      '/engineer/ai',
      // 2026-11-21 需求调整：入口直达新建记录页
      '/engineer/maintenance-records/new',
      '/engineer/work-order-summaries',
      // 任务 07 我的资料记录入口
      '/engineer/records',
      '/reference-documents',
      '/account/settings',
    ]);
  });

  it('SUPER_ADMIN 保留「我的资料记录」入口（2026-11-21 页面口径：管理员查本人记录，不读他人草稿）', () => {
    const paths = getNavigationItems('prod', 'SUPER_ADMIN', 'GLOBAL').map((item) => item.path);

    expect(paths).toContain('/engineer/records');
  });

  it('一级管理员见任务 08 管理入口、全域文档数据库、归属待核实（任务 07 R061-01）与任务 10 关键操作记录', () => {
    const paths = getNavigationItems('prod', 'SUPER_ADMIN', 'GLOBAL').map((item) => item.path);

    expect(paths).toEqual([
      '/',
      '/engineer/ai',
      '/engineer/records',
      '/reference-documents',
      '/admin/users',
      '/admin/companies',
      '/admin/engineer-registrations',
      '/admin/ai-conversations',
      '/admin/document-database',
      '/admin/reference-ownership',
      '/admin/operation-records',
      '/admin/orders',
      '/account/settings',
    ]);
  });

  it('任务 08 管理入口对一级平台与可信公司二级管理员可见；文档聚合仍为全域，任务 10 两级均可见', () => {
    for (const scope of ['PLATFORM', 'ORGANIZATION'] as const) {
      expect(getNavigationItems('prod', 'SUPER_ADMIN', scope).map((item) => item.path)).toEqual([
        '/',
        '/engineer/ai',
        '/engineer/records',
        '/reference-documents',
        '/admin/users',
        '/admin/companies',
        '/admin/engineer-registrations',
        '/admin/ai-conversations',
        '/admin/operation-records',
        '/admin/orders',
        '/account/settings',
      ]);
    }

    expect(getNavigationItems('prod', 'SUPER_ADMIN').map((item) => item.path)).toEqual([
      '/',
      '/engineer/ai',
      '/engineer/records',
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
