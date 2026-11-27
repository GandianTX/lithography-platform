// e2e/helpers/auth-session-seed.ts

import type { Page } from '@playwright/test';

/**
 * e2e 预置会话快照的唯一收口：字段布局跟随 features/auth-session 的
 * auth-session-storage 持久化格式（当前 version: 3），格式升版时只改这里。
 * 各 *.spec.ts 一律导入本文件，不再复制快照结构。
 */
export const AUTH_SESSION_STORAGE_KEY = 'lithography-platform.auth-session.v1';

export type SeededAuthSessionRole = 'CUSTOMER' | 'ENGINEER' | 'SUPER_ADMIN';

/**
 * 预置会话的会话事实（与后端 `mySessionIdentity` 契约同字段）。
 *
 * 侧栏收口、路由守卫与页面内权限显隐都按「等级 + 可信公司」判定，因此这里不再只有
 * 管理员两字段：客户公司、工程师公司、注册目标公司同样可以显式声明。
 * 缺省一律为 null —— 缺省不得被解释成「一级管理员」或「已有可信公司」。
 */
export type SeededAuthSessionFacts = {
  /** 管理员等级：1=一级（全公司）；2=二级（本公司） */
  adminLevel?: number | null;
  /** 请求期复核得到的可信管理员公司 */
  adminOrganizationId?: number | null;
  /** 客户可信公司归属 */
  customerOrganizationId?: number | null;
  /** 工程师可信公司归属 */
  engineerOrganizationId?: number | null;
  /** 工程师注册申请的目标公司 */
  registrationOrganizationId?: number | null;
  /** 会话限制状态；缺省 NONE（正常会话） */
  restriction?: string;
  /** 预置账号主键；缺省与会话身份复核 mock 共用同一常量 */
  accountId?: number;
};

/** 预置会话的默认账号主键：`MySessionIdentity` mock 必须返回同一个值。 */
export const SEEDED_AUTH_SESSION_ACCOUNT_ID = 900201;

/** 预置会话对应的服务端身份投影（GraphQL `MySessionIdentity` 响应体）。 */
export type SeededAuthSessionIdentity = {
  accountId: number;
  role: SeededAuthSessionRole;
  adminLevel: number | null;
  adminOrganizationId: number | null;
  customerOrganizationId: number | null;
  engineerOrganizationId: number | null;
  registrationOrganizationId: number | null;
  restriction: string;
};

/**
 * 会话事实的唯一构造入口：sessionStorage 种子与 `MySessionIdentity` mock 都从这里取值，
 * 避免「种子里是二级、mock 里是一级」这类同一份夹具出现两个真源。
 */
export function buildSeededAuthSessionIdentity(
  role: SeededAuthSessionRole,
  facts: SeededAuthSessionFacts = {},
): SeededAuthSessionIdentity {
  return {
    accountId: facts.accountId ?? SEEDED_AUTH_SESSION_ACCOUNT_ID,
    adminLevel: facts.adminLevel ?? null,
    adminOrganizationId: facts.adminOrganizationId ?? null,
    customerOrganizationId: facts.customerOrganizationId ?? null,
    engineerOrganizationId: facts.engineerOrganizationId ?? null,
    registrationOrganizationId: facts.registrationOrganizationId ?? null,
    restriction: facts.restriction ?? 'NONE',
    role,
  };
}

export async function seedAuthSession(
  page: Page,
  role: SeededAuthSessionRole,
  facts: SeededAuthSessionFacts = {},
) {
  const identity = buildSeededAuthSessionIdentity(role, facts);

  // sessionStorage 按源隔离：必须先落在应用源上再写入，否则预置会话无效。
  await page.goto('/');
  await page.evaluate(
    ({ key, sessionIdentity }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          accessToken: 'test-only-access-token',
          accountId: sessionIdentity.accountId,
          adminLevel: sessionIdentity.adminLevel,
          customerOrganizationId: sessionIdentity.customerOrganizationId,
          engineerOrganizationId: sessionIdentity.engineerOrganizationId,
          adminOrganizationId: sessionIdentity.adminOrganizationId,
          registrationOrganizationId: sessionIdentity.registrationOrganizationId,
          restriction: sessionIdentity.restriction,
          role: sessionIdentity.role,
          userInfo: {
            accessGroup: [sessionIdentity.role],
            nickname: '测试会话',
          },
          version: 3,
        }),
      );
    },
    { key: AUTH_SESSION_STORAGE_KEY, sessionIdentity: identity },
  );
}

export function readStoredAuthSession(page: Page) {
  return page.evaluate((key) => sessionStorage.getItem(key), AUTH_SESSION_STORAGE_KEY);
}

const SEEDED_ROLES: readonly SeededAuthSessionRole[] = ['CUSTOMER', 'ENGINEER', 'SUPER_ADMIN'];

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 读取当前页面已预置的会话事实（未预置 / 结构非法 / Storage 不可读时为 null）。
 *
 * 用途：GraphQL `MySessionIdentity` 的 mock 直接回显这份事实，而不是另写一份夹具。
 * 这样「mock 是一级管理员、种子里却没有可信公司」这类漂移不可能发生；反例
 * （缺公司、缺等级、二级管理员）也会原样穿过 mock，不会被统一放行掩盖。
 */
export async function readSeededAuthSessionIdentity(
  page: Page,
): Promise<SeededAuthSessionIdentity | null> {
  // 导航途中执行上下文可能被销毁：按「未预置」处理，由调用方失败关闭。
  const raw = await page
    .evaluate((key) => sessionStorage.getItem(key), AUTH_SESSION_STORAGE_KEY)
    .catch(() => null);

  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const role = parsed['role'];

    if (
      typeof parsed['accountId'] !== 'number' ||
      typeof role !== 'string' ||
      !SEEDED_ROLES.includes(role as SeededAuthSessionRole)
    ) {
      return null;
    }

    return {
      accountId: parsed['accountId'],
      adminLevel: readNullableNumber(parsed['adminLevel']),
      adminOrganizationId: readNullableNumber(parsed['adminOrganizationId']),
      customerOrganizationId: readNullableNumber(parsed['customerOrganizationId']),
      engineerOrganizationId: readNullableNumber(parsed['engineerOrganizationId']),
      registrationOrganizationId: readNullableNumber(parsed['registrationOrganizationId']),
      restriction: typeof parsed['restriction'] === 'string' ? parsed['restriction'] : 'NONE',
      role: role as SeededAuthSessionRole,
    };
  } catch {
    return null;
  }
}
