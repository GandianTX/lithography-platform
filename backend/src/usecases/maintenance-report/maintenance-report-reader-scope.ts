// src/usecases/maintenance-report/maintenance-report-reader-scope.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';

/** 只读依赖（与 reference-document-read-scope 同模式，便于用例单测注入替身）。 */
export interface MaintenanceReportAdminLevelReader {
  findAdminLevelByAccountId(accountId: number): Promise<number | null>;
}

export interface MaintenanceReportOrganizationReader {
  resolveForAccount(params: {
    accountId: number;
  }): Promise<{ organizationId: number; memberRole: string }>;
}

/**
 * 「我的资料记录」读者范围决议（2026-11-21 平台级角色口径确认）：
 *
 * - FIRST_LEVEL_ADMIN：一级管理员（SUPER_ADMIN 且账号当前事实 `admin_level=1`）
 *   是平台级角色，没有业务上的所属公司，也不存在换公司场景——本页面按
 *   「作者本人」读取自己的记录，不解析、不要求组织成员关系（没有本人记录时
 *   返回正常空态而不是组织错误）；其全公司正式资料读取走参考资料库/文档
 *   数据库既有权限，不经本页面。
 * - ORGANIZATION：其余读者（工程师、二级管理员、缺等级管理员）按可信组织
 *   成员关系解析唯一本公司（0 条/多条成员关系失败关闭），页面谓词=作者本人
 *   +本公司；组织成员关系是业务所属公司的服务端事实来源，不接受客户端自报。
 *
 * 等级来自账号当前事实（不信任 JWT 静态等级，行缺失失败关闭）；seed 等环境里
 * 一级管理员账号可能存在技术性成员关系行，那只是数据关联，不是业务所属公司，
 * 不得当作本页面的权限条件使用。
 */
export type MyMaintenanceReportReaderScope =
  { kind: 'FIRST_LEVEL_ADMIN' } | { kind: 'ORGANIZATION'; organizationId: number };

export async function resolveMyMaintenanceReportReaderScope(params: {
  session: UsecaseSession;
  adminLevelReader: MaintenanceReportAdminLevelReader;
  organizationContextService: MaintenanceReportOrganizationReader;
}): Promise<MyMaintenanceReportReaderScope> {
  if (params.session.roles.includes(IdentityTypeEnum.SUPER_ADMIN)) {
    const adminLevel = await params.adminLevelReader.findAdminLevelByAccountId(
      params.session.accountId,
    );
    if (adminLevel === 1) {
      return { kind: 'FIRST_LEVEL_ADMIN' };
    }
  }

  const membership = await params.organizationContextService.resolveForAccount({
    accountId: params.session.accountId,
  });
  return { kind: 'ORGANIZATION', organizationId: membership.organizationId };
}
