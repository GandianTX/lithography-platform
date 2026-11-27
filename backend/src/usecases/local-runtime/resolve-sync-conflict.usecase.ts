// src/usecases/local-runtime/resolve-sync-conflict.usecase.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  resolveSyncConflictOutcome,
  type SyncConflictDecision,
  type SyncConflictStatus,
} from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import { resolveSyncConflictCloudAdoption } from '@core/local-runtime/policy/sync-conflict-readonly.policy';
import { resolveSyncConflictVersionFreshness } from '@core/local-runtime/policy/sync-conflict-version.policy';
import { planCloudConflictAlignment } from '@core/local-runtime/policy/sync-conflict-cloud-alignment.policy';
import { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import type {
  ResolveSyncConflictCommand,
  SyncConflictResolveOutcomeView,
} from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  SYNC_CONFLICT_LOCAL_VIEW_WRITER,
  type SyncConflictLocalViewWriter,
} from '@src/usecases/common/ports/sync-conflict-local-view-writer.contract';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

/**
 * 「使用云端」对齐本地视图的修订原因（进修订历史行；调用方补冲突 ID）。
 */
export const CLOUD_ALIGNMENT_REVISION_REASON = '同步冲突裁决：采用云端版本';

/**
 * 冲突裁决（任务 09 S2.2／R067–R069／R-03）。
 *
 * - 锁读在事务内完成，判定交给 core 策略，写入交给模块服务；
 * - 重复相同方向返回既有事实（`outcome='existing'`），不重复写；
 * - 稍后处理（`outcome='later'`）保持 PENDING，确认人保持为空；
 * - 使用云端（`CLOUD`）**先对齐本地当前有权视图、再落裁决事实**（R068）：
 *   对齐由**来源域的受控写入入口**执行（中立端口），本用例只做裁决与事务边界；
 *   **对齐失败即整体回滚**，不标 resolved（R068「对齐失败不得标 resolved」）；
 *   云端原记录与原本地历史一律不动（R068）；
 * - **写侧与读侧同一授权口径**：裁决前按**来源记录归属**复核记录级权限
 *   （登记公司不参与放行），避免"看不见却能改"；
 * - **写侧复核展示版本**：冲突登记的本地版本必须仍是来源记录的当前版本，
 *   否则用户裁决的是过期内容，拒绝执行；
 * - 保留本地（`LOCAL`）**不在本用例处理**：它是管理员动作，由管理员文档库域的
 *   受控修订入口执行（任务 04 的工单受控修订入口），GraphQL 层按动作分派；
 *   本用例收到 LOCAL 时显式失败，避免跨域再实现一套权限口径；
 * - 确认人取自 Session（数据库复核后的账号），不接受客户端传入；
 * - 返回体只给冲突**摘要**：裁决是一次写动作，没有必要再带两份正文快照。
 */
