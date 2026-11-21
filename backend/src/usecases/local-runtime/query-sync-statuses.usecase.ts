// src/usecases/local-runtime/query-sync-statuses.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  resolveSyncStatusAccess,
  type SyncStatusAccessFacts,
} from '@core/local-runtime/policy/sync-status-access.policy';
import {
  resolveSyncStatus,
  type SyncStatusConflictFact,
  type SyncStatusFacts,
  type SyncStatusReceiptFact,
  type SyncStatusTaskFact,
} from '@core/local-runtime/policy/sync-status.policy';
import { Injectable } from '@nestjs/common';

import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import {
  SyncSourceRecordQueryService,
  type SyncSourceRecordFact,
  type SyncSourceResourceType,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import {
  SyncStatusQueryService,
  type SyncStatusConflictRow,
  type SyncStatusReceiptRow,
  type SyncStatusTaskRow,
} from '@src/modules/lithography/queries/sync-status.query.service';

import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import type {
  SyncStatusQueryItem,
  SyncStatusQueryPort,
  SyncStatusQueryRequest,
} from './sync-status.contract';

/**
 * 业务同步状态批量查询用例（任务 09 后续S1／S2）。
 *
 * 职责边界：
 * - 取事实（来源记录、任务、回执、冲突、授权）→ 交给纯策略裁决 → 组装对外条目；
 * - **不产生任何副作用**：不触发上传、不写回执、不改任务状态；
 * - 公司、类型、稳定键与当前版本一律以服务端事实为准，客户端传入的公司与版本不参与裁决。
 */
@Injectable()
export class QuerySyncStatusesUsecase implements SyncStatusQueryPort {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
    private readonly syncStatusQueryService: SyncStatusQueryService,
  ) {}

  async queryStatuses(params: {
    session: UsecaseSession;
    requests: readonly SyncStatusQueryRequest[];
  }): Promise<readonly SyncStatusQueryItem[]> {
    if (params.requests.length === 0) {
      return [];
    }

    const scope = await this.scopeResolver.resolve(params.session);
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (installation === null) {
      // 本机未安装：没有可信的本机事实来源，不能给出任何同步结论
      return [];
    }

    const requests = this.dedupeRequests(params.requests);
    const grouped = this.groupRequests(requests);

    const items: SyncStatusQueryItem[] = [];
    for (const group of grouped.values()) {
      items.push(
        ...(await this.processGroup({
          group,
          sessionAccountId: params.session.accountId,
          scope,
          installationId: installation.installationId,
        })),
      );
    }

    return items;
  }

  /** 处理一个（公司、来源类型）分组：取事实 → 逐条授权 → 逐条裁决 */
  private async processGroup(input: {
    group: {
      organizationId: number;
      resourceType: SyncSourceResourceType;
      requests: SyncStatusQueryRequest[];
    };
    sessionAccountId: number;
    scope: LocalRuntimeViewerScope;
    installationId: string;
  }): Promise<SyncStatusQueryItem[]> {
    const { group } = input;
    const groupRequests = group.requests;
    const facts = await this.loadSourceFacts(group.organizationId, group.resourceType);
    if (facts.size === 0) {
      return [];
    }

    const recordUuids = groupRequests.map((request) => request.recordUuid);
    const [tasks, receipts, conflicts] = await Promise.all([
      this.syncStatusQueryService.readBusinessSyncTasks(input.installationId, recordUuids),
      this.syncStatusQueryService.readReceipts(
        group.organizationId,
        group.resourceType,
        recordUuids,
      ),
      this.syncStatusQueryService.readPendingConflicts(
        group.organizationId,
        group.resourceType,
        recordUuids,
      ),
    ]);

    const authorizations = await this.syncStatusQueryService.readAuthorizations(
      input.installationId,
      group.organizationId,
      this.collectRelatedAccountIds(groupRequests, facts),
    );

    return this.resolveGroupItems({
      groupRequests,
      facts,
      tasks,
      receipts,
      conflicts,
      authorizations,
      sessionAccountId: input.sessionAccountId,
      scope: input.scope,
    });
  }

  /** 逐条授权并裁决，输出可展示条目 */
  private resolveGroupItems(input: {
    groupRequests: readonly SyncStatusQueryRequest[];
    facts: ReadonlyMap<string, SyncSourceRecordFact>;
    tasks: readonly SyncStatusTaskRow[];
    receipts: readonly SyncStatusReceiptRow[];
    conflicts: readonly SyncStatusConflictRow[];
    authorizations: ReadonlyMap<number, 'ACTIVE' | 'REVOKED'>;
    sessionAccountId: number;
    scope: LocalRuntimeViewerScope;
  }): SyncStatusQueryItem[] {
    const items: SyncStatusQueryItem[] = [];
    for (const request of input.groupRequests) {
      const fact = input.facts.get(request.recordUuid);
      if (fact === undefined) {
        // 稳定键在本机找不到来源记录：无法核对归属与版本，不返回条目
        continue;
      }

      const access = resolveSyncStatusAccess({
        sessionAccountId: input.sessionAccountId,
        scope: input.scope,
        ownerOrganizationId: fact.ownerOrganizationId,
        relatedAccountIds: fact.relatedAccountIds,
      } satisfies SyncStatusAccessFacts);
      if (!access.allowed) {
        continue;
      }

      const item = this.resolveItem({
        request,
        fact,
        tasks: input.tasks,
        receipts: input.receipts,
        conflicts: input.conflicts,
        authorizations: input.authorizations,
      });
      if (item !== null) {
        items.push(item);
      }
    }
    return items;
  }

  /** 收集分组内记录关联账号（按仓库约定用只读数组 + includes 去重，不用手工 Set） */
  private collectRelatedAccountIds(
    groupRequests: readonly SyncStatusQueryRequest[],
    facts: ReadonlyMap<string, SyncSourceRecordFact>,
  ): number[] {
    const accountIds: number[] = [];
    for (const request of groupRequests) {
      const fact = facts.get(request.recordUuid);
      if (fact === undefined) {
        continue;
      }
      for (const accountId of fact.relatedAccountIds) {
        if (!accountIds.includes(accountId)) {
          accountIds.push(accountId);
        }
      }
    }
    return accountIds;
  }

  private resolveItem(input: {
    request: SyncStatusQueryRequest;
    fact: SyncSourceRecordFact;
    tasks: readonly SyncStatusTaskRow[];
    receipts: readonly SyncStatusReceiptRow[];
    conflicts: readonly SyncStatusConflictRow[];
    authorizations: ReadonlyMap<number, 'ACTIVE' | 'REVOKED'>;
  }): SyncStatusQueryItem | null {
    const { request, fact } = input;

    const taskRows = input.tasks.filter((row) => row.recordUuid === request.recordUuid);
    const receiptRows = input.receipts.filter((row) => row.recordUuid === request.recordUuid);
    const conflictRows = input.conflicts.filter((row) => row.recordUuid === request.recordUuid);

    const currentVersion = fact.currentVersion;

    // 任务：只认当前版本；同一版本有多条时取未取消的最新一条
    const currentTasks = taskRows.filter(
      (row) => currentVersion !== null && row.sourceVersion === currentVersion,
    );
    const task: SyncStatusTaskFact | null = this.pickTask(currentTasks);

    // 回执：优先取与当前版本任务一致的回执；没有匹配时取版本最高的一条，
    // 由状态策略如实表达"回执版本与当前版本不一致"（而不是笼统报缺回执）
    const receiptRow = this.pickReceipt(receiptRows, task);
    const receipt: SyncStatusReceiptFact | null =
      receiptRow === null
        ? null
        : {
            status: receiptRow.receiptStatus as SyncStatusReceiptFact['status'],
            versionNo: receiptRow.versionNo,
            manifestChecksum: receiptRow.manifestChecksum,
            // 正文与原件完整性以回执确认的事实为准：当前结构只落摘要与状态，
            // 未落完整性确认时按"不完整"处理（不得据此显示已同步）
            bodyComplete:
              receiptRow.receiptStatus === 'SUCCEEDED' && receiptRow.manifestChecksum !== null,
            originalsComplete:
              receiptRow.receiptStatus === 'SUCCEEDED' && receiptRow.manifestChecksum !== null,
          };

    // 冲突：当前版本存在待处理冲突即如实呈现（不因版本不可核验而隐藏）
    const conflictRow = conflictRows[0] ?? null;
    const conflict: SyncStatusConflictFact | null =
      conflictRow === null
        ? null
        : {
            conflictId: conflictRow.conflictId,
            localVersion: conflictRow.localVersion,
            cloudVersion: conflictRow.cloudVersion,
            readable: true,
            // 处理冲突需要写权与当前展示版本一致，二者由冲突裁决入口再校验；
            // 此处只表达"当前查看者可进入处理入口"，避免在状态查询里越权放行
            resolvable: false,
          };

    // 授权：原记录账号授权失效时如实呈现，不允许他人接管
    const authorizationValid = this.resolveAuthorization(input);

    const facts: SyncStatusFacts = {
      connected: true,
      identityTrusted: true,
      versionTrusted: fact.versionTrusted,
      applicable: fact.applicable,
      authorizationValid,
      task,
      receipt,
      conflict,
    };

    const outcome = resolveSyncStatus(facts);
    return {
      organizationId: fact.ownerOrganizationId ?? request.organizationId,
      resourceType: request.resourceType,
      recordUuid: request.recordUuid,
      sourceVersion: currentVersion,
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      conflictId: outcome.conflictId,
      canResolveConflict: outcome.canResolveConflict,
    };
  }

  private resolveAuthorization(input: {
    fact: SyncSourceRecordFact;
    authorizations: ReadonlyMap<number, 'ACTIVE' | 'REVOKED'>;
  }): boolean | null {
    const revoked = input.fact.relatedAccountIds.some(
      (accountId) => input.authorizations.get(accountId) === 'REVOKED',
    );
    if (revoked) {
      return false;
    }
    const hasAny = input.fact.relatedAccountIds.some((accountId) =>
      input.authorizations.has(accountId),
    );
    // 未取得授权事实时保持 null（未知），不推断为有效
    return hasAny ? true : null;
  }

  private pickTask(rows: readonly SyncStatusTaskRow[]): SyncStatusTaskFact | null {
    if (rows.length === 0) {
      return null;
    }
    const alive = rows.filter((row) => row.status !== 'CANCELLED');
    const picked = alive[0] ?? rows[0];
    return {
      status: picked.status as SyncStatusTaskFact['status'],
      sourceVersion: picked.sourceVersion,
    };
  }

  /**
   * 选取回执：优先取与当前版本任务一致的回执；没有一致回执时取版本号最高的一条，
   * 由状态策略如实表达"回执版本与当前版本不一致"，而不是笼统报"缺回执"。
   */
  private pickReceipt(
    rows: readonly SyncStatusReceiptRow[],
    task: SyncStatusTaskFact | null,
  ): SyncStatusReceiptRow | null {
    if (rows.length === 0) {
      return null;
    }
    if (task !== null) {
      const matched = rows.find((row) => row.versionNo === task.sourceVersion);
      if (matched !== undefined) {
        return matched;
      }
    }
    return rows.reduce((latest, row) => (row.versionNo > latest.versionNo ? row : latest));
  }

  private dedupeRequests(requests: readonly SyncStatusQueryRequest[]): SyncStatusQueryRequest[] {
    const seen = new Map<string, SyncStatusQueryRequest>();
    for (const request of requests) {
      const key = `${request.organizationId}|${request.resourceType}|${request.recordUuid}`;
      if (!seen.has(key)) {
        seen.set(key, request);
      }
    }
    return Array.from(seen.values());
  }

  private groupRequests(requests: readonly SyncStatusQueryRequest[]): Map<
    string,
    {
      organizationId: number;
      resourceType: SyncSourceResourceType;
      requests: SyncStatusQueryRequest[];
    }
  > {
    const grouped = new Map<
      string,
      {
        organizationId: number;
        resourceType: SyncSourceResourceType;
        requests: SyncStatusQueryRequest[];
      }
    >();
    for (const request of requests) {
      const resourceType = request.resourceType as SyncSourceResourceType;
      const key = `${request.organizationId}|${request.resourceType}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, {
          organizationId: request.organizationId,
          resourceType,
          requests: [request],
        });
      } else {
        existing.requests.push(request);
      }
    }
    return grouped;
  }

  private async loadSourceFacts(
    organizationId: number,
    resourceType: SyncSourceResourceType,
  ): Promise<Map<string, SyncSourceRecordFact>> {
    const rows = await this.sourceRecordQueryService.listFacts(organizationId, resourceType);
    const result = new Map<string, SyncSourceRecordFact>();
    for (const row of rows) {
      result.set(row.recordUuid, row);
    }
    return result;
  }
}
