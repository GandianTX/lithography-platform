// src/usecases/reference-document/reference-document-management.helpers.ts

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import type { ReferenceDocumentDetailQueryResult } from '@src/modules/lithography/lithography.types';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import {
  composeFrozenReportText,
  parseFrozenReportVersion,
  readRevisionContentText,
} from '@src/modules/lithography/reference-document-effective-content';
import { buildReferenceDocumentRevisionSnapshot } from '@src/modules/lithography/reference-document-revision-snapshot';
import {
  readRevisionStructuredContent,
  structuredContentFromFrozenVersion,
  toStructuredSnapshotValue,
  type ReferenceDocumentStructuredContent,
} from './reference-document-structured-content';

/**
 * 任务 07 管理操作共享助手（R053/R058–R061）。
 *
 * 生效正文口径与 GetReferenceDocumentDetailUsecase 完全一致：
 * 管理修订 > 原始冻结报告 > 资料自身正文。状态/归属类修订的 after 快照
 * 必须携带「当时生效正文」，保证后续读取（CURRENT_REVISION 来源）不回退原报告。
 */

/** 管理写用例对查询服务的最小依赖面（便于单测注入替身） */
export type ReferenceDocumentEffectiveContentReaders = {
  referenceDocumentQueryService: Pick<ReferenceDocumentQueryService, 'findRevision'>;
  maintenanceReportQueryService: Pick<MaintenanceReportQueryService, 'readVersionById'>;
};

/**
 * 解析资料当前生效正文文本。
 *
 * - 生效修订号指向缺失行 / 冻结版本行缺失属数据定式破坏：失败关闭（NOT_FOUND），
 *   不让管理修订把正文静默回退旧版。
 */
export async function resolveEffectiveContentText(
  detail: ReferenceDocumentDetailQueryResult,
  readers: ReferenceDocumentEffectiveContentReaders,
): Promise<string | null> {
  if (detail.effectiveRevisionNo > 0) {
    const revision = await readers.referenceDocumentQueryService.findRevision(
      detail.id,
      detail.effectiveRevisionNo,
    );
    if (revision === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问', {
        id: detail.id,
      });
    }
    return readRevisionContentText(revision.afterSnapshot) ?? detail.contentText;
  }

  if (
    detail.sourceReportVersionId !== null &&
    (detail.sourceKind === 'INDEPENDENT_REPORT' || detail.sourceKind === 'WORK_ORDER_SUMMARY')
  ) {
    const version = await readers.maintenanceReportQueryService.readVersionById(
      detail.sourceReportId as number,
      detail.sourceReportVersionId,
    );
    if (version === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问', {
        id: detail.id,
      });
    }
    return composeFrozenReportText(parseFrozenReportVersion(version));
  }

  return detail.contentText;
}

/**
 * 解析资料当前生效的结构化内容（任务 07 管理修订，报告来源正式资料）。
 *
 * - 生效修订携带 structuredReport 键 → 该修订的结构化内容；
 * - 报告来源且无管理修订 → 冻结版本 payload 派生（编辑初值语义）；
 * - 其余（普通资料 / 旧扁平修订）→ null：不伪造缺失的故障数据，
 *   编辑通道回落扁平正文模式。
 */
export async function resolveEffectiveStructuredContent(
  detail: ReferenceDocumentDetailQueryResult,
  readers: ReferenceDocumentEffectiveContentReaders,
): Promise<ReferenceDocumentStructuredContent | null> {
  if (detail.effectiveRevisionNo > 0) {
    const revision = await readers.referenceDocumentQueryService.findRevision(
      detail.id,
      detail.effectiveRevisionNo,
    );
    if (revision === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问', {
        id: detail.id,
      });
    }
    return readRevisionStructuredContent(revision.afterSnapshot);
  }

  if (
    detail.sourceReportVersionId !== null &&
    (detail.sourceKind === 'INDEPENDENT_REPORT' || detail.sourceKind === 'WORK_ORDER_SUMMARY')
  ) {
    const version = await readers.maintenanceReportQueryService.readVersionById(
      detail.sourceReportId as number,
      detail.sourceReportVersionId,
    );
    if (version === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问', {
        id: detail.id,
      });
    }
    return structuredContentFromFrozenVersion(version);
  }

  return null;
}

/**
 * 快照 JSON 的固定键集合（白名单；不写存储引用与账号敏感信息）。
 *
 * 形态与「使用云端」的本地视图对齐共用同一构造器
 * （`@src/modules/lithography/reference-document-revision-snapshot.ts`），
 * 两处写的是同一张 `reference_document_revision` 表，形态必须一致。
 */
function toSnapshotRecord(
  detail: ReferenceDocumentDetailQueryResult,
  contentText: string | null,
): Record<string, unknown> {
  return buildReferenceDocumentRevisionSnapshot({
    schemaVersion: detail.schemaVersion,
    title: detail.title,
    documentType: detail.documentType,
    description: detail.description,
    contentText,
    publicationStatus: detail.publicationStatus,
    ownershipStatus: detail.ownershipStatus,
    createdByAccountId: detail.createdByAccountId,
    ownerOrganizationId: detail.ownerOrganizationId,
  });
}

/**
 * 组装修订前后完整快照 JSON（满足 chk_reference_document_revision_schema 的
 * schema_version 非空校验）。
 *
 * @param overrides after 快照上的字段级覆盖（状态/归属变更的事实值，白名单键）
 * @param beforeStructuredReport 修订前快照携带的结构化内容键（undefined 不写键，
 *   与历史快照形态保持一致）；状态/归属类修订传当前生效值以继承，不回退正文
 * @param afterStructuredReport 修订后快照携带的结构化内容键（undefined 不写键）
 */
export function buildRevisionSnapshots(params: {
  detail: ReferenceDocumentDetailQueryResult;
  beforeContentText: string | null;
  afterContentText: string | null;
  overrides?: Record<string, unknown>;
  beforeStructuredReport?: Record<string, unknown>;
  afterStructuredReport?: Record<string, unknown>;
}): { beforeSnapshot: string; afterSnapshot: string } {
  const before = {
    ...toSnapshotRecord(params.detail, params.beforeContentText),
    ...(params.beforeStructuredReport !== undefined
      ? { structuredReport: params.beforeStructuredReport }
      : {}),
  };
  const after = {
    ...toSnapshotRecord(params.detail, params.afterContentText),
    ...(params.afterStructuredReport !== undefined
      ? { structuredReport: params.afterStructuredReport }
      : {}),
    ...(params.overrides ?? {}),
  };
  return {
    beforeSnapshot: JSON.stringify(before),
    afterSnapshot: JSON.stringify(after),
  };
}

/** 当前生效结构化内容 → 快照键写入值（无结构化内容时不写键） */
export function structuredSnapshotValueOrNull(
  content: ReferenceDocumentStructuredContent | null,
): Record<string, unknown> | undefined {
  return content === null ? undefined : toStructuredSnapshotValue(content);
}

/** expected_version（current_revision_no）一致性校验：过期即拒绝，不覆盖新版本 */
export function assertExpectedRevisionNo(
  detail: ReferenceDocumentDetailQueryResult,
  expectedVersion: number,
): void {
  if (detail.effectiveRevisionNo !== expectedVersion) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT,
      '历史维修记录版本已更新，请重新读取当前版本后重试',
      { id: detail.id, expectedVersion, currentVersion: detail.effectiveRevisionNo },
    );
  }
}
