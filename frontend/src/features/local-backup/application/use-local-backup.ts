// src/features/local-backup/application/use-local-backup.ts

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { isForbiddenIngressError, isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n/runtime-translator';

import type {
  LocalBackupCleanupMode,
  LocalBackupCleanupResult,
  LocalBackupRecordPage,
  LocalBackupSetting,
  LocalRestoreCapability,
  LocalRestorePrecheckResult,
  StartManualLocalBackupResult,
} from '../infrastructure/local-backup.types';
import {
  cleanupLocalBackupPackages,
  fetchLocalBackupRecords,
  fetchLocalBackupSettings,
  fetchLocalRestoreCapability,
  precheckLocalRestore,
  startManualLocalBackup,
} from '../infrastructure/local-backup-graphql-adapter';

/**
 * 备份与恢复页的应用层（任务 09 S3／S4）。
 *
 * 竞态防护：与本仓库其它列表/统计 hook 同级，以 `requestIdRef` 为序号唯一真源，
 * 晚到的旧响应一律丢弃，避免"上一账号的数据覆盖当前账号"。
 *
 * 失败不做乐观降级：不展示缓存值、不伪造"备份成功"，只给可重试的失败态。
 *
 * 失败分三类（不混为一谈）：
 * - `forbidden`：权限不足——重试无用，提示联系管理员；
 * - `failed`：其它失败，可重试；
 * - 兜底文案按当前语言即时翻译（application 层不能调用 useI18n）。
 */

export type AsyncState<T> =
  | { status: 'loading'; requestId: number }
  | { status: 'ready'; requestId: number; data: T }
  | { status: 'forbidden'; requestId: number; message: string }
  | { status: 'failed'; requestId: number; message: string };

type Action<T> =
  | { type: 'load-start'; requestId: number }
  | { type: 'load-ready'; requestId: number; data: T }
  | { type: 'load-forbidden'; requestId: number; message: string }
  | { type: 'load-failed'; requestId: number; message: string };

function reducer<T>(state: AsyncState<T>, action: Action<T>): AsyncState<T> {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestId: action.requestId };
    case 'load-ready':
      return action.requestId === state.requestId
        ? { status: 'ready', requestId: action.requestId, data: action.data }
        : state;
    case 'load-forbidden':
      return action.requestId === state.requestId
        ? { status: 'forbidden', requestId: action.requestId, message: action.message }
        : state;
    case 'load-failed':
      return action.requestId === state.requestId
        ? { status: 'failed', requestId: action.requestId, message: action.message }
        : state;
    default:
      return state;
  }
}

/** 权限不足提示（当前语言即时翻译） */
function forbiddenMessage(): string {
  return translateNow('local-backup.error.forbidden');
}

function useAsyncResource<T>(load: () => Promise<T>, fallbackMessage: string) {
  const [state, dispatch] = useReducer(reducer<T>, {
    status: 'loading',
    requestId: 0,
  } as AsyncState<T>);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    dispatch({ type: 'load-start', requestId });

    try {
      const data = await load();
      dispatch({ type: 'load-ready', requestId, data });
    } catch (error) {
      if (isForbiddenIngressError(error)) {
        dispatch({ type: 'load-forbidden', requestId, message: forbiddenMessage() });
        return;
      }
      dispatch({
        type: 'load-failed',
        requestId,
        message: isGraphQLIngressError(error) ? error.userMessage : fallbackMessage,
      });
    }
  }, [fallbackMessage, load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
}

/** 备份记录列表（分页） */
export function useLocalBackupRecords(page: number, pageSize: number) {
  const load = useCallback(() => fetchLocalBackupRecords(page, pageSize), [page, pageSize]);

  return useAsyncResource<LocalBackupRecordPage>(
    load,
    translateNow('local-backup.error.recordsLoadFailed'),
  );
}

/** 自动备份设置 */
export function useLocalBackupSettings() {
  const load = useCallback(() => fetchLocalBackupSettings(), []);

  return useAsyncResource<LocalBackupSetting[]>(
    load,
    translateNow('local-backup.error.settingsLoadFailed'),
  );
}

/** 恢复执行能力状态 */
export function useLocalRestoreCapability() {
  const load = useCallback(() => fetchLocalRestoreCapability(), []);

  return useAsyncResource<LocalRestoreCapability>(
    load,
    translateNow('local-backup.error.capabilityLoadFailed'),
  );
}

export type ActionState<T> =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'succeeded'; data: T }
  | { status: 'forbidden'; message: string }
  | { status: 'failed'; message: string };

/** 手动备份触发 */
export function useManualLocalBackup() {
  const [state, setState] = useState<ActionState<StartManualLocalBackupResult>>({
    status: 'idle',
  });

  const trigger = useCallback(async (organizationId?: number) => {
    setState({ status: 'running' });

    try {
      const data = await startManualLocalBackup(organizationId);
      setState({ status: 'succeeded', data });
      return data;
    } catch (error) {
      if (isForbiddenIngressError(error)) {
        setState({ status: 'forbidden', message: forbiddenMessage() });
        return null;
      }
      setState({
        status: 'failed',
        message: isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('local-backup.error.manualFailed'),
      });
      return null;
    }
  }, []);

  return { state, trigger, reset: () => setState({ status: 'idle' }) };
}

/** 清理本机本公司的本地备份包 */
export function useCleanupLocalBackupPackages() {
  const [state, setState] = useState<ActionState<LocalBackupCleanupResult>>({
    status: 'idle',
  });

  const trigger = useCallback(async (mode: LocalBackupCleanupMode) => {
    setState({ status: 'running' });

    try {
      const data = await cleanupLocalBackupPackages(mode);
      setState({ status: 'succeeded', data });
      return data;
    } catch (error) {
      if (isForbiddenIngressError(error)) {
        setState({ status: 'forbidden', message: forbiddenMessage() });
        return null;
      }
      setState({
        status: 'failed',
        message: isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('local-backup.error.cleanupFailed'),
      });
      return null;
    }
  }, []);

  return { state, trigger, reset: () => setState({ status: 'idle' }) };
}

/** 恢复预检 */
export function useRestorePrecheck() {
  const [state, setState] = useState<ActionState<LocalRestorePrecheckResult>>({
    status: 'idle',
  });

  const trigger = useCallback(async (backupId: string) => {
    setState({ status: 'running' });

    try {
      const data = await precheckLocalRestore(backupId);
      setState({ status: 'succeeded', data });
    } catch (error) {
      if (isForbiddenIngressError(error)) {
        setState({ status: 'forbidden', message: forbiddenMessage() });
        return;
      }
      setState({
        status: 'failed',
        message: isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('local-backup.error.precheckFailed'),
      });
    }
  }, []);

  return { state, trigger, reset: () => setState({ status: 'idle' }) };
}
