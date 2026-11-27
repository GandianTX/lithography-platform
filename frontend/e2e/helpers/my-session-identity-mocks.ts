// e2e/helpers/my-session-identity-mocks.ts
//
// 启动 / 每请求复核的会话身份（GraphQL `MySessionIdentity`）在 mock-only Playwright
// 中的唯一收口。
//
// 为什么需要它：AppLayout 挂载后会真实发出 `MySessionIdentity`，失败关闭的 mock
// （helpers/reference-document-mocks.ts、helpers/customer-repair-request-mocks.ts）
// 会把它判成「未登记 operation」而让用例失败；宽松兜底（返回 `{}` 或统一放行）又会
// 把「缺可信公司 / 等级错误」这类反例掩盖成通过。因此这里只做两件事：
//   1) 按 `buildSeededAuthSessionIdentity()` 生成**与种子逐字段一致**的响应；
//   2) 提供显式场景夹具（GLOBAL / ORGANIZATION / PLATFORM / 工程师 / 客户），
//      让用例自己声明「这次会话到底是什么身份」，不在 mock 内部做任何升级或兜底。
//
// 不涉及任何生产权限逻辑：响应里不带等级/公司的降级、不把 null 补成一等级。

import type { Page, Route } from '@playwright/test';

import {
  buildSeededAuthSessionIdentity,
  readSeededAuthSessionIdentity,
  SEEDED_AUTH_SESSION_ACCOUNT_ID,
  type SeededAuthSessionFacts,
  type SeededAuthSessionIdentity,
  type SeededAuthSessionRole,
} from './auth-session-seed';

export const MY_SESSION_IDENTITY_OPERATION = 'MySessionIdentity';
export const MY_ENGINEER_REGISTRATION_OPERATION = 'MyEngineerRegistration';

/** 夹具使用的两个可信公司主键（与视觉用例既有取值一致）。 */
export const GLOBAL_ADMIN_ORGANIZATION_ID = 910003;
export const ORGANIZATION_ADMIN_ORGANIZATION_ID = 910004;

/** 一级管理员 + 可信公司：scope=GLOBAL，文档数据库与两个旧入口都放行。 */
export const GLOBAL_ADMIN_IDENTITY_FACTS: SeededAuthSessionFacts = {
  accountId: SEEDED_AUTH_SESSION_ACCOUNT_ID,
  adminLevel: 1,
  adminOrganizationId: GLOBAL_ADMIN_ORGANIZATION_ID,
};

/** 二级管理员 + 可信公司：scope=ORGANIZATION，本公司范围，文档数据库不可进。 */
export const ORGANIZATION_ADMIN_IDENTITY_FACTS: SeededAuthSessionFacts = {
  accountId: SEEDED_AUTH_SESSION_ACCOUNT_ID,
  adminLevel: 2,
  adminOrganizationId: ORGANIZATION_ADMIN_ORGANIZATION_ID,
};

/** 一级管理员但缺可信公司：scope=PLATFORM，两个旧入口保留、文档数据库不放行。 */
export const PLATFORM_ADMIN_IDENTITY_FACTS: SeededAuthSessionFacts = {
  accountId: SEEDED_AUTH_SESSION_ACCOUNT_ID,
  adminLevel: 1,
  adminOrganizationId: null,
};

/** 管理员但缺等级：scope=NONE，管理路径一律不放行。 */
export const NO_LEVEL_ADMIN_IDENTITY_FACTS: SeededAuthSessionFacts = {
  accountId: SEEDED_AUTH_SESSION_ACCOUNT_ID,
  adminLevel: null,
  adminOrganizationId: GLOBAL_ADMIN_ORGANIZATION_ID,
};

/** 工程师 + 本公司：历史维修记录库入口按角色路径表保留。 */
export const ENGINEER_IDENTITY_FACTS: SeededAuthSessionFacts = {
  accountId: SEEDED_AUTH_SESSION_ACCOUNT_ID,
  engineerOrganizationId: GLOBAL_ADMIN_ORGANIZATION_ID,
};

/** 客户：历史维修记录库与管理员入口都不可见。 */
export const CUSTOMER_IDENTITY_FACTS: SeededAuthSessionFacts = {
  accountId: SEEDED_AUTH_SESSION_ACCOUNT_ID,
  customerOrganizationId: GLOBAL_ADMIN_ORGANIZATION_ID,
};

/** 按角色 + 显式事实构造身份响应（与种子同源）。 */
export function buildMySessionIdentity(
  role: SeededAuthSessionRole,
  facts: SeededAuthSessionFacts,
): SeededAuthSessionIdentity {
  return buildSeededAuthSessionIdentity(role, facts);
}

/** GraphQL 成功信封的 `data` 载荷（供 operationName → data 的处理表直接使用）。 */
export function mySessionIdentityData(identity: SeededAuthSessionIdentity): {
  mySessionIdentity: SeededAuthSessionIdentity;
} {
  return { mySessionIdentity: { ...identity } };
}

/** 处理表风格（operationName → data）的便捷包装。 */
export function mySessionIdentityHandler(
  identity: SeededAuthSessionIdentity,
): () => { mySessionIdentity: SeededAuthSessionIdentity } {
  return () => mySessionIdentityData(identity);
}

/**
 * 工程师本人「没有申请记录」的响应。
 *
 * 契约依据：adapter 只把 `extensions.code === 'NOT_FOUND'` 映射为 null（无申请），
 * 其余失败一律上抛；因此这里必须回 GraphQL errors 信封，不能回空 data。
 * 后端对应 `ENGINEER_REGISTRATION_APPLICATION_NOT_FOUND`（对外大类码 NOT_FOUND）。
 */
export function myEngineerRegistrationNotFoundResponse(): Record<string, unknown> {
  return {
    errors: [
      {
        extensions: {
          code: 'NOT_FOUND',
          errorCode: 'ENGINEER_REGISTRATION_APPLICATION_NOT_FOUND',
        },
        message: '未找到工程师注册申请。',
      },
    ],
  };
}

/**
 * 会话启动链路（壳层挂载 / 工程师准入检查）真实发出的两个只读 operation：
 * - `MySessionIdentity`：回显预置会话事实；没有预置会话时失败关闭（不回空 data）；
 * - `MyEngineerRegistration`：夹具代表「本人没有申请记录」，按契约回 NOT_FOUND。
 *
 * 返回 true 表示已由本函数应答；各页面 mock 只需在分发前调用一次，
 * 无需为每个 spec 再传一份身份参数（身份只有一个真源：sessionStorage 种子）。
 */
export async function handleSessionBootstrapOperation(
  page: Page,
  route: Route,
  operationName: string | undefined,
): Promise<boolean> {
  if (operationName === MY_SESSION_IDENTITY_OPERATION) {
    const identity = await readSeededAuthSessionIdentity(page);

    if (identity === null) {
      // 失败关闭：未预置会话还请求身份复核，说明用例自身没种会话，不得伪造事实。
      await route.fulfill({
        body: JSON.stringify({
          errors: [{ message: 'MySessionIdentity mock 缺少预置会话（sessionStorage 为空）' }],
        }),
        contentType: 'application/json',
        status: 200,
      });

      return true;
    }

    await route.fulfill({
      body: JSON.stringify({ data: mySessionIdentityData(identity) }),
      contentType: 'application/json',
      status: 200,
    });

    return true;
  }

  if (operationName === MY_ENGINEER_REGISTRATION_OPERATION) {
    await route.fulfill({
      body: JSON.stringify(myEngineerRegistrationNotFoundResponse()),
      contentType: 'application/json',
      status: 200,
    });

    return true;
  }

  return false;
}
