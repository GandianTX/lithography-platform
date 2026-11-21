// e2e/helpers/auth-session-seed.ts

import type { Page } from '@playwright/test';

/**
 * e2e 预置会话快照的唯一收口：字段布局跟随 features/auth-session 的
 * auth-session-storage 持久化格式（当前 version: 3），格式升版时只改这里。
 * 各 *.spec.ts 一律导入本文件，不再复制快照结构。
 */
export const AUTH_SESSION_STORAGE_KEY = 'lithography-platform.auth-session.v1';

export type SeededAuthSessionRole = 'CUSTOMER' | 'ENGINEER' | 'SUPER_ADMIN';

/** 预置会话可选的管理员侧事实（路由守卫按 adminLevel 与可信公司判定管理员页面准入） */
export type SeededAuthSessionAdminFacts = {
  /** 管理员等级：1=一级（全公司）；2=二级（本公司） */
  adminLevel?: number | null;
  /** 请求期复核得到的可信管理员公司 */
  adminOrganizationId?: number | null;
};

export async function seedAuthSession(
  page: Page,
  role: SeededAuthSessionRole,
  adminFacts: SeededAuthSessionAdminFacts = {},
) {
  // sessionStorage 按源隔离：必须先落在应用源上再写入，否则预置会话无效。
  await page.goto('/');
  await page.evaluate(
    ({ key, role: seededRole, adminLevel, adminOrganizationId }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          accessToken: 'test-only-access-token',
          accountId: 900201,
          adminLevel: adminLevel ?? null,
          customerOrganizationId: null,
          engineerOrganizationId: null,
          adminOrganizationId: adminOrganizationId ?? null,
          registrationOrganizationId: null,
          restriction: 'NONE',
          role: seededRole,
          userInfo: {
            accessGroup: [seededRole],
            nickname: '测试会话',
          },
          version: 3,
        }),
      );
    },
    {
      key: AUTH_SESSION_STORAGE_KEY,
      role,
      adminLevel: adminFacts.adminLevel ?? null,
      adminOrganizationId: adminFacts.adminOrganizationId ?? null,
    },
  );
}

export function readStoredAuthSession(page: Page) {
  return page.evaluate((key) => sessionStorage.getItem(key), AUTH_SESSION_STORAGE_KEY);
}
