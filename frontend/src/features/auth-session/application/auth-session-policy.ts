// src/features/auth-session/application/auth-session-policy.ts

import { sanitizeRedirectTarget } from '@/shared/navigation';

import {
  AUTH_LOGIN_REASON_SESSION_EXPIRED,
  composeLoginRedirectPath,
  composeSessionExpiredLoginRedirectPath,
  extractUrlPathname,
} from '../infrastructure/auth-return-to-url';

import {
  AUTH_SESSION_RESTRICTIONS,
  AUTH_SESSION_ROLES,
  type AuthSessionRestriction,
  type AuthSessionRole,
  type AuthSessionSnapshot,
  type AuthSessionUserSummary,
  type AuthSessionView,
  type EstablishAuthSessionInput,
} from './auth-session.types';

export function isAuthSessionRole(value: unknown): value is AuthSessionRole {
  return typeof value === 'string' && (AUTH_SESSION_ROLES as readonly string[]).includes(value);
}

export function isAuthSessionRestriction(value: unknown): value is AuthSessionRestriction {
  return (
    typeof value === 'string' && (AUTH_SESSION_RESTRICTIONS as readonly string[]).includes(value)
  );
}

// 正整数身份字段（adminLevel / customerOrganizationId）的宽容归一：缺失、
// null 或非法值一律回落 null——它们是展示性事实，不参与会话合法性判定。
function normalizeNullableIdentityId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeUserSummary(
  value: AuthSessionUserSummary | null,
  activeRole: AuthSessionRole,
): AuthSessionUserSummary | null {
  if (value === null) {
    return null;
  }

  const nickname = value.nickname.trim();
  const accessGroup = value.accessGroup;
  // 头像 URL 是展示性字段，不参与会话合法性判定：缺失/空白回落 null
  const avatarUrl = typeof value.avatarUrl === 'string' ? value.avatarUrl.trim() : '';

  if (
    !nickname ||
    !Array.isArray(accessGroup) ||
    accessGroup.length === 0 ||
    !accessGroup.every(isAuthSessionRole) ||
    !accessGroup.includes(activeRole)
  ) {
    throw new Error('Cannot establish an invalid auth session.');
  }

  return {
    accessGroup: [...accessGroup],
    avatarUrl: avatarUrl === '' ? null : avatarUrl,
    nickname,
  };
}

export function createAuthSessionSnapshot(input: EstablishAuthSessionInput): AuthSessionSnapshot {
  const accessToken = input.accessToken.trim();
  const { accountId, role } = input;

  if (
    !accessToken ||
    typeof accountId !== 'number' ||
    !Number.isInteger(accountId) ||
    accountId <= 0 ||
    !isAuthSessionRole(role)
  ) {
    throw new Error('Cannot establish an invalid auth session.');
  }

  return {
    accessToken,
    accountId,
    // 限制状态缺省 NONE、身份扩展字段缺省 null：仅携带最小身份的调用方
    // （既有测试夹具 / 旧调用点）建立的是正常会话
    adminLevel: normalizeNullableIdentityId(input.adminLevel),
    customerOrganizationId: normalizeNullableIdentityId(input.customerOrganizationId),
    engineerOrganizationId: normalizeNullableIdentityId(input.engineerOrganizationId),
    adminOrganizationId: normalizeNullableIdentityId(input.adminOrganizationId),
    registrationOrganizationId: normalizeNullableIdentityId(input.registrationOrganizationId),
    restriction: isAuthSessionRestriction(input.restriction) ? input.restriction : 'NONE',
    role,
    userInfo: normalizeUserSummary(input.userInfo, role),
  };
}
export function createAuthSessionView(session: AuthSessionSnapshot): AuthSessionView {
  return {
    accountId: session.accountId,
    adminLevel: session.adminLevel,
    customerOrganizationId: session.customerOrganizationId,
    engineerOrganizationId: session.engineerOrganizationId,
    adminOrganizationId: session.adminOrganizationId,
    registrationOrganizationId: session.registrationOrganizationId,
    restriction: session.restriction,
    role: session.role,
    userInfo: session.userInfo,
  };
}

const AUTH_SESSION_ROLE_HOME_PATHS: Record<AuthSessionRole, string> = {
  CUSTOMER: '/customer',
  ENGINEER: '/engineer',
  SUPER_ADMIN: '/admin',
};

// 受限会话（必须改密 / 工程师待审 / 工程师拒绝）的唯一落地页；非受限会话
// 访问该路径时回到自己的角色主页
export const AUTH_SESSION_RESTRICTED_PATH = '/restricted';

