// src/usecases/reference-document/reference-document-read-scope.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { ReferenceDocumentReadScope } from '@src/modules/lithography/lithography.types';
import { assertReferenceDocumentReadRole } from './reference-document-roles';

/** 只读依赖（便于用例单测注入替身，避免直接依赖 Account/Lithography 实现）。 */
export interface ReferenceDocumentAdminLevelReader {
  findAdminLevelByAccountId(accountId: number): Promise<number | null>;
}

export interface ReferenceDocumentOrganizationReader {
  resolveForAccount(params: {
    accountId: number;
  }): Promise<{ organizationId: number; memberRole: string }>;
}

/**
 * 历史维修记录库读侧范围决议（列表 / 详情 / 历史版本 / 原件下载共用同一口径）。
 *
 * - CUSTOMER 一律拒绝（`assertReferenceDocumentReadRole` 兜底，守卫层已拦截）；
 * - SUPER_ADMIN 且 `admin_level = 1`：GLOBAL（全部公司正式资料，功能 V5.6 R055、
 *   页面 V6.5 §9.1「1级看全部公司」；R057-01 原件下载「1级可跨公司」）；
 * - 其余（ENGINEER、二级管理员、缺等级管理员）：仅服务端可信组织上下文解析出的
 *   本公司，口径与既有行为一致，不放宽。
 *
 * 等级来自账号当前事实（不信任 JWT 静态等级），组织来自可信成员关系（不接受客户端
 * 自报）。一级管理员不再要求本人组织成员关系：跨公司读取是需求明确授权，
 * 无成员关系不构成拒绝理由；二级管理员与工程师仍失败关闭。
 * 范围只决定「哪些公司的正式资料可读」，上架/归属确认/软删谓词由 QueryService
 * 统一叠加，避免各入口各写一套过滤条件。
 */
export async function resolveReferenceDocumentReadScope(params: {
  session: UsecaseSession;
  accountQueryService: ReferenceDocumentAdminLevelReader;
  organizationContextService: ReferenceDocumentOrganizationReader;
}): Promise<ReferenceDocumentReadScope> {
  assertReferenceDocumentReadRole(params.session.roles);

  if (params.session.roles.includes(IdentityTypeEnum.SUPER_ADMIN)) {
    const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(
      params.session.accountId,
    );
    if (adminLevel === 1) {
      return { kind: 'GLOBAL' };
    }
  }

  const membership = await params.organizationContextService.resolveForAccount({
    accountId: params.session.accountId,
  });
  return { kind: 'ORGANIZATION', organizationId: membership.organizationId };
}
