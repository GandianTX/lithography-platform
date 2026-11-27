// src/modules/lithography/reference-document-revision-snapshot.ts

/**
 * 资料修订快照的**统一形态**（任务 07 管理修订 ＋ 任务 09 R068 对齐写入共用）。
 *
 * 为什么放在 modules 层：管理修订（usecases 层）与「使用云端」的本地视图对齐
 * （modules 层的来源域受控写入入口）都要写同一张 `reference_document_revision`
 * 表的 before/after 快照；快照形态是**来源域契约**，两处必须一致，
 * 且 modules 层不得反向依赖 usecases 层（架构规则
 * `local-architecture/no-modules-to-usecases-imports`）。
 *
 * 形态约束：
 * - 键集合固定为白名单（不写存储引用、账号敏感信息与扩展属性）；
 * - `schema_version` 必填（库级 CHECK `chk_reference_document_revision_schema`
 *   要求 before/after 快照的 `$.schema_version` 非空）；
 * - 正文键固定为 `contentText`（读侧 `listRevisions` 以此键给出该版本生效正文）。
 */
export type ReferenceDocumentRevisionSnapshotRecord = {
  schema_version: number;
  title: string;
  documentType: string;
  description: string | null;
  contentText: string | null;
  publicationStatus: string;
  ownershipStatus: string;
  createdByAccountId: number;
  ownerOrganizationId: number | null;
};

/** 快照原料（调用方提供事实，本函数只组装固定形态） */
export type ReferenceDocumentRevisionSnapshotInput = {
  schemaVersion: number;
  title: string;
  documentType: string;
  description: string | null;
  contentText: string | null;
  publicationStatus: string;
  ownershipStatus: string;
  createdByAccountId: number;
  ownerOrganizationId: number | null;
};

/** 组装资料修订快照（固定键集合与顺序） */
export function buildReferenceDocumentRevisionSnapshot(
  input: ReferenceDocumentRevisionSnapshotInput,
): ReferenceDocumentRevisionSnapshotRecord {
  return {
    schema_version: input.schemaVersion,
    title: input.title,
    documentType: input.documentType,
    description: input.description,
    contentText: input.contentText,
    publicationStatus: input.publicationStatus,
    ownershipStatus: input.ownershipStatus,
    createdByAccountId: input.createdByAccountId,
    ownerOrganizationId: input.ownerOrganizationId,
  };
}
