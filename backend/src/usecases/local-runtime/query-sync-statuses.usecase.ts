// src/usecases/local-runtime/query-sync-statuses.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import {
  resolveSyncStatusAccess,
  type SyncStatusAccessFacts,
} from '@core/local-runtime/policy/sync-status-access.policy';
import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import {
  resolveSyncStatus,
  resolveSyncApplicability,
  SYNC_TASK_STATUSES,
  type SyncStatusConflictFact,
  type SyncStatusFacts,
  type SyncStatusReceiptFact,
  type SyncStatusTaskFact,
  type SyncTaskStatus,
} from '@core/local-runtime/policy/sync-status.policy';
import { resolveSyncConflictEntry } from '@core/local-runtime/policy/sync-conflict-entry.policy';
import { Injectable } from '@nestjs/common';

import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
  type SyncSourceRecordFact,
  type SyncSourceResourceType,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import {
  SyncStatusQueryService,
  type SyncCompanyAuthorizationSummary,
  type SyncStatusConflictRow,
  type SyncStatusReceiptRow,
  type SyncStatusTaskRow,
} from '@src/modules/lithography/queries/sync-status.query.service';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import {
  SYNC_STATUS_QUERY_MAX_BATCH,
  type SyncStatusQueryItem,
  type SyncStatusQueryPort,
  type SyncStatusQueryRequest,
} from './sync-status.contract';

const KNOWN_TASK_STATUSES = new Set<string>(SYNC_TASK_STATUSES);

