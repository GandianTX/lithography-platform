// src/modules/lithography/reference-document.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository, type QueryDeepPartialEntity } from 'typeorm';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import {
  ReferenceDocumentDeleteOutcome,
  ReferenceDocumentInsertData,
  ReferenceDocumentUpdateData,
} from './lithography.types';

/**
 * AI 参考资料写服务
 *
 * 职责范围：
 * - 参考资料插入（显式落初始状态：未软删；本周仅 contentText 内容来源，存储字段留空）
 * - 参考资料编辑（全量覆盖式更新，写入数据由 usecase 完成合并与校验）
 * - 参考资料原子条件软删除（deprecated 与 deleted_at 同事务写入，满足
 *   实体 chk_reference_document_deletion_consistency；不执行物理 DELETE）
 *
 * 不包含：
 * - 权限判断、输入规范化、字段合并等业务决策（归 usecase）
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有）
 */
@Injectable()
export class ReferenceDocumentService {
  constructor(
    @InjectRepository(ReferenceDocumentEntity)
    private readonly repository: Repository<ReferenceDocumentEntity>,
  ) {}

  /**
   * 插入参考资料记录
   *
   * 初始状态由本方法统一保证：
   * - deprecated = false，deletedAt 为 NULL；
   * - ownerOrganizationId / ingestMethod 由 usecase 传入（可信组织上下文与入库方式
   *   判定均归 usecase，本层不自行推断，也不接受客户端直传）；
   * - 内容来源为正文或存储引用至少一个（chk_reference_document_content_source 兜底）；
   * - 存储引用由 usecase 层经存储契约生成（服务端随机、无路径语义），本方法不参与命名；
   * - 审核发布（REVIEWED_SUBMISSION）时 usecase 传入 sourceSubmissionId /
   *   sourceRevisionId / equipmentModelText / schemaVersion 回链与快照字段，
   *   管理员直建不传（列取 NULL/默认值；来源同空或同有由 CHECK 兜底）
   *
   * @param data 已完成业务判定的写入数据
   * @param transactionContext 可选的事务上下文
   * @returns 写入完成后的资料主键
   */
  async insertDocument(
    data: ReferenceDocumentInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ id: number }> {
    const repository = this.getRepository(transactionContext);
    try {
      const entity = repository.create({
        title: data.title,
        documentType: data.documentType,
        equipmentModelId: data.equipmentModelId,
        equipmentModelText: data.equipmentModelText ?? null,
        description: data.description,
        contentText: data.contentText,
        originalFilename: data.originalFilename,
        mimeType: data.mimeType,
        storageBackend: data.storageBackend,
        storageReference: data.storageReference,
        createdByAccountId: data.createdByAccountId,
        ownerOrganizationId: data.ownerOrganizationId,
        ingestMethod: data.ingestMethod,
        sourceSubmissionId: data.sourceSubmissionId ?? null,
        sourceRevisionId: data.sourceRevisionId ?? null,
        extensionJson: data.extensionJson ?? null,
        schemaVersion: data.schemaVersion ?? 1,
        deprecated: false,
      });
      const saved = await repository.save(entity);
      return { id: saved.id };
    } catch (error) {
      // 客户端可见的 details 不得携带原始数据库错误（可能含表名/约束/输入内容）；
      // 底层异常仅以 cause 保留，供服务端日志与排查使用（全局 GraphQL Filter 会将
      // details 原样写入响应）
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.CREATION_FAILED,
        '参考资料创建失败，请稍后重试',
        { title: data.title },
        error,
      );
    }
  }

  /**
   * 编辑参考资料（全量覆盖式更新，仅未软删行可编辑）
   *
   * 条件更新含 deprecated = 0，已软删行不可被编辑穿透；
   * 未命中时按状态事实返回 NOT_FOUND（负责人 docx 口径：不存在或已软删统一不可访问）。
   * equipmentModelText / updatedByAccountId 为 S6 案例更正扩展的可选扩展列：
   * 未传（undefined）时不进入更新集合（通用编辑路径保持原行为）。
   *
   * @param data 已完成合并与校验的写入数据
   * @param transactionContext 可选的事务上下文
   * @returns 编辑完成后的资料主键
   */
  async updateDocument(
    data: ReferenceDocumentUpdateData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ id: number }> {
    const repository = this.getRepository(transactionContext);
    const updatePayload: QueryDeepPartialEntity<ReferenceDocumentEntity> = {
      title: data.title,
      documentType: data.documentType,
      equipmentModelId: data.equipmentModelId,
      description: data.description,
      contentText: data.contentText,
    };
    if (data.equipmentModelText !== undefined) {
      updatePayload.equipmentModelText = data.equipmentModelText;
    }
    if (data.updatedByAccountId !== undefined) {
      updatePayload.updatedByAccountId = data.updatedByAccountId;
    }
    let affected: number;
    try {
      const result = await repository.update(
        { id: data.documentId, deprecated: false },
        updatePayload,
      );
      affected = result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
        '参考资料更新失败，请稍后重试',
        { id: data.documentId },
        error,
      );
    }
    if (affected !== 1) {
      // 不存在与已软删统一拒绝，不泄露删除状态
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可编辑', {
        id: data.documentId,
      });
    }
    return { id: data.documentId };
  }

  /**
   * 原子条件软删除：deprecated 与 deleted_at 同语句写入（满足删除一致性 CHECK）
   *
   * 仅返回状态事实；错误映射归 usecase。
   * 未命中（不存在或已软删）统一 NOT_FOUND，不泄露删除状态（负责人 docx 验收标准）。
   * 原始文件不物理删除。
   *
   * @param params 软删除参数
   * @param transactionContext 可选的事务上下文
   * @returns 软删除状态事实
   */
  async softDeleteDocument(
    params: { documentId: number },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentDeleteOutcome> {
    const repository = this.getRepository(transactionContext);
    let affected: number;
    try {
      const result = await repository.update(
        { id: params.documentId, deprecated: false },
        // 软删除固定落库 deleted_at（与实体 chk_reference_document_deletion_consistency 一致）
        { deprecated: true, deletedAt: () => 'CURRENT_TIMESTAMP(3)' },
      );
      affected = result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.DELETION_FAILED,
        '参考资料删除失败，请稍后重试',
        { id: params.documentId },
        error,
      );
    }
    if (affected === 1) {
      return { kind: 'DELETED', id: params.documentId };
    }
    // 条件未命中：行不存在或已软删，统一状态事实，不区分对外表述
    return { kind: 'NOT_FOUND', id: params.documentId };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(ReferenceDocumentEntity) : this.repository;
  }
}
