// src/usecases/local-runtime/list-sync-conflicts.usecase.ts

import { Injectable } from '@nestjs/common';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import type {
  LocalRuntimePagination,
  ListSyncConflictsCommand,
} from './local-runtime.command.types';
import type {
  SyncConflictListPage,
  SyncConflictSnapshot,
} from '@src/modules/lithography/sync.types';
import {
  SyncConflictQueryService,
  type SyncConflictMetadataRow,
} from '@src/modules/lithography/queries/sync-conflict.query.service';

/**
 * 冲突清单（任务 09 S2.1／R066／后续S2·S2.2）。
 *
 * 范围与本地运行数据一致：工程师与二级管理员只看本公司数据区，
 * 一级管理员看本设备全部公司。列表不含正文快照的解包结果，
 * 快照内容只在详情读取。
 *
 * 后续S2 增补（任务书 S2.2「冲突先查元数据授权再读正文」）：
 * - 读取拆成两段：先只读冲突**元数据**做记录级授权裁决，授权通过后才按需读正文快照；
 * - 授权不通过的条目整条不返回（不通过存在性泄露），过滤后的集合才是分页与总数口径；
 * - 候选超过扫描上限时如实标记 `truncated`，不静默丢条目。
 */
@Injectable()
export class ListSyncConflictsUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly syncConflictQueryService: SyncConflictQueryService,
    private readonly syncConflictAccessResolver: SyncConflictAccessResolver,
  ) {}

  async execute(command: ListSyncConflictsCommand): Promise<SyncConflictListPage> {
    const scope = await this.scopeResolver.resolve(command.session);
    const pagination: LocalRuntimePagination = command.pagination ?? { page: 1, pageSize: 20 };
    const page = Math.max(1, Math.trunc(pagination.page));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(pagination.pageSize)));

    const { rows, truncated } = await this.syncConflictQueryService.listMetadataForScope(
      scope.organizationId,
      { statusOnlyPending: command.statusOnlyPending },
    );

    // 记录级授权：越权与事实不可得的条目整条剔除后再分页
    const readable = await this.syncConflictAccessResolver.filterReadable({
      sessionAccountId: command.session.accountId,
      scope,
      rows,
    });

    const start = (page - 1) * pageSize;
    const pageRows = readable.slice(start, start + pageSize);

    // 只对授权通过的条目读取正文快照
    const snapshots = await this.syncConflictQueryService.readSnapshots(
      pageRows.map((row) => row.conflictId),
    );

    // 快照缺失（并发删除）时不返回半成品条目：宁可少一条，也不给"正文为空"的假象
    const items: SyncConflictSnapshot[] = [];
    for (const row of pageRows) {
      const payload = snapshots.get(row.conflictId);
      if (payload === undefined) {
        continue;
      }
      items.push(this.toSnapshot(row, payload));
    }

    return {
      items,
      total: command.pagination?.withTotal === true ? readable.length : undefined,
      page,
      pageSize,
      truncated,
    };
  }

  /** 元数据 + 快照 → 对外快照 */
  private toSnapshot(
    row: SyncConflictMetadataRow,
    payload: { localSnapshot: string; cloudSnapshot: string },
  ): SyncConflictSnapshot {
    return {
      conflictId: row.conflictId,
      recordUuid: row.recordUuid,
      organizationId: row.organizationId,
      resourceType: row.resourceType,
      versionNo: row.versionNo,
      localVersion: row.localVersion,
      cloudVersion: row.cloudVersion,
      displayedCloudVersion: row.displayedCloudVersion,
      decision: row.decision,
      status: row.status,
      localSnapshot: payload.localSnapshot,
      cloudSnapshot: payload.cloudSnapshot,
      conflictReason: row.conflictReason,
      confirmedByAccountId: row.confirmedByAccountId,
      confirmedAt: row.confirmedAt,
      createdAt: row.createdAt,
    };
  }
}
