// src/usecases/reference-document/reference-document-access.ts

import { AccountQueryService } from '@src/modules/account/queries/account.query.service';

/**
 * 参考资料读侧跨组织范围判定：只有数据库当前 `admin_level = 1` 的一级管理员
 * 可以查看其他公司的「正式」参考资料。
 *
 * 等级缺失、非法值或非一级一律返回 `false`（保持既有的本组织范围，失败关闭），
 * 不信任 token 侧的角色声明或前端传入的等级。
 */
export async function canReadCrossOrganizationReferenceDocuments(params: {
  accountQueryService: AccountQueryService;
  accountId: number;
}): Promise<boolean> {
  const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(params.accountId);
  return adminLevel === 1;
}
