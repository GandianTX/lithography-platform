// src/features/auth-session/infrastructure/auth-web-session-rest.ts

import { isGraphQLIngressError } from '@/shared/graphql';

import type { AuthSessionSnapshot } from '../application/auth-session.types';

import { postWebSession } from './auth-login-rest';
import { decodeAuthSessionPayload } from './auth-session-mapper';

/** 恢复结果三态：明确有会话 / 明确无会话 / 无法确认（不得当成未登录） */
export type RestoreWebSessionResult =
  | { status: 'restored'; session: AuthSessionSnapshot }
  | { status: 'absent' }
  | { status: 'unavailable'; userMessage?: string };

export type RevokeWebSessionResult =
  | 'ok'
  /** 该部署未启用服务端会话（404）：不可能存在由本功能下发的 Cookie，可继续本地退出 */
  | 'unsupported'
  | 'failed';

export type WebSessionRestGateway = {
  restore: () => Promise<RestoreWebSessionResult>;
  /** 主动退出：服务端清 Cookie 是否成功（401 视为已无会话，也算成功） */
  revoke: () => Promise<RevokeWebSessionResult>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 浏览器会话恢复/退出网关。
 *
 * 关键语义：
 * - **只有 401 才算「服务端明确无会话/已失效」**，调用方据此清理本地会话；
 * - 网络失败、403（来源不在可信站点白名单）、5xx、响应体异常一律 `unavailable`：
 *   既不清会话也不跳登录，交给重试页，避免把服务故障误判成未登录或误踢人；
 * - 退出不区分「本来就没有会话」，401 也算成功（Cookie 已不需要清除）。
 */
export function createRestWebSessionGateway(fetchImpl?: FetchLike): WebSessionRestGateway {
  return {
    async restore(): Promise<RestoreWebSessionResult> {
      let payload: unknown;

      try {
        payload = await postWebSession('restore', null, fetchImpl);
      } catch (error) {
        if (isGraphQLIngressError(error) && error.type === 'auth') {
          return { status: 'absent' };
        }

        return {
          status: 'unavailable',
          ...(isGraphQLIngressError(error) ? { userMessage: error.userMessage } : {}),
        };
      }

      const session = decodeAuthSessionPayload(payload);

      // 服务端 200 但载荷不合法：属实现/代理异常，不当作「无会话」清空本地
      if (!session) {
        return { status: 'unavailable' };
      }

      return { status: 'restored', session };
    },

    async revoke(): Promise<RevokeWebSessionResult> {
      try {
        await postWebSession('logout', null, fetchImpl);

        return 'ok';
      } catch (error) {
        // 已无会话（401）时 Cookie 清除请求仍应继续，这里视为成功
        if (isGraphQLIngressError(error) && error.type === 'auth') {
          return 'ok';
        }

        // 端点不存在 = 该部署未启用本功能：不可能有本功能下发的 Cookie
        if (isGraphQLIngressError(error) && error.statusCode === 404) {
          return 'unsupported';
        }

        return 'failed';
      }
    },
  };
}

export const restWebSessionGateway = createRestWebSessionGateway();
