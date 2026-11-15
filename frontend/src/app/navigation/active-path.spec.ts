// src/app/navigation/active-path.spec.ts

import { describe, expect, it } from 'vitest';

import { resolveActiveNavigationPath } from './active-path';
import type { NavigationItem } from './types';

function item(id: string, path: string): NavigationItem {
  return {
    descriptionKey: 'nav.home.description',
    id,
    kind: 'stable',
    labelKey: 'nav.home.label',
    path,
    tags: [],
  };
}

const ITEMS = [
  item('home', '/'),
  item('customer-repair-request-new', '/customer/repair-requests/new'),
  item('customer-repair-requests', '/customer/repair-requests'),
  item('engineer-repair-requests', '/engineer/repair-requests'),
  item('reference-documents', '/reference-documents'),
  item('admin-users', '/admin/users'),
  // 中性父路径 fixture：仅验证前缀优先级，不代表任何真实/计划菜单（R2 P2-02）
  item('admin-root', '/admin'),
];

describe('resolveActiveNavigationPath', () => {
  it('根路径回落到首页', () => {
    expect(resolveActiveNavigationPath('/', ITEMS)).toBe('/');
  });

  it('业务子路由按前缀命中菜单项', () => {
    expect(resolveActiveNavigationPath('/customer/repair-requests/42', ITEMS)).toBe(
      '/customer/repair-requests',
    );
    expect(resolveActiveNavigationPath('/reference-documents/abc', ITEMS)).toBe(
      '/reference-documents',
    );
  });

  it('最长前缀优先：/admin/users 选中用户管理而非父路径', () => {
    expect(resolveActiveNavigationPath('/admin/users', ITEMS)).toBe('/admin/users');
  });

  it('最长前缀优先：/customer/repair-requests/new 选中发起申请而非我的申请', () => {
    expect(resolveActiveNavigationPath('/customer/repair-requests/new', ITEMS)).toBe(
      '/customer/repair-requests/new',
    );
  });

  it('带边界匹配：相似前缀不误命中', () => {
    expect(resolveActiveNavigationPath('/customer-abc', ITEMS)).toBe('/');
    expect(resolveActiveNavigationPath('/admin-users', ITEMS)).toBe('/');
  });

  it('角色主页等无业务菜单项的路径回落到首页', () => {
    expect(resolveActiveNavigationPath('/engineer', ITEMS)).toBe('/');
    expect(resolveActiveNavigationPath('/customer', ITEMS)).toBe('/');
    expect(resolveActiveNavigationPath('/login', ITEMS)).toBe('/');
  });

  it('菜单项缺失首页时无业务命中的结果为 undefined', () => {
    expect(resolveActiveNavigationPath('/engineer', ITEMS.slice(1))).toBeUndefined();
  });
});
