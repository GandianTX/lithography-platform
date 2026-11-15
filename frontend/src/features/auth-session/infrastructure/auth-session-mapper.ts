// src/features/auth-session/infrastructure/auth-session-mapper.ts

import type {
  AuthSessionRole,
  AuthSessionSnapshot,
  AuthSessionUserSummary,
} from '../application/auth-session.types';
import {
  createAuthSessionSnapshot,
  isAuthSessionRestriction,
  isAuthSessionRole,
} from '../application/auth-session-policy';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function decodeAccessGroup(value: unknown): AuthSessionRole[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const roles: AuthSessionRole[] = [];

  for (const role of value) {
    if (!isAuthSessionRole(role)) {
      return null;
    }

    roles.push(role);
  }

  return roles;
}

function decodeUserSummary(value: unknown): AuthSessionUserSummary | null | undefined {
  if (value === null) {
    return null;
  }

  if (!isRecord(value) || typeof value.nickname !== 'string') {
    return undefined;
  }

  const accessGroup = decodeAccessGroup(value.accessGroup);

  if (!accessGroup) {
    return undefined;
  }

  return {
    accessGroup,
    // 展示性字段，宽容解码：非字符串或缺失一律回落 null，绝不因此拒绝整份会话
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : null,
    nickname: value.nickname,
  };
}

// 身份扩展字段的宽容解码：缺失/非法一律回落 null，由 snapshot 工厂再归一；
// 限制状态缺失或未知时按 NONE 处理，非法值不可能被提升成受限/放行依据。
function decodeNullableIdentityId(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function decodeAuthSessionPayload(value: unknown): AuthSessionSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== 'string' ||
    typeof value.accountId !== 'number' ||
    !isAuthSessionRole(value.role)
  ) {
    return null;
  }

  const userInfo = decodeUserSummary(value.userInfo);

  if (userInfo === undefined) {
    return null;
  }

  try {
    return createAuthSessionSnapshot({
      accessToken: value.accessToken,
      accountId: value.accountId,
      adminLevel: decodeNullableIdentityId(value.adminLevel),
      customerOrganizationId: decodeNullableIdentityId(value.customerOrganizationId),
      engineerOrganizationId: decodeNullableIdentityId(value.engineerOrganizationId),
      adminOrganizationId: decodeNullableIdentityId(value.adminOrganizationId),
      registrationOrganizationId: decodeNullableIdentityId(value.registrationOrganizationId),
      restriction: isAuthSessionRestriction(value.restriction) ? value.restriction : undefined,
      role: value.role,
      userInfo,
    });
  } catch {
    return null;
  }
}
