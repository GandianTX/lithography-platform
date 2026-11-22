// src/features/my-records/application/use-my-records-stats.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { fetchMyRecords } from '../infrastructure/my-records-adapter';

export type MyRecordsStats = {
  status: 'loading' | 'ready' | 'failed';
  /** 未完成记录全量总数（服务端按同一归属谓词统计，非当页数量）；失败为 null */
  draftTotal: number | null;
  /** 已提交记录全量总数（同上）；失败为 null */
  formalTotal: number | null;
  reload: () => void;
};

type MyRecordsStatsState =
  | { status: 'loading'; requestSeq: number; draftTotal: null; formalTotal: null }
  | { status: 'ready'; requestSeq: number; draftTotal: number; formalTotal: number }
  | { status: 'failed'; requestSeq: number; draftTotal: number | null; formalTotal: number | null };

type MyRecordsStatsAction =
  | { type: 'load-start'; requestSeq: number }
  | {
      type: 'load-ready';
      requestSeq: number;
      draftTotal: number | null;
      formalTotal: number | null;
    };

function myRecordsStatsReducer(
  state: MyRecordsStatsState,
  action: MyRecordsStatsAction,
): MyRecordsStatsState {
  switch (action.type) {
    case 'load-start':
      return {
        status: 'loading',
        requestSeq: action.requestSeq,
        draftTotal: null,
        formalTotal: null,
      };
    case 'load-ready': {
      if (action.requestSeq !== state.requestSeq) {
        return state; // 过期请求结果不覆盖新结果
      }

      // 显式分支构造：任一统计失败降级为 failed（null 透传给页面显示「—」）
      if (action.draftTotal === null || action.formalTotal === null) {
        return {
          status: 'failed',
          requestSeq: state.requestSeq,
          draftTotal: action.draftTotal,
          formalTotal: action.formalTotal,
        };
      }
      return {
        status: 'ready',
        requestSeq: state.requestSeq,
        draftTotal: action.draftTotal,
        formalTotal: action.formalTotal,
      };
    }
  }
}

/**
 * 顶部汇总统计（任务 07，Demo V44 V24MyRecords 的统计区对齐）。
 *
 * 数据口径（2026-11-22 页面统计事实化要求）：
 * - 草稿/已入库：分别用 recordKind=DRAFT / FORMAL 的服务端列表请求取 total——
 *   total 由后端同一归属谓词全量计算，不是当前页数量冒充的总数；
 * - 待同步/版本冲突：任务 09 未接入，无真实统计接口，不提供任何数字
 *   （页面显示「—」并标注未接入，不使用 Demo 演示假数据）；
 * - 请求失败降级为 null（显示「—」），不影响列表主查询，也不伪造 0；
 * - 请求序号原子更新：旧请求结果不覆盖新结果。
 */
export function useMyRecordsStats(): MyRecordsStats {
  const [state, dispatch] = useReducer(myRecordsStatsReducer, {
    status: 'loading',
    requestSeq: 0,
    draftTotal: null,
    formalTotal: null,
  } as MyRecordsStatsState);
  const requestSeqRef = useRef(0);

  const load = useCallback(async () => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;

    dispatch({ type: 'load-start', requestSeq });

    const fetchTotal = async (recordKind: 'DRAFT' | 'FORMAL'): Promise<number | null> => {
      try {
        const result = await fetchMyRecords({ page: 1, pageSize: 1, filter: { recordKind } });
        return result.total;
      } catch {
        // 单项统计失败只降级该项为「—」，不抛出影响列表
        return null;
      }
    };

    const [draft, formal] = await Promise.all([fetchTotal('DRAFT'), fetchTotal('FORMAL')]);

    dispatch({ type: 'load-ready', requestSeq, draftTotal: draft, formalTotal: formal });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    status: state.status,
    draftTotal: state.draftTotal,
    formalTotal: state.formalTotal,
    reload: () => void load(),
  };
}
