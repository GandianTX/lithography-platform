// src/features/my-records/application/use-my-records-list.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { MyRecordListFilter, MyRecordSummary } from '../infrastructure/my-records.types';
import { fetchMyRecords } from '../infrastructure/my-records-adapter';

type MyRecordsListState =
  | { status: 'loading'; requestSeq: number; page: number; pageSize: number }
  | {
      status: 'ready';
      requestSeq: number;
      items: MyRecordSummary[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { status: 'failed'; requestSeq: number; page: number; pageSize: number; message: string };

type MyRecordsListAction =
  | { type: 'load-start'; requestSeq: number; page: number; pageSize: number }
  | {
      type: 'load-ready';
      requestSeq: number;
      items: MyRecordSummary[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { type: 'load-failed'; requestSeq: number; page: number; pageSize: number; message: string };

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '资料记录加载失败，请稍后重试。';
}

function myRecordsListReducer(
  state: MyRecordsListState,
  action: MyRecordsListAction,
): MyRecordsListState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', ...action };
    case 'load-ready':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return {
        status: 'ready',
        requestSeq: action.requestSeq,
        items: action.items,
        total: action.total,
        page: action.page,
        pageSize: action.pageSize,
      };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'failed', ...action };
  }
}

/** filter 等价键：避免父组件内联对象引用变化触发多余重载 */
function filterKey(filter: MyRecordListFilter | undefined): string {
  return `${filter?.sourceType ?? ''}|${filter?.recordKind ?? ''}|${filter?.titleKeyword ?? ''}`;
}

/**
 * 本人记录列表流程（query 状态机，收束在 feature application）。
 *
 * - 筛选变化回到第 1 页；分页与重试沿用当前筛选；
 * - 请求序号原子更新：旧请求结果不覆盖新结果；
 * - 服务端按同一归属谓词计算 total，前端不二次推断。
 */
export function useMyRecordsList(filter: MyRecordListFilter | undefined, pageSize = 10) {
  const [state, dispatch] = useReducer(myRecordsListReducer, {
    status: 'loading',
    requestSeq: 0,
    page: 1,
    pageSize,
  } as MyRecordsListState);
  const requestSeqRef = useRef(0);
  const cursorRef = useRef({ filter, page: 1, pageSize });

  const loadList = useCallback(
    async (targetFilter: MyRecordListFilter | undefined, page: number) => {
      requestSeqRef.current += 1;
      const requestSeq = requestSeqRef.current;
      cursorRef.current = { filter: targetFilter, page, pageSize };

      dispatch({ type: 'load-start', requestSeq, page, pageSize });

      try {
        const result = await fetchMyRecords({ page, pageSize, filter: targetFilter });
        dispatch({
          type: 'load-ready',
          requestSeq,
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        });
      } catch (error) {
        dispatch({
          type: 'load-failed',
          requestSeq,
          page,
          pageSize,
          message: toUserMessage(error),
        });
      }
    },
    [pageSize],
  );

  const appliedFilterKeyRef = useRef(filterKey(filter));
  useEffect(() => {
    const nextKey = filterKey(filter);

    if (appliedFilterKeyRef.current !== nextKey) {
      appliedFilterKeyRef.current = nextKey;
      void loadList(filter, 1);

      return;
    }

    if (state.status === 'loading' && state.requestSeq === 0) {
      void loadList(filter, 1);
    }
  }, [filter, loadList, state.status, state.requestSeq]);

  const goToPage = useCallback(
    (page: number) => {
      void loadList(cursorRef.current.filter, page);
    },
    [loadList],
  );

  const reload = useCallback(() => {
    const cursor = cursorRef.current;

    void loadList(cursor.filter, cursor.page);
  }, [loadList]);

  return { state, goToPage, reload };
}
