// src/usecases/maintenance-report/record-package-source-identity.verifier.ts

/**
 * 记录包来源身份的**本机可信核验**（任务 09 S3 补丁 P4）。
 *
 * 归属：**来源域（维修报告）**。按端口契约的纪律，「身份、公司范围、版本条件
 * 都由来源域裁决」，任务 09 的导入编排只向本核验器请求一次受控结论，
 * 不自己另立一套账号状态／公司归属判定。
 *
 * 核验依据全部来自**本机数据库当前事实**：
 * - `base_user_account.status`：账号行是否存在、是否仍启用；
 * - `base_user_info.user_state`：资料行是否存在、是否仍启用；
 * - `organization_membership` ＋ `organization`：来源账号是不是目标公司的在职成员
 *   （覆盖「归属变更」「已离开」「组织停用」）；
 * - `base_user_account.admin_level`：导入者的管理员等级（决定其对本公司记录的权限范围）。
 *
 * 包内自报的 `source_account_id` 只作为**待核验的账号 id** 进入，
 * 不作为授权真源；缺失或不可信一律失败关闭并给出可读原因。
 */

import { Injectable } from '@nestjs/common';

import {
  evaluateRecordPackageSourceIdentity,
  type RecordPackageSourceIdentityDecision,
} from '@core/local-runtime/policy/record-package-source-identity.policy';

import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';

/** 核验入参（与端口契约的 `verifySourceIdentity` 一致） */
export type RecordPackageSourceIdentityQuery = {
  sourceAccountId: number | null;
  ownerOrganizationId: number | null;
  targetOrganizationId: number;
  importerAccountId: number;
};

@Injectable()
export class RecordPackageSourceIdentityVerifier {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
  ) {}

  /**
   * 核验包内来源身份是否可以作为本次导入的作者事实。
   *
   * 读不到账号行不是「放行」，而是「不可核验」→ 拒绝。
   */
  async verify(
    query: RecordPackageSourceIdentityQuery,
  ): Promise<RecordPackageSourceIdentityDecision> {
    const sourceAccountId = query.sourceAccountId;
    if (sourceAccountId === null) {
      return evaluateRecordPackageSourceIdentity({
        sourceAccountId: null,
        accountStatus: null,
        userState: null,
        memberships: [],
        ownerOrganizationId: query.ownerOrganizationId,
        targetOrganizationId: query.targetOrganizationId,
        importerAccountId: query.importerAccountId,
        importerAdminLevel: null,
      });
    }

    const [authority, memberships, importerAdminLevel] = await Promise.all([
      this.accountQueryService.findSessionAuthoritySnapshot({ accountId: sourceAccountId }),
      this.organizationMembershipQueryService.listMembershipsForBinding({
        accountId: sourceAccountId,
      }),
      this.readImporterAdminLevel(query.importerAccountId),
    ]);

    return evaluateRecordPackageSourceIdentity({
      sourceAccountId,
      accountStatus: authority.accountStatus,
      userState: authority.userInfo?.userState ?? null,
      memberships: memberships.map((membership) => ({
        organizationId: membership.organizationId,
        membershipStatus: membership.membershipStatus,
        organizationStatus: membership.organizationStatus,
      })),
      ownerOrganizationId: query.ownerOrganizationId,
      targetOrganizationId: query.targetOrganizationId,
      importerAccountId: query.importerAccountId,
      importerAdminLevel,
    });
  }

  /**
   * 导入者的管理员等级（账号当前事实）。
   *
   * 账号行缺失时按「非管理员」处理（失败关闭）：会话已认证但账号行读不到时，
   * 不能据此扩大权限。
   */
  private async readImporterAdminLevel(importerAccountId: number): Promise<number | null> {
    try {
      return await this.accountQueryService.findAdminLevelByAccountId(importerAccountId);
    } catch {
      return null;
    }
  }
}
