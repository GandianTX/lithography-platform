// src/usecases/local-runtime/sync-conflict-access.resolver.ts

import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import {
  resolveSyncConflictAccess,
  type SyncConflictAccessOutcome,
} from '@core/local-runtime/policy/sync-conflict-access.policy';
import {
  resolveSyncConflictCloudAdoption,
  resolveSyncConflictReadOnly,
} from '@core/local-runtime/policy/sync-conflict-readonly.policy';
import { Injectable } from '@nestjs/common';

import type { SyncConflictMetadataRow } from '@src/modules/lithography/queries/sync-conflict.query.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
  type SyncSourceRecordFact,
  type SyncSourceResourceType,
} from '@src/modules/lithography/queries/sync-source-record.query.service';

/**
 * 来源记录的**只读／采用准入**事实（清单与详情共用）。
 *
 * 取不到来源事实时如实返回"不可采用"：读不到依据不等于可以采用。
 */
export type SyncConflictSourceState = {
  /** 来源记录的本机 ID；取不到时为 null（页面据此不提供来源页跳转） */
  recordId: number | null;
  /** 来源内容是否只读（已删除／下架／冻结／结单） */
  readOnly: boolean;
  /** 只读受控原因码 */
  readOnlyReason: string | null;
  /** 是否允许采用云端视图（R066） */
  canAdoptCloud: boolean;
  /** 是否为只读采用（来源已结单：只呈现视图，不写业务记录） */
  adoptionReadOnly: boolean;
};

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
    const { readable } = await this.filterReadableWithFacts(params);
    return readable;
  }

  /**
   * 过滤出可读的冲突条目，并**同时**返回本次取到的来源事实。
   *
   * 清单与详情都需要来源事实（只读标记与采用准入）；
   * 一次解析两处复用，避免同一页重复回表。
   */
  async filterReadableWithFacts(params: {
    sessionAccountId: number;
    scope: LocalRuntimeViewerScope;
    rows: readonly SyncConflictMetadataRow[];
  }): Promise<{
    readable: SyncConflictMetadataRow[];
    facts: Map<string, SyncSourceRecordFact>;
  }> {
    if (params.rows.length === 0) {
      return { readable: [], facts: new Map() };
    }
    const facts = await this.resolveRecordFacts(params.rows);
    const readable: SyncConflictMetadataRow[] = [];
    for (const row of params.rows) {
      if (this.isReadableRow(row, facts, params.sessionAccountId, params.scope)) {
        readable.push(row);
      }
    }
    return { readable, facts };
  }

  /**
   * 来源记录的只读标记与采用准入（纯装配；事实已由 resolveRecordFacts 取回）。
   *
   * 口径与裁决侧一致（R066）：
   * - 已删除／下架、冻结 ⇒ 不可采用云端；
   * - 已结单 ⇒ 允许**只读采用**（不写业务记录、不获得写入权）；
   * - 事实取不到 ⇒ 不可采用（读不到依据不等于可以采用）。
   */
  resolveSourceState(
    row: Pick<SyncConflictMetadataRow, 'resourceType' | 'recordUuid'>,
    facts: ReadonlyMap<string, SyncSourceRecordFact>,
  ): SyncConflictSourceState {
    const fact = facts.get(this.factKey(row.resourceType, row.recordUuid));
    if (fact === undefined) {
      return {
        recordId: null,
        readOnly: false,
        readOnlyReason: null,
        canAdoptCloud: false,
        adoptionReadOnly: false,
      };
    }
    const readOnly = resolveSyncConflictReadOnly(fact.contentState);
    const adoption = resolveSyncConflictCloudAdoption(fact.contentState);
    return {
      recordId: fact.recordId,
      readOnly: readOnly.readOnly,
      readOnlyReason: readOnly.reason,
      canAdoptCloud: adoption.adoptable,
      adoptionReadOnly: adoption.readOnlyAdoption,
    };
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

  /**
   * 单条授权判定（**写侧**用；裁决前必须复核）。
   *
   * 为什么写侧也要走这里：此前裁决只按"冲突登记公司"命中范围就放行，
   * 而读侧口径是"按**来源记录归属**判定"（登记公司不参与放行）。
   * 写权宽于读权时，同公司内不可读的冲突也能被裁决并留下账号痕迹。
   * 口径统一到读侧同一策略，避免出现"看不见却能改"。
   *
   * 取不到来源事实时按不可读处理（读不到授权依据不等于有权写）。
   */
  async resolveRowAccess(params: {
    row: Pick<SyncConflictMetadataRow, 'recordUuid' | 'organizationId' | 'resourceType'>;
    sessionAccountId: number;
    scope: LocalRuntimeViewerScope;
  }): Promise<SyncConflictAccessOutcome> {
    const facts = await this.resolveRecordFacts([params.row]);
    const fact = facts.get(this.factKey(params.row.resourceType, params.row.recordUuid));
    return resolveSyncConflictAccess({
      sessionAccountId: params.sessionAccountId,
      scope: params.scope,
      conflictOrganizationId: params.row.organizationId,
      recordResolved: fact !== undefined,
      ownerOrganizationId: fact?.ownerOrganizationId ?? null,
      relatedAccountIds: fact?.relatedAccountIds ?? [],
    });
  }

  /** 批量取来源记录事实：按（资源类型，登记公司）分组取，避免跨公司串读 */
  async resolveRecordFacts(
    rows: readonly Pick<
      SyncConflictMetadataRow,
      'recordUuid' | 'organizationId' | 'resourceType'
    >[],
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
