// src/features/admin-engineer-approval/application/use-admin-engineer-approval-commands.ts

/**
 * 工程师注册审批命令的执行入口（use case / command）。
 *
 * - 批准与拒绝各持有独立 in-flight 键：同类命令进行中拒绝重复提交，两类命令互不阻塞；
 * - 命令的显式业务结果（成功 / 业务拒绝）由 adapter 归一后原样透传给调用方；
 * - transport / auth / 网络类未处理失败统一收敛为 unhandled-error（附兜底文案），
 *   UNAUTHENTICATED 的会话清理与跳转仍由共享 ingress 链路负责；
 * - 命令成功或并发冲突后由宿主统一 reload 当前队列游标（保留当前筛选与页码）。
 */

import { useCallback, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { reviewEngineerRegistration } from '../infrastructure/admin-engineer-approval-adapter';

import type {
  AdminEngineerReviewDraft,
  AdminEngineerReviewResult,
} from './admin-engineer-approval.types';

export const ADMIN_ENGINEER_COMMAND_KEYS = ['approve', 'reject'] as const;

export type AdminEngineerCommandKey = (typeof ADMIN_ENGINEER_COMMAND_KEYS)[number];

export type AdminEngineerCommandExecution =
  | { kind: 'ok'; result: AdminEngineerReviewResult }
  | { kind: 'in-flight' }
  | { kind: 'unhandled-error'; message: string };

const UNHANDLED_FALLBACK_MESSAGE = '操作失败，请稍后重试。';

function toUnhandledUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : UNHANDLED_FALLBACK_MESSAGE;
}

export function useAdminEngineerApprovalCommands() {
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<AdminEngineerCommandKey>>(new Set());
  const pendingKeysRef = useRef<ReadonlySet<AdminEngineerCommandKey>>(new Set());

  const setPending = useCallback((key: AdminEngineerCommandKey, pending: boolean) => {
    const next = new Set(pendingKeysRef.current);

    if (pending) {
      next.add(key);
    } else {
      next.delete(key);
    }

    pendingKeysRef.current = next;
    setPendingKeys(next);
  }, []);

  const runCommand = useCallback(
    async (
      key: AdminEngineerCommandKey,
      draft: AdminEngineerReviewDraft,
    ): Promise<AdminEngineerCommandExecution> => {
      if (pendingKeysRef.current.has(key)) {
        return { kind: 'in-flight' };
      }

      setPending(key, true);

      try {
        return { kind: 'ok', result: await reviewEngineerRegistration(draft) };
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          console.error('注册审批命令执行出现未分类错误：', error);
        }

        return { kind: 'unhandled-error', message: toUnhandledUserMessage(error) };
      } finally {
        setPending(key, false);
      }
    },
    [setPending],
  );

  const approve = useCallback(
    (applicationId: number): Promise<AdminEngineerCommandExecution> =>
      runCommand('approve', { applicationId, action: 'APPROVE', reviewComment: null }),
    [runCommand],
  );

  const reject = useCallback(
    (applicationId: number, reviewComment: string): Promise<AdminEngineerCommandExecution> =>
      runCommand('reject', { applicationId, action: 'REJECT', reviewComment }),
    [runCommand],
  );

  const isPending = useCallback(
    (key: AdminEngineerCommandKey) => pendingKeys.has(key),
    [pendingKeys],
  );

  return { approve, isPending, reject };
}
