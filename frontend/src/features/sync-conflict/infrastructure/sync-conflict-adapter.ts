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
 *
 * 形状校验（任务 09 第 11 项补齐）：响应**形状**不符时**失败关闭**——抛受控错误，
 * 让页面落"可重试失败态"，而不是把缺字段／错类型的值直接交给渲染层。
 * 缺这一层时，字段形状一变（如快照正文不是字符串）就会变成**渲染期 TypeError**，
 * 整页被路由错误边界替换，用户看不到任何冲突事实。
 */

/** 读取响应中必须是字符串的字段 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`同步冲突响应字段 ${field} 缺失或类型不正确`);
  }
  return value;
}

/** 读取响应中必须是数字的字段 */
function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`同步冲突响应字段 ${field} 缺失或类型不正确`);
  }
  return value;
}

/** 读取响应中必须是布尔值的字段 */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`同步冲突响应字段 ${field} 缺失或类型不正确`);
  }
  return value;
}

/** 读取响应中必须是数组的字段 */
function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`同步冲突响应字段 ${field} 缺失或类型不正确`);
  }
  return value;
}

/** 冲突摘要项的形状校验（清单与裁决结果共用） */
function assertSyncConflictSummary(item: unknown, index: number): SyncConflictSummary {
  if (typeof item !== 'object' || item === null) {
    throw new Error(`同步冲突清单第 ${index + 1} 项形状不正确`);
  }
  const raw = item as Record<string, unknown>;
  return {
    ...(raw as unknown as SyncConflictSummary),
    conflictId: requireString(raw['conflictId'], `items[${index}].conflictId`),
    recordUuid: requireString(raw['recordUuid'], `items[${index}].recordUuid`),
    resourceType: requireString(raw['resourceType'], `items[${index}].resourceType`),
    status: requireString(raw['status'], `items[${index}].status`),
  };
}

/** 冲突详情的形状校验（含正文快照与字段级差异） */
function assertSyncConflictDetail(raw: unknown): SyncConflictDetail {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('同步冲突详情响应缺少冲突主体');
  }
  const detail = raw as Record<string, unknown>;
  const diff = detail['diff'];

  // diff 在 GraphQL 契约里**可空**（服务端未给出差异时为 null）：
  //   - 显式 null ⇒ 合法，按"无差异"处理；
  //   - 字段缺失（undefined）⇒ 非法响应，失败关闭。
  if (diff === undefined) {
    throw new Error('同步冲突响应字段 diff 缺失');
  }
  let diffChecked: SyncConflictDetail['diff'] = null;
  if (diff !== null) {
    if (typeof diff !== 'object') {
      throw new Error('同步冲突响应字段 diff 类型不正确');
    }
    const diffRaw = diff as Record<string, unknown>;
    diffChecked = {
      entries: requireArray(diffRaw['entries'], 'diff.entries').map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
          throw new Error(`同步冲突差异第 ${index + 1} 项形状不正确`);
        }
        const entryRaw = entry as Record<string, unknown>;
        return {
          ...(entryRaw as unknown as SyncConflictDetail['diff'] extends null
            ? never
            : NonNullable<SyncConflictDetail['diff']>['entries'][number]),
          path: requireString(entryRaw['path'], `diff.entries[${index}].path`),
          kind: requireString(entryRaw['kind'], `diff.entries[${index}].kind`),
        };
      }),
      truncated: requireBoolean(diffRaw['truncated'], 'diff.truncated'),
      invalid: requireBoolean(diffRaw['invalid'], 'diff.invalid'),
    };
  }

  return {
    ...(detail as unknown as SyncConflictDetail),
    conflictId: requireString(detail['conflictId'], 'conflictId'),
    recordUuid: requireString(detail['recordUuid'], 'recordUuid'),
    resourceType: requireString(detail['resourceType'], 'resourceType'),
    status: requireString(detail['status'], 'status'),
    // 快照正文会被直接渲染 ⇒ 必须是字符串（曾因对象导致渲染期 TypeError）
    localSnapshot: requireString(detail['localSnapshot'], 'localSnapshot'),
    cloudSnapshot: requireString(detail['cloudSnapshot'], 'cloudSnapshot'),
    versionNo: requireNumber(detail['versionNo'], 'versionNo'),
    diff: diffChecked,
  };
}

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
      canAdoptCloud
      adoptionReadOnly
      confirmedByAccountId
      confirmedAt
      createdAt
    }
  }
`;

const RESOLVE_SYNC_CONFLICT_MUTATION = `
  mutation ResolveSyncConflict(
    $conflictId: String!
    $action: SyncConflictAction!
    $displayedCloudVersion: Int
  ) {
    resolveSyncConflict(
      conflictId: $conflictId
      action: $action
      displayedCloudVersion: $displayedCloudVersion
    ) {
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

  const list = data.syncConflicts;
  if (typeof list !== 'object' || list === null) {
    throw new Error('同步冲突清单响应缺少主体');
  }
  const raw = list as unknown as Record<string, unknown>;

  return {
    items: requireArray(raw['items'], 'syncConflicts.items').map(assertSyncConflictSummary),
    total: typeof raw['total'] === 'number' ? raw['total'] : null,
    page: requireNumber(raw['page'], 'syncConflicts.page'),
    pageSize: requireNumber(raw['pageSize'], 'syncConflicts.pageSize'),
    truncated: typeof raw['truncated'] === 'boolean' ? raw['truncated'] : null,
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

  return assertSyncConflictDetail(data.syncConflict);
}

/**
 * 裁决冲突：使用云端（CLOUD）／保留本地（LOCAL）／稍后处理（LATER）。
 *
 * `displayedCloudVersion`：**用户实际看到**的云端版本。服务端据此复核
 * "云端是否已变化"（R067）——提交与登记不一致时返回刷新重确认，
 * 前端不自行判断云端是否变化。
 */
export async function resolveSyncConflict(
  conflictId: string,
  action: SyncConflictAction,
  displayedCloudVersion: number | null,
): Promise<{ outcome: 'resolved' | 'existing' | 'later'; conflict: SyncConflictSummary }> {
  const data = await executeGraphQL<
    ResolveSyncConflictMutationResult,
    { conflictId: string; action: SyncConflictAction; displayedCloudVersion: number | null }
  >(RESOLVE_SYNC_CONFLICT_MUTATION, { conflictId, action, displayedCloudVersion });

  const result = data.resolveSyncConflict;
  if (typeof result !== 'object' || result === null) {
    throw new Error('冲突裁决响应缺少主体');
  }
  const raw = result as unknown as Record<string, unknown>;

  return {
    ...(raw as unknown as {
      outcome: 'resolved' | 'existing' | 'later';
      conflict: SyncConflictSummary;
    }),
    outcome: requireString(raw['outcome'], 'resolveSyncConflict.outcome') as
      | 'resolved'
      | 'existing'
      | 'later',
    conflict: assertSyncConflictSummary(raw['conflict'], 0),
  };
}
