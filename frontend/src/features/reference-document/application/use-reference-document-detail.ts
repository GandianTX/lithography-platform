// src/features/reference-document/application/use-reference-document-detail.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { ReferenceDocumentDetail } from '../infrastructure/reference-document.types';
import {
  fetchPendingOwnershipReferenceDocument,
  fetchReferenceDocument,
} from '../infrastructure/reference-document-adapter';

/**
 * 历史维修记录详情流程（query 状态机，收束在 feature application）。
 *
 * - 不存在 / 已软删由 adapter 归并 not-found（统一口径，不区分原因）；
 * - transport / auth / network 失败进入 failed 态（含重试），不混入 not-found；
 * - id 变化时重载；auth 错误由共享 GraphQL + auth-session 全局链路负责；
 * - id 为 null（路由参数非法）时不发请求，直接进入统一 not-found 口径；
 *   进入 null 分支前同样递增请求序号，使在途旧请求（有效 ID 发出的）的任何
 *   后续返回都被 reducer 丢弃——「有效 A → 无效路由」与「A → B」是同级竞态。
 * - 请求序号随状态原子更新（与列表同级竞态保护）：快速切换后，
 *   旧请求的成功、not-found、失败结果都不会覆盖当前 ID 的状态，
 *   杜绝「界面显示 A、保存/删除却发送 B」的目标错位。
 */

export type ReferenceDocumentDetailState =
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; requestSeq: number; detail: ReferenceDocumentDetail }
  | { status: 'not-found'; requestSeq: number; message: string }
  | { status: 'failed'; requestSeq: number; message: string };

type ReferenceDocumentDetailAction =
  | { type: 'load-start'; requestSeq: number }
  | { type: 'load-ready'; requestSeq: number; detail: ReferenceDocumentDetail }
  | { type: 'load-not-found'; requestSeq: number; message: string }
  | { type: 'load-failed'; requestSeq: number; message: string }
  // 路由参数非法（id=null）：切换到新序号并原子进入 not-found；
  // 递增序号使在途旧请求（有效 ID 发出的）的成功/未找到/失败结果全部过期被丢弃
  | { type: 'load-invalid-id'; requestSeq: number };

function toDetailUserMessage(error: unknown): string {
  return isGraphQLIngressError(error)
    ? error.userMessage
    : '历史维修记录详情加载失败，请稍后重试。';
}

/** 非法路由参数的统一文案：与后端统一 NOT_FOUND 口径一致，不区分原因 */
const INVALID_ID_NOT_FOUND_MESSAGE = '历史维修记录不存在或不可查看。';

function referenceDocumentDetailReducer(
  state: ReferenceDocumentDetailState,
  action: ReferenceDocumentDetailAction,
): ReferenceDocumentDetailState {
  switch (action.type) {
    case 'load-start':
      // 开始新请求：原子切换到 loading 并记录序号，旧结果不再可能被应用
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'load-ready':
      // 竞态防护：过期请求的结果直接丢弃
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'ready', requestSeq: action.requestSeq, detail: action.detail };
    case 'load-not-found':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'not-found', requestSeq: action.requestSeq, message: action.message };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'failed', requestSeq: action.requestSeq, message: action.message };
    case 'load-invalid-id':
      return {
        status: 'not-found',
        requestSeq: action.requestSeq,
        message: INVALID_ID_NOT_FOUND_MESSAGE,
      };
  }
}

/**
 * 详情读取流程入口。
 *
 * - `variant = 'library'`（默认）：普通资料库详情（ONLINE + CONFIRMED 可见范围）；
 * - `variant = 'pending-ownership'`：归属待核实详情（任务 07 R061-01，一级管理员专用
 *   管理入口查询），走服务端专用查询；两者共用同一状态机与竞态保护。
 */
export function useReferenceDocumentDetail(
  id: number | null,
  variant: 'library' | 'pending-ownership' = 'library',
) {
  const [state, dispatch] = useReducer(referenceDocumentDetailReducer, {
    status: 'loading',
    requestSeq: 0,
  } as ReferenceDocumentDetailState);
  // 请求序号唯一真源（ref）：旧请求在途时切换目标，新请求序号仍能正确递增，
  // 旧结果回到 reducer 后因序号不匹配被丢弃；与列表 requestIdRef 同一模式
  const requestSeqRef = useRef(0);

  const loadDetail = useCallback(
    async (targetId: number, requestSeq: number) => {
      dispatch({ type: 'load-start', requestSeq });

      try {
        const result =
          variant === 'pending-ownership'
            ? await fetchPendingOwnershipReferenceDocument(targetId)
            : await fetchReferenceDocument(targetId);

        if (result.ok) {
          dispatch({ type: 'load-ready', requestSeq, detail: result.detail });
        } else {
          dispatch({ type: 'load-not-found', requestSeq, message: result.message });
        }
      } catch (error) {
        dispatch({ type: 'load-failed', requestSeq, message: toDetailUserMessage(error) });
      }
    },
    [variant],
  );

  useEffect(() => {
    if (id === null) {
      // 竞态防护：null 分支同样先递增序号再切换状态，
      // 使有效 ID 发出的在途请求后续返回时因序号不匹配被丢弃
      requestSeqRef.current += 1;
      dispatch({ type: 'load-invalid-id', requestSeq: requestSeqRef.current });

      return;
    }

    // 竞态防护：序号在发起前递增，旧请求返回时序号已不匹配，reducer 直接丢弃
    requestSeqRef.current += 1;

    void loadDetail(id, requestSeqRef.current);
  }, [id, loadDetail]);

  const reload = useCallback(() => {
    if (id === null) {
      return;
    }

    requestSeqRef.current += 1;

    void loadDetail(id, requestSeqRef.current);
  }, [id, loadDetail]);

  return { state, reload };
}
