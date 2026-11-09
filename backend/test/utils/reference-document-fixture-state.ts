// test/utils/reference-document-fixture-state.ts

/**
 * 参考资料夹具的 V13 必填状态生成器（仅供测试与种子装配使用）。
 *
 * 迁移 `1775501100000-alter-repair-ai-report-for-v13` 把 `publication_status` /
 * `ownership_status` / `source_kind` 收紧为 NOT NULL 且不再保留默认值；回填只使用
 * 既有字段可证明的事实：
 * - `deprecated = 0` 且 `deleted_at IS NULL` -> `ONLINE`，否则 `OFFLINE`；
 * - `owner_organization_id` 非空 -> `CONFIRMED`，否则 `PENDING`；
 * - 历史正文/文件资料 -> `MATERIAL`。
 *
 * 本生成器复用该回填口径，让仍直接写 `reference_document` 的夹具显式补齐状态，
 * 不改变原有用例的上下架、软删除与权限隔离语义；也不替代 MySQL CHECK
 * （`chk_reference_document_publication` / `_ownership` / `_source_kind` /
 * `_content_source_v13`）的实库验证。
 */

export type ReferenceDocumentFixtureFacts = {
  /** 是否已软删除（与 deletedAt 必须同真同假） */
  deprecated: boolean;
  /** 软删除时间；未删除为 null */
  deletedAt: Date | null;
  /** 所属组织；未知归属为 null */
  ownerOrganizationId: number | null;
};

export type ReferenceDocumentFixtureState = {
  publicationStatus: 'ONLINE' | 'OFFLINE';
  ownershipStatus: 'CONFIRMED' | 'PENDING';
  sourceKind: 'MATERIAL';
};

/**
 * 按夹具的既有事实派生 V13 必填状态。
 *
 * 当前直接写库的夹具都来自正文/文件资料，尚无报告来源回链，因此 `source_kind`
 * 固定为 `MATERIAL`；报告来源发布由新链路单独实现，不在夹具中预造。
 */
export const deriveReferenceDocumentFixtureState = (
  facts: ReferenceDocumentFixtureFacts,
): ReferenceDocumentFixtureState => ({
  publicationStatus: facts.deprecated || facts.deletedAt !== null ? 'OFFLINE' : 'ONLINE',
  ownershipStatus: facts.ownerOrganizationId === null ? 'PENDING' : 'CONFIRMED',
  sourceKind: 'MATERIAL',
});

/**
 * 在夹具对象上补齐 V13 必填状态；事实字段本身不被改写。
 */
export const withReferenceDocumentFixtureState = <T extends ReferenceDocumentFixtureFacts>(
  fixture: T,
): T & ReferenceDocumentFixtureState => ({
  ...fixture,
  ...deriveReferenceDocumentFixtureState(fixture),
});
