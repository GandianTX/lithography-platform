// src/features/record-package/application/use-record-package-import.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';
import type { MessageKey } from '@/shared/i18n';

import type {
  RecordPackageCheckResult,
  RecordPackageProcessResult,
} from '../infrastructure/record-package.types';
import { checkRecordPackage, importRecordPackage } from '../infrastructure/record-package-adapter';

export type RecordPackageImportState =
  | { status: 'idle'; requestId: number }
  | { status: 'checking'; requestId: number }
  | { status: 'checked'; requestId: number; check: RecordPackageCheckResult; packagePath: string }
  | { status: 'importing'; requestId: number; check: RecordPackageCheckResult; packagePath: string }
  | {
      status: 'imported';
      requestId: number;
      result: RecordPackageProcessResult;
      packagePath: string;
    }
  | { status: 'failed'; requestId: number; message: string; messageKey?: MessageKey };

type RecordPackageImportAction =
  | { type: 'check-start'; requestId: number }
  | {
      type: 'check-ok';
      requestId: number;
      check: RecordPackageCheckResult;
      packagePath: string;
    }
  | { type: 'check-failed'; requestId: number; message: string; messageKey?: MessageKey }
  | {
      type: 'import-start';
      requestId: number;
      check: RecordPackageCheckResult;
      packagePath: string;
    }
  | {
      type: 'import-ok';
      requestId: number;
      result: RecordPackageProcessResult;
      packagePath: string;
    }
  | { type: 'import-failed'; requestId: number; message: string; messageKey?: MessageKey }
  | { type: 'reset'; requestId: number };

/**
 * GraphQL 生产分支只依据稳定的 `extensions.code` 分类决定受控翻译键，
 * 不依赖可能隐藏的 `errorCode`/`errorMessage`。清单级错误（例如同键重复）
 * 归 BAD_USER_INPUT：UI 用当前语言提示重新导出，而不是误导用户"稍后重试"。
 */
function resolveRecordPackageFailure(
  error: unknown,
  fallback: string,
): { message: string; messageKey?: MessageKey } {
  const detail = readGraphQLErrorDetail(error);
  if (detail?.code === 'BAD_USER_INPUT') {
    return { message: fallback, messageKey: 'recordPackage.import.error.badUserInput' };
  }
  return { message: isGraphQLIngressError(error) ? error.userMessage : fallback };
}

/**
 * 记录包导入流程：安全预检 → 明确确认 → 受控逐项导入 → 逐条结果。
 *
 * - 预检**不写正式业务**，只落检查事实；
 * - 确认时带上预检得到的清单摘要：包内容变了服务端会让旧确认作废；
 * - 换包／重新预检都会清掉上一次的确认状态（`reset`）。
 *
 * **竞态防护（任务 09 第 06 项 · P2-1／G36）**：
 * - `requestIdRef` 为序号唯一真源：晚到的旧预检／旧导入响应一律丢弃
 *   （旧失败不会覆盖新成功，旧预检不会把界面改回上一个包）；
 * - `reset` 递增序号 ⇒ 换包／关闭后旧响应不会"复活"状态；
 * - **确认的副作用不在状态更新函数里发起**（updater 必须是纯函数；
 *   在其中发起请求会让 React StrictMode 重复调用 updater ⇒ 开发态双发导入）；
 * - 双击确认由**同步闸门**（`importingRef`）拦下，不依赖 React 渲染快照；
 * - 确认绑定**那一轮预检**的包 ID／路径／清单摘要（换包即失效）。
 */