@Injectable()
export class ResolveSyncConflictUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly syncConflictService: SyncConflictService,
    private readonly accessResolver: SyncConflictAccessResolver,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    /**
     * 本地视图对齐的**来源域受控写入入口**（中立端口）。
     *
     * 未注册即失败关闭：不静默降级为"只改冲突事实"——
     * 那会让用户看到"冲突已解决"而本地视图仍是旧内容（R068 的核心缺陷）。
     */
    @Optional()
    @Inject(SYNC_CONFLICT_LOCAL_VIEW_WRITER)
    private readonly localViewWriter?: SyncConflictLocalViewWriter,
  ) {}

  async execute(command: ResolveSyncConflictCommand): Promise<SyncConflictResolveOutcomeView> {
    const scope = await this.scopeResolver.resolve(command.session);

    const prepared = await this.transactionRunner.run(async (transactionContext) => {
      const locked = await this.syncConflictService.lockConflictView(
        command.conflictId,
        transactionContext,
      );
      if (!locked) {
        throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
      }
      // 范围校验：一级管理员（organizationId=null）可见全部，其余必须命中本公司数据区
      if (scope.organizationId !== null && locked.organizationId !== scope.organizationId) {
        throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
      }

      // 恢复期冻结：该公司数据区正在恢复时不得执行裁决（裁决会回写业务记录版本）
      // 事务内版本：取范围共享锁并锁定读冻结事实 ⇒ 与恢复建立冻结互斥（P1-1）
      await this.localWriteHoldService.assertCompanyWritableInTransaction({
        organizationId: locked.organizationId,
        transactionContext,
      });

      const outcome = resolveSyncConflictOutcome(
        {
          status: locked.status as SyncConflictStatus,
          decision: locked.decision as SyncConflictDecision | null,
        },
        command.action,
      );

      if (outcome.kind === 'later') {
        return { kind: 'later' as const };
      }

      if (outcome.kind === 'existing') {
        return { kind: 'existing' as const };
      }

      if (outcome.action === 'CLOUD') {
        // 云端版本复核（R067）：客户端必须提交**实际看到**的云端版本，
        // 服务端与冲突登记的云端版本逐一对齐；云端已变化 ⇒ 刷新重确认，
        // 不信任前端带来的版本或快照。
        this.assertDisplayedCloudVersion(locked, command.displayedCloudVersion);

        // 写侧授权复核：与读侧同一口径（按来源记录归属判定，登记公司不参与放行）
        const access = await this.accessResolver.resolveRowAccess({
          row: {
            recordUuid: locked.recordUuid,
            organizationId: locked.organizationId,
            resourceType: locked.resourceType,
          },
          sessionAccountId: command.session.accountId,
          scope,
        });
        if (!access.allowed) {
          // 与读侧一致：不通过存在性泄露（与"不存在"同码同文案）
          throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
        }

        // 来源事实复核：采用准入（R066）＋ 展示版本新鲜度（R067）
        const adoption = await this.assertAdoptableAndFresh(locked);

        // 本地视图对齐（R068）：**先对齐本地当前有权视图，再落裁决事实**。
        // 对齐在同一个事务里做 ⇒ 对齐失败即整体回滚 ⇒ 不标 resolved。
        await this.alignLocalViewToCloud({
          locked,
          readOnlyAdoption: adoption.readOnlyAdoption,
          recordId: adoption.recordId,
          sessionAccountId: command.session.accountId,
          transactionContext,
        });

        const affected = await this.syncConflictService.applyCloudResolution(
          {
            conflictId: command.conflictId,
            action: 'CLOUD',
            confirmedByAccountId: command.session.accountId,
            // 本地视图对齐到云端版本：冲突行登记的本地版本推进到云端版本，
            // 读侧据此呈现"本地视图已对齐"；只读采用（已结单）同样只对齐**视图**，
            // 不写业务记录、不改历史（R066）。
            displayedCloudVersion: locked.cloudVersion,
            alignedLocalVersion: locked.cloudVersion,
          },
          new Date(),
          transactionContext,
        );
        // 持锁情况下 0 行只可能是并发已裁决：回读既有事实，不覆盖
        return { kind: affected === 0 ? ('existing' as const) : ('resolved' as const) };
      }

      // LOCAL：保留本地是管理员动作，由管理员文档库域的受控修订入口执行；
      // 本用例只处理"使用云端"与"稍后处理"（跨域不重复实现权限口径）。
      // 载荷映射与资源类型准入见 core/local-runtime/policy/sync-conflict-local-resolution.policy.ts。
      throw new DomainError(
        SYNC_ERROR.LOCAL_RESOLUTION_REQUIRES_ADMIN_ENTRY,
        '保留本地需通过管理员受控修订入口执行',
      );
    });

    return {
      outcome: prepared.kind,
      conflict: await this.syncConflictService.readConflictSummaryById(command.conflictId),
    };
  }

  /**
   * 云端版本复核（R067）：客户端提交**实际看到**的云端版本，服务端逐一对齐。
   *
   * - 客户端未提交版本 ⇒ 拒绝（不允许"盲裁决"）；
   * - 提交版本与冲突登记的云端版本不一致 ⇒ 云端已变化，要求刷新后重新确认。
   *
   * 不信任前端带来的快照或版本号：一切以服务端冲突行的登记事实为准。
   */
  private assertDisplayedCloudVersion(
    locked: { cloudVersion: number | null },
    displayedCloudVersion: number | null | undefined,
  ): void {
    if (displayedCloudVersion === null || displayedCloudVersion === undefined) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '未提交所看到的云端版本，不能执行裁决；请刷新后重新确认',
      );
    }
    if (locked.cloudVersion === null) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '同步冲突的云端版本不可核验，不能执行裁决；请刷新后重新确认',
      );
    }
    if (displayedCloudVersion !== locked.cloudVersion) {
      throw new DomainError(SYNC_ERROR.CONFLICT_VERSION_STALE, '云端版本已变化，请刷新后重新确认');
    }
  }

  /**
   * 采用准入 ＋ 展示版本新鲜度复核（纯读取一次来源事实）。
   *
   * - 采用准入（R066）：已删除／下架、冻结一律拒绝；**已结单允许只读采用**
   *   （只呈现云端视图，不写业务记录、不获得写入权）；
   * - 新鲜度（R067）：冲突登记的本地版本必须仍是来源记录的当前版本。
   */
  private async assertAdoptableAndFresh(locked: {
    recordUuid: string;
    organizationId: number;
    resourceType: string;
    localVersion: number | null;
    cloudVersion: number | null;
  }): Promise<{ readOnlyAdoption: boolean; recordId: number }> {
    const resourceType = SYNC_SOURCE_RESOURCE_TYPES.find(
      (candidate) => candidate === locked.resourceType,
    );
    if (resourceType === undefined) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '同步冲突的来源记录不可核验，不能按当前展示版本执行裁决',
      );
    }
    const facts = await this.sourceRecordQueryService.listFacts({
      organizationId: locked.organizationId,
      resourceType,
      recordUuids: [locked.recordUuid],
    });
    const fact = facts.facts.get(locked.recordUuid);

    // 采用准入：只读事实缺失（事实不完整）同样失败关闭——读不到只读事实不等于可以写。
    const contentState = fact?.contentState ?? {
      withdrawn: false,
      frozen: true,
      closed: false,
    };
    const adoption = resolveSyncConflictCloudAdoption(contentState);
    if (!adoption.adoptable) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
        adoption.reason === 'SOURCE_WITHDRAWN'
          ? '来源记录已删除或下架，不得用云端版本恢复内容'
          : '来源记录正在被别处推进（冻结），不得用云端版本恢复内容',
      );
    }

    const freshness = resolveSyncConflictVersionFreshness({
      conflictLocalVersion: locked.localVersion,
      recordCurrentVersion: fact?.currentVersion ?? null,
      versionTrusted: fact?.versionTrusted ?? false,
    });
    if (!freshness.fresh) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '同步冲突的展示版本已不是来源记录的当前版本，请刷新后重新裁决',
      );
    }
    if (fact === undefined) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_NOT_FOUND,
        '同步冲突的来源记录不可用，不能对齐本地视图',
      );
    }
    return { readOnlyAdoption: adoption.readOnlyAdoption, recordId: fact.recordId };
  }

  /**
   * 对齐本地当前有权视图（R068）。
   *
   * 三种情形：
   * 1. **只读采用**（来源已结单）：只呈现云端视图，
   *    **不写业务记录、不改历史**（R066／R068）；
   * 2. **可写来源**：按版本条件把云端快照里的受控字段落成本地当前视图，
   *    由**来源域的受控写入入口**执行（中立端口），本用例不直接写业务表；
   * 3. **不支持／快照不合法／入口未注册**：失败关闭，不标 resolved。
   *
   * 与裁决事实在**同一事务**内：任一步失败都整体回滚，
   * 不会出现"本地视图改了但冲突还挂着"或"冲突结了但本地视图没改"。
   */
  private async alignLocalViewToCloud(input: {
    locked: {
      conflictId: string;
      organizationId: number;
      resourceType: string;
      localVersion: number | null;
      cloudSnapshot: string;
    };
    readOnlyAdoption: boolean;
    recordId: number;
    sessionAccountId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    const plan = planCloudConflictAlignment({
      resourceType: input.locked.resourceType,
      localVersion: input.locked.localVersion,
      cloudSnapshot: input.locked.cloudSnapshot,
      readOnlyAdoption: input.readOnlyAdoption,
    });
    if (plan.kind === 'reject') {
      throw new DomainError(plan.code, plan.message);
    }
    if (plan.kind === 'view-only') {
      // 只读采用：只呈现云端视图，不写业务记录、不改历史（R066／R068）
      return;
    }

    const writer = this.localViewWriter;
    if (writer === undefined) {
      throw new DomainError(
        SYNC_ERROR.CLOUD_ALIGNMENT_UNAVAILABLE,
        '本地视图对齐入口未注册，不能执行使用云端裁决',
      );
    }
    if (!writer.supportedResourceTypes.includes(plan.payload.resourceType)) {
      throw new DomainError(
        SYNC_ERROR.CLOUD_ALIGNMENT_RESOURCE_UNSUPPORTED,
        '该资源类型还没有受控的本地视图对齐入口，不能执行使用云端裁决',
      );
    }
    await writer.alignLocalViewToCloud(
      {
        organizationId: input.locked.organizationId,
        recordId: input.recordId,
        payload: plan.payload,
        actorAccountId: input.sessionAccountId,
        reason: `${CLOUD_ALIGNMENT_REVISION_REASON}（冲突 ${input.locked.conflictId}）`,
      },
      input.transactionContext,
    );
  }
}
