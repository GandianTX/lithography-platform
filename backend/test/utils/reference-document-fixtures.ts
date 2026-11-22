// test/utils/reference-document-fixtures.ts

/**
 * 参考资料 E2E 受控夹具（任务 07 收口）。
 *
 * 背景：确认需求已关闭普通资料新增（`createReferenceDocument`）、通用编辑
 * （`updateReferenceDocument`）、REST multipart 上传与投稿审核决定
 * （`reviewContentSubmissionDecision` APPROVE 发布 REVIEWED_SUBMISSION 资料）。
 * E2E 不得再以生产写入口造数，也不得为造数重新开放入口，因此改为直接写
 * `reference_document` / `reference_document_case_detail`。
 *
 * 归属纪律（R01/R02，与 `e2e-scoped-cleanup` 同口径）：
 * - 只登记本次 `save()` 实际返回的真实 ID 与创建即定的归属事实；
 * - 不按标题/组织编码等自然键接管库内既有行，也不在清理阶段反填台账；
 * - V13 必填状态（publication/ownership/source_kind）由
 *   `withReferenceDocumentFixtureState` 依据夹具事实派生，不重写既有事实字段。
 */

import { DataSource, Repository } from 'typeorm';

import { ReferenceDocumentCaseDetailEntity } from '@src/modules/lithography/entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from '@src/modules/lithography/entities/reference-document.entity';

import { recordOwnedResource, type OwnedResourceLedger } from './e2e-scoped-cleanup';
import { withReferenceDocumentFixtureState } from './reference-document-fixture-state';

/** 资料夹具输入：只允许显式给出的事实，其余按历史资料默认值补齐 */
export interface ReferenceDocumentFixture {
  readonly title: string;
  readonly documentType: string;
  readonly createdByAccountId: number;
  /** 归属公司；未知归属（待核实）为 null */
  readonly ownerOrganizationId: number | null;
  readonly contentText?: string | null;
  readonly description?: string | null;
  readonly equipmentModelId?: number | null;
  readonly equipmentModelText?: string | null;
  readonly originalFilename?: string | null;
  readonly mimeType?: string | null;
  readonly storageBackend?: string | null;
  readonly storageReference?: string | null;
  readonly ingestMethod?: string;
  readonly schemaVersion?: number;
  readonly deprecated?: boolean;
  readonly deletedAt?: Date | null;
  /** 默认由上架/软删事实派生；需要「已下架但未软删」时显式传 OFFLINE */
  readonly publicationStatus?: 'ONLINE' | 'OFFLINE';
}

/** 案例明细夹具输入：DB CHECK 要求 RESOLVED 必须有非空结果 */
export interface ReferenceDocumentCaseFixture {
  readonly documentId: number;
  readonly handlingStatus?: 'UNRESOLVED' | 'IN_PROGRESS' | 'RESOLVED';
  readonly errorCode?: string | null;
  readonly phenomenon?: string;
  readonly conditionText?: string | null;
  readonly reproductionSteps?: string;
  readonly diagnosis?: string | null;
  readonly actionTaken?: string | null;
  readonly resolution?: string | null;
}

const documentRepository = (dataSource: DataSource): Repository<ReferenceDocumentEntity> =>
  dataSource.getRepository(ReferenceDocumentEntity);

const caseDetailRepository = (
  dataSource: DataSource,
): Repository<ReferenceDocumentCaseDetailEntity> =>
  dataSource.getRepository(ReferenceDocumentCaseDetailEntity);

/**
 * 建立一条正式资料夹具行（不带案例明细）。
 *
 * 返回落库实体；`ownership` 存在时按真实 ID 与最小预期事实登记，
 * 供 `runGuardedSpecCleanup` 精确回收。
 */
export const seedReferenceDocumentFixture = async (params: {
  readonly dataSource: DataSource;
  readonly ownership?: OwnedResourceLedger;
  readonly fixture: ReferenceDocumentFixture;
}): Promise<ReferenceDocumentEntity> => {
  const repository = documentRepository(params.dataSource);
  const fixture = params.fixture;
  const deprecated = fixture.deprecated ?? false;
  const deletedAt = fixture.deletedAt ?? null;

  const derived = withReferenceDocumentFixtureState({
    deprecated,
    deletedAt,
    ownerOrganizationId: fixture.ownerOrganizationId,
  });

  const saved = await repository.save(
    repository.create({
      title: fixture.title,
      documentType: fixture.documentType,
      equipmentModelId: fixture.equipmentModelId ?? null,
      equipmentModelText: fixture.equipmentModelText ?? null,
      description: fixture.description ?? null,
      originalFilename: fixture.originalFilename ?? null,
      mimeType: fixture.mimeType ?? null,
      contentText: fixture.contentText ?? null,
      storageBackend: fixture.storageBackend ?? null,
      storageReference: fixture.storageReference ?? null,
      createdByAccountId: fixture.createdByAccountId,
      ownerOrganizationId: fixture.ownerOrganizationId,
      publicationStatus: fixture.publicationStatus ?? derived.publicationStatus,
      ownershipStatus: derived.ownershipStatus,
      sourceKind: derived.sourceKind,
      ingestMethod: fixture.ingestMethod ?? 'ADMIN_DIRECT',
      schemaVersion: fixture.schemaVersion ?? 1,
      deprecated,
      deletedAt,
    }),
  );

  if (params.ownership) {
    recordOwnedResource(params.ownership, 'document', saved.id, {
      ownerOrganizationId: saved.ownerOrganizationId,
      createdByAccountId: saved.createdByAccountId,
      sourceSubmissionId: saved.sourceSubmissionId ?? null,
      sourceRevisionId: saved.sourceRevisionId ?? null,
      equipmentModelId: saved.equipmentModelId ?? null,
    });
  }

  return saved;
};

