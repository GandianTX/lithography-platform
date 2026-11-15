// src/usecases/account/my-account-settings.support.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import type {
  MyAccountSettingsSnapshot,
  MyAccountSettingsView,
} from '@src/modules/account/account.types';
import type { MyAccountTrustedOrganizationFacts } from './my-account-settings.types';

/**
 * 当前用户账号设置场景的共享纯函数支撑：内部快照 → 公开稳定 View 的**单一映射实现**，
 * 供读取用例（P1）与设置更新用例（P2）共用，不得各写一份——「剥离 `accountId`」是
 * 安全敏感的映射决策，两份实现会让将来新增敏感字段时出现只改一处的不一致漂移。
 *
 * 逐字段显式赋值，不使用 `{ ...snapshot }` 展开：公开 View 上不存在 `accountId` 等内部
 * 字段，新增内部字段不会自动流入 View（编译期结构约束，见 `MyAccountSettingsView` 注释）。
 */
export function toMyAccountSettingsView(
  snapshot: MyAccountSettingsSnapshot,
  trustedCompanyName: string | null,
): MyAccountSettingsView {
  return {
    loginName: snapshot.loginName,
    loginEmail: snapshot.loginEmail,
    nickname: snapshot.nickname,
    realName: snapshot.realName,
    companyName: snapshot.companyName,
    trustedCompanyName,
    phone: snapshot.phone,
    contactEmail: snapshot.contactEmail,
    role: snapshot.role,
    status: snapshot.status,
    adminLevel: snapshot.adminLevel,
    updatedAt: snapshot.updatedAt,
  };
}

/**
 * 按当前角色选择可信组织 ID：CUSTOMER → customer、ENGINEER → engineer、
 * SUPER_ADMIN → admin，其余角色无组织归属返回 null。
 *
 * 只做纯映射，不查询、不裁决权限；调用方据返回值决定是否读取组织名称。
 */
export function resolveTrustedOrganizationId(
  role: IdentityTypeEnum,
  facts: MyAccountTrustedOrganizationFacts,
): number | null {
  switch (role) {
    case IdentityTypeEnum.CUSTOMER:
      return facts.customerOrganizationId;
    case IdentityTypeEnum.ENGINEER:
      return facts.engineerOrganizationId;
    case IdentityTypeEnum.SUPER_ADMIN:
      return facts.adminOrganizationId;
    default:
      return null;
  }
}
