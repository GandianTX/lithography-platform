// src/features/repair-request/application/use-engineer-work-order-options.ts

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type { EngineerRepairRequestListItem } from '../infrastructure/engineer-repair-request.types';
import { fetchEngineerRepairRequests } from '../infrastructure/engineer-repair-request-adapter';

/**
 * 「本人已接工单」选择器候选（任务 05 S1 的 AI 诊断关联工单）。
 *
 * - 只读：实时取 `scope: 'MINE'`（当前工程师本人已接单），不做接单等写操作；
 * - 候选只是操作便利，真正的归属校验仍由后端在创建会话时执行；
 * - 分页追加（选项型加载更多）、空态、失败重试齐全；
 * - 请求序号随状态推进，切换账号后旧页响应不得混入新列表。
 */

const OPTION_PAGE_SIZE = 50;

/** 选择器候选项：只暴露业务编号与机型，不泄露客户信息 */
export type EngineerWorkOrderOption = {
  readonly id: number;
  readonly label: string;
  readonly modelName: string;
  readonly requestNo: string;
};

type OptionsState = {
  options: EngineerWorkOrderOption[];
  status: 'loading' | 'ready' | 'failed';
  message: string | null;
  hasMore: boolean;
};

const INITIAL: OptionsState = { options: [], status: 'loading', message: null, hasMore: false };

function toOption(item: EngineerRepairRequestListItem): EngineerWorkOrderOption {
  const modelName = item.equipmentModel?.modelName ?? '';
  return {
    id: item.id,
    label: modelName.length > 0 ? `${item.requestNo} · ${modelName}` : item.requestNo,
    modelName,
    requestNo: item.requestNo,
  };
}

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : translateNow('repairList.loadFailed');
}

export function useEngineerWorkOrderOptions() {
  const [state, setState] = useState<OptionsState>(INITIAL);
  const sequence = useRef(0);
  const page = useRef(0);

  const load = useCallback(async (targetPage: number) => {
    sequence.current += 1;
    const requestId = sequence.current;
    setState((current) => ({
      ...current,
      status: targetPage === 1 ? 'loading' : current.status,
      message: null,
    }));
    try {
      const result = await fetchEngineerRepairRequests({
        scope: 'MINE',
        filter: { equipmentModelId: null, customerNickname: null },
        page: targetPage,
        pageSize: OPTION_PAGE_SIZE,
      });
      if (requestId !== sequence.current) {
        return;
      }
      page.current = targetPage;
      setState((current) => {
        const merged =
          targetPage === 1
            ? result.items.map(toOption)
            : [...current.options, ...result.items.map(toOption)];
        // 分页期间工单可能新增/结单，按 ID 去重并保持首次出现顺序
        const seen = new Set<number>();
        const options = merged.filter((option) => {
          if (seen.has(option.id)) {
            return false;
          }
          seen.add(option.id);
          return true;
        });
        return {
          options,
          status: 'ready',
          message: null,
          hasMore: options.length < result.total,
        };
      });
    } catch (error) {
      if (requestId !== sequence.current) {
        return;
      }
      setState((current) => ({
        ...current,
        status: 'failed',
        message: toUserMessage(error),
      }));
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  const loadMore = useCallback(() => {
    if (state.status === 'loading' || !state.hasMore) {
      return;
    }
    void load(page.current + 1);
  }, [load, state.hasMore, state.status]);

  const reload = useCallback(() => {
    void load(1);
  }, [load]);

  return {
    options: state.options,
    status: state.status,
    message: state.message,
    hasMore: state.hasMore,
    loadMore,
    reload,
  };
}
