// src/features/admin-company-management/application/use-admin-company-commands.ts

/**
 * 公司档案写命令的执行入口（use case / command，收束在 feature application）。
 *
 * - 新增与编辑各持有独立 in-flight 键：同类命令进行中拒绝重复提交，两类命令互不阻塞；
 * - 命令的显式业务结果（成功 / 业务拒绝）由 adapter 归一后原样透传给调用方；
 * - transport / auth / 网络类未处理失败统一收敛为 unhandled-error（附兜底文案），
 *   UNAUTHENTICATED 的会话清理与跳转仍由共享 ingress 链路负责；
 * - 命令成功后由 application 统一 reload 当前列表游标（保留当前筛选与页码）。
 */

import { useCallback, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import {
  adminCreateCompany,
  adminReissueLevelTwoCredential,
  adminUpdateCompany,
} from '../infrastructure/admin-company-adapter';

import type {
  AdminCompanyCreateDraft,
  AdminCompanyCredentialResult,
  AdminCompanyProvisionResult,
  AdminCompanyRecordResult,
  AdminCompanyUpdateDraft,
} from './admin-company-management.types';

export const ADMIN_COMPANY_COMMAND_KEYS = ['create', 'update', 'reissue-credential'] as const;

export type AdminCompanyCommandKey = (typeof ADMIN_COMPANY_COMMAND_KEYS)[number];

export type AdminCompanyCommandExecution<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'in-flight' }
  | { kind: 'unhandled-error'; message: string };

const UNHANDLED_FALLBACK_MESSAGE = '操作失败，请稍后重试。';

function toUnhandledUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : UNHANDLED_FALLBACK_MESSAGE;
}

export function useAdminCompanyCommands(reload: () => void) {
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<AdminCompanyCommandKey>>(new Set());
  const pendingKeysRef = useRef<ReadonlySet<AdminCompanyCommandKey>>(new Set());

  const setPending = useCallback((key: AdminCompanyCommandKey, pending: boolean) => {
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
    async <T>(
      key: AdminCompanyCommandKey,
      action: () => Promise<T>,
    ): Promise<AdminCompanyCommandExecution<T>> => {
      if (pendingKeysRef.current.has(key)) {
        return { kind: 'in-flight' };
      }

      setPending(key, true);

      try {
        return { kind: 'ok', result: await action() };
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          console.error('公司档案命令执行出现未分类错误：', error);
        }

        return { kind: 'unhandled-error', message: toUnhandledUserMessage(error) };
      } finally {
        setPending(key, false);
      }
    },
    [setPending],
  );

  const runReloadingCommand = useCallback(
    async <T extends { ok: boolean }>(
      key: AdminCompanyCommandKey,
      action: () => Promise<T>,
    ): Promise<AdminCompanyCommandExecution<T>> => {
      const execution = await runCommand(key, action);
      if (execution.kind === 'ok' && execution.result.ok) {
        reload();
      }
      return execution;
    },
    [reload, runCommand],
  );

  const createCompany = useCallback(
    (
      draft: AdminCompanyCreateDraft,
      submissionKey: string,
    ): Promise<AdminCompanyCommandExecution<AdminCompanyProvisionResult>> =>
      runReloadingCommand('create', () => adminCreateCompany(draft, submissionKey)),
    [runReloadingCommand],
  );

  const updateCompany = useCallback(
    (
      draft: AdminCompanyUpdateDraft,
    ): Promise<AdminCompanyCommandExecution<AdminCompanyRecordResult>> =>
      runReloadingCommand('update', () => adminUpdateCompany(draft)),
    [runReloadingCommand],
  );

  /** 补发临时密码：成功即回读列表与绑定状态（旧凭据已被服务端作废） */
  const reissueCredential = useCallback(
    (organizationId: number): Promise<AdminCompanyCommandExecution<AdminCompanyCredentialResult>> =>
      runReloadingCommand('reissue-credential', () =>
        adminReissueLevelTwoCredential(organizationId),
      ),
    [runReloadingCommand],
  );

  const isPending = useCallback(
    (key: AdminCompanyCommandKey) => pendingKeys.has(key),
    [pendingKeys],
  );

  return { createCompany, isPending, reissueCredential, updateCompany };
}
