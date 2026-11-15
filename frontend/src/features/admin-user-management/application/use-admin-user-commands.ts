// src/features/admin-user-management/application/use-admin-user-commands.ts

/**
 * 管理员用户管理写命令的执行入口（use case / command，收束在 feature application）。
 *
 * - 两个独立命令（状态修改 / 重置为默认密码）各持有自己的 in-flight 键：
 *   同类命令进行中拒绝重复提交，不同命令互不阻塞；
 * - 命令的显式业务结果（成功 / 业务拒绝）由 adapter 归一后原样透传给调用方；
 * - transport / auth / 网络类未处理失败统一收敛为 unhandled-error（附兜底文案），
 *   UNAUTHENTICATED 的会话清理与跳转仍由共享 ingress 链路负责，
 *   本 hook 不建立私有登出或错误分类；
 * - 命令成功后由 application 统一 reload 当前列表游标（保留当前筛选与页码）。
 */

import { useCallback, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import {
  adminResetUserPasswordToDefault,
  adminSetUserStatus,
} from '../infrastructure/admin-user-adapter';

import type {
  AdminUserCommandResult,
  AdminUserPasswordResetResult,
  AdminUserStatusFilter,
} from './admin-user-management.types';

export const ADMIN_USER_COMMAND_KEYS = ['status', 'reset-password'] as const;

export type AdminUserCommandKey = (typeof ADMIN_USER_COMMAND_KEYS)[number];

export type AdminUserCommandExecution<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'in-flight' }
  | { kind: 'unhandled-error'; message: string };

const UNHANDLED_FALLBACK_MESSAGE = '操作失败，请稍后重试。';

function toUnhandledUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : UNHANDLED_FALLBACK_MESSAGE;
}

export function useAdminUserCommands(reload: () => void) {
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<AdminUserCommandKey>>(new Set());
  const pendingKeysRef = useRef<ReadonlySet<AdminUserCommandKey>>(new Set());

  const setPending = useCallback((key: AdminUserCommandKey, pending: boolean) => {
    const next = new Set(pendingKeysRef.current);

    if (pending) {
      next.add(key);
    } else {
      next.delete(key);
    }

    pendingKeysRef.current = next;
    setPendingKeys(next);
  }, []);

  /**
   * 执行一个写命令：同一命令 in-flight 时返回 in-flight（不重复提交，
   * 调用方静默忽略，提交按钮已处于 loading 态）。
   */
  const runCommand = useCallback(
    async <T>(
      key: AdminUserCommandKey,
      action: () => Promise<T>,
    ): Promise<AdminUserCommandExecution<T>> => {
      if (pendingKeysRef.current.has(key)) {
        return { kind: 'in-flight' };
      }

      setPending(key, true);

      try {
        return { kind: 'ok', result: await action() };
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          // 非 ingress 错误原始信息只保留在控制台，避免收敛文案后线上无法排障
          console.error('管理员用户管理命令执行出现未分类错误：', error);
        }

        return { kind: 'unhandled-error', message: toUnhandledUserMessage(error) };
      } finally {
        setPending(key, false);
      }
    },
    [setPending],
  );

  /** 成功后统一刷新当前列表游标；业务失败与未处理异常均保持原 execution 形状。 */
  const runReloadingCommand = useCallback(
    async <T extends { ok: boolean }>(
      key: AdminUserCommandKey,
      action: () => Promise<T>,
    ): Promise<AdminUserCommandExecution<T>> => {
      const execution = await runCommand(key, action);
      if (execution.kind === 'ok' && execution.result.ok) {
        reload();
      }
      return execution;
    },
    [reload, runCommand],
  );

  const setUserStatus = useCallback(
    (input: {
      accountId: number;
      status: AdminUserStatusFilter;
    }): Promise<AdminUserCommandExecution<AdminUserCommandResult>> =>
      runReloadingCommand('status', () => adminSetUserStatus(input)),
    [runReloadingCommand],
  );

  const resetPasswordToDefault = useCallback(
    (input: {
      accountId: number;
    }): Promise<AdminUserCommandExecution<AdminUserPasswordResetResult>> =>
      runReloadingCommand('reset-password', () => adminResetUserPasswordToDefault(input)),
    [runReloadingCommand],
  );

  const isPending = useCallback((key: AdminUserCommandKey) => pendingKeys.has(key), [pendingKeys]);

  return {
    isPending,
    resetPasswordToDefault,
    setUserStatus,
  };
}
