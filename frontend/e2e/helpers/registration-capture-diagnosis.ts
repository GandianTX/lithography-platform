// e2e/helpers/registration-capture-diagnosis.ts
//
// 注册提交结论的分类与收尾诊断（第三轮 P2）。
//
// 这里刻意不依赖台账 / 数据库 / Playwright 运行时：分类与诊断是纯函数，
// 既能在 afterAll 里安全使用，也能被单测直接覆盖（无需重启浏览器或连库）。

/**
 * 注册提交的四种结论：
 * - captured：已取得真实账号 ID 且关联核验通过，台账已闭合；
 * - rejected：服务端明确拒绝（响应带 GraphQL errors），未创建账号；
 * - unverified：已取得账号 ID 但关联核验失败，台账未闭合；
 * - unknown：可能已提交但缺可核验响应（超时 / 响应体不可读 / 页面关闭）。
 */
export type RegistrationCaptureOutcome =
  | { readonly kind: 'captured'; readonly accountId: number }
  | { readonly kind: 'rejected'; readonly detail: string }
  | { readonly kind: 'unverified'; readonly accountId: number; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

export type RegistrationResponseReading =
  | { readonly kind: 'account'; readonly accountId: number }
  | { readonly kind: 'rejected'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

/** 诊断文本里附带的响应片段做长度截断，避免把整段 API 正文写进报告 */
const truncate = (text: string, limit = 300): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/**
 * 只看响应体判断提交结论（纯函数）：
 * - 有 `errors` → 明确拒绝；
 * - `data.registerWeb.accountId` 为正整数 → 已取得账号 ID；
 * - 其余（缺字段、结构不符）→ 可能已提交但缺可核验响应。
 */
export function readRegistrationAccountFromResponse(body: unknown): RegistrationResponseReading {
  const record = (body ?? {}) as {
    data?: { registerWeb?: { accountId?: unknown } | null } | null;
    errors?: unknown;
  };

  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first = record.errors[0] as { message?: unknown } | null;
    const detail =
      typeof first?.message === 'string' && first.message.length > 0
        ? first.message
        : JSON.stringify(record.errors);
    return { detail: truncate(detail), kind: 'rejected' };
  }

  const accountId = record.data?.registerWeb?.accountId;
  if (typeof accountId === 'number' && Number.isSafeInteger(accountId) && accountId > 0) {
    return { accountId, kind: 'account' };
  }

  return { detail: truncate(`响应缺少有效账号 ID：${JSON.stringify(body)}`), kind: 'unknown' };
}

/**
 * 收尾诊断：captured 无话可说（返回 null），其余三种都必须显式出现在收尾报告里。
 * 未知资源只登记，不据业务名称推导删除。
 */
export function describeCaptureDiagnosis(
  capture: { readonly outcome: RegistrationCaptureOutcome | null } | null,
  context: { readonly loginEmail: string },
): string | null {
  const outcome = capture?.outcome ?? null;
  if (outcome === null) {
    return null;
  }

  switch (outcome.kind) {
    case 'captured':
      return null;
    case 'rejected':
      return `注册提交被明确拒绝（未创建账号）：${outcome.detail}；本轮关联信息：loginEmail=${context.loginEmail}`;
    case 'unverified':
      return `已取得账号 ID ${outcome.accountId} 但关联核验失败，台账未闭合：${outcome.detail}；本轮关联信息：loginEmail=${context.loginEmail}、accountId=${outcome.accountId}`;
    case 'unknown':
      return `提交结果待确认（可能已提交但缺可核验响应）：${outcome.detail}；本轮关联信息：loginEmail=${context.loginEmail}；仅做只读核查，不按业务名称推导删除`;
  }
}

/** 只读核查用的登录邮箱白名单：合成邮箱由用例生成，禁止任何拼接注入 */
const PROBE_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64}\.[A-Za-z]{2,10}$/;

/**
 * 待确认提交的只读核查 SQL（禁止 DELETE / UPDATE）：
 * 以本轮合成登录邮箱这一可追溯事实查账号及其直接关联行，让接手人看到
 * 「可能已提交」的实际 ID。不得据公司名称或前缀推导删除。
 */
export function buildRegistrationAttemptProbeSql(loginEmail: string): string {
  if (!PROBE_EMAIL_PATTERN.test(loginEmail)) {
    throw new Error(`待确认核查只接受合成登录邮箱，拒绝拼接：${JSON.stringify(loginEmail)}`);
  }

  const accountIds = `(SELECT id FROM base_user_account WHERE login_email = '${loginEmail}')`;
  const organizationIds = `(SELECT organization_id FROM organization_membership WHERE account_id IN ${accountIds})`;

  return [
    `SELECT 'account', id, login_email FROM base_user_account WHERE login_email = '${loginEmail}'`,
    `SELECT 'user_info', id, account_id, customer_organization_id FROM base_user_info WHERE account_id IN ${accountIds}`,
    `SELECT 'membership', id, account_id, organization_id FROM organization_membership WHERE account_id IN ${accountIds}`,
    `SELECT 'organization', id, name, is_managed_company FROM organization WHERE id IN ${organizationIds}`,
  ].join('; ');
}
