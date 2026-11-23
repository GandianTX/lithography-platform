// src/modules/lithography/reference-document-revision.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository, type QueryDeepPartialEntity } from 'typeorm';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { ReferenceDocumentRevisionEntity } from './entities/reference-document-revision.entity';

/**
 * 资料行的受控写入目标快照（任务 09 R068 本地视图对齐用）。
 *
 * 只含**受控白名单字段**与判定所需事实；不含存储引用与扩展属性。
 */
export type ReferenceDocumentRevisionTargetSnapshot = {
  id: number;
  title: string;
  documentType: string;
  description: string | null;
  contentText: string | null;
  publicationStatus: string;
  ownershipStatus: string;
  ownerOrganizationId: number | null;
  createdByAccountId: number;
  schemaVersion: number;
  currentRevisionNo: number;
  deprecated: boolean;
  sourceKind: string;
  sourceReportId: number | null;
  sourceReportVersionId: number | null;
};

/**
 * 资料管理操作允许同语句推进的列白名单（任务 07 R053/R058–R061）。
 *
 * 只开放业务确认过的字段：正文/标题/说明（R058）、发布状态（R059）、
 * 软删标记（R053/R060）、归属字段与归属核实状态（R061）。
 * updatedByAccountId 由各 usecase 统一传入实际操作人（不冒充作者）。
 */
export type ReferenceDocumentRevisionApply = {
  title?: string;
  description?: string | null;
  contentText?: string | null;
  publicationStatus?: 'ONLINE' | 'OFFLINE';
  ownershipStatus?: 'CONFIRMED' | 'PENDING';
  createdByAccountId?: number;
  ownerOrganizationId?: number | null;
  updatedByAccountId?: number;
  /**
   * 结构化管理修订改选机型（任务 07）：显式变更时写入资料自身关联列，
   * 并同步清空互斥的手填机型文字（chk_reference_document_model_exclusive）。
   * 存在性与启用状态由 usecase 事务内校验（findModelById FOR UPDATE）；
   * 不改来源工单、原始冻结报告与机型字典。
   */
  equipmentModelId?: number;
  /**
   * 管理删除（R060）与原作者删除（R053）：deprecated 与 deleted_at 同语句写入，
   * 满足删除一致性 CHECK（chk_reference_document_deletion_consistency）。
   */
  markDeleted?: boolean;
};

/**
 * 资料修订写服务（任务 07）。
 *
 * 职责范围：
 * - 追加 reference_document_revision 生效修订行（前后快照 JSON、操作者、原因）；
 * - 以条件更新原子推进 reference_document.current_revision_no 并应用白名单字段；
 *
 * 不包含：
 * - 权限判断、状态白名单、快照组装等业务决策（归 usecase）；
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有）；
 * - 审计写入（由 usecase 在同一事务内经 ManagementAuditService 编排）。
 *
 * 并发口径：调用方先用 findDetail(forUpdate) 锁定资料行并核对
 * expected_version（current_revision_no），本服务的条件更新把
 * current_revision_no = expected 作为 WHERE 条件兜底——行锁意外失效或
 * 调用方漏锁时更新不生效，不会出现「旧版本覆盖新版本」的半写。
 */
@Injectable()
export class ReferenceDocumentRevisionService {
  constructor(
    @InjectRepository(ReferenceDocumentRevisionEntity)
    private readonly revisionRepository: Repository<ReferenceDocumentRevisionEntity>,
    @InjectRepository(ReferenceDocumentEntity)
    private readonly documentRepository: Repository<ReferenceDocumentEntity>,
  ) {}

