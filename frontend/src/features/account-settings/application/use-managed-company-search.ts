// src/features/account-settings/application/use-managed-company-search.ts

/**
 * 名单内受管公司候选检索（补录卡片的「从名单选择」侧）。
 *
 * - 只在用户选择「从名单选择」时启用（`enabled`）：关闭时清空状态并作废在途响应，
 *   不做预加载，也不保留上一次的关键字；
 * - 关键字变化即检索（服务端分页，固定第一页），以**请求序号**防乱序：只有最新一次
 *   请求的响应可以写状态，连打关键字产生的迟到响应一律丢弃；
 * - transport / auth 失败收敛为 failed 状态与兜底文案并支持重试；未分类错误保留在
 *   控制台以便排障（与 useAccountSettings 同一口径）；
 * - 候选资格由服务端决定（ACTIVE 且受管），本层不做二次过滤。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { type MessageKey, translateNow } from '@/shared/i18n';

import { searchManagedCompanies } from '../infrastructure/account-settings-adapter';

import type { ManagedCompanyOption } from './account-settings.types';

/** 与注册入口候选检索同口径的小页；本卡片只需要第一页候选 */
export const MANAGED_COMPANY_PAGE_SIZE = 20;

export type ManagedCompanySearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { message: string; status: 'failed' }
  | { options: ManagedCompanyOption[]; status: 'ready'; total: number };

function toUserMessage(error: unknown, fallbackKey: MessageKey): string {
  return isGraphQLIngressError(error) ? error.userMessage : translateNow(fallbackKey);
}

export function useManagedCompanySearch(enabled: boolean) {
  const [keyword, setKeywordState] = useState('');
  const [state, setState] = useState<ManagedCompanySearchState>({ status: 'idle' });
  const seqRef = useRef(0);

  /** 纯拉取：序号已推进即视为过期，不再写状态 */
  const load = useCallback((nextKeyword: string) => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setState({ status: 'loading' });

    void searchManagedCompanies({
      keyword: nextKeyword,
      page: 1,
      pageSize: MANAGED_COMPANY_PAGE_SIZE,
    })
      .then((page) => {
        if (seqRef.current === seq) {
          setState({ options: page.items, status: 'ready', total: page.total });
        }
      })
      .catch((error: unknown) => {
        if (!isGraphQLIngressError(error)) {
          console.error('公司候选检索出现未分类错误：', error);
        }

        if (seqRef.current === seq) {
          setState({
            message: toUserMessage(error, 'account.companySearchFailed'),
            status: 'failed',
          });
        }
      });
  }, []);

  const setKeyword = useCallback(
    (nextKeyword: string) => {
      setKeywordState(nextKeyword);
      load(nextKeyword);
    },
    [load],
  );

  /** 关闭分支：作废在途响应并清空检索态（抽成回调，避免在 effect 体内同步 setState） */
  const resetSearch = useCallback(() => {
    seqRef.current += 1;
    setKeywordState('');
    setState({ status: 'idle' });
  }, []);

  /** 启用分支：以空关键字检索第一页（关键字在关闭时已清空） */
  const startSearch = useCallback(() => load(''), [load]);

  useEffect(() => {
    if (!enabled) {
      // 切回手填：先在 effect 内同步作废在途响应（只写 ref），再于微任务中清空检索态，
      // 避免 effect 同步链路 setState（react-hooks/set-state-in-effect）
      seqRef.current += 1;
      queueMicrotask(() => resetSearch());

      return;
    }

    // 启用：微任务中发起首轮检索，effect 同步链路不 setState
    queueMicrotask(() => startSearch());
  }, [enabled, resetSearch, startSearch]);

  const retry = useCallback(() => load(keyword), [keyword, load]);

  return { keyword, retry, setKeyword, state };
}
