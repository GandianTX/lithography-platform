// src/core/local-runtime/policy/local-credential-purpose.policy.ts

/**
 * 本机凭据的**用途维度**（任务 09 S4 第 2 条）。
 *
 * 需求："设备／公司／用途独立凭据……**不复用业务同步授权**"。
 * 含义：同一账号在同一公司下，业务同步授权与云备份授权是**两份互不相干的事实**——
 * 撤销其一不得影响其二；云端回执与同步状态判定**不得**拿云备份授权充数，
 * 上云也不得拿业务同步授权充数。
 *
 * 用途从**云端签名声明**取（`local_account_authorization.signed_claims` 里的
 * `purpose`，与 OAuth 的 scope/purpose 同义）：本机不自己发用途，只核对云端声明，
 * 因此**不需要新增数据库列**（结构增量方案见执行记录）。
 *
 * 口径：
 * - 声明缺失／不可解析 → **用途不可核验**（verifiable=false）：不得当作任一用途的凭据；
 * - 一份声明可同时列出多个用途（云端一次签发覆盖多用途），本机按"是否包含目标用途"判定；
 * - 判定只回答"这份凭据**是不是**该用途的"，不回答"有没有别的用途"。
 */

/** 本机凭据用途 */
export const LOCAL_CREDENTIAL_PURPOSE = {
  /** 业务同步（同步状态、派发、云端回执） */
  BUSINESS_SYNC: 'BUSINESS_SYNC',
  /** 云备份（本地备份包上云、云端包元数据与下载） */
  CLOUD_BACKUP: 'CLOUD_BACKUP',
} as const;

export type LocalCredentialPurpose =
  (typeof LOCAL_CREDENTIAL_PURPOSE)[keyof typeof LOCAL_CREDENTIAL_PURPOSE];

/** 用途判定结果 */
export type LocalCredentialPurposeVerdict = {
  /** 声明里包含的用途（按受控枚举过滤，未知值丢弃） */
  purposes: LocalCredentialPurpose[];
  /** 用途是否可核验（声明缺失或不可解析＝不可核验） */
  verifiable: boolean;
};

const KNOWN_PURPOSES: readonly string[] = Object.values(LOCAL_CREDENTIAL_PURPOSE);

/**
 * 解析云端签名声明里的用途。
 *
 * @param signedClaims 授权行登记的签名声明。
 *   **两种载体都要认**（此前只认 JSON 文本，与写入侧口径矛盾）：
 *   - **对象**（生产写入形态：`validateAuthorizationRenewalInput` 要求"签名凭据必须是对象"，
 *     `local_account_authorization.signed_claims` 是 `json` 列，读回即对象）；
 *   - **JSON 文本**（历史行／其他写入方直接登记原文）。
 *   两者都解析不出受控用途时，一律按**不可核验**处理（不猜、不放宽）。
 */
export function resolveCredentialPurposes(signedClaims: unknown): LocalCredentialPurposeVerdict {
  if (signedClaims === null || signedClaims === undefined) {
    return { purposes: [], verifiable: false };
  }
  let parsed: unknown;
  if (typeof signedClaims === 'string') {
    const raw = signedClaims.trim();
    if (raw.length === 0) {
      return { purposes: [], verifiable: false };
    }
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { purposes: [], verifiable: false };
    }
  } else if (typeof signedClaims === 'object') {
    parsed = signedClaims;
  } else {
    return { purposes: [], verifiable: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { purposes: [], verifiable: false };
  }
  const raw = (parsed as { purpose?: unknown }).purpose;
  const candidates = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const purposes = candidates.filter(
    (candidate): candidate is LocalCredentialPurpose =>
      typeof candidate === 'string' && KNOWN_PURPOSES.includes(candidate),
  );
  // 声明里没有任何已知用途 → 视为不可核验（不猜）
  if (purposes.length === 0) {
    return { purposes: [], verifiable: false };
  }
  return { purposes, verifiable: true };
}

/**
 * 该凭据是否可用于指定用途。
 *
 * 不可核验一律 false：用途不明不得当作任一用途使用。
 */
export function hasCredentialPurpose(
  signedClaims: unknown,
  purpose: LocalCredentialPurpose,
): boolean {
  const verdict = resolveCredentialPurposes(signedClaims);
  return verdict.verifiable && verdict.purposes.includes(purpose);
}
