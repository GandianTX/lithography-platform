// src/modules/lithography/reference-document-case-detail.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { ReferenceDocumentCaseDetailEntity } from './entities/reference-document-case-detail.entity';
import type {
  ReferenceDocumentCaseDetailInsertData,
  ReferenceDocumentCaseDetailUpdateData,
} from './lithography.types';

/**
 * 正式故障案例明细写服务（A-PR0 §3.1 `reference_document_case_detail`）
 *
 * 职责范围：
 * - 审核发布时插入案例结构化明细（主键即正式资料外键，与正式资料同事务）；
 * - 案例专属更正时全量覆盖更新明细（A-PR0 §S6，与正式资料同事务）；
 * - 写入数据由 usecase 完成状态裁决与字段组装（本层不做业务判断）。
 *
 * 不包含：
 * - 权限判断、标题/正文生成、状态值域裁决（归 usecase；数据库 CHECK 兜底：
 *   handling_status 受控值域、RESOLVED 时 resolution 必填非空）；
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有）。
 */
@Injectable()
export class ReferenceDocumentCaseDetailService {
  constructor(
    @InjectRepository(ReferenceDocumentCaseDetailEntity)
    private readonly repository: Repository<ReferenceDocumentCaseDetailEntity>,
  ) {}

  /**
   * 插入案例明细（与正式资料同事务；document_id 唯一，重复插入被主键拒绝）。
   *
   * @param data 已完成业务判定的写入数据
   * @param transactionContext 可选的事务上下文
   * @returns 写入完成后的资料主键（即明细主键）
   */
  async insertCaseDetail(
    data: ReferenceDocumentCaseDetailInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ documentId: number }> {
    const repository = this.getRepository(transactionContext);
    try {
      await repository.insert({
        documentId: data.documentId,
        errorCode: data.errorCode,
        handlingStatus: data.handlingStatus,
        phenomenon: data.phenomenon,
        conditionText: data.conditionText,
        reproductionSteps: data.reproductionSteps,
        diagnosis: data.diagnosis,
        actionTaken: data.actionTaken,
        resolution: data.resolution,
        // TypeORM 对 JSON 列的深度映射不接受 unknown 值类型；快照已由 usecase
        // 组装为可 JSON 序列化的纯对象字面量，此处仅收窄类型
        casePayloadJson: (data.casePayloadJson ?? null) as Record<string, never> | null,
        schemaVersion: 1,
      });
      return { documentId: data.documentId };
    } catch (error) {
      // 客户端可见的 details 不得携带原始数据库错误；底层异常仅以 cause 保留
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.CREATION_FAILED,
        '案例明细保存失败，请稍后重试',
        { documentId: data.documentId },
        error,
      );
    }
  }

  /**
   * 更正案例明细（A-PR0 §S6 专属更正，全量覆盖式更新）：document_id 主键定位，
   * 只覆盖 8 个业务列，casePayloadJson / schemaVersion / 创建时间维持原值。
   *
   * 条件命中必须为 1：明细在更正事务内已由用例读取确认存在，未命中视为
   * 定式破坏（失败关闭；对外统一系统侧失败，不披露内部一致性细节）。
   *
   * @param data 已完成合并与最终态校验的写入数据
   * @param transactionContext 可选的事务上下文
   * @returns 更正完成后的资料主键（即明细主键）
   */
  async updateCaseDetail(
    data: ReferenceDocumentCaseDetailUpdateData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ documentId: number }> {
    const repository = this.getRepository(transactionContext);
    let affected: number;
    try {
      const result = await repository.update(
        { documentId: data.documentId },
        {
          errorCode: data.errorCode,
          handlingStatus: data.handlingStatus,
          phenomenon: data.phenomenon,
          conditionText: data.conditionText,
          reproductionSteps: data.reproductionSteps,
          diagnosis: data.diagnosis,
          actionTaken: data.actionTaken,
          resolution: data.resolution,
        },
      );
      affected = result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
        '案例明细更正失败，请稍后重试',
        { documentId: data.documentId },
        error,
      );
    }
    if (affected !== 1) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
        '案例明细更正失败，请稍后重试',
        {
          documentId: data.documentId,
        },
      );
    }
    return { documentId: data.documentId };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentCaseDetailEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(ReferenceDocumentCaseDetailEntity) : this.repository;
  }
}
