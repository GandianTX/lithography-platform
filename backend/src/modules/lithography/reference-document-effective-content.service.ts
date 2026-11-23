// src/modules/lithography/reference-document-effective-content.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';

import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { ReferenceDocumentRevisionEntity } from './entities/reference-document-revision.entity';
import { toMaintenanceReportVersionSnapshot } from './maintenance-report.mapper';
import {
  composeFrozenReportText,
  parseFrozenReportVersion,
  readRevisionContentText,
} from './reference-document-effective-content';

/**
 * 资料**生效正文**的来源域解析（任务 09 R068 本地视图对齐用）。
 *
 * 为什么需要它：写修订历史时，before/after 快照必须携带**当时生效正文**
 * （任务 07 的既有口径）。资料正文有三个来源，优先级为
 * 「管理修订 > 原始冻结报告 > 资料自身正文」：
 * - 管理修订：读 `reference_document_revision.after_snapshot.contentText`；
 * - 冻结报告：读 `maintenance_report_version.payload_snapshot` 拼装文本；
 * - 其余：资料自身 `content_text` 列。
 *
 * 对齐写入在 modules 层（来源域受控入口），**不得**依赖 usecases 层，
 * 故本服务在来源域内独立实现该口径；读侧
 * （`usecases/reference-document/reference-document-management.helpers.ts`）
 * 仍走既有读链，两者口径一致。
 *
 * 失败关闭：修订行／冻结版本行缺失属数据定式破坏，直接失败关闭，
 * **不回退**资料自身正文冒充历史（否则历史快照会悄悄改写生效正文）。
 */
@Injectable()
export class ReferenceDocumentEffectiveContentService {
  constructor(
    @InjectRepository(ReferenceDocumentRevisionEntity)
    private readonly revisionRepository: Repository<ReferenceDocumentRevisionEntity>,
    @InjectRepository(MaintenanceReportVersionEntity)
    private readonly reportVersionRepository: Repository<MaintenanceReportVersionEntity>,
  ) {}

  /**
   * 解析资料当前生效正文。
   *
   * @param effectiveRevisionNo 生效管理修订号（0 表示没有管理修订）
   * @param sourceKind 资料来源类型（MATERIAL / INDEPENDENT_REPORT / WORK_ORDER_SUMMARY）
   * @param sourceReportId 来源报告 ID（报告来源资料必填）
   * @param sourceReportVersionId 来源冻结版本 ID（报告来源资料必填）
   * @param contentText 资料自身正文列（回落用）
   */
  async resolveEffectiveContentText(params: {
    documentId: number;
    effectiveRevisionNo: number;
    sourceKind: string;
    sourceReportId: number | null;
    sourceReportVersionId: number | null;
    contentText: string | null;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<string | null> {
    if (params.effectiveRevisionNo > 0) {
      const repository = this.getRevisionRepository(params.transactionContext);
      const row = await repository.findOne({
        where: { documentId: params.documentId, revisionNo: params.effectiveRevisionNo },
      });
      if (!row) {
        throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
          id: params.documentId,
        });
      }
      let parsed: Record<string, unknown> = {};
      try {
        const raw: unknown = JSON.parse(row.afterSnapshot);
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          parsed = raw as Record<string, unknown>;
        }
      } catch {
        parsed = {};
      }
      return readRevisionContentText(parsed) ?? params.contentText;
    }

    if (
      params.sourceReportVersionId !== null &&
      (params.sourceKind === 'INDEPENDENT_REPORT' || params.sourceKind === 'WORK_ORDER_SUMMARY')
    ) {
      const repository = this.getReportVersionRepository(params.transactionContext);
      const row = await repository.findOne({
        where: {
          id: params.sourceReportVersionId,
          reportId: params.sourceReportId ?? -1,
        },
      });
      if (!row) {
        throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
          id: params.documentId,
        });
      }
      return composeFrozenReportText(
        parseFrozenReportVersion(toMaintenanceReportVersionSnapshot(row)),
      );
    }

    return params.contentText;
  }

  private getRevisionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentRevisionEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ReferenceDocumentRevisionEntity)
      : this.revisionRepository;
  }

  private getReportVersionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportVersionEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(MaintenanceReportVersionEntity)
      : this.reportVersionRepository;
  }
}