  /**
   * 资料行锁读（pessimistic_write）与目标快照装配。
   *
   * 供「使用云端」的本地视图对齐（任务 09 R068）使用：
   * 调用方先持锁核对 `current_revision_no`，再用条件更新推进版本，
   * 避免"读-改-写"交错导致覆盖别人的推进。
   *
   * 不存在时返回 null（由调用方失败关闭），不返回"空资料"。
   */
  async lockDocumentForRevision(
    documentId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentRevisionTargetSnapshot | null> {
    const repository = this.getDocumentRepository(transactionContext);
    try {
      const entity = await repository.findOne({
        where: { id: documentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entity) {
        return null;
      }
      return {
        id: entity.id,
        title: entity.title,
        documentType: entity.documentType,
        description: entity.description,
        contentText: entity.contentText,
        publicationStatus: entity.publicationStatus,
        ownershipStatus: entity.ownershipStatus,
        ownerOrganizationId: entity.ownerOrganizationId,
        createdByAccountId: entity.createdByAccountId,
        schemaVersion: entity.schemaVersion,
        currentRevisionNo: entity.currentRevisionNo,
        deprecated: entity.deprecated,
        sourceKind: entity.sourceKind,
        sourceReportId: entity.sourceReportId,
        sourceReportVersionId: entity.sourceReportVersionId,
      };
    } catch (error) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
        '参考资料修订失败，请稍后重试',
        { id: documentId },
        error,
      );
    }
  }

  /**
   * 读取指定生效修订版本的正文（`after_snapshot.contentText`）。
   *
   * - `found=false`：该修订行**不存在**（数据定式破坏，调用方须失败关闭，
   *   不得回退资料自身正文冒充历史）；
   * - `found=true` 且 `contentText=null`：修订行在，但快照里没有正文键
   *   （历史快照 schema 差异，读侧按空值降级）。
   */
  async findRevisionContentText(
    documentId: number,
    revisionNo: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ found: boolean; contentText: string | null }> {
    const repository = this.getRevisionRepository(transactionContext);
    const row = await repository.findOne({ where: { documentId, revisionNo } });
    if (!row) {
      return { found: false, contentText: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.afterSnapshot);
    } catch {
      return { found: true, contentText: null };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { found: true, contentText: null };
    }
    const contentText = (parsed as Record<string, unknown>).contentText;
    return { found: true, contentText: typeof contentText === 'string' ? contentText : null };
  }

  /**
   * 追加生效修订行（revisionNo 必须是 expected+1，由调用方核对后传入）。
   * 唯一键 (document_id, revision_no) 兜底重复写入；快照 JSON 由数据库
   * chk_reference_document_revision_schema 校验 schema_version 存在。
   */
  async insertRevision(
    data: {
      documentId: number;
      revisionNo: number;
      beforeSnapshot: string;
      afterSnapshot: string;
      actorAccountId: number;
      reason: string;
    },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRevisionRepository(transactionContext);
    try {
      await repository.insert({
        documentId: data.documentId,
        revisionNo: data.revisionNo,
        beforeSnapshot: data.beforeSnapshot,
        afterSnapshot: data.afterSnapshot,
        actorAccountId: data.actorAccountId,
        reason: data.reason,
      });
    } catch (error) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
        '参考资料修订历史写入失败，请稍后重试',
        { id: data.documentId },
        error,
      );
    }
  }

  /**
   * 条件推进生效版本并应用白名单字段（单语句原子更新）。
   *
   * WHERE id + current_revision_no = expected + 未软删；未命中说明资料不存在、
   * 已软删或版本已过期，按状态事实返回，由 usecase 统一映射为
   * NOT_FOUND / VERSION_CONFLICT（不泄漏删除状态）。
   */
  async advanceCurrentRevision(
    params: {
      documentId: number;
      expectedRevisionNo: number;
      apply: ReferenceDocumentRevisionApply;
    },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<'ADVANCED' | 'NOT_FOUND' | 'VERSION_CONFLICT'> {
    const repository = this.getDocumentRepository(transactionContext);
    const { apply } = params;
    const payload: QueryDeepPartialEntity<ReferenceDocumentEntity> = {
      currentRevisionNo: params.expectedRevisionNo + 1,
    };
    if (apply.title !== undefined) payload.title = apply.title;
    if (apply.description !== undefined) payload.description = apply.description;
    if (apply.contentText !== undefined) payload.contentText = apply.contentText;
    if (apply.publicationStatus !== undefined) payload.publicationStatus = apply.publicationStatus;
    if (apply.ownershipStatus !== undefined) payload.ownershipStatus = apply.ownershipStatus;
    if (apply.createdByAccountId !== undefined)
      payload.createdByAccountId = apply.createdByAccountId;
    if (apply.ownerOrganizationId !== undefined)
      payload.ownerOrganizationId = apply.ownerOrganizationId;
    if (apply.updatedByAccountId !== undefined)
      payload.updatedByAccountId = apply.updatedByAccountId;
    if (apply.equipmentModelId !== undefined) {
      // 机型改选：写 ID 并同步清空互斥手填文字（CHECK 要求二者恰一为空）
      payload.equipmentModelId = apply.equipmentModelId;
      payload.equipmentModelText = null;
    }
    if (apply.markDeleted === true) {
      payload.deprecated = true;
      payload.deletedAt = () => 'CURRENT_TIMESTAMP(3)';
      payload.publicationStatus = 'OFFLINE';
    }

    let affected: number;
    try {
      const result = await repository.update(
        {
          id: params.documentId,
          deprecated: false,
          currentRevisionNo: params.expectedRevisionNo,
        },
        payload,
      );
      affected = result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
        '参考资料管理修订推进失败，请稍后重试',
        { id: params.documentId },
        error,
      );
    }

    if (affected === 1) return 'ADVANCED';
    // 条件未命中：区分「行不存在/已软删」与「版本过期」需要额外读取；
    // 调用方已持锁核对过版本，未命中在业务上只能是行事实变化，统一按
    // 版本冲突事实返回，由 usecase 决定对外口径（R053/R060 映射 NOT_FOUND）。
    return 'VERSION_CONFLICT';
  }

  private getRevisionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentRevisionEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ReferenceDocumentRevisionEntity)
      : this.revisionRepository;
  }

  private getDocumentRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(ReferenceDocumentEntity) : this.documentRepository;
  }
}