/**
 * 业务同步状态批量查询用例（任务 09 后续S1／S2）。
 *
 * 职责边界：
 * - 取事实（来源记录、任务、回执、冲突、授权）→ 交给纯策略裁决 → 组装对外条目；
 * - **不产生任何副作用**：不触发上传、不写回执、不改任务状态；
 * - 公司、类型、稳定键与当前版本一律以服务端事实为准：
 *   客户端传入的公司只用于与来源事实核对，客户端传入的版本只用于回显。
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
    if (params.requests.length > SYNC_STATUS_QUERY_MAX_BATCH) {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.INVALID_PARAMS,
        `同步状态批量查询不能超过 ${SYNC_STATUS_QUERY_MAX_BATCH} 条`,
      );
    }

    const scope = await this.scopeResolver.resolve(params.session);
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (installation === null) {
      // 本机未安装：没有可信的本机事实来源，不能给出任何同步结论
      return [];
    }
    const installationOrganizationId = installation.organizationId;
    if (installationOrganizationId === null) {
      // 本机未映射云端组织：无法确定本机负责的数据区，不能给出同步结论
      return [];
    }

    const requests = this.normalizeRequests(params.requests);
    const grouped = this.groupRequests(requests);

    // 公司级「正式运行模式」事实：本机 × 本机映射公司的账号授权登记（每次查询读一次）
    const companyAuthorization = await this.syncStatusQueryService.readCompanyAuthorizationSummary(
      installation.installationId,
      installationOrganizationId,
    );

    const items: SyncStatusQueryItem[] = [];
    for (const group of grouped.values()) {
      items.push(
        ...(await this.processGroup({
          group,
          sessionAccountId: params.session.accountId,
          scope,
          installationId: installation.installationId,
          installationOrganizationId,
          companyAuthorization,
        })),
      );
    }

    return items;
  }

  /** 处理一个来源类型分组：取事实 → 逐条核对 → 逐条裁决 */
  private async processGroup(input: {
    group: {
      resourceType: SyncSourceResourceType;
      requests: SyncStatusQueryRequest[];
    };
    sessionAccountId: number;
    scope: LocalRuntimeViewerScope;
    installationId: string;
    installationOrganizationId: number;
    companyAuthorization: SyncCompanyAuthorizationSummary;
  }): Promise<SyncStatusQueryItem[]> {
    const { group } = input;
    const groupRequests = group.requests;
    const recordUuids = groupRequests.map((request) => request.recordUuid);

    const { facts, scanComplete } = await this.sourceRecordQueryService.listFacts({
      organizationId: input.installationOrganizationId,
      resourceType: group.resourceType,
      recordUuids,
    });

    const [tasks, legacyTaskUuids, receipts, conflicts] = await Promise.all([
      this.syncStatusQueryService.readBusinessSyncTasks(input.installationId, recordUuids),
      this.syncStatusQueryService.readLegacyTaskUuids(input.installationId, recordUuids),
      this.syncStatusQueryService.readReceipts(
        input.installationOrganizationId,
        group.resourceType,
        recordUuids,
      ),
      this.syncStatusQueryService.readPendingConflicts(
        input.installationOrganizationId,
        group.resourceType,
        recordUuids,
      ),
    ]);

    const authorizations = await this.syncStatusQueryService.readAuthorizations(
      input.installationId,
      input.installationOrganizationId,
      this.collectSubjectAccountIds(groupRequests, facts),
    );

    const items: SyncStatusQueryItem[] = [];
    for (const request of groupRequests) {
      const fact = facts.get(request.recordUuid);
      if (fact === undefined) {
        // 扫描不完整时无法断言"记录不存在"，只能如实判为未知
        if (!scanComplete) {
          items.push(
            this.buildItem({
              request,
              status: 'UNKNOWN',
              reasonCode: 'IDENTITY_UNTRUSTED',
              organizationId: input.installationOrganizationId,
              resourceType: group.resourceType,
            }),
          );
        }
        // 记录确实不存在（或不可见）时直接省略，不泄露该记录是否存在
        continue;
      }

      // 公司以服务端事实为准：来源记录归属必须与本机映射公司一致
      if (
        fact.ownerOrganizationId !== null &&
        fact.ownerOrganizationId !== input.installationOrganizationId
      ) {
        continue;
      }
      // 调用方传入的公司与来源事实不一致时按不一致处理（客户端公司不参与裁决）
      if (request.organizationId !== fact.ownerOrganizationId) {
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
        tasks,
        legacyTaskUuids,
        receipts,
        conflicts,
        authorizations,
        installationId: input.installationId,
        scope: input.scope,
        companyAuthorization: input.companyAuthorization,
      });
      items.push(item);
    }
    return items;
  }

  /** 逐条裁决：组装事实 → 纯策略 → 对外条目 */
  private resolveItem(input: {
    request: SyncStatusQueryRequest;
    fact: SyncSourceRecordFact;
    tasks: readonly SyncStatusTaskRow[];
    legacyTaskUuids: readonly string[];
    receipts: readonly SyncStatusReceiptRow[];
    conflicts: readonly SyncStatusConflictRow[];
    authorizations: ReadonlyMap<number, 'ACTIVE' | 'REVOKED'>;
    installationId: string;
    scope: LocalRuntimeViewerScope;
    companyAuthorization: SyncCompanyAuthorizationSummary;
  }): SyncStatusQueryItem {
    const { request, fact } = input;
    const currentVersion = fact.currentVersion;

    // 任务：只认当前版本；同版本多条时取最新（查询已按 id 倒序）
    const currentTasks = input.tasks.filter(
      (row) => currentVersion !== null && row.sourceVersion === currentVersion,
    );
    const task = this.pickTask(currentTasks);

    // 回执：优先取与当前版本任务一致的回执，否则取版本号最高的一条
    const receiptRows = input.receipts.filter((row) => row.recordUuid === request.recordUuid);
    const receiptRow = this.pickReceipt(receiptRows, task);
    const receipt = this.buildReceipt(receiptRow, task, input.installationId);

    // 冲突：只认与当前版本相关的待处理冲突（旧版本遗留冲突不误报当前版本）
    const conflictRow = this.pickConflict(
      input.conflicts.filter((row) => row.recordUuid === request.recordUuid),
      currentVersion,
    );
    const conflict: SyncStatusConflictFact | null =
      conflictRow === null
        ? null
        : {
            conflictId: conflictRow.conflictId,
            localVersion: conflictRow.localVersion,
            cloudVersion: conflictRow.cloudVersion,
            // 可读性由记录级授权保证（越权记录已在上一层被排除）；
            // 处理入口还要求写权成立且当前展示版本与冲突版本一致
            readable: true,
            resolvable: this.resolveConflictResolvable({
              scope: input.scope,
              conflictRow,
              displayedVersion: request.sourceVersion,
              serverCurrentVersion: currentVersion,
            }),
          };

    const facts: SyncStatusFacts = {
      connected: true,
      identityTrusted: true,
      versionTrusted: fact.versionTrusted,
      applicable: this.resolveApplicability(fact, input.companyAuthorization),
      authorizationValid: this.resolveAuthorization(fact, input.authorizations),
      task,
      legacyTaskExists: input.legacyTaskUuids.includes(request.recordUuid),
      receipt,
      conflict,
    };

    const outcome = resolveSyncStatus(facts);
    return this.buildItem({
      request,
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      conflictId: outcome.conflictId,
      canResolveConflict: outcome.canResolveConflict,
      organizationId: fact.ownerOrganizationId ?? request.organizationId,
      resourceType: fact.resourceType,
      sourceVersion: currentVersion,
      identityPersisted: fact.identityPersisted,
    });
  }

  /**
   * 适用性裁决（事实驱动，不做硬编码断言）：
   * - 材料级明确不适用（已下架／软删除）→ 不适用；
   * - 材料级无法判定（归属待确认等）→ 未知；
   * - 材料级适用 → 取公司级「正式运行模式」判定（有 ACTIVE 授权 → 适用；
   *   授权全部撤销 → 不适用；未取得授权事实 → 未知，不硬编码为真）。
   */
  private resolveApplicability(
    fact: SyncSourceRecordFact,
    company: SyncCompanyAuthorizationSummary,
  ): boolean | null {
    return resolveSyncApplicability(fact.materialApplicable, {
      authorizationCount: company.authorizationCount,
      activeAuthorizationCount: company.activeAuthorizationCount,
    });
  }

  /**
   * 冲突处理入口判定：写权成立 **且** 当前展示版本与冲突版本一致。
   *
   * 写权口径与 `resolve-sync-conflict.usecase.ts` 对齐（一级管理员全局；
   * 工程师／二级管理员限本公司数据区），避免出现"有入口但裁决被拒"。
   */
  private resolveConflictResolvable(input: {
    scope: LocalRuntimeViewerScope;
    conflictRow: SyncStatusConflictRow;
    displayedVersion: number | null;
    serverCurrentVersion: number | null;
  }): boolean {
    const entry = resolveSyncConflictEntry({
      scopeOrganizationId: input.scope.organizationId,
      conflictOrganizationId: input.conflictRow.organizationId,
      recordReadable: true,
      conflictStatus: input.conflictRow.status,
      displayedVersion: input.displayedVersion,
      serverCurrentVersion: input.serverCurrentVersion,
      conflictVersions: [
        input.conflictRow.localVersion,
        input.conflictRow.cloudVersion,
        input.conflictRow.versionNo,
        input.conflictRow.displayedCloudVersion,
      ],
    });
    return entry.allowed;
  }

  /**
   * 授权有效性裁决：**只看授权主体账号**（原归属账号）的授权状态。
   * 其他关联账号（客户、受理人、修改人）的授权不影响本记录。
   */
  private resolveAuthorization(
    fact: SyncSourceRecordFact,
    authorizations: ReadonlyMap<number, 'ACTIVE' | 'REVOKED'>,
  ): boolean | null {
    const subject = fact.authorizationSubjectAccountId;
    if (subject === null) {
      return null;
    }
    const status = authorizations.get(subject);
    if (status === undefined) {
      // 未取得授权事实时保持 null（未知），不推断为有效
      return null;
    }
    return status === 'ACTIVE';
  }

  private pickTask(rows: readonly SyncStatusTaskRow[]): SyncStatusTaskFact | null {
    if (rows.length === 0) {
      return null;
    }
    const alive = rows.filter((row) => row.status !== 'CANCELLED');
    const picked = alive[0] ?? rows[0];
    return {
      status: this.mapTaskStatus(picked.status),
      sourceVersion: picked.sourceVersion,
      manifestChecksum: picked.manifestChecksum,
      entityType: picked.entityType,
    };
  }

  /** 把数据库字符串收敛为受控任务状态；未知取值按 UNKNOWN 处理（不做 `as` 断言） */
  private mapTaskStatus(value: string): SyncTaskStatus | 'UNKNOWN' {
    return KNOWN_TASK_STATUSES.has(value) ? (value as SyncTaskStatus) : 'UNKNOWN';
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

  /**
   * 组装回执事实：**完整性由摘要一致性推导**，不接受"状态成功即完整"的推断；
   * 来源安装标识为空或不是本机的回执，不得作为本机已同步的证据。
   */
  private buildReceipt(
    row: SyncStatusReceiptRow | null,
    task: SyncStatusTaskFact | null,
    installationId: string,
  ): SyncStatusReceiptFact | null {
    if (row === null) {
      return null;
    }
    const sourceInstallationConfirmed =
      row.sourceInstallationId !== null && row.sourceInstallationId === installationId;
    const manifestMatched =
      task !== null &&
      task.manifestChecksum !== null &&
      row.manifestChecksum !== null &&
      row.manifestChecksum === task.manifestChecksum;
    return {
      status: row.receiptStatus as SyncStatusReceiptFact['status'],
      versionNo: row.versionNo,
      manifestChecksum: row.manifestChecksum,
      sourceInstallationConfirmed,
      bodyComplete: manifestMatched,
      originalsComplete: manifestMatched,
    };
  }

  /** 选取与当前版本相关的待处理冲突；旧版本遗留冲突不作为当前版本冲突 */
  private pickConflict(
    rows: readonly SyncStatusConflictRow[],
    currentVersion: number | null,
  ): SyncStatusConflictRow | null {
    if (rows.length === 0) {
      return null;
    }
    if (currentVersion === null) {
      // 当前版本不可核验时不做版本匹配，取第一条并如实保留其版本事实
      return rows[0] ?? null;
    }
    const matched = rows.find(
      (row) =>
        row.localVersion === currentVersion ||
        row.cloudVersion === currentVersion ||
        row.versionNo === currentVersion,
    );
    return matched ?? null;
  }

  /** 组装对外条目（含调用方版本回显与一致性标记） */
  private buildItem(input: {
    request: SyncStatusQueryRequest;
    status: SyncStatusQueryItem['status'];
    reasonCode: SyncStatusQueryItem['reasonCode'];
    conflictId?: string | null;
    canResolveConflict?: boolean;
    organizationId: number;
    resourceType: string;
    sourceVersion?: number | null;
    identityPersisted?: boolean;
  }): SyncStatusQueryItem {
    const sourceVersion = input.sourceVersion ?? null;
    const requestedVersion = input.request.sourceVersion;
    return {
      organizationId: input.organizationId,
      resourceType: input.resourceType,
      recordUuid: input.request.recordUuid,
      sourceVersion,
      identityPersisted: input.identityPersisted ?? false,
      requestedVersion,
      versionAligned:
        requestedVersion === null || sourceVersion === null
          ? null
          : requestedVersion === sourceVersion,
      status: input.status,
      reasonCode: input.reasonCode,
      conflictId: input.conflictId ?? null,
      canResolveConflict: input.canResolveConflict ?? false,
    };
  }

  /** 收集授权主体账号（按仓库约定用只读数组 + includes 去重，不用手工 Set） */
  private collectSubjectAccountIds(
    groupRequests: readonly SyncStatusQueryRequest[],
    facts: ReadonlyMap<string, SyncSourceRecordFact>,
  ): number[] {
    const accountIds: number[] = [];
    for (const request of groupRequests) {
      const fact = facts.get(request.recordUuid);
      if (fact === undefined || fact.authorizationSubjectAccountId === null) {
        continue;
      }
      if (!accountIds.includes(fact.authorizationSubjectAccountId)) {
        accountIds.push(fact.authorizationSubjectAccountId);
      }
    }
    return accountIds;
  }

  /** 归一化请求：去重、剔除非法资源类型（非法项跳过，不影响同批其他记录） */
  private normalizeRequests(requests: readonly SyncStatusQueryRequest[]): SyncStatusQueryRequest[] {
    const seen = new Map<string, SyncStatusQueryRequest>();
    for (const request of requests) {
      if (!SYNC_SOURCE_RESOURCE_TYPES.includes(request.resourceType as SyncSourceResourceType)) {
        // 未知资源类型：跳过该条，不让整批失败
        continue;
      }
      const key = `${request.organizationId}|${request.resourceType}|${request.recordUuid}`;
      if (!seen.has(key)) {
        seen.set(key, request);
      }
    }
    return Array.from(seen.values());
  }

  private groupRequests(
    requests: readonly SyncStatusQueryRequest[],
  ): Map<string, { resourceType: SyncSourceResourceType; requests: SyncStatusQueryRequest[] }> {
    const grouped = new Map<
      string,
      { resourceType: SyncSourceResourceType; requests: SyncStatusQueryRequest[] }
    >();
    for (const request of requests) {
      const resourceType = request.resourceType as SyncSourceResourceType;
      const key = request.resourceType;
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, { resourceType, requests: [request] });
      } else {
        existing.requests.push(request);
      }
    }
    return grouped;
  }
}
