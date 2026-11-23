// src/usecases/local-runtime/get-sync-conflict.usecase.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { computeSyncConflictDiff } from '@core/local-runtime/policy/sync-conflict-diff.policy';
import { Injectable } from '@nestjs/common';
import type { GetSyncConflictCommand } from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import { SyncConflictQueryService } from '@src/modules/lithography/queries/sync-conflict.query.service';
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

    // 来源事实：给出"来源页入口"所需的本机 ID、只读标记与采用准入；
    // 与冲突清单同一解析口径（同一 resolver），取不到即如实为空
    const facts = await this.syncConflictAccessResolver.resolveRecordFacts([metadata]);
    const source = this.syncConflictAccessResolver.resolveSourceState(metadata, facts);

    // 本地视图是否已对齐到云端（采用云端后）：
    // 对齐只改**视图呈现**（本地侧展示云端内容、版本推进到云端版本），
    // 原本地冲突副本在冲突行里原样保留，不改写、不覆盖。
    const alignedToCloud = metadata.decision === 'CLOUD' && metadata.status === 'RESOLVED';
    const localSnapshot = alignedToCloud ? payload.cloudSnapshot : payload.localSnapshot;

    return {
      conflictId: metadata.conflictId,
      recordUuid: metadata.recordUuid,
      organizationId: metadata.organizationId,
      resourceType: metadata.resourceType,
      versionNo: metadata.versionNo,
      localVersion: alignedToCloud
        ? (metadata.cloudVersion ?? metadata.localVersion)
        : metadata.localVersion,
      cloudVersion: metadata.cloudVersion,
      displayedCloudVersion: metadata.displayedCloudVersion,
      decision: metadata.decision,
      status: metadata.status,
      localSnapshot,
      cloudSnapshot: payload.cloudSnapshot,
      conflictReason: metadata.conflictReason,
      sourceRecordId: source.recordId,
      sourceReadOnly: source.readOnly,
      sourceReadOnlyReason: source.readOnlyReason,
      canAdoptCloud: source.canAdoptCloud,
      adoptionReadOnly: source.adoptionReadOnly,
      // 字段级差异：页面据此展示"哪里不一样"，比较口径统一在后端
      diff: computeSyncConflictDiff({
        localSnapshot,
        cloudSnapshot: payload.cloudSnapshot,
      }),
      confirmedByAccountId: metadata.confirmedByAccountId,
      confirmedAt: metadata.confirmedAt,
      createdAt: metadata.createdAt,
    };
  }
}
