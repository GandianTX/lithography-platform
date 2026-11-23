// src/usecases/management-audit/list-management-audit-events.organization-ids.normalize.ts

/**
 * 关键操作记录列表的公司 ID 归一（任务 10）。
 *
 * 输入收敛与去重集中在 normalize 文件：用例层不得手工 `new Set(...)` 去重
 * （见 `scripts/check-usecase-normalize-guard.js` 的 manual-set-dedupe 守卫）。
 */

/** 事件条目中参与公司名富集的公司字段。 */
type OrganizationScopedItem = {
  readonly organizationId: number | null;
};

/**
 * 取出待查名的公司 ID：去空、去非法值、保持首次出现顺序且去重。
 *
 * 公司为空的记录（一级可见的 NULL 归属行）不参与查名，由调用方按 null 展示。
 */
export function collectDistinctOrganizationIds(
  items: ReadonlyArray<OrganizationScopedItem>,
): number[] {
  const collected: number[] = [];
  const seen = new Set<number>();

  for (const item of items) {
    const id = item.organizationId;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    collected.push(id);
  }

  return collected;
}
