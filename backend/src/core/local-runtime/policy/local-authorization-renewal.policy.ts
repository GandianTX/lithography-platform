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
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
] as const;

export function isForbiddenClaimKey(key: string): boolean {
  return (FORBIDDEN_CLAIM_KEYS as readonly string[]).includes(key.trim().toLowerCase());
}

/** 深度收集对象键名（数组与嵌套对象都查），用于拒绝敏感材料进入本地事实 */
export function collectClaimKeys(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return [];
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
 * - `permissionVersion` 必须为 >=1 的整数（对齐 DB CHECK）。
 */
export function validateAuthorizationRenewalInput(input: LocalAuthorizationRenewalInput): void {
  const claims = input.signedClaims;
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new DomainError(SYNC_ERROR.CLAIMS_INVALID, '签名凭据必须是对象');
  }
  const keys = collectClaimKeys(claims);
  const hit = keys.find((key) => isForbiddenClaimKey(key));
  if (hit !== undefined) {
    throw new DomainError(
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      `签名凭据包含禁止写入本地事实的敏感材料：${hit}`,
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
