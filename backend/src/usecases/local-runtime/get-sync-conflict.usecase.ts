// src/usecases/local-runtime/get-sync-conflict.usecase.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { computeSyncConflictDiff } from '@core/local-runtime/policy/sync-conflict-diff.policy';
import { resolveSyncConflictReadOnly } from '@core/local-runtime/policy/sync-conflict-readonly.policy';
import { Injectable } from '@nestjs/common';
import type { GetSyncConflictCommand } from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import { SyncConflictQueryService } from '@src/modules/lithography/queries/sync-conflict.query.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import type { SyncConflictSnapshot } from '@src/modules/lithography/sync.types';

/**
 * 冲突详情（任务 09 S2.2／R066／后续S2）：三方版本、本地/云端快照与可展示原因。
 *
 * 范围内才可见；范围外与不存在同码返回，不区分"没有"与"不让你看"，
 * 避免通过错误码差异探测其他公司数据区。
 *
 * 后续S2 增补（任务书 S2.2「冲突先查元数据授权再读正文」）：
 * 先只读冲突元数据并做**记录级**授权裁决，授权通过后才读取正文快照；
 * 授权不通过与范围外同码返回，不区分原因，避免暴露"这条冲突存在但你不能看"。
 */
@Injectable()
export class GetSyncConflictUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly syncConflictQueryService: SyncConflictQueryService,
    private readonly syncConflictAccessResolver: SyncConflictAccessResolver,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
  ) {}

  async execute(command: GetSyncConflictCommand): Promise<SyncConflictSnapshot> {
    const scope = await this.scopeResolver.resolve(command.session);
    const metadata = await this.syncConflictQueryService.readMetadataById(
      command.conflictId,
      scope.organizationId,
    );
    if (metadata === null) {
      throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
    }

    const readable = await this.syncConflictAccessResolver.filterReadable({
      sessionAccountId: command.session.accountId,
      scope,
      rows: [metadata],
    });
    if (readable.length === 0) {
      throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
    }

    const snapshots = await this.syncConflictQueryService.readSnapshots([metadata.conflictId]);
    const payload = snapshots.get(metadata.conflictId);
    if (payload === undefined) {
      throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
    }

    // 来源事实：给出"来源页入口"所需的本机 ID 与只读标记；取不到即如实为空
    const source = await this.readSourceFacts(metadata);

    return {
      conflictId: metadata.conflictId,
      recordUuid: metadata.recordUuid,
      organizationId: metadata.organizationId,
      resourceType: metadata.resourceType,
      versionNo: metadata.versionNo,
      localVersion: metadata.localVersion,
      cloudVersion: metadata.cloudVersion,
      displayedCloudVersion: metadata.displayedCloudVersion,
      decision: metadata.decision,
      status: metadata.status,
      localSnapshot: payload.localSnapshot,
      cloudSnapshot: payload.cloudSnapshot,
      conflictReason: metadata.conflictReason,
      sourceRecordId: source.recordId,
      sourceReadOnly: source.readOnly,
      sourceReadOnlyReason: source.readOnlyReason,
      // 字段级差异：页面据此展示"哪里不一样"，比较口径统一在后端
      diff: computeSyncConflictDiff({
        localSnapshot: payload.localSnapshot,
        cloudSnapshot: payload.cloudSnapshot,
      }),
      confirmedByAccountId: metadata.confirmedByAccountId,
      confirmedAt: metadata.confirmedAt,
      createdAt: metadata.createdAt,
    };
  }

  /**
   * 读取来源事实：只取本机 ID 与只读标记。
   *
   * 取不到（资源类型不在白名单／记录已删除／归属已变更）时如实返回空值：
   * 页面据此不提供来源页跳转，而不是猜一个可能指错的路径。
   */
  private async readSourceFacts(metadata: {
    recordUuid: string;
    organizationId: number;
    resourceType: string;
  }): Promise<{ recordId: number | null; readOnly: boolean; readOnlyReason: string | null }> {
    const resourceType = SYNC_SOURCE_RESOURCE_TYPES.find(
      (candidate) => candidate === metadata.resourceType,
    );
    if (resourceType === undefined) {
      return { recordId: null, readOnly: false, readOnlyReason: null };
    }
    const facts = await this.sourceRecordQueryService.listFacts({
      organizationId: metadata.organizationId,
      resourceType: resourceType,
      recordUuids: [metadata.recordUuid],
    });
    const fact = facts.facts.get(metadata.recordUuid);
    if (fact === undefined) {
      return { recordId: null, readOnly: false, readOnlyReason: null };
    }
    const readOnly = resolveSyncConflictReadOnly(fact.contentState);
    return {
      recordId: fact.recordId,
      readOnly: readOnly.readOnly,
      readOnlyReason: readOnly.reason,
    };
  }
}
