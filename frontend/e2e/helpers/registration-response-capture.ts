// e2e/helpers/registration-response-capture.ts
//
// 注册提交的真实响应接管（B 复审第二轮 P2-01：登记时序）。
//
// 为什么需要它：旧实现先 `expect(成功文案)` 再解析响应并登记台账。只要在
// 「服务端已返回有效账号 ID」与「台账登记」之间抛错（文案断言超时、注入故障、
// 后续步骤异常），已创建的账号 / 资料 / 成员关系 / 手填公司就完全在账外，
// afterAll 只能回收夹具公司，脏数据留在库里。
//
// 现在的时序：
// - 点击前挂接响应；
// - 成功响应一到，立即按真实 accountId + 归属事实登记台账，早于任何页面断言；
// - `settled` 永不 reject，错误记录在 `error` 上，由用例显式抛出；
// - afterAll 必须先 `await settled` 再清理，保证已返回的成功响应先入账；
// - 提交结果未知（无有效账号 ID）时保留诊断、不猜测删除。

import type { Page } from '@playwright/test';

import {
  locateRegistrationRoundAccount,
  type RegistrationRoundLedger,
} from './registration-round-cleanup';

export interface RegistrationCapture {
  /** 响应处理（含按真实 ID 登记）完全收敛；永不 reject */
  settled: Promise<void>;
  located: { accountId: number; selfFilledOrganizationId: number } | null;
  error: unknown;
}

export interface RegistrationCaptureInput {
  readonly expectedSelfFilledName: string;
  readonly loginEmail: string;
  /** GraphQL operation 名（默认 RegisterCustomer） */
  readonly operation?: string;
}

export function startRegistrationCapture(
  page: Page,
  ledger: RegistrationRoundLedger,
  input: RegistrationCaptureInput,
): RegistrationCapture {
  const operation = input.operation ?? 'RegisterCustomer';
  const capture: RegistrationCapture = { error: null, located: null, settled: Promise.resolve() };

  capture.settled = page
    .waitForResponse(
      (response) =>
        response.url().includes('/graphql') &&
        (response.request().postData() ?? '').includes(operation),
      { timeout: 30_000 },
    )
    .then(async (response) => {
      const body = (await response.json()) as {
        data?: { registerWeb?: { accountId?: number | null } };
      };
      const accountId = body.data?.registerWeb?.accountId ?? null;

      if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error(
          `注册响应未返回有效账号 ID，提交结果未知：保留诊断且不猜测删除：${JSON.stringify(body)}`,
        );
      }

      // 账号 / 资料 / 成员 / 手填公司仍由真实关联定位并核验，
      // 不按名称或邮箱前缀授权删除。
      capture.located = locateRegistrationRoundAccount(ledger, {
        accountId,
        expectedSelfFilledName: input.expectedSelfFilledName,
        loginEmail: input.loginEmail,
      });
    })
    .catch((error: unknown) => {
      capture.error = error;
    });

  return capture;
}
