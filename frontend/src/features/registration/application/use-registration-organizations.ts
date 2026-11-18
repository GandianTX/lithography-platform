// src/features/registration/application/use-registration-organizations.ts

/**
 * 注册公司候选加载状态机（客户 / 工程师两个注册页共用）。
 *
 * - 挂载即加载第 1 页；`search` 切换关键字并重置分页；`loadMore` 追加下一页；
 * - 乱序保护：每次请求推进序号，响应回来时序号已变即整体丢弃（搜索切换、连续
 *   输入、分页与搜索交叉时，旧响应不会覆盖新结果）；
 * - 失败重试：首屏失败进入 failed（可 retry）；追加失败保留已加载列表，仅标记
 *   `loadMoreFailed`，由 `loadMore` 再次重试；
 * - 不做客户端资格过滤：候选范围完全以服务端返回为准。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import { fetchRegistrationOrganizations } from '../infrastructure/registration-organization-adapter';

import type { RegistrationOrganizationOption } from './registration.types';

/** 默认单页数量（与服务端公开查询上限 50 之内） */
export const REGISTRATION_ORGANIZATION_PAGE_SIZE = 20;

export type RegistrationOrganizationsState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      items: RegistrationOrganizationOption[];
      total: number;
      page: number;
      pageSize: number;
      hasMore: boolean;
      loadingMore: boolean;
      loadMoreFailed: boolean;
    };

export type UseRegistrationOrganizationsOptions = {
  pageSize?: number;
};

export function useRegistrationOrganizations(options: UseRegistrationOrganizationsOptions = {}) {
  const pageSize = options.pageSize ?? REGISTRATION_ORGANIZATION_PAGE_SIZE;
  const [state, setState] = useState<RegistrationOrganizationsState>({ status: 'loading' });

  // 请求序号：只允许最后一次发起的请求写状态
  const requestSeqRef = useRef(0);
  // 已加载事实（供 loadMore 同步读取，不依赖渲染后的 state）
  const keywordRef = useRef('');
  const itemsRef = useRef<RegistrationOrganizationOption[]>([]);
  const pageRef = useRef(1);
  const totalRef = useRef(0);
  const loadingMoreRef = useRef(false);

  // 请求与状态回写：首个 setState 一定在 await 之后（供挂载 effect 直接调用，
  // 避免 effect 内同步 setState 触发级联渲染）
  const fetchPage = useCallback(
    async (seq: number, keyword: string, page: number, mode: 'replace' | 'append') => {
      try {
        const result = await fetchRegistrationOrganizations({
          keyword: keyword || undefined,
          page,
          pageSize,
        });

        if (seq !== requestSeqRef.current) {
          return;
        }

        const items =
          mode === 'append' ? mergeUnique(itemsRef.current, result.items) : result.items;

        itemsRef.current = items;
        pageRef.current = result.page;
        totalRef.current = result.total;
        loadingMoreRef.current = false;

        setState({
          status: 'ready',
          items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: items.length < result.total,
          loadingMore: false,
          loadMoreFailed: false,
        });
      } catch (error) {
        if (seq !== requestSeqRef.current) {
          return;
        }

        if (!isGraphQLIngressError(error)) {
          console.error('注册公司候选加载出现未分类错误：', error);
        }

        loadingMoreRef.current = false;
        setState((previous) =>
          mode === 'append' && previous.status === 'ready'
            ? { ...previous, loadingMore: false, loadMoreFailed: true }
            : { status: 'failed', message: translateNow('register.orgLoadFailed') },
        );
      }
    },
    [pageSize],
  );

  // 交互触发的加载：先同步推进序号与加载态，再交给 fetchPage 请求
  const loadPage = useCallback(
    async (keyword: string, page: number, mode: 'replace' | 'append') => {
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      keywordRef.current = keyword;

      if (mode === 'replace') {
        setState({ status: 'loading' });
      } else {
        loadingMoreRef.current = true;
        setState((previous) =>
          previous.status === 'ready'
            ? { ...previous, loadingMore: true, loadMoreFailed: false }
            : previous,
        );
      }

      await fetchPage(seq, keyword, page, mode);
    },
    [fetchPage],
  );

  // 挂载（及 pageSize 变化）时加载第 1 页：初始状态已是 loading，
  // 这里只发请求，不在 effect 内同步 setState
  useEffect(() => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    keywordRef.current = '';
    void fetchPage(seq, '', 1, 'replace');
  }, [fetchPage]);

  /** 切换名称关键字：去首尾空白并回到第 1 页 */
  const search = useCallback(
    (keyword: string) => {
      const trimmed = keyword.trim();
      itemsRef.current = [];
      pageRef.current = 1;
      totalRef.current = 0;
      void loadPage(trimmed, 1, 'replace');
    },
    [loadPage],
  );

  /** 追加下一页；已无更多或正在加载时忽略 */
  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) {
      return;
    }
    if (itemsRef.current.length >= totalRef.current) {
      return;
    }
    void loadPage(keywordRef.current, pageRef.current + 1, 'append');
  }, [loadPage]);

  /** 首屏 / 搜索失败后重试当前关键字第 1 页 */
  const retry = useCallback(() => {
    void loadPage(keywordRef.current, 1, 'replace');
  }, [loadPage]);

  return { loadMore, retry, search, state };
}

/** 追加去重：服务端排序稳定，但仍按主键去重避免边界重复项 */
function mergeUnique(
  current: RegistrationOrganizationOption[],
  incoming: RegistrationOrganizationOption[],
): RegistrationOrganizationOption[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}
