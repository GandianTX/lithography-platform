// src/features/auth-session/index.ts

export type {
  AuthSessionIdentity,
  AuthSessionRestriction,
  AuthSessionRole,
  AuthSessionUserSummary,
  AuthSessionView,
  AuthSessionViewState,
} from './application/auth-session.types';
export { AUTH_SESSION_RESTRICTIONS, AUTH_SESSION_ROLES } from './application/auth-session.types';
export {
  AUTH_SESSION_RESTRICTED_PATH,
  type AuthSessionAdminScope,
  type AuthSessionRoleCarrier,
  isAuthSessionAdminPathAllowedAt,
  isAuthSessionDuplicateSidebarEntrySuppressedAt,
  isAuthSessionExpiredReason,
  isAuthSessionRestricted,
  isAuthSessionRestriction,
  isAuthSessionRole,
  isAuthSessionRoleAllowedAt,
  resolveAuthSessionAdminScope,
  resolveAuthSessionEntryPath,
  resolveAuthSessionHomePath,
  resolveEntryRouteRedirect,
  resolveLoginRouteRedirect,
  resolveProtectedRouteRedirect,
  resolveSafeReturnTo,
  resolveSessionExpiredLoginPath,
} from './application/auth-session-policy';
export type { WebSessionRestoreOutcome } from './application/restore-auth-session';
export type {
  AuthSessionIdentityRefreshOutcome,
  LogoutAuthSessionOutcome,
} from './auth-session-entry';
export {
  applyCrossTabSessionEvent,
  clearAuthSessionLocally,
  clearSessionAfterPasswordChange,
  ensureWebSessionRestored,
  getAuthSessionAccessToken,
  getCurrentAuthSession,
  hasCurrentAuthSession,
  logoutAuthSession,
  logoutAuthSessionWithSignOut,
  refreshCurrentAuthSessionIdentity,
  sampleCurrentAuthSessionIdentity,
  startAuthSessionCrossTabSync,
  updateCurrentAuthSessionNickname,
  webSessionEnabled,
} from './auth-session-entry';
export {
  AUTH_LOGIN_REASON_PARAM_KEY,
  AUTH_LOGIN_REASON_SESSION_EXPIRED,
  AUTH_RETURN_TO_PARAM_KEY,
  composeLoginRedirectPath,
  composeProtectedRequestTarget,
  composeSessionExpiredLoginRedirectPath,
  composeSessionUnavailableRedirectPath,
  extractUrlPathname,
  readAuthLoginReasonParam,
  readAuthReturnToFromRequest,
  readAuthReturnToParam,
  SESSION_UNAVAILABLE_PATH,
} from './infrastructure/auth-return-to-url';
export { useAuthSession } from './ui/auth-session-context';
export { AuthSessionPanel } from './ui/auth-session-panel';
export { AuthSessionProvider } from './ui/auth-session-provider';
export { LoginForm, type LoginFormProps } from './ui/login-form';
export { LogoutButton } from './ui/logout-button';
export {
  AUTH_SESSION_EXPIRED_NOTICE_MESSAGE,
  SessionExpiredNotice,
  type SessionExpiredNoticeProps,
} from './ui/session-expired-notice';
