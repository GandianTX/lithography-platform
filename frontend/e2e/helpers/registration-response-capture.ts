// e2e/helpers/registration-response-capture.ts
//
// 注册提交的真实响应接管（B 复审第二轮 P2-01：登记时序；第三轮 P2：诊断不被 UI 失败吞掉）。
//
// 为什么需要它：旧实现先 `expect(成功文案)` 再解析响应并登记台账。只要在
// 「服务端已返回有效账号 ID」与「台账登记」之间抛错（文案断言超时、注入故障、
// 后续步骤异常），已创建的账号 / 资料 / 成员关系 / 手填公司就完全在账外，
// afterAll 只能回收夹具公司，脏数据留在库里。
//
// 现在的时序与状态：
// - 点击前挂接响应；
// - 成功响应一到，立即按真实 accountId + 归属事实登记台账，早于任何页面断言；
// - `settled` 永不 reject，错误记录在 `error` 上，由用例显式抛出；
// - `outcome` 把结果分成 captured / rejected / unverified / unknown（分类与诊断
//   见 registration-capture-diagnosis.ts），afterAll 必须把它连同「原 UI 失败」
//   一起写进收尾报告，否则 UI 先失败会吞掉「提交结果待确认」的诊断；
// - 提交结果未知（超时、响应体不可读、页面关闭）时保留诊断、只读核查、不猜测删除。

import type { Page } from '@playwright/test';

import {
  readRegistrationAccountFromResponse,
  type RegistrationCaptureOutcome,
} from './registration-capture-diagnosis';
import {
  locateRegistrationRoundAccount,
  type RegistrationRoundLedger,
} from './registration-round-cleanup';

export {
  buildRegistrationAttemptProbeSql,
  describeCaptureDiagnosis,
  readRegistrationAccountFromResponse,
  type RegistrationCaptureOutcome,
  type RegistrationResponseReading,
} from './registration-capture-diagnosis';

export interface RegistrationCapture {
  /** 响应处理（含按真实 ID 登记）完全收敛；永不 reject */
  settled: Promise<void>;
  located: { accountId: number; selfFilledOrganizationId: number } | null;
  /** 收敛后的结论；未收敛前为 null */
  outcome: RegistrationCaptureOutcome | null;
  error: unknown;
}

export interface RegistrationCaptureInput {
  readonly expectedSelfFilledName: string;
  readonly loginEmail: string;
  /** GraphQL operation 名（默认 RegisterCustomer） */
  readonly operation?: string;
  /** 等待响应的时间上限（默认 30s；响应丢失反例需更短以便尽快给出诊断） */
  readonly timeoutMs?: number;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function startRegistrationCapture(
  page: Page,
  ledger: RegistrationRoundLedger,
  input: RegistrationCaptureInput,
): RegistrationCapture {
  const operation = input.operation ?? 'RegisterCustomer';
  const capture: RegistrationCapture = {
    error: null,
    located: null,
    outcome: null,
    settled: Promise.resolve(),
  };

  capture.settled = page
    .waitForResponse(
      (response) =>
        response.url().includes('/graphql') &&
        (response.request().postData() ?? '').includes(operation),
      { timeout: input.timeoutMs ?? 30_000 },
    )
    .then(async (response) => {
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        capture.outcome = {
          detail: `响应体读取失败：${describeError(error)}`,
          kind: 'unknown',
        };
        throw new Error(`注册响应体不可读，提交结果待确认：${describeError(error)}`, {
          cause: error,
        });
      }

      const reading = readRegistrationAccountFromResponse(body);

      if (reading.kind === 'rejected') {
        capture.outcome = { detail: reading.detail, kind: 'rejected' };
        throw new Error(`注册提交被明确拒绝（未创建账号）：${reading.detail}`);
      }

      if (reading.kind === 'unknown') {
        capture.outcome = { detail: reading.detail, kind: 'unknown' };
        throw new Error(`注册响应无法核验，提交结果待确认：${reading.detail}`);
      }

      // 账号 / 资料 / 成员 / 手填公司仍由真实关联定位并核验，
      // 不按名称或邮箱前缀授权删除。
      try {
        capture.located = locateRegistrationRoundAccount(ledger, {
          accountId: reading.accountId,
          expectedSelfFilledName: input.expectedSelfFilledName,
          loginEmail: input.loginEmail,
        });
        capture.outcome = { accountId: reading.accountId, kind: 'captured' };
      } catch (error) {
        capture.outcome = {
          accountId: reading.accountId,
          detail: describeError(error),
          kind: 'unverified',
        };
        throw new Error(
          `注册响应已返回账号 ID ${reading.accountId}，但关联核验失败：${describeError(error)}`,
          { cause: error },
        );
      }
    })
    .catch((error: unknown) => {
      capture.outcome ??= { detail: describeError(error), kind: 'unknown' };
      capture.error = error;
    });

  return capture;
}