function recordPackageImportReducer(
  state: RecordPackageImportState,
  action: RecordPackageImportAction,
): RecordPackageImportState {
  switch (action.type) {
    case 'check-start':
      return { status: 'checking', requestId: action.requestId };
    case 'check-ok':
      if (action.requestId !== state.requestId) {
        return state;
      }
      return {
        status: 'checked',
        requestId: action.requestId,
        check: action.check,
        packagePath: action.packagePath,
      };
    case 'check-failed':
      if (action.requestId !== state.requestId) {
        return state;
      }
      return {
        status: 'failed',
        requestId: action.requestId,
        message: action.message,
        ...(action.messageKey === undefined ? {} : { messageKey: action.messageKey }),
      };
    case 'import-start':
      return {
        status: 'importing',
        requestId: action.requestId,
        check: action.check,
        packagePath: action.packagePath,
      };
    case 'import-ok':
      if (action.requestId !== state.requestId) {
        return state;
      }
      return {
        status: 'imported',
        requestId: action.requestId,
        result: action.result,
        packagePath: action.packagePath,
      };
    case 'import-failed':
      if (action.requestId !== state.requestId) {
        return state;
      }
      return {
        status: 'failed',
        requestId: action.requestId,
        message: action.message,
        ...(action.messageKey === undefined ? {} : { messageKey: action.messageKey }),
      };
    case 'reset':
      return { status: 'idle', requestId: action.requestId };
  }
}

/**
 * @param sessionKey 当前会话的账号标识：切账号时变化 ⇒ 在途响应作废（不写进新账号的界面）。
 */
export function useRecordPackageImport(sessionKey?: number | null) {
  const [state, dispatch] = useReducer(recordPackageImportReducer, {
    status: 'idle',
    requestId: 0,
  } as RecordPackageImportState);
  const requestIdRef = useRef(0);
  const lastSessionKeyRef = useRef(sessionKey);

  // 切账号：作废在途响应并回到空闲（旧账号的检查／导入结果不得出现在新账号的界面）
  useEffect(() => {
    if (lastSessionKeyRef.current === sessionKey) {
      return;
    }
    lastSessionKeyRef.current = sessionKey;
    requestIdRef.current += 1;
    dispatch({ type: 'reset', requestId: requestIdRef.current });
  }, [sessionKey]);
  /** 最新状态镜像：确认时读取（不在状态更新函数里发起副作用） */
  const stateRef = useRef(state);
  /** 导入中的同步闸门：双击确认只允许一次请求进入 */
  const importingRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const check = useCallback(async (packagePath: string) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    dispatch({ type: 'check-start', requestId });
    try {
      const result = await checkRecordPackage(packagePath);
      dispatch({ type: 'check-ok', requestId, check: result, packagePath });
      return { ok: true as const, result };
    } catch (error) {
      const { message, messageKey } = resolveRecordPackageFailure(
        error,
        '记录包检查失败，请稍后重试。',
      );
      dispatch({ type: 'check-failed', requestId, message, messageKey });
      return { ok: false as const, message };
    }
  }, []);

  const confirmImport = useCallback(async () => {
    // 双击互斥：同步闸门先判（同一批次内的两次点击看到的仍是旧状态，
    // 只靠状态快照拦不住）⇒ 第二次调用直接返回，不发第二个导入请求。
    if (importingRef.current) {
      return { ok: false as const, message: '记录包正在导入，请勿重复提交。' };
    }
    const current = stateRef.current;
    if (current.status !== 'checked') {
      return { ok: false as const, message: '请先完成安全预检再确认导入。' };
    }

    importingRef.current = true;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    dispatch({
      type: 'import-start',
      requestId,
      check: current.check,
      packagePath: current.packagePath,
    });

    try {
      const result = await importRecordPackage({
        packageId: current.check.import.packageId,
        packagePath: current.packagePath,
        manifestChecksum: current.check.import.manifestChecksum,
      });
      dispatch({ type: 'import-ok', requestId, result, packagePath: current.packagePath });
      return { ok: true as const, result };
    } catch (error) {
      const { message, messageKey } = resolveRecordPackageFailure(
        error,
        '记录包导入失败，请稍后重试。',
      );
      dispatch({ type: 'import-failed', requestId, message, messageKey });
      return { ok: false as const, message };
    } finally {
      // 只释放同步闸门，不回写状态（旧响应是否作废由序号判定）
      importingRef.current = false;
    }
  }, []);

  // 重置同时使在途响应作废（序号递增）：换包后旧响应不会复活状态
  const reset = useCallback(() => {
    requestIdRef.current += 1;
    dispatch({ type: 'reset', requestId: requestIdRef.current });
  }, []);

  return { state, check, confirmImport, reset };
}
