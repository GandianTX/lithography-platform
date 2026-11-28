// src/adapters/api/rest/web-session/web-session-cookie.spec.ts

import {
  buildClearedSessionCookie,
  buildSessionCookie,
  computeCookieMaxAgeSeconds,
  isTrustedRequestOrigin,
  normalizeOrigin,
  readCookieValue,
} from './web-session-cookie';
import { WEB_SESSION_COOKIE_NAME, WEB_SESSION_COOKIE_PATH } from './web-session.options';

describe('web-session-cookie', () => {
  const NOW = new Date('2026-11-28T00:00:00Z');

  describe('readCookieValue', () => {
    it('从多个 Cookie 中取出会话 Cookie 原值', () => {
      const header = `locale=zh-CN; ${WEB_SESSION_COOKIE_NAME}=header.payload.signature; theme=dark`;

      expect(readCookieValue(header, WEB_SESSION_COOKIE_NAME)).toBe('header.payload.signature');
    });

    it('没有该 Cookie、值为空或头部缺失时返回 null', () => {
      expect(readCookieValue(undefined, WEB_SESSION_COOKIE_NAME)).toBeNull();
      expect(readCookieValue('locale=zh-CN', WEB_SESSION_COOKIE_NAME)).toBeNull();
      expect(readCookieValue(`${WEB_SESSION_COOKIE_NAME}=`, WEB_SESSION_COOKIE_NAME)).toBeNull();
      expect(readCookieValue('=broken', WEB_SESSION_COOKIE_NAME)).toBeNull();
    });

    it('不做前缀匹配：相似名称不会被误取', () => {
      const header = `${WEB_SESSION_COOKIE_NAME}_old=stale-token`;

      expect(readCookieValue(header, WEB_SESSION_COOKIE_NAME)).toBeNull();
    });
  });

  describe('computeCookieMaxAgeSeconds', () => {
    it('Max-Age 取令牌剩余秒数（不晚于令牌过期）', () => {
      const expiresAt = new Date(NOW.getTime() + 8 * 60 * 60 * 1000);

      expect(computeCookieMaxAgeSeconds({ expiresAt, now: NOW })).toBe(28_800);
    });

    it('已过期或没有到期事实时返回 0（调用方不得下发 Cookie）', () => {
      expect(computeCookieMaxAgeSeconds({ expiresAt: NOW, now: NOW })).toBe(0);
      expect(
        computeCookieMaxAgeSeconds({ expiresAt: new Date(NOW.getTime() - 1000), now: NOW }),
      ).toBe(0);
      expect(computeCookieMaxAgeSeconds({ expiresAt: null, now: NOW })).toBe(0);
      expect(computeCookieMaxAgeSeconds({ expiresAt: undefined, now: NOW })).toBe(0);
    });

    it('对不足一秒的余量向下取整，绝不向上放大窗口', () => {
      const expiresAt = new Date(NOW.getTime() + 1999);

      expect(computeCookieMaxAgeSeconds({ expiresAt, now: NOW })).toBe(1);
    });
  });

  describe('buildSessionCookie', () => {
    it('固定窄路径 + HttpOnly + SameSite=Lax + 不设 Domain', () => {
      const cookie = buildSessionCookie({
        token: 'header.payload.signature',
        maxAgeSeconds: 28_800,
        secure: false,
      });

      expect(cookie).toBe(
        `${WEB_SESSION_COOKIE_NAME}=header.payload.signature; Path=${WEB_SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=28800`,
      );
      expect(cookie).not.toContain('Domain=');
      expect(WEB_SESSION_COOKIE_PATH).toBe('/api/auth/web-session');
    });

    it('启用 Secure 时追加 Secure 属性', () => {
      const cookie = buildSessionCookie({ token: 'token', maxAgeSeconds: 60, secure: true });

      expect(cookie).toContain('; Secure');
    });
  });

  describe('buildClearedSessionCookie', () => {
    it('用同名同路径覆盖清除，Max-Age=0 且带过期时刻', () => {
      const cookie = buildClearedSessionCookie({ secure: true });

      expect(cookie).toContain(`${WEB_SESSION_COOKIE_NAME}=;`);
      expect(cookie).toContain(`Path=${WEB_SESSION_COOKIE_PATH}`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      expect(cookie).toContain('Secure');
    });
  });

  describe('isTrustedRequestOrigin', () => {
    const allowedOrigins = ['https://app.example.com', 'http://localhost:5173'];

    it('Origin 命中可信站点时放行（大小写与默认端口归一化）', () => {
      expect(
        isTrustedRequestOrigin({
          origin: 'HTTPS://APP.EXAMPLE.COM',
          allowedOrigins,
        }),
      ).toBe(true);
      expect(isTrustedRequestOrigin({ origin: 'http://localhost:5173/', allowedOrigins })).toBe(
        true,
      );
    });

    it('Origin 缺失时回退 Referer 的 origin', () => {
      expect(
        isTrustedRequestOrigin({
          referer: 'https://app.example.com/admin/orders',
          allowedOrigins,
        }),
      ).toBe(true);
    });

    it('不可信来源、缺失来源、非法头一律拒绝', () => {
      expect(isTrustedRequestOrigin({ origin: 'https://evil.example', allowedOrigins })).toBe(
        false,
      );
      expect(isTrustedRequestOrigin({ allowedOrigins })).toBe(false);
      expect(isTrustedRequestOrigin({ origin: 'not-a-url', allowedOrigins })).toBe(false);
      expect(
        isTrustedRequestOrigin({ origin: 'https://app.example.com.evil.example', allowedOrigins }),
      ).toBe(false);
    });

    it('不通过 Host / X-Forwarded-* 自动放行：未配置白名单时永不通过', () => {
      expect(isTrustedRequestOrigin({ origin: 'http://localhost:3000', allowedOrigins: [] })).toBe(
        false,
      );
    });

    it('normalizeOrigin 对非法输入返回 null', () => {
      expect(normalizeOrigin('')).toBeNull();
      expect(normalizeOrigin('://bad')).toBeNull();
      expect(normalizeOrigin('https://app.example.com/path')).toBe('https://app.example.com');
    });
  });
});
