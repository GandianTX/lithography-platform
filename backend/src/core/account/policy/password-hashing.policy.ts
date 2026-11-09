// 文件位置：src/core/account/policy/password-hashing.policy.ts

import { AUTH_ERROR, DomainError } from '@core/common/errors/domain-error';
import { pbkdf2Sync, timingSafeEqual } from 'crypto';

/**
 * 账号密码哈希的单一纯函数实现。
 *
 * 生产调用点：
 * - `AccountService.hashPasswordWithTimestamp()` / `verifyPassword()`（登录、注册、改密、
 *   管理员创建用户、管理员重置密码）；
 * - `admin-bootstrap`（受控管理员初始化，infrastructure 层不得 import modules）。
 *
 * 算法与历史实现逐字保持一致：NFKC 预处理后以 `created_at` 的 UTC ISO 字符串为盐，
 * PBKDF2-SHA256 5000 次迭代、64 字节输出。改动此处必须同步验证登录验密链路。
 */
function preprocessPassword(password: string): string {
  if (!password || /^\s*$/u.test(password)) {
    throw new DomainError(AUTH_ERROR.INVALID_PASSWORD, '密码不能为空或纯空白字符');
  }

  const normalizedPassword = password.normalize('NFKC');

  if (/^\s|\s$/u.test(normalizedPassword)) {
    throw new DomainError(AUTH_ERROR.INVALID_PASSWORD, '密码首尾不能包含空格');
  }

  return normalizedPassword;
}

/** 原始 PBKDF2 哈希，供既有 `LegacyPasswordCryptoHelper` 委托复用。 */
export function hashPasswordWithSalt(password: string, salt: string): string {
  return pbkdf2Sync(password, salt, 5000, 64, 'sha256').toString('hex');
}

export function verifyPasswordWithSalt(
  password: string,
  salt: string,
  hashedPassword: string,
): boolean {
  return timingSafeEqual(
    Buffer.from(hashPasswordWithSalt(password, salt), 'hex'),
    Buffer.from(hashedPassword, 'hex'),
  );
}

export function hashPasswordWithTimestamp(password: string, createdAt: Date): string {
  return hashPasswordWithSalt(preprocessPassword(password), createdAt.toISOString());
}

export function verifyPasswordWithTimestamp(
  password: string,
  hashedPassword: string,
  createdAt: Date,
): boolean {
  return verifyPasswordWithSalt(
    preprocessPassword(password),
    createdAt.toISOString(),
    hashedPassword,
  );
}