// SUPER_ADMIN 按后端角色层级继承 ENGINEER 与 CUSTOMER 的访问能力，见
// backend/docs/api/auth-session-current.md 与 docs/development/task-acceptance.md。
// 这里登记的是各角色允许访问的路由根路径；根路径下的子页面（如 /customer/）
// 由 isRolePathAllowed 的带边界前缀匹配统一放行，不在别处维护第二份角色路径表。
const AUTH_SESSION_ROLE_ALLOWED_ROOT_PATHS: Record<AuthSessionRole, readonly string[]> = {
  // /account：账号设置（0909 账号设置计划）对全部登录角色开放，三种角色同口径放行
  CUSTOMER: ['/account', '/customer'],
  // /reference-documents：AI 参考资料库（0907 任务二）；读模型向 ENGINEER/SUPER_ADMIN
  // 开放，CUSTOMER 完全禁入（访问时安全跳转回个人主页，与后端读守卫口径一致）
  ENGINEER: ['/account', '/engineer', '/reference-documents'],
  SUPER_ADMIN: ['/account', '/admin', '/customer', '/engineer', '/reference-documents'],
};

// 角色路由拒绝清单：优先于根路径表生效，匹配语义与根路径表一致（精确或带边界子路径）。
// 2026-08-29 负责人裁定：SUPER_ADMIN 第一版不代客户创建维修申请（后端精确仅接受
// CUSTOMER）。继承放行会让超管进入「型号加载即被拒」的残缺页面，前后端口径不一致，
// 故在此显式拒绝创建页，与 ENGINEER 一致跳回各自个人主页；后端约束保持不变。
const AUTH_SESSION_ROLE_DENIED_PATHS: Record<AuthSessionRole, readonly string[]> = {
  CUSTOMER: [],
  // /reference-documents/new：新增资料仅 SUPER_ADMIN（后端写接口精确角色），
  // 与维修申请创建页的裁定同理：拒绝清单避免「能进页面但提交必被拒」的残缺中间态
  ENGINEER: ['/reference-documents/new'],
  SUPER_ADMIN: ['/customer/repair-requests/new'],
};

export function resolveAuthSessionHomePath(role: AuthSessionRole): string {
  return AUTH_SESSION_ROLE_HOME_PATHS[role];
}

