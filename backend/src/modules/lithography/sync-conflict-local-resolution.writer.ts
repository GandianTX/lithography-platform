// src/modules/lithography/sync-conflict-local-resolution.writer.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type {
  SyncConflictLocalResolutionWriteCommand,
  SyncConflictLocalResolutionWriteOutcome,
  SyncConflictLocalResolutionWriter,
} from '@usecases/common/ports/sync-conflict-local-resolution-writer.contract';
import { ReferenceDocumentEffectiveContentService } from './reference-document-effective-content.service';
import { buildReferenceDocumentRevisionSnapshot } from './reference-document-revision-snapshot';
import {
  ReferenceDocumentRevisionService,
  type ReferenceDocumentRevisionTargetSnapshot,
} from './reference-document-revision.service';

/**
 * 「保留本地」的来源域受控写入实现（任务 09 第 05 项 · P1-5／G10）。
 *
 * 由**来源域**注册实现（中立契约 `SYNC_CONFLICT_LOCAL_RESOLUTION_WRITER`）：
 * 冲突编排只负责"能不能保留本地"的裁决与事务边界，
 * 真正的**业务行写入**在这里按来源业务的受控入口完成——
 * 与「使用云端」的本地视图对齐同一条纪律："不得绕过来源域的受控入口直接写业务表"。
 *
 * 资料分支的写入语义（与「使用云端」刻意不同）：
 * - **只写受控白名单字段**：标题 `title`、说明 `description`；
 * - **正文不反写**：「保留本地」要保留的就是本地正文本身，
 *   而资料的生效正文可能来自**冻结的维修报告版本**（`source_kind` 指向报告），
 *   用快照里的资料自身正文覆盖会让读侧回退到自身正文、丢掉冻结报告正文；
 * - **版本条件**：`expectedVersion` 必须等于资料当前 `current_revision_no`，
 *   条件更新命中 0 行即版本冲突（不覆盖别人的推进）；
 * - **历史只追加**：写一条新的修订历史行（前后完整快照＋修改人＋原因），
 *   原本地历史不被覆盖；
 * - **允许留痕型修订**：内容与当前一致时同样写修订行——
 *   保留本地的业务留痕不能因为"值没变"就丢掉。
 */
@Injectable()
export class SyncConflictLocalResolutionWriterService implements SyncConflictLocalResolutionWriter {
  readonly supportedResourceTypes: readonly string[] = ['REFERENCE_DOCUMENT'];

  constructor(
    private readonly documentRevisionService: ReferenceDocumentRevisionService,
    private readonly documentEffectiveContentService: ReferenceDocumentEffectiveContentService,
  ) {}

  async writeLocalVersion(
    command: SyncConflictLocalResolutionWriteCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SyncConflictLocalResolutionWriteOutcome> {
    const payload = command.payload;
    if (payload.resourceType !== 'REFERENCE_DOCUMENT') {
      throw new DomainError(
        SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED,
        '该资源类型还没有受控版本写入入口，不能执行保留本地裁决',
      );
    }

    const target = this.assertWritableDocument(
      await this.documentRevisionService.lockDocumentForRevision(
        command.recordId,
        transactionContext,
      ),
      command.expectedVersion,
    );

    // 当前生效正文（保留本地不改写正文 ⇒ 前后快照沿用同一生效正文，
    // 修订行因此不会把冻结报告正文换成资料自身正文）
    const effectiveContentText =
      await this.documentEffectiveContentService.resolveEffectiveContentText({
        documentId: target.id,
        effectiveRevisionNo: target.currentRevisionNo,
        sourceKind: target.sourceKind,
        sourceReportId: target.sourceReportId,
        sourceReportVersionId: target.sourceReportVersionId,
        contentText: target.contentText,
        transactionContext,
      });

    const nextTitle = payload.title ?? target.title;
    const nextDescription = payload.description ?? target.description;
    const nextRevisionNo = target.currentRevisionNo + 1;

    const beforeSnapshot = buildReferenceDocumentRevisionSnapshot({
      schemaVersion: target.schemaVersion,
      title: target.title,
      documentType: target.documentType,
      description: target.description,
      contentText: effectiveContentText,
      publicationStatus: target.publicationStatus,
      ownershipStatus: target.ownershipStatus,
      createdByAccountId: target.createdByAccountId,
      ownerOrganizationId: target.ownerOrganizationId,
    });
    const afterSnapshot = buildReferenceDocumentRevisionSnapshot({
      schemaVersion: target.schemaVersion,
      title: nextTitle,
      documentType: target.documentType,
      description: nextDescription,
      contentText: effectiveContentText,
      publicationStatus: target.publicationStatus,
      ownershipStatus: target.ownershipStatus,
      createdByAccountId: target.createdByAccountId,
      ownerOrganizationId: target.ownerOrganizationId,
    });

    const outcome = await this.documentRevisionService.advanceCurrentRevision(
      {
        documentId: command.recordId,
        expectedRevisionNo: command.expectedVersion,
        apply: {
          title: nextTitle,
          description: nextDescription,
          updatedByAccountId: command.actorAccountId,
          // 正文不反写：保留本地不改写资料正文（冻结报告正文不得被自身正文覆盖）
        },
      },
      transactionContext,
    );
    if (outcome === 'VERSION_CONFLICT') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '来源记录已被别处推进，请刷新后重新裁决',
      );
    }
    if (outcome !== 'ADVANCED') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_NOT_FOUND,
        '同步冲突的来源记录不存在或不可用，不能执行保留本地裁决',
      );
    }

    await this.documentRevisionService.insertRevision(
      {
        documentId: command.recordId,
        revisionNo: nextRevisionNo,
        beforeSnapshot: JSON.stringify(beforeSnapshot),
        afterSnapshot: JSON.stringify(afterSnapshot),
        actorAccountId: command.actorAccountId,
        reason: command.reason,
      },
      transactionContext,
    );

    return { written: true, writtenVersion: nextRevisionNo };
  }

  /**
   * 受控写入前的来源事实守卫：不可用／只读／版本条件不成立一律拒绝。
   *
   * 返回收窄后的目标行（不可用时直接抛错 ⇒ 调用方拿到的一定是可写目标）。
   */
  private assertWritableDocument(
    target: ReferenceDocumentRevisionTargetSnapshot | null,
    expectedVersion: number,
  ): ReferenceDocumentRevisionTargetSnapshot {
    if (target === null || target.deprecated) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_NOT_FOUND,
        '同步冲突的来源记录不存在或不可用，不能执行保留本地裁决',
      );
    }
    // 只读来源不得反写：下架（撤回）与归属待确认（冻结）一律拒绝
    if (target.publicationStatus === 'OFFLINE') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
        '来源记录已删除或下架，不得写回内容',
      );
    }
    if (target.ownershipStatus === 'PENDING') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
        '来源记录正在被别处推进（冻结），不得写回内容',
      );
    }
    if (target.currentRevisionNo !== expectedVersion) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '来源记录已被别处推进，请刷新后重新裁决',
      );
    }
    return target;
  }
}
