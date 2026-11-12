// src/usecases/admin-document-database/resolve-admin-data-scope.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 管理员读侧数据范围：等级来自数据库当前事实，组织来自可信成员关系。
 *
 * - 一级（admin_level = 1）：`ownerOrganizationId` 为 `undefined`，保留全平台范围；
 * - 二级（admin_level = 2）及等级缺失/非法：只读可信成员关系所属组织，
 *   缺失等级不会被提升为一级（失败关闭）。
 *
 * usecase 不得使用前端传入的公司或等级字段覆盖本结果。
 */
export type AdminDataScope = {
  adminLevel: number | null;
  /** undefined = 全平台（仅一级）；number = 仅该归属组织 */
  ownerOrganizationId: number | undefined;
  /** 当前账号可信归属组织（统计中的组织范围同样使用该值） */
  organizationId: number;
};

export async function resolveAdminDataScope(params: {
  session: UsecaseSession;
  accountQueryService: AccountQueryService;
  organizationContextService: TrustedOrganizationContextQueryService;
}): Promise<AdminDataScope> {
  // 先解析成员关系：无有效关系或多关系歧义在此拒绝，不进入业务查询
  const membership = await params.organizationContextService.resolveForAccount({
    accountId: params.session.accountId,
  });
  const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(
    params.session.accountId,
  );

  return {
    adminLevel,
    ownerOrganizationId: adminLevel === 1 ? undefined : membership.organizationId,
    organizationId: membership.organizationId,
  };
}
