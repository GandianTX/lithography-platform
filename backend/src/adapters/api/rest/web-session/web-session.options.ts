// src/adapters/api/rest/web-session/web-session.options.ts

/**
 * 浏览器会话 REST 边界所需的全部协议级配置。
 *
 * 由 `RestAdapterModule` 从 `webSession.*` 配置构建，控制器只消费这个对象，
 * 不直接读 env —— 保证「开关 → 行为」只有一条映射路径。
 */
export interface WebSessionOptions {
  /** 功能开关：关闭时三个端点一律 404，与改造前完全一致 */
  readonly enabled: boolean;
  /** 网页登录独立有效期（jsonwebtoken 时长格式）；undefined 表示沿用全局 JWT_EXPIRES_IN */
  readonly accessTokenTtl?: string;
  /** 生产必须为 true；非生产允许 false（本地 http） */
  readonly cookieSecure: boolean;
  /** 明确可信的前端站点来源（完整 scheme://host[:port]），用于同源来源校验 */
  readonly allowedOrigins: readonly string[];
  /** 与 Bearer 链路一致的签发者校验值 */
  readonly issuer?: string;
}

export const WEB_SESSION_OPTIONS = Symbol('WEB_SESSION_OPTIONS');

/** Cookie 名称固定（不接受运行时配置，避免改名后旧 Cookie 变成不可清除的孤儿）。 */
export const WEB_SESSION_COOKIE_NAME = 'lithography_web_session';

/**
 * Cookie 路径固定且窄：只有本模块的三个端点会收到该 Cookie。
 * 业务 GraphQL（/graphql）、REST（/api/stored-files 等）请求头中不会出现它。
 */
export const WEB_SESSION_COOKIE_PATH = '/api/auth/web-session';

/**
 * 传输层拒绝码。
 *
 * 这些是「本入口的协议结果」，不是领域业务错误，因此不新增/不改动
 * `core/common/errors` 的既有错误码词表，避免影响 GraphQL 错误契约。
 */
export const WEB_SESSION_REST_CODES = {
  ABSENT: 'WEB_SESSION_ABSENT',
  INVALID: 'WEB_SESSION_INVALID',
  REVOKED: 'WEB_SESSION_REVOKED',
  ORIGIN_NOT_ALLOWED: 'WEB_SESSION_ORIGIN_NOT_ALLOWED',
  DISABLED: 'WEB_SESSION_DISABLED',
  PERSISTENCE_UNAVAILABLE: 'WEB_SESSION_PERSISTENCE_UNAVAILABLE',
  INVALID_INPUT: 'WEB_SESSION_INVALID_INPUT',
} as const;
