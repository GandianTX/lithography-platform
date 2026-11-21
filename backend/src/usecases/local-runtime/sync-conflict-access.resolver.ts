// src/usecases/local-runtime/sync-conflict-access.resolver.ts

import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { resolveSyncConflictAccess } from '@core/local-runtime/policy/sync-conflict-access.policy';
import { Injectable } from '@nestjs/common';

import type { SyncConflictMetadataRow } from '@src/modules/lithography/queries/sync-conflict.query.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
  type SyncSourceRecordFact,
  type SyncSourceResourceType,
} from '@src/modules/lithography/queries/sync-source-record.query.service';

/**
 * 冲突读取的记录级授权解析（任务 09 后续S2·S2.2）。
 *
 * 职责：把冲突**元数据**翻译成"这条冲突对当前查看者是否可读"，并据此过滤。
 *
 * 为什么放在用例层：授权需要两类事实同时在手——
 * 冲突行的元数据（登记公司、稳定键、资源类型）与来源业务记录的事实
 * （归属公司、关联账号）。前者来自冲突表，后者只能回到来源业务表取，
 * 冲突查询服务本身拿不到来源事实。
 *
 * 授权不通过的条目**整条不返回**（连元数据也不给），与同步状态读侧
 * "越权记录不返回条目"的既有口径一致：不通过存在性泄露。
 */
@Injectable()
export class SyncConflictAccessResolver {
  constructor(private readonly sourceRecordQueryService: SyncSourceRecordQueryService) {}

  /**
   * 过滤出可读的冲突条目。
   *
   * 事实取得失败的条目（资源类型不在来源白名单、来源记录已删除或归属公司已变更）
   * 同样按不可读处理：读不到授权依据不等于有权看。
   */
  async filterReadable(params: {
    sessionAccountId: number;
    scope: LocalRuntimeViewerScope;
    rows: readonly SyncConflictMetadataRow[];
  }): Promise<SyncConflictMetadataRow[]> {
    if (params.rows.length === 0) {
      return [];
    }
    const facts = await this.resolveRecordFacts(params.rows);
    const readable: SyncConflictMetadataRow[] = [];
    for (const row of params.rows) {
      if (this.isReadableRow(row, facts, params.sessionAccountId, params.scope)) {
        readable.push(row);
      }
    }
    return readable;
  }

  /** 单条判定（详情读取用） */
  isReadableRow(
    row: SyncConflictMetadataRow,
    facts: ReadonlyMap<string, SyncSourceRecordFact>,
    sessionAccountId: number,
    scope: LocalRuntimeViewerScope,
  ): boolean {
    const fact = facts.get(this.factKey(row.resourceType, row.recordUuid));
    const access = resolveSyncConflictAccess({
      sessionAccountId,
      scope,
      conflictOrganizationId: row.organizationId,
      recordResolved: fact !== undefined,
      ownerOrganizationId: fact?.ownerOrganizationId ?? null,
      relatedAccountIds: fact?.relatedAccountIds ?? [],
    });
    return access.allowed;
  }

  /** 批量取来源记录事实：按（资源类型，登记公司）分组取，避免跨公司串读 */
  private async resolveRecordFacts(
    rows: readonly SyncConflictMetadataRow[],
  ): Promise<Map<string, SyncSourceRecordFact>> {
    const facts = new Map<string, SyncSourceRecordFact>();
    const groups = new Map<
      string,
      { resourceType: SyncSourceResourceType; organizationId: number; recordUuids: string[] }
    >();

    for (const row of rows) {
      const resourceType = this.toSourceResourceType(row.resourceType);
      if (resourceType === null) {
        continue; // 非来源业务类型：取不到来源事实 → 按不可读处理
      }
      const key = `${resourceType}|${row.organizationId}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          resourceType,
          organizationId: row.organizationId,
          recordUuids: [row.recordUuid],
        });
      } else if (!group.recordUuids.includes(row.recordUuid)) {
        group.recordUuids.push(row.recordUuid);
      }
    }

    for (const group of groups.values()) {
      const result = await this.sourceRecordQueryService.listFacts({
        organizationId: group.organizationId,
        resourceType: group.resourceType,
        recordUuids: group.recordUuids,
      });
      for (const [uuid, fact] of result.facts) {
        facts.set(this.factKey(group.resourceType, uuid), fact);
      }
    }
    return facts;
  }

  /** 冲突的资源类型 → 来源业务类型；不在白名单内则无来源事实 */
  private toSourceResourceType(resourceType: string): SyncSourceResourceType | null {
    const matched = SYNC_SOURCE_RESOURCE_TYPES.find((candidate) => candidate === resourceType);
    return matched ?? null;
  }

  /** 事实索引键：资源类型＋稳定键，避免不同类型的同名键串读 */
  private factKey(resourceType: string, recordUuid: string): string {
    return `${resourceType}|${recordUuid}`;
  }
}