/** 建立一条案例明细夹具行（类型与明细一一对应，必须与 FAULT_CASE 资料配套） */
export const seedReferenceDocumentCaseFixture = async (params: {
  readonly dataSource: DataSource;
  readonly ownership?: OwnedResourceLedger;
  readonly fixture: ReferenceDocumentCaseFixture;
}): Promise<ReferenceDocumentCaseDetailEntity> => {
  const repository = caseDetailRepository(params.dataSource);
  const fixture = params.fixture;

  const saved = await repository.save(
    repository.create({
      documentId: fixture.documentId,
      handlingStatus: fixture.handlingStatus ?? 'UNRESOLVED',
      errorCode: fixture.errorCode ?? null,
      phenomenon: fixture.phenomenon ?? '夹具故障现象',
      conditionText: fixture.conditionText ?? null,
      reproductionSteps: fixture.reproductionSteps ?? '1. 复现夹具步骤',
      diagnosis: fixture.diagnosis ?? null,
      actionTaken: fixture.actionTaken ?? null,
      resolution: fixture.resolution ?? null,
      casePayloadJson: null,
      schemaVersion: 1,
    }),
  );

  if (params.ownership) {
    // documentCaseDetail 以 document_id 为主键（一资料一行），按资料 ID 登记
    recordOwnedResource(params.ownership, 'documentCaseDetail', saved.documentId);
  }

  return saved;
};

/** 修订行事实（reference_document_revision 无业务写入口，只能由被调用用例产生） */
interface ReferenceDocumentRevisionRow {
  readonly id: number | string;
  readonly document_id: number | string;
  readonly revision_no: number | string;
  readonly actor_account_id: number | string;
}

/** 审计行事实（management_audit_event 主键为 char(36)） */
interface ManagementAuditEventRow {
  readonly event_id: string;
  readonly actor_account_id: number | string;
  readonly organization_id: number | string | null;
  readonly operation: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly result: string;
}

/**
 * 登记本轮资料上实际产生的修订行。
 *
 * 修订只由被验证的生产用例（R053/R058–R061）写入，夹具不预造；
 * 调用方在用例执行后按资料 ID 回收真实行并登记，清理先删修订再删资料
 * （FK RESTRICT）。
 */
export const registerReferenceDocumentRevisions = async (params: {
  readonly dataSource: DataSource;
  readonly ownership: OwnedResourceLedger;
  readonly documentId: number;
}): Promise<number> => {
  const rows = await params.dataSource.query<ReferenceDocumentRevisionRow[]>(
    `SELECT id, document_id, revision_no, actor_account_id
       FROM reference_document_revision
      WHERE document_id = ?`,
    [params.documentId],
  );

  for (const row of rows) {
    recordOwnedResource(params.ownership, 'referenceDocumentRevision', Number(row.id), {
      documentId: Number(row.document_id),
      revisionNo: Number(row.revision_no),
      actorAccountId: Number(row.actor_account_id),
    });
  }

  return rows.length;
};

/** 登记本轮资料上实际产生的关键操作审计行（只认 target_type=REFERENCE_DOCUMENT） */
export const registerReferenceDocumentAuditEvents = async (params: {
  readonly dataSource: DataSource;
  readonly ownership: OwnedResourceLedger;
  readonly documentId: number;
}): Promise<number> => {
  const rows = await params.dataSource.query<ManagementAuditEventRow[]>(
    `SELECT event_id, actor_account_id, organization_id, operation, target_type, target_id, result
       FROM management_audit_event
      WHERE target_type = 'REFERENCE_DOCUMENT' AND target_id = ?`,
    [String(params.documentId)],
  );

  for (const row of rows) {
    recordOwnedResource(params.ownership, 'managementAuditEvent', row.event_id, {
      actorAccountId: Number(row.actor_account_id),
      organizationId: row.organization_id === null ? null : Number(row.organization_id),
      operation: row.operation,
      targetType: row.target_type,
      targetId: row.target_id,
      result: row.result,
    });
  }

  return rows.length;
};

/** 读取资料行的最小状态事实（断言用，不写库） */
export interface ReferenceDocumentFacts {
  readonly publication_status: string;
  readonly ownership_status: string;
  readonly current_revision_no: number;
  readonly deprecated: number | boolean;
  readonly deleted_at: string | Date | null;
  readonly created_by_account_id: number;
  readonly owner_organization_id: number | null;
  readonly title: string;
  readonly document_type: string;
  readonly description: string | null;
  readonly content_text: string | null;
  readonly equipment_model_id: number | null;
  readonly equipment_model_text: string | null;
  readonly ingest_method: string | null;
  readonly source_submission_id: string | null;
  readonly source_revision_id: string | null;
  readonly storage_backend: string | null;
  readonly storage_reference: string | null;
  readonly original_filename: string | null;
}

/** 按 ID 回读资料行（只读；不参与清理归属判定） */
export const readReferenceDocumentFacts = async (params: {
  readonly dataSource: DataSource;
  readonly documentId: number;
}): Promise<ReferenceDocumentFacts | null> => {
  const rows = await params.dataSource.query<ReferenceDocumentFacts[]>(
    `SELECT publication_status, ownership_status, current_revision_no, deprecated,
            deleted_at, created_by_account_id, owner_organization_id, title, document_type,
            description, content_text, equipment_model_id, equipment_model_text, ingest_method,
            source_submission_id, source_revision_id, storage_backend, storage_reference,
            original_filename
       FROM reference_document
      WHERE id = ?`,
    [params.documentId],
  );
  return rows[0] ?? null;
};