// 角色路由放行判断的唯一实现：精确等于根路径，或位于根路径的带边界子路径下。
// 带边界前缀可放行 /customer/、/customer/repair-requests/new，
// 同时拒绝相似前缀 /customer-admin、/customerABC。
export function isAuthSessionRolePathAllowed(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

export function isAuthSessionRoleAllowedAt(role: AuthSessionRole, path: string): boolean {
  const denied = AUTH_SESSION_ROLE_DENIED_PATHS[role].some((deniedPath) =>
    isAuthSessionRolePathAllowed(path, deniedPath),
  );

  if (denied) {
    return false;
  }

  return AUTH_SESSION_ROLE_ALLOWED_ROOT_PATHS[role].some((rootPath) =>
    isAuthSessionRolePathAllowed(path, rootPath),
  );
}

export type AuthSessionRoleCarrier = Pick<AuthSessionSnapshot, 'role'> & {
  /** 可选：仅做路由决策的既有调用方可不携带，缺省视为正常会话 */
  restriction?: AuthSessionRestriction;
  /** 可选：缺省视为无等级（不能进入全域管理路径） */
  adminLevel?: number | null;
  /** 可选：2 级管理员的本公司归属，缺省视为不可信 */
  adminOrganizationId?: number | null;
};

/**
 * 管理能力范围：GLOBAL 全域（1 级 + 可信组织）、ORGANIZATION 本公司
 * （2 级 + 可信组织）、NONE 无可用管理能力（非管理员、缺等级、非法等级、
 * 缺可信组织归属）。这是管理入口可见性与直达路由的共同唯一判定。
 */
export type AuthSessionAdminScope = 'GLOBAL' | 'ORGANIZATION' | 'NONE';

export function resolveAuthSessionAdminScope(
  session: AuthSessionRoleCarrier,
): AuthSessionAdminScope {
  if (session.role !== 'SUPER_ADMIN') {
    return 'NONE';
  }

  // 任一等级都要求可信组织归属：缺成员的管理员在服务端同样被拒绝执行组织范围操作
  const hasTrustedOrganization = normalizeNullableIdentityId(session.adminOrganizationId) !== null;

  if (session.adminLevel === 1) {
    return hasTrustedOrganization ? 'GLOBAL' : 'NONE';
  }

  if (session.adminLevel === 2) {
    return hasTrustedOrganization ? 'ORGANIZATION' : 'NONE';
  }

  // 缺等级与非法等级（0/3/非整数）一律不升级
  return 'NONE';
}

// 全域管理路径：仅 GLOBAL 范围可进。与导航目录 requiresAdminScope 标注逐项对账，
// 二者保持同一份路径集合，避免展示与直达语义漂移。
const AUTH_SESSION_ADMIN_GLOBAL_PATHS: readonly string[] = [
  '/admin/users',
  '/admin/document-database',
];

function isAuthSessionAdminGlobalPath(pathname: string): boolean {
  return AUTH_SESSION_ADMIN_GLOBAL_PATHS.some((globalPath) =>
    isAuthSessionRolePathAllowed(pathname, globalPath),
  );
}

// 角色放行 + 管理范围放行的唯一组合判定：直达路由与导航可见性同语义。
function isAuthSessionPathAllowed(session: AuthSessionRoleCarrier, pathname: string): boolean {
  if (!isAuthSessionRoleAllowedAt(session.role, pathname)) {
    return false;
  }

  return (
    !isAuthSessionAdminGlobalPath(pathname) || resolveAuthSessionAdminScope(session) === 'GLOBAL'
  );
}

// 受限会话判定：restriction 非 NONE 时只允许访问 /restricted。
// 未携带 restriction 的载体（策略函数的既有调用点）按正常会话处理。
export function isAuthSessionRestricted(carrier: AuthSessionRoleCarrier): boolean {
  return carrier.restriction !== undefined && carrier.restriction !== 'NONE';
}

// 登录/守卫共用的入口路径决策唯一实现；resolveLoginRouteRedirect、
// resolveEntryRouteRedirect 与 app/router 的登录后跳转都委托这里，
// 避免在组合根出现第二份决策。
export function resolveAuthSessionEntryPath(
  session: AuthSessionRoleCarrier,
  returnToCandidate?: unknown,
): string {
  // 受限会话不看 returnTo：一律落到受限页，避免「登录后进入无权页面」
  if (isAuthSessionRestricted(session)) {
    return AUTH_SESSION_RESTRICTED_PATH;
  }

  const safeReturnTo = resolveSafeReturnTo(returnToCandidate);

  if (safeReturnTo && isAuthSessionPathAllowed(session, extractUrlPathname(safeReturnTo))) {
    return safeReturnTo;
  }

  return resolveAuthSessionHomePath(session.role);
}

export function resolveLoginRouteRedirect(
  session: AuthSessionRoleCarrier | null,
  returnToCandidate?: unknown,
): string | null {
  if (!session) {
    return null;
  }

  return resolveAuthSessionEntryPath(session, returnToCandidate);
}

export function resolveProtectedRouteRedirect(
  session: AuthSessionRoleCarrier | null,
  requestedPath: string,
): string | null {
  if (!session) {
    return composeLoginRedirectPath(requestedPath);
  }

  const requestedPathname = extractUrlPathname(requestedPath);
  const isRequestingRestrictedPath = isAuthSessionRolePathAllowed(
    requestedPathname,
    AUTH_SESSION_RESTRICTED_PATH,
  );

  // 受限会话：只放行受限落地页，其余受保护路由一律收回 /restricted
  if (isAuthSessionRestricted(session)) {
    return isRequestingRestrictedPath ? null : AUTH_SESSION_RESTRICTED_PATH;
  }

  // 非受限会话访问受限页：回自己的角色主页（该页只属于受限会话）
  if (isRequestingRestrictedPath) {
    return resolveAuthSessionHomePath(session.role);
  }

  // 角色与管理范围共同决定放行：2 级管理员或未知等级直达全域管理路径时
  // 与导航同语义地退回管理员主页
  if (!isAuthSessionPathAllowed(session, requestedPathname)) {
    return resolveAuthSessionHomePath(session.role);
  }

  return null;
}

// 入口路由恒跳转，因此没有请求目标与 returnTo：匿名去 /login，
// 已登录去角色默认入口；不带 returnTo 避免登录后多一次中转。
export function resolveEntryRouteRedirect(session: AuthSessionRoleCarrier | null): string {
  if (!session) {
    return '/login';
  }

  return resolveAuthSessionEntryPath(session);
}

export function resolveSafeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    return null;
  }

  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return null;
  }

  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);

    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

  if (hasControlCharacter) {
    return null;
  }

  // 同源归一化复用 shared/navigation 的既有实现；它失败时回退 '/'，
  // 仅在输入本身就是 '/' 时才视为合法结果。
  const sanitized = sanitizeRedirectTarget(value);

  if (sanitized === '/' && value !== '/') {
    return null;
  }

  return sanitized;
}

// 失效原因的受控判定：仅预定义的 session-expired 成立；后端原始 message、
// errorCode、Token 或任意字符串都不被视为失效原因。
export function isAuthSessionExpiredReason(value: unknown): boolean {
  return value === AUTH_LOGIN_REASON_SESSION_EXPIRED;
}

// 失效跳转目标的唯一决策：恒定携带固定失效原因；仅安全站内路径才作为
// returnTo；当前已在 /login 前缀下（含 /login/ 等尾随形式）时不携带，避免循环。
// /login 是叶子路由，其子路径都不是有效的返回目标，判定口径与角色路径表一致。
export function resolveSessionExpiredLoginPath(currentPath?: unknown): string {
  const safeReturnTo = resolveSafeReturnTo(currentPath);
  const returnToPathname = safeReturnTo === null ? null : extractUrlPathname(safeReturnTo);

  if (returnToPathname === null || isAuthSessionRolePathAllowed(returnToPathname, '/login')) {
    return composeSessionExpiredLoginRedirectPath(null);
  }

  return composeSessionExpiredLoginRedirectPath(safeReturnTo);
}
