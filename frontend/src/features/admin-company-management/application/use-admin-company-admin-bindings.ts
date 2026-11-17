// src/features/admin-company-management/application/use-admin-company-admin-bindings.ts

/**
 * 公司档案列表的「二级管理员账号」绑定状态读取。
 *
 * 只读：按当前页的公司主键逐行调用 `adminCompanyAdminBinding`，不写库、不带凭据。
 * - 同一页内主键去重，最多 4 个并发，避免整页一次性打满后端；
 * - 请求代次随参数变化推进，过期响应直接丢弃，不覆盖新页结果；
 * - 单行失败只降级该行（可重试），不阻塞整张表格。
 *
 * 绑定状态是列表展示事实，不参与授权：补发资格与写操作仍由服务端在锁内裁决。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchAdminCompanyAdminBinding } from '../infrastructure/admin-company-adapter';

import type { AdminCompanyAdminBinding } from './admin-company-management.types';

export type AdminCompanyBindingEntry =
  | { status: 'loading' }
  | { status: 'ready'; binding: AdminCompanyAdminBinding }
  | { status: 'failed'; message: string };

type AdminCompanyBindingSnapshot = {
  entries: Readonly<Record<number, AdminCompanyBindingEntry>>;
  /** 这份结果对应的取数轮次（主键集合 + 列表回读序号 + 手动重试） */
  key: string;
};

const MAX_CONCURRENT_BINDING_REQUESTS = 4;
const FALLBACK_MESSAGE = '绑定状态加载失败，可重试。';
const EMPTY_ENTRIES: Readonly<Record<number, AdminCompanyBindingEntry>> = {};
const EMPTY_SNAPSHOT: AdminCompanyBindingSnapshot = { entries: EMPTY_ENTRIES, key: '' };
const LOADING_ENTRY: AdminCompanyBindingEntry = { status: 'loading' };

export function useAdminCompanyAdminBindings(params: {
  enabled: boolean;
  organizationIds: readonly number[];
  /** 列表重新加载的序号：变化即统一回读当前页绑定 */
  revision: number;
}) {
  const { enabled, organizationIds, revision } = params;
  const [snapshot, setSnapshot] = useState<AdminCompanyBindingSnapshot>(EMPTY_SNAPSHOT);
  const [retryTick, setRetryTick] = useState(0);
  const generationRef = useRef(0);

  const idsKey = useMemo(() => organizationIds.join(','), [organizationIds]);
  // 本轮取数的标识：主键集合 / 列表回读 / 手动重试任一变化都算新的一轮。
  // 渲染期直接从快照推导：不属于当前轮次的公司一律视为「读取中」，
  // 不需要在 effect 里同步 setState 清空旧结果，也不会读到上一页的绑定。
  const requestKey = enabled && idsKey !== '' ? `${idsKey}#${revision}#${retryTick}` : '';
  const entries = snapshot.key === requestKey ? snapshot.entries : undefined;

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;

    if (!enabled || idsKey === '') {
      return;
    }

    // 同一页内按 organizationId 去重：重复主键只发一次请求，也避免后到的同键结果覆盖先到的
    const uniqueIds = Array.from(
      new Set(
        idsKey
          .split(',')
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    );
    const effectKey = `${idsKey}#${revision}#${retryTick}`;

    let cursor = 0;

    async function worker(): Promise<void> {
      while (cursor < uniqueIds.length) {
        const index = cursor;
        cursor += 1;
        const organizationId = uniqueIds[index];

        let entry: AdminCompanyBindingEntry;

        try {
          const result = await fetchAdminCompanyAdminBinding(organizationId);

          entry = result.ok
            ? { status: 'ready', binding: result.binding }
            : { status: 'failed', message: result.message };
        } catch (error) {
          if (!isGraphQLIngressError(error)) {
            console.error('绑定状态查询出现未分类错误：', error);
          }

          entry = {
            status: 'failed',
            message: isGraphQLIngressError(error) ? error.userMessage : FALLBACK_MESSAGE,
          };
        }

        if (generation !== generationRef.current) {
          return;
        }

        setSnapshot((previous) => ({
          entries: {
            ...(previous.key === effectKey ? previous.entries : EMPTY_ENTRIES),
            [organizationId]: entry,
          },
          key: effectKey,
        }));
      }
    }

    void Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_BINDING_REQUESTS, uniqueIds.length) }, () =>
        worker(),
      ),
    );

    return () => {
      generationRef.current += 1;
    };
  }, [enabled, idsKey, retryTick, revision]);

  const bindingOf = useCallback(
    (organizationId: number): AdminCompanyBindingEntry | undefined => {
      const known = entries?.[organizationId];

      if (known !== undefined) {
        return known;
      }

      // 本轮结果尚未回来：已启用且有目标公司时按「读取中」展示
      return requestKey === '' ? undefined : LOADING_ENTRY;
    },
    [entries, requestKey],
  );

  const retry = useCallback(() => {
    setRetryTick((previous) => previous + 1);
  }, []);

  return { bindingOf, retry };
}
