// src/features/record-package/application/use-record-package-export.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type {
  RecordPackageExportEntry,
  RecordPackageExportResult,
  RecordPackageResourceType,
} from '../infrastructure/record-package.types';
import { exportRecordPackage } from '../infrastructure/record-package-adapter';

export type RecordPackageExportState =
  | { status: 'idle'; requestId: number }
  | { status: 'running'; requestId: number }
  | { status: 'succeeded'; requestId: number; result: RecordPackageExportResult }
  | { status: 'failed'; requestId: number; message: string };

type RecordPackageExportAction =
  | { type: 'run-start'; requestId: number }
  | { type: 'run-succeeded'; requestId: number; result: RecordPackageExportResult }
  | { type: 'run-failed'; requestId: number; message: string }
  | { type: 'reset'; requestId: number };

/**
 * 记录包导出流程。
 *
 * 目标目录必须是本机绝对路径（U盘挂载点或空目录），由服务端复核；
 * 前端只把服务端返回的**逐条结论**如实展示，不自行判断哪些记录可导出。
 *
 * **竞态防护（任务 09 第 06 项 · P2-1／G36）**：与本仓其它列表／状态 hook 同级，
 * 以 `requestIdRef` 为序号唯一真源：
 * - 新一次导出使上一次的在途响应作废 ⇒ **晚到的旧响应不覆盖当前结果**；
 * - `reset`（关闭对话框／换目标目录）同样递增序号 ⇒ 关闭后旧响应不会"复活"状态；
 * - 成功／失败两条回写路径都核对序号 ⇒ 旧响应的失败不会覆盖新响应的成功。
 */
function recordPackageExportReducer(
  state: RecordPackageExportState,
  action: RecordPackageExportAction,
): RecordPackageExportState {
  switch (action.type) {
    case 'run-start':
      return { status: 'running', requestId: action.requestId };
    case 'run-succeeded':
      if (action.requestId !== state.requestId) {
        return state;
      }
      return { status: 'succeeded', requestId: action.requestId, result: action.result };
    case 'run-failed':
      if (action.requestId !== state.requestId) {
        return state;
      }
      return { status: 'failed', requestId: action.requestId, message: action.message };
    case 'reset':
      return { status: 'idle', requestId: action.requestId };
  }
}

/**
 * @param sessionKey 当前会话的账号标识：切账号时变化 ⇒ 在途响应作废（不写进新账号的界面）。
 */
export function useRecordPackageExport(sessionKey?: number | null) {
  const [state, dispatch] = useReducer(recordPackageExportReducer, {
    status: 'idle',
    requestId: 0,
  } as RecordPackageExportState);
  const requestIdRef = useRef(0);
  const lastSessionKeyRef = useRef(sessionKey);

  // 切账号：作废在途响应并回到空闲（旧账号的结果不得出现在新账号的界面）
  useEffect(() => {
    if (lastSessionKeyRef.current === sessionKey) {
      return;
    }
    lastSessionKeyRef.current = sessionKey;
    requestIdRef.current += 1;
    dispatch({ type: 'reset', requestId: requestIdRef.current });
  }, [sessionKey]);

  const run = useCallback(
    async (input: {
      targetPath: string;
      /** 可省略：省略时由服务端按可信 session 范围取本公司（来源页导出入口） */
      organizationId?: number;
      resourceType: RecordPackageResourceType;
      /** 记录 ID（多值输入控件给出字符串，由 adapter 归一化为正整数） */
      recordIds: Array<number | string>;
      /**
       * 混合导出条目（逐条自带资源类型）。
       *
       * 提供时服务端以它为准；缺省沿用旧的单一类型形态（旧客户端不受影响）。
       */
      entries?: RecordPackageExportEntry[];
    }) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      dispatch({ type: 'run-start', requestId });
      try {
        const result = await exportRecordPackage(input);
        dispatch({ type: 'run-succeeded', requestId, result });
        return { ok: true as const, result };
      } catch (error) {
        const message = isGraphQLIngressError(error)
          ? error.userMessage
          : '记录包导出失败，请稍后重试。';
        dispatch({ type: 'run-failed', requestId, message });
        return { ok: false as const, message };
      }
    },
    [],
  );

  // 重置同时使在途响应作废（序号递增）：关闭对话框后旧结果不会复活
  const reset = useCallback(() => {
    requestIdRef.current += 1;
    dispatch({ type: 'reset', requestId: requestIdRef.current });
  }, []);

  return { state, run, reset };
}
