// src/adapters/api/rest/web-session/web-session-cookie.ts

import { WEB_SESSION_COOKIE_NAME, WEB_SESSION_COOKIE_PATH } from './web-session.options';

/** 过期时刻统一用 epoch 毫秒字符串，避免测试里的本地时区差异 */
const EPOCH_EXPIRED = 'Thu, 01 Jan 1970 00:00:00 GMT';

/**
 * 从 Cookie 头中读取指定名称的原值。
 *
 * 只做字节级拆分：值为 JWT（base64url + `.`），不含需要转义的字符；
 * 任何解析异常都按「没有 Cookie」处理（调用方据此返回 401），不抛错、不记录原值。
 */
export function readCookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const segment of header.split(';')) {
    const separatorIndex = segment.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = segment.slice(0, separatorIndex).trim();
    if (key !== name) continue;

    const value = segment.slice(separatorIndex + 1).trim();
    if (!value) continue;

    return value;
  }

  return null;
}

/**
 * Cookie 的 Max-Age 必须不晚于令牌自身过期。
 *
 * 返回 0 表示「无法给出安全窗口」（无到期事实或已过期），调用方必须不下发 Cookie，
 * 绝不能用配置值兜底成比令牌更长的窗口。
 */
export function computeCookieMaxAgeSeconds(input: {
  readonly expiresAt: Date | null | undefined;
  readonly now: Date;
}): number {
  const expiresAtMs = input.expiresAt?.getTime();

  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
    return 0;
  }

  const remainingSeconds = Math.floor((expiresAtMs - input.now.getTime()) / 1000);

  return remainingSeconds > 0 ? remainingSeconds : 0;
}

/** 仅由登录写入：HttpOnly + SameSite=Lax + 窄路径，不设置 Domain（host-only）。 */
export function buildSessionCookie(input: {
  readonly token: string;
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
}): string {
  const parts = [
    `${WEB_SESSION_COOKIE_NAME}=${input.token}`,
    `Path=${WEB_SESSION_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${input.maxAgeSeconds}`,
  ];

  if (input.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * 仅由主动退出清除。
 *
 * 覆盖时必须与写入时的名称/路径/属性一致，否则浏览器会保留原 Cookie。
 */
export function buildClearedSessionCookie(input: { readonly secure: boolean }): string {
  const parts = [
    `${WEB_SESSION_COOKIE_NAME}=`,
    `Path=${WEB_SESSION_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    `Expires=${EPOCH_EXPIRED}`,
  ];

  if (input.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * 归一化来源为 `scheme://host[:port]`。
 *
 * 刻意不使用 `Host` / `X-Forwarded-*`：反代头可被伪造，只有显式配置的可信站点
 * 才能作为来源判定依据。非法/缺失来源返回 null（= 不可信）。
 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null;

  try {
    const parsed = new URL(value.trim());

    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * 同源来源校验：`Origin` 优先，缺失时回退 `Referer` 的 origin；
 * 两者都不可信/缺失一律拒绝。
 */
export function isTrustedRequestOrigin(input: {
  readonly origin?: string | undefined;
  readonly referer?: string | undefined;
  readonly allowedOrigins: readonly string[];
}): boolean {
  const candidate = normalizeOrigin(input.origin) ?? normalizeOrigin(input.referer);

  if (!candidate) return false;

  return input.allowedOrigins.some((allowed) => normalizeOrigin(allowed) === candidate);
}
