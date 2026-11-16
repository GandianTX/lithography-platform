// src/features/auth-session/application/auth-session-policy.spec.ts

import { describe, expect, it } from 'vitest';

import {
  createAuthSessionSnapshot,
  isAuthSessionExpiredReason,
  isAuthSessionRoleAllowedAt,
  resolveAuthSessionAdminScope,
  resolveAuthSessionEntryPath,
  resolveAuthSessionHomePath,
  resolveEntryRouteRedirect,
  resolveLoginRouteRedirect,
  resolveProtectedRouteRedirect,
  resolveSafeReturnTo,
  resolveSessionExpiredLoginPath,
} from './auth-session-policy';

describe('auth session policy', () => {
  it('maps each known role to its frozen home route', () => {
    expect(resolveAuthSessionHomePath('SUPER_ADMIN')).toBe('/admin');
    expect(resolveAuthSessionHomePath('ENGINEER')).toBe('/engineer');
    expect(resolveAuthSessionHomePath('CUSTOMER')).toBe('/customer');
  });

  it('redirects authenticated sessions away from the login route', () => {
    const session = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900201,
      role: 'CUSTOMER',
      userInfo: null,
    });

    expect(resolveLoginRouteRedirect(session)).toBe('/customer');
    expect(resolveLoginRouteRedirect(null)).toBeNull();
  });

  it('enters the role default entry from the backend role', () => {
    expect(resolveAuthSessionEntryPath({ role: 'SUPER_ADMIN' }, null)).toBe('/admin');
    expect(resolveAuthSessionEntryPath({ role: 'ENGINEER' }, null)).toBe('/engineer');
    expect(resolveAuthSessionEntryPath({ role: 'CUSTOMER' }, null)).toBe('/customer');
  });

  it('adopts a safe in-role returnTo and falls back to the default entry otherwise', () => {
    expect(resolveAuthSessionEntryPath({ role: 'ENGINEER' }, '/engineer?tab=open')).toBe(
      '/engineer?tab=open',
    );
    expect(resolveAuthSessionEntryPath({ role: 'ENGINEER' }, '/customer')).toBe('/engineer');
    expect(resolveAuthSessionEntryPath({ role: 'ENGINEER' }, 'https://example.com')).toBe(
      '/engineer',
    );
  });

  it('lets SUPER_ADMIN inherit ENGINEER and CUSTOMER route access', () => {
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/admin')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/engineer')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/customer')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/engineer')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/customer')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/admin')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/customer')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/engineer')).toBe(false);
  });

  it('allows role sub-pages and trailing slashes but rejects lookalike prefixes', () => {
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/customer/')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/customer/repair-requests/new')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/customer-admin')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/customerABC')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/engineer/repair-requests/1')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/customer/repair-requests/1')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/admin/settings')).toBe(true);
    // PR3 S3：/admin/document-database 沿 /admin/** 根路径表规则（文档数据库定点断言）
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/admin/document-database')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/admin/document-database')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/admin/document-database')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/engineer/repair-requests/1')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/admin-console')).toBe(false);
  });

  it('denies SUPER_ADMIN the customer create page despite inheritance (2026-08-29 裁定)', () => {
    // 后端精确仅接受 CUSTOMER 创建；继承放行会造成残缺页面，故路由层显式拒绝。
    // 拒绝语义与根路径表一致：精确命中与带边界子路径均拒绝。
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/customer/repair-requests/new')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/customer/repair-requests/new/')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/customer')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/customer/repair-requests/new')).toBe(true);
  });

  it('gates the reference-document routes by role (0907 任务二)', () => {
    // 读：ENGINEER/SUPER_ADMIN 放行（根路径表带边界前缀，详情子路径同规则）；
    // 写页：ENGINEER 拒绝清单优先于根路径表，避免「能进页但提交必被拒」的残缺态；
    // CUSTOMER 不在允许表，全部子路径（含详情）均拒，与后端读守卫口径一致。
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/reference-documents')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/reference-documents/new')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/reference-documents/970001')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/reference-documents')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/reference-documents/970001')).toBe(true);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/reference-documents/new')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('ENGINEER', '/reference-documents/new/')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/reference-documents')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/reference-documents/970001')).toBe(false);
    expect(isAuthSessionRoleAllowedAt('CUSTOMER', '/reference-documents/new')).toBe(false);
    // 相似前缀不落入本功能规则（带边界匹配边界依旧成立）。
    expect(isAuthSessionRoleAllowedAt('SUPER_ADMIN', '/reference-documents-library')).toBe(false);
  });

  it('guards role sub-pages through the shared role path policy', () => {
    const engineerSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900101,
      role: 'ENGINEER',
      userInfo: null,
    });
    const customerSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900201,
      role: 'CUSTOMER',
      userInfo: null,
    });
    const superAdminSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900001,
      adminLevel: 1,
      adminOrganizationId: 910003,
      role: 'SUPER_ADMIN',
      userInfo: null,
    });

    expect(
      resolveProtectedRouteRedirect(engineerSession, '/engineer/repair-requests/1'),
    ).toBeNull();
    expect(resolveProtectedRouteRedirect(engineerSession, '/customer/repair-requests/1')).toBe(
      '/engineer',
    );
    expect(resolveProtectedRouteRedirect(customerSession, '/customer/')).toBeNull();
    expect(resolveProtectedRouteRedirect(customerSession, '/customer-admin')).toBe('/customer');
    expect(resolveProtectedRouteRedirect(superAdminSession, '/admin/settings')).toBeNull();
    // PR3 S3：文档数据库页未授权直达被拒，跳回管理员主页
    expect(resolveProtectedRouteRedirect(superAdminSession, '/admin/document-database')).toBeNull();
    // SUPER_ADMIN 访问创建页与 ENGINEER 一致：跳回各自个人主页，不是 403。
    expect(resolveProtectedRouteRedirect(superAdminSession, '/customer/repair-requests/new')).toBe(
      '/admin',
    );
  });

  it('resolves the admin scope from trusted level and organization facts (S1)', () => {
    // 只有 SUPER_ADMIN 且等级可信才具备管理范围；非管理员即便带等级也不升级
    expect(resolveAuthSessionAdminScope({ role: 'CUSTOMER' })).toBe('NONE');
    expect(resolveAuthSessionAdminScope({ role: 'ENGINEER', adminLevel: 1 })).toBe('NONE');

    // 一级无可信组织仍可访问任务 08 平台管理入口
    expect(resolveAuthSessionAdminScope({ role: 'SUPER_ADMIN', adminLevel: 1 })).toBe('PLATFORM');
    expect(
      resolveAuthSessionAdminScope({
        role: 'SUPER_ADMIN',
        adminLevel: 1,
        adminOrganizationId: 910003,
      }),
    ).toBe('GLOBAL');

    // 2 级 = 本公司，但公司归属必须是正整数才可信
    expect(
      resolveAuthSessionAdminScope({
        role: 'SUPER_ADMIN',
        adminLevel: 2,
        adminOrganizationId: 910004,
      }),
    ).toBe('ORGANIZATION');
    expect(resolveAuthSessionAdminScope({ role: 'SUPER_ADMIN', adminLevel: 2 })).toBe('NONE');
    expect(
      resolveAuthSessionAdminScope({
        role: 'SUPER_ADMIN',
        adminLevel: 2,
        adminOrganizationId: 0,
      }),
    ).toBe('NONE');

    // 缺等级与非法等级一律不升级
    expect(resolveAuthSessionAdminScope({ role: 'SUPER_ADMIN', adminLevel: null })).toBe('NONE');
    expect(resolveAuthSessionAdminScope({ role: 'SUPER_ADMIN', adminLevel: 3 })).toBe('NONE');
    expect(resolveAuthSessionAdminScope({ role: 'SUPER_ADMIN', adminLevel: 1.5 })).toBe('NONE');
  });

  it('distinguishes task 08 management from the document database using trusted scope', () => {
    const globalAdmin = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900307,
      adminLevel: 1,
      adminOrganizationId: 910003,
      role: 'SUPER_ADMIN',
      userInfo: null,
    });
    const level2Admin = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900308,
      adminLevel: 2,
      adminOrganizationId: 910004,
      role: 'SUPER_ADMIN',
      userInfo: null,
    });
    const level2AdminWithoutOrg = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900308,
      adminLevel: 2,
      role: 'SUPER_ADMIN',
      userInfo: null,
    });
    const unknownLevelAdmin = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900309,
      adminLevel: null,
      role: 'SUPER_ADMIN',
      userInfo: null,
    });

    const level1WithoutOrg = { ...globalAdmin, adminOrganizationId: null };
    for (const path of ['/admin/users', '/admin/companies', '/admin/engineer-registrations']) {
      for (const session of [globalAdmin, level1WithoutOrg, level2Admin]) {
        expect(resolveProtectedRouteRedirect(session, path)).toBeNull();
      }
      for (const session of [level2AdminWithoutOrg, unknownLevelAdmin]) {
        expect(resolveProtectedRouteRedirect(session, path)).toBe('/admin');
      }
    }

    expect(resolveProtectedRouteRedirect(globalAdmin, '/admin/document-database')).toBeNull();
    for (const session of [
      level1WithoutOrg,
      level2Admin,
      level2AdminWithoutOrg,
      unknownLevelAdmin,
    ]) {
      expect(resolveProtectedRouteRedirect(session, '/admin/document-database')).toBe('/admin');
    }

    // 非全域范围不影响管理员主页与既有继承路由
    expect(resolveProtectedRouteRedirect(level2Admin, '/admin')).toBeNull();
    expect(resolveProtectedRouteRedirect(level2Admin, '/engineer')).toBeNull();

    // 相似前缀不是全域路径，不能误伤 2 级管理员的 /admin 子路径
    expect(resolveProtectedRouteRedirect(level2Admin, '/admin/users-x')).toBeNull();

    // 登录 returnTo 与直达同语义。
    expect(resolveAuthSessionEntryPath(level2Admin, '/admin/document-database')).toBe('/admin');
    expect(resolveAuthSessionEntryPath(level2Admin, '/admin/users')).toBe('/admin/users');
    expect(resolveAuthSessionEntryPath(globalAdmin, '/admin/users')).toBe('/admin/users');
  });

  it('funnels restricted sessions into the dedicated landing page', () => {
    const pendingSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900101,
      restriction: 'ENGINEER_PENDING',
      role: 'ENGINEER',
      userInfo: null,
    });
    const mustChangeSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900102,
      restriction: 'MUST_CHANGE_PASSWORD',
      role: 'ENGINEER',
      userInfo: null,
    });
    const normalSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900103,
      role: 'ENGINEER',
      userInfo: null,
    });

    // 入口 / 登录回跳 / 受保护路由：受限会话一律落到 /restricted，不看 returnTo
    expect(resolveAuthSessionEntryPath(pendingSession, '/engineer')).toBe('/restricted');
    expect(resolveLoginRouteRedirect(pendingSession, '/engineer?tab=open')).toBe('/restricted');
    expect(resolveEntryRouteRedirect(mustChangeSession)).toBe('/restricted');
    expect(resolveProtectedRouteRedirect(pendingSession, '/engineer')).toBe('/restricted');
    expect(resolveProtectedRouteRedirect(pendingSession, '/account/settings')).toBe('/restricted');
    expect(resolveProtectedRouteRedirect(pendingSession, '/restricted')).toBeNull();
    expect(resolveProtectedRouteRedirect(pendingSession, '/restricted/')).toBeNull();

    // 非受限会话不得停留在受限页：回到自己的角色主页
    expect(resolveProtectedRouteRedirect(normalSession, '/restricted')).toBe('/engineer');
    expect(resolveProtectedRouteRedirect({ role: 'CUSTOMER' }, '/restricted')).toBe('/customer');
  });

  it('adopts a same-role sub-page returnTo and rejects cross-role or lookalike targets', () => {
    expect(resolveAuthSessionEntryPath({ role: 'CUSTOMER' }, '/customer/repair-requests/new')).toBe(
      '/customer/repair-requests/new',
    );
    expect(resolveAuthSessionEntryPath({ role: 'ENGINEER' }, '/customer/repair-requests/new')).toBe(
      '/engineer',
    );
    expect(resolveAuthSessionEntryPath({ role: 'CUSTOMER' }, '/customer-admin')).toBe('/customer');
    expect(resolveLoginRouteRedirect({ role: 'CUSTOMER' }, '/customer/repair-requests/new')).toBe(
      '/customer/repair-requests/new',
    );
  });

  it('falls back to the role default entry for denied or cross-role returnTo after re-login', () => {
    // 不同角色重新登录时不得进入无权限页面：含 2026-08-29 裁定的超管拒绝清单。
    expect(
      resolveAuthSessionEntryPath({ role: 'SUPER_ADMIN' }, '/customer/repair-requests/new'),
    ).toBe('/admin');
    expect(resolveAuthSessionEntryPath({ role: 'ENGINEER' }, '/admin')).toBe('/engineer');
    expect(resolveAuthSessionEntryPath({ role: 'CUSTOMER' }, '/engineer')).toBe('/customer');
  });

  it('accepts only the predefined session-expired reason as an expiry signal', () => {
    // 后端原始 message、errorCode、Token 或任意字符串都不被视为失效原因。
    expect(isAuthSessionExpiredReason('session-expired')).toBe(true);
    expect(isAuthSessionExpiredReason('UNAUTHENTICATED')).toBe(false);
    expect(isAuthSessionExpiredReason('internal auth detail')).toBe(false);
    expect(isAuthSessionExpiredReason('INVALID_TOKEN')).toBe(false);
    expect(isAuthSessionExpiredReason(null)).toBe(false);
    expect(isAuthSessionExpiredReason(undefined)).toBe(false);
    expect(isAuthSessionExpiredReason(401)).toBe(false);
  });

  it('carries the fixed reason and the safe pre-expiry path as returnTo', () => {
    expect(resolveSessionExpiredLoginPath('/customer/repair-requests/new')).toBe(
      '/login?reason=session-expired&returnTo=%2Fcustomer%2Frepair-requests%2Fnew',
    );
    expect(resolveSessionExpiredLoginPath('/engineer?tab=open')).toBe(
      '/login?reason=session-expired&returnTo=%2Fengineer%3Ftab%3Dopen',
    );
  });

  it('never attaches a returnTo loop when already on the login route', () => {
    expect(resolveSessionExpiredLoginPath('/login')).toBe('/login?reason=session-expired');
    expect(resolveSessionExpiredLoginPath('/login?returnTo=%2Fcustomer')).toBe(
      '/login?reason=session-expired',
    );
  });

  it('excludes the whole /login prefix, including trailing-slash forms', () => {
    // /login 是叶子路由，其子路径都不是有效的返回目标；
    // 但相似前缀 /login-admin 不能被误排除（带边界匹配）。
    expect(resolveSessionExpiredLoginPath('/login/')).toBe('/login?reason=session-expired');
    expect(resolveSessionExpiredLoginPath('/login/extra')).toBe('/login?reason=session-expired');
    expect(resolveSessionExpiredLoginPath('/login-admin')).toBe(
      '/login?reason=session-expired&returnTo=%2Flogin-admin',
    );
  });

  it('drops external, protocol-relative, backslashed and control-character paths', () => {
    expect(resolveSessionExpiredLoginPath('https://example.com/admin')).toBe(
      '/login?reason=session-expired',
    );
    expect(resolveSessionExpiredLoginPath('//example.com/admin')).toBe(
      '/login?reason=session-expired',
    );
    expect(resolveSessionExpiredLoginPath('/\\example.com')).toBe('/login?reason=session-expired');
    expect(resolveSessionExpiredLoginPath('/engineer\u007Ftab')).toBe(
      '/login?reason=session-expired',
    );
    expect(resolveSessionExpiredLoginPath(null)).toBe('/login?reason=session-expired');
    expect(resolveSessionExpiredLoginPath(undefined)).toBe('/login?reason=session-expired');
  });

  it('sends anonymous users to the login route with a safe return target', () => {
    expect(resolveProtectedRouteRedirect(null, '/engineer?tab=open')).toBe(
      '/login?returnTo=%2Fengineer%3Ftab%3Dopen',
    );
  });

  it('dispatches the entry route by login state without a return target', () => {
    const customerSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900201,
      role: 'CUSTOMER',
      userInfo: null,
    });

    expect(resolveEntryRouteRedirect(null)).toBe('/login');
    expect(resolveEntryRouteRedirect({ role: 'SUPER_ADMIN' })).toBe('/admin');
    expect(resolveEntryRouteRedirect({ role: 'ENGINEER' })).toBe('/engineer');
    expect(resolveEntryRouteRedirect(customerSession)).toBe('/customer');
  });

  it('only allows the requested protected path for the session role', () => {
    const engineerSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900101,
      role: 'ENGINEER',
      userInfo: null,
    });
    const superAdminSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900001,
      role: 'SUPER_ADMIN',
      userInfo: null,
    });

    expect(resolveProtectedRouteRedirect(engineerSession, '/engineer')).toBeNull();
    expect(resolveProtectedRouteRedirect(engineerSession, '/customer')).toBe('/engineer');
    expect(resolveProtectedRouteRedirect(superAdminSession, '/customer?tab=open')).toBeNull();
  });

  it('honours a safe in-role returnTo after login and rejects everything else', () => {
    const engineerSession = createAuthSessionSnapshot({
      accessToken: 'access-token',
      accountId: 900101,
      role: 'ENGINEER',
      userInfo: null,
    });

    expect(resolveLoginRouteRedirect(engineerSession, '/engineer?tab=open')).toBe(
      '/engineer?tab=open',
    );
    expect(resolveLoginRouteRedirect(engineerSession, '/customer')).toBe('/engineer');
    expect(resolveLoginRouteRedirect(engineerSession, 'https://example.com/admin')).toBe(
      '/engineer',
    );
    expect(resolveLoginRouteRedirect(engineerSession, null)).toBe('/engineer');
    expect(resolveLoginRouteRedirect(engineerSession, '')).toBe('/engineer');
    expect(resolveLoginRouteRedirect(engineerSession, '/engineer\ttab')).toBe('/engineer');
    expect(resolveLoginRouteRedirect(engineerSession, '/engineer\u007Ftab')).toBe('/engineer');
  });

  it('accepts only same-origin absolute return paths', () => {
    expect(resolveSafeReturnTo('/engineer?tab=open#latest')).toBe('/engineer?tab=open#latest');
    expect(resolveSafeReturnTo('https://example.com/admin')).toBeNull();
    expect(resolveSafeReturnTo('//example.com/admin')).toBeNull();
    expect(resolveSafeReturnTo('/\\example.com/admin')).toBeNull();
    expect(resolveSafeReturnTo(' /admin')).toBeNull();
    expect(resolveSafeReturnTo('/admin\n')).toBeNull();
    expect(resolveSafeReturnTo('relative/admin')).toBeNull();
  });

  it('creates a normalized minimal session snapshot', () => {
    expect(
      createAuthSessionSnapshot({
        accessToken: ' access-token ',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: {
          accessGroup: ['ENGINEER'],
          avatarUrl: ' https://example.test/avatar/chen.png ',
          nickname: ' 陈工 ',
        },
      }),
    ).toEqual({
      accessToken: 'access-token',
      accountId: 900101,
      adminLevel: null,
      customerOrganizationId: null,
      engineerOrganizationId: null,
      adminOrganizationId: null,
      registrationOrganizationId: null,
      restriction: 'NONE',
      role: 'ENGINEER',
      userInfo: {
        accessGroup: ['ENGINEER'],
        avatarUrl: 'https://example.test/avatar/chen.png',
        nickname: '陈工',
      },
    });
  });

  it('normalizes restricted-session facts and fails open to NONE on unknown values', () => {
    expect(
      createAuthSessionSnapshot({
        accessToken: 'access-token',
        accountId: 900101,
        adminLevel: 2,
        customerOrganizationId: 4401,
        restriction: 'ENGINEER_PENDING',
        role: 'ENGINEER',
        userInfo: null,
      }),
    ).toMatchObject({
      adminLevel: 2,
      customerOrganizationId: 4401,
      restriction: 'ENGINEER_PENDING',
    });

    // 非法身份扩展字段回落 null、未知限制状态回落 NONE（服务端仍按数据库事实鉴权）
    expect(
      createAuthSessionSnapshot({
        accessToken: 'access-token',
        accountId: 900101,
        adminLevel: -1,
        customerOrganizationId: 1.5,
        restriction: 'UNKNOWN' as never,
        role: 'ENGINEER',
        userInfo: null,
      }),
    ).toMatchObject({
      adminLevel: null,
      customerOrganizationId: null,
      restriction: 'NONE',
    });
  });

  it('normalizes a missing or blank avatarUrl to null without rejecting the session', () => {
    expect(
      createAuthSessionSnapshot({
        accessToken: 'access-token',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: {
          accessGroup: ['ENGINEER'],
          avatarUrl: '   ',
          nickname: '陈工',
        },
      }).userInfo,
    ).toEqual({ accessGroup: ['ENGINEER'], avatarUrl: null, nickname: '陈工' });
  });

  it('rejects invalid session invariants', () => {
    expect(() =>
      createAuthSessionSnapshot({
        accessToken: ' ',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: null,
      }),
    ).toThrow('Cannot establish an invalid auth session.');

    expect(() =>
      createAuthSessionSnapshot({
        accessToken: 'access-token',
        accountId: 900201,
        role: 'CUSTOMER',
        userInfo: {
          accessGroup: ['ENGINEER'],
          avatarUrl: null,
          nickname: '错误身份',
        },
      }),
    ).toThrow('Cannot establish an invalid auth session.');
  });
});
