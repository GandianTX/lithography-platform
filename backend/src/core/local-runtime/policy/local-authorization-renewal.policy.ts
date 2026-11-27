// src/core/local-runtime/policy/local-authorization-renewal.policy.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';

/**
 * 本地授权续期纯规则（任务 09 R065／R063，S2.1；同时补验 S1.3 的"同公司授权续期"）。
 *
 * 口径（D-13）：`local_account_authorization` 只承载**业务同步**凭据；
 * 自动备份凭据不复用本表。
 *
 * 续期只允许更新三项事实：签名凭据、权限版本、最近校验成功时间。
 * 待传任务、公司配置、备份运行**一律不动**——"撤权保留待传、续期不碰队列"。
 */

/** 只允许"本人续期自己公司内的授权"：范围键必须与行完全一致 */
export type LocalAuthorizationRenewalScope = {
  installationId: string;
  accountId: number;
  organizationId: number;
};

/**
 * 续期输入：凭据材料与校验事实。
 * `claims` 必须是对象；具体签名校验由真实接收端（X07／云）接入时完成，
 * 本层先拒绝结构非法与含敏感材料的载荷。
 */
export type LocalAuthorizationRenewalInput = {
  signedClaims: unknown;
  permissionVersion: number;
  lastVerifiedAt: Date;
};

/** 凭据材料禁止出现的键（小写比较）：密码类/密钥类/令牌原文不得进入本地事实 */
const FORBIDDEN_CLAIM_KEYS = [
  'password',
  'passwordhash',
  'password_hash',
  'passwd',
  'pass',
  'loginpassword',
  'login_password',
  'secret',
  'secretkey',
  'secret_key',
  'privatekey',
  'private_key',
  'encryptionkey',
  'encryption_key',
  'protectionkey',
  'protection_key',
  'signingkey',
  'signing_key',
  'apikey',
  'api_key',
  'jwt',
  'token',
  'bearer',
  'credential',
  'credentials',
  'authorization',
  'sessionkey',
  'session_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
] as const;

/**
 * 签名凭据**允许**出现的键（白名单）。
 *
 * 口径（R067／review M9）：授权材料只写本地确实需要的身份与权限事实。
 * 黑名单是"漏一个就放过"的写法——`api_key`、`jwt`、`passwd` 之类变体可以绕过；
 * 白名单则默认拒绝，未明确允许的一律不接受。
 *
 * 真实接收端（X07／云）接入后若 claim 契约变化，按实际契约**收敛**本表，
 * 不放宽成"黑名单＋例外"。
 */
const ALLOWED_CLAIM_KEYS = new Set([
  // 标准注册声明
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  // 本地需要的权限事实
  'scopes',
  'scope',
  'permissions',
  'permissionversion',
  'organizationid',
  'accountid',
  'installationid',
  'role',
  'adminlevel',
]);

export function isForbiddenClaimKey(key: string): boolean {
  return (FORBIDDEN_CLAIM_KEYS as readonly string[]).includes(key.trim().toLowerCase());
}

/** 键是否在签名凭据白名单内（大小写与首尾空白不敏感） */
export function isAllowedClaimKey(key: string): boolean {
  return ALLOWED_CLAIM_KEYS.has(key.trim().toLowerCase());
}

/** 收集键名时允许的最大嵌套深度 */
export const MAX_CLAIM_KEY_DEPTH = 8;

/**
 * 深度收集对象键名（数组与嵌套对象都查），用于拒绝敏感材料进入本地事实。
 *
 * 深度超限时**拒绝**（fail closed），不做静默截断：
 * 此前"深度 >8 即停止扫描"等于给绕过留了后门——把敏感键放到第 9 层即可躲开检查。
 */
export function collectClaimKeys(value: unknown, depth = 0): string[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (depth > MAX_CLAIM_KEY_DEPTH) {
    throw new DomainError(
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      '凭据材料嵌套层级过深，无法确认不含敏感材料',
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectClaimKeys(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, item]) => [
    key,
    ...collectClaimKeys(item, depth + 1),
  ]);
}

/**
 * 校验续期载荷：
 * - 必须是普通对象（不含原型链怪键）；
 * - 任一键命中禁止清单即拒绝（R067：不得把密码／密钥写入凭据、日志或冲突页）；
 * - **只允许白名单内的键**（review M9：黑名单可被变体绕过，白名单默认拒绝）；
 * - `permissionVersion` 必须为 >=1 的整数（对齐 DB CHECK）。
 */
export function validateAuthorizationRenewalInput(input: LocalAuthorizationRenewalInput): void {
  const claims = input.signedClaims;
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new DomainError(SYNC_ERROR.CLAIMS_INVALID, '签名凭据必须是对象');
  }
  const keys = collectClaimKeys(claims);
  const forbidden = keys.find((key) => isForbiddenClaimKey(key));
  if (forbidden !== undefined) {
    throw new DomainError(
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      `签名凭据包含禁止写入本地事实的敏感材料：${forbidden}`,
    );
  }
  const notAllowed = keys.find((key) => !isAllowedClaimKey(key));
  if (notAllowed !== undefined) {
    throw new DomainError(
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      `签名凭据包含不在白名单内的键：${notAllowed}`,
    );
  }
  if (!Number.isInteger(input.permissionVersion) || input.permissionVersion < 1) {
    throw new DomainError(SYNC_ERROR.CLAIMS_INVALID, '权限版本必须为不小于 1 的整数');
  }
  if (!(input.lastVerifiedAt instanceof Date) || Number.isNaN(input.lastVerifiedAt.getTime())) {
    throw new DomainError(SYNC_ERROR.CLAIMS_INVALID, '最近校验时间无效');
  }
}

/** 续期是否允许：只有 ACTIVE 行可续期；REVOKED 必须重新授权，不叫续期 */
export function isRenewalAllowed(authorizationStatus: string): boolean {
  return authorizationStatus === 'ACTIVE';
}
