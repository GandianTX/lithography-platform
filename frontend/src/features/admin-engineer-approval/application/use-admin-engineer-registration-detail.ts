// src/features/admin-engineer-approval/application/use-admin-engineer-registration-detail.ts

/**
 * 申请详情读取（use case / query）。
 *
 * 详情入口按目标主键单独向后端读取，不复用列表行快照：列表可能已过期，
 * 而详情弹窗的职责是给出当前落库事实。请求代次用于丢弃过期响应：
 * 连续打开不同申请时，旧请求晚到不得覆盖当前目标。
 *
 * 除请求代次外，每次打开还构成一个「打开会话」：审批命令在发起时捕获该会话，
 * 成功 / 冲突后续体只有在当前详情仍是同一会话时才触发重查。这样晚到的响应
 * 既不会重开已关闭的旧详情，也不会覆盖用户后来打开的另一申请；
 * 关闭后重新打开同一申请属于新会话，同样不因上一代的命令结果被动刷新。
 */

import { useCallback, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchAdminEngineerRegistrationDetail } from '../infrastructure/admin-engineer-approval-adapter';

import type { AdminEngineerRegistrationDetail } from './admin-engineer-approval.types';

export type AdminEngineerRegistrationDetailState =
  | { status: 'idle' }
  | { status: 'loading'; applicationId: number }
  | { status: 'ready'; registration: AdminEngineerRegistrationDetail }
  | { status: 'failed'; applicationId: number; message: string };

/** 一次「打开详情」的会话快照：目标主键 + 打开代次 */
export type AdminEngineerRegistrationDetailSession = {
  readonly applicationId: number;
  readonly sessionSeq: number;
};

const FALLBACK_MESSAGE = '注册申请详情加载失败，请稍后重试。';

export function useAdminEngineerRegistrationDetail() {
  const [state, setState] = useState<AdminEngineerRegistrationDetailState>({ status: 'idle' });
  /** 请求代次与打开代次共用同一计数器：每次 open / close 都推进，天然区分会话 */
  const requestIdRef = useRef(0);
  const currentSessionRef = useRef<AdminEngineerRegistrationDetailSession | null>(null);

  const open = useCallback(async (applicationId: number) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    currentSessionRef.current = { applicationId, sessionSeq: requestId };

    setState({ status: 'loading', applicationId });

    try {
      const result = await fetchAdminEngineerRegistrationDetail(applicationId);

      if (requestId !== requestIdRef.current) {
        return;
      }

      setState(
        result.ok
          ? { status: 'ready', registration: result.registration }
          : { status: 'failed', applicationId, message: result.message },
      );
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!isGraphQLIngressError(error)) {
        console.error('注册申请详情加载出现未分类错误：', error);
      }

      setState({
        applicationId,
        message: isGraphQLIngressError(error) ? error.userMessage : FALLBACK_MESSAGE,
        status: 'failed',
      });
    }
  }, []);

  const close = useCallback(() => {
    requestIdRef.current += 1;
    currentSessionRef.current = null;
    setState({ status: 'idle' });
  }, []);

  /** 捕获当前打开会话；详情未打开时为 null。命令发起时调用。 */
  const captureCurrent = useCallback((): AdminEngineerRegistrationDetailSession | null => {
    return currentSessionRef.current;
  }, []);

  /** 当前详情是否仍属于给定会话（关闭 / 切换目标 / 重新打开都会使其失效）。 */
  const isCurrentSession = useCallback(
    (session: AdminEngineerRegistrationDetailSession | null): boolean =>
      session !== null && currentSessionRef.current?.sessionSeq === session.sessionSeq,
    [],
  );

  /**
   * 仅当详情仍是发起命令时的同一打开会话才重查；否则保持用户当前界面不动。
   * 读取的是 ref 而非渲染时快照，晚到响应不会因闭包持有旧 ID 而误刷新。
   */
  const refreshIfCurrent = useCallback(
    (session: AdminEngineerRegistrationDetailSession | null) => {
      if (!isCurrentSession(session) || session === null) {
        return;
      }

      void open(session.applicationId);
    },
    [isCurrentSession, open],
  );

  return { captureCurrent, close, isCurrentSession, open, refreshIfCurrent, state };
}
