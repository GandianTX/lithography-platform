// src/features/auth-session/infrastructure/auth-session-identity-graphql.ts

/**
 * 启动 / 刷新时的会话身份复核：读取服务端每请求复核后的当前限制状态。
 *
 * 只读，不改写任何服务端状态；本地持久化由 store 的窄入口在校验会话代次后写入。
 * 解码失败或 `restriction` 非法时返回 null（调用方保持现状）——unknown 值不得
 * 回落成 NONE，否则会把受限会话误放行。
 */

import { executeGraphQL } from '@/shared/graphql';

import type { AuthSessionRestriction } from '../application/auth-session.types';
import { isAuthSessionRestriction } from '../application/auth-session-policy';

import { isRecord } from './auth-session-mapper';

const MY_SESSION_IDENTITY_QUERY = `
  query MySessionIdentity {
    mySessionIdentity {
      accountId
      role
      adminLevel
      customerOrganizationId
      engineerOrganizationId
      adminOrganizationId
      registrationOrganizationId
      restriction
    }
  }
`;

export type SessionIdentitySnapshot = {
  accountId: number;
  adminLevel: number | null;
  customerOrganizationId: number | null;
  engineerOrganizationId: number | null;
  adminOrganizationId: number | null;
  registrationOrganizationId: number | null;
  restriction: AuthSessionRestriction | null;
};

function decodeIdentityOrganizationId(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export async function fetchMySessionIdentity(): Promise<SessionIdentitySnapshot | null> {
  const response: unknown = await executeGraphQL(MY_SESSION_IDENTITY_QUERY, {});
  const value = isRecord(response) ? response.mySessionIdentity : null;

  if (!isRecord(value) || typeof value.accountId !== 'number') {
    return null;
  }

  return {
    accountId: value.accountId,
    adminLevel: typeof value.adminLevel === 'number' ? value.adminLevel : null,
    customerOrganizationId:
      typeof value.customerOrganizationId === 'number' ? value.customerOrganizationId : null,
    engineerOrganizationId: decodeIdentityOrganizationId(value.engineerOrganizationId),
    adminOrganizationId: decodeIdentityOrganizationId(value.adminOrganizationId),
    registrationOrganizationId: decodeIdentityOrganizationId(value.registrationOrganizationId),
    restriction: isAuthSessionRestriction(value.restriction) ? value.restriction : null,
  };
}
