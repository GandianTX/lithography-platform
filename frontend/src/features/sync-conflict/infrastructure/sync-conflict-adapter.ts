// src/features/sync-conflict/infrastructure/sync-conflict-adapter.ts

import { executeGraphQL } from '@/shared/graphql';

import type {
  SyncConflictAction,
  SyncConflictDetail,
  SyncConflictListPage,
  SyncConflictSummary,
} from './sync-conflict.types';

/**
 * 同步冲突真实 GraphQL 数据访问层。
 *
 * 权限口径（服务端唯一真源）：可读范围、是否可裁决、只读内容是否可恢复，全部由服务端裁决；
 * 前端只按服务端给出的事实渲染按钮可用性与说明，不自行判断权限。
 *
 * 错误口径：transport/auth/network 失败按共享错误模型上抛 GraphQLIngressError；
 * 不存在与越权同码返回，前端统一按"取不到"展示，不区分原因。
 */

const SYNC_CONFLICT_LIST_QUERY = `
  query SyncConflicts($statusOnlyPending: Boolean, $page: Int!, $pageSize: Int!) {
    syncConflicts(statusOnlyPending: $statusOnlyPending, page: $page, pageSize: $pageSize) {
      items {
        conflictId
        recordUuid
        resourceType
        versionNo
        localVersion
        cloudVersion
        displayedCloudVersion
        decision
        status
        conflictReason
        createdAt
      }
      total
      page
      pageSize
      truncated
    }
  }
`;

const SYNC_CONFLICT_DETAIL_QUERY = `
  query SyncConflict($conflictId: String!) {
    syncConflict(conflictId: $conflictId) {
      conflictId
      recordUuid
      organizationId
      resourceType
      versionNo
      localVersion
      cloudVersion
      displayedCloudVersion
      decision
      status
      localSnapshot
      cloudSnapshot
      conflictReason
      diff {
        entries {
          path
          kind
          localValue
          cloudValue
        }
        truncated
        invalid
      }
      sourceRecordId
      sourceReadOnly
      sourceReadOnlyReason
      confirmedByAccountId
      confirmedAt
      createdAt
    }
  }
`;

const RESOLVE_SYNC_CONFLICT_MUTATION = `
  mutation ResolveSyncConflict($conflictId: String!, $action: SyncConflictAction!) {
    resolveSyncConflict(conflictId: $conflictId, action: $action) {
      outcome
      conflict {
        conflictId
        recordUuid
        resourceType
        versionNo
        localVersion
        cloudVersion
        displayedCloudVersion
        decision
        status
        conflictReason
        createdAt
      }
    }
  }
`;

type SyncConflictListVariables = {
  statusOnlyPending: boolean;
  page: number;
  pageSize: number;
};

type SyncConflictListQueryResult = {
  syncConflicts: {
    items: SyncConflictSummary[];
    total: number | null;
    page: number;
    pageSize: number;
    truncated: boolean | null;
  };
};

type SyncConflictDetailQueryResult = {
  syncConflict: SyncConflictDetail;
};

type ResolveSyncConflictMutationResult = {
  resolveSyncConflict: {
    outcome: 'resolved' | 'existing' | 'later';
    conflict: SyncConflictSummary;
  };
};

/** 读取冲突清单 */
export async function fetchSyncConflicts(input: {
  statusOnlyPending: boolean;
  page: number;
  pageSize: number;
}): Promise<SyncConflictListPage> {
  const data = await executeGraphQL<SyncConflictListQueryResult, SyncConflictListVariables>(
    SYNC_CONFLICT_LIST_QUERY,
    {
      statusOnlyPending: input.statusOnlyPending,
      page: input.page,
      pageSize: input.pageSize,
    },
  );

  return {
    items: data.syncConflicts.items,
    total: data.syncConflicts.total,
    page: data.syncConflicts.page,
    pageSize: data.syncConflicts.pageSize,
    truncated: data.syncConflicts.truncated,
  };
}

/** 读取冲突详情（含正文快照与字段级差异） */
export async function fetchSyncConflictDetail(conflictId: string): Promise<SyncConflictDetail> {
  const data = await executeGraphQL<SyncConflictDetailQueryResult, { conflictId: string }>(
    SYNC_CONFLICT_DETAIL_QUERY,
    {
      conflictId,
    },
  );

  return data.syncConflict;
}

/** 裁决冲突：使用云端（CLOUD）／保留本地（LOCAL）／稍后处理（LATER） */
export async function resolveSyncConflict(
  conflictId: string,
  action: SyncConflictAction,
): Promise<{ outcome: 'resolved' | 'existing' | 'later'; conflict: SyncConflictSummary }> {
  const data = await executeGraphQL<
    ResolveSyncConflictMutationResult,
    { conflictId: string; action: SyncConflictAction }
  >(RESOLVE_SYNC_CONFLICT_MUTATION, { conflictId, action });

  return data.resolveSyncConflict;
}
