// src/usecases/maintenance-report/record-package-source-identity.verifier.ts

/**
 * 记录包来源身份的**本机可信核验**（任务 09 S3 补丁 P4；S1-2 修订）。
 *
 * 归属：**来源域（维修报告）**。按端口契约的纪律，「身份、公司范围、版本条件
 * 都由来源域裁决」，任务 09 的导入编排只向本核验器请求一次受控结论，
 * 不自己另立一套账号状态／公司归属判定。
 *
 * 核验依据全部来自**本机数据库当前事实**：
 * - `base_user_account.account_uuid` ／ `login_name`：跨端可移植来源账号标识
 *   （稳定标识命中即同一条账号事实；账号名命中需配合姓名快照交叉核对）；
 * - `base_user_account.status`：账号行是否存在、是否仍启用；
 * - `base_user_info.user_state`：资料行是否存在、是否仍启用；
 * - `organization.organization_code`：来源公司的稳定业务编码（跨设备对齐公司）；
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
import {
  evaluateRecordPackageCompanyIdentity,
  evaluateRecordPackagePortableIdentity,
  type RecordPackagePortableSourceIdentity,
} from '@core/local-runtime/policy/record-package-portable-identity.policy';

import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';

/** 核验入参（与端口契约的 `verifySourceIdentity` 一致） */
export type RecordPackageSourceIdentityQuery = {
  sourceAccountId: number | null;
  ownerOrganizationId: number | null;
  targetOrganizationId: number;
  importerAccountId: number;
  /** 包内携带的跨端可移植来源身份（任务 09 S1-2） */
  portableSourceIdentity: RecordPackagePortableSourceIdentity;
};

@Injectable()
export class RecordPackageSourceIdentityVerifier {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  /**
   * 核验包内来源身份是否可以作为本次导入的作者事实。
   *
   * 读不到账号行不是「放行」，而是「不可核验」→ 拒绝。
   *
   * 三段裁决（顺序固定）：
   * 1. **公司身份**：包内携带公司业务编码时按编码对齐（跨设备时源机公司 id 无意义）；
   * 2. **可移植账号身份**：稳定标识 → 账号名 → 均不可核验即拒绝
   *    （**绝不**用包内数字 id 选作者）；
   * 3. **账号当前事实与导入者权限**：账号启用、资料启用、目标公司在职、导入者有权。
   */
  async verify(
    query: RecordPackageSourceIdentityQuery,
  ): Promise<RecordPackageSourceIdentityDecision> {
    // ① 公司身份（跨安装口径）
    const targetOrganization = await this.organizationQueryService.findOrganizationIdentityById({
      organizationId: query.targetOrganizationId,
    });
    const companyDecision = evaluateRecordPackageCompanyIdentity({
      sourceOrganizationCode: query.portableSourceIdentity.sourceOrganizationCode,
      sourceOrganizationId: query.ownerOrganizationId,
      targetOrganizationCode: targetOrganization?.organizationCode ?? null,
      targetOrganizationId: query.targetOrganizationId,
    });
    if (!companyDecision.allowed) {
      return { allowed: false, reason: companyDecision.reason };
    }

    // ② 可移植账号身份（稳定标识优先，账号名次之；均不可核验即拒绝）
    const portable = query.portableSourceIdentity;
    const [matchedByStableId, matchedByLoginName] = await Promise.all([
      portable.sourceAccountUuid === null
        ? Promise.resolve(null)
        : this.accountQueryService
            .findCrossInstallationIdentity({
              accountUuid: portable.sourceAccountUuid,
              loginName: null,
            })
            .then((identity) => (identity === null ? null : { accountId: identity.accountId })),
      portable.sourceAccountLoginName === null
        ? Promise.resolve(null)
        : this.accountQueryService
            .findCrossInstallationIdentity({
              accountUuid: null,
              loginName: portable.sourceAccountLoginName,
            })
            .then((identity) =>
              identity === null
                ? null
                : { accountId: identity.accountId, realName: identity.realName },
            ),
    ]);
    const portableDecision = evaluateRecordPackagePortableIdentity({
      portable,
      matchedByStableId,
      matchedByLoginName,
    });
    if (!portableDecision.allowed) {
      return { allowed: false, reason: portableDecision.reason };
    }

    const resolvedSourceAccountId = portableDecision.sourceAccountId;

    // ③ 账号当前事实与导入者权限
    const [authority, memberships, importerAdminLevel] = await Promise.all([
      this.accountQueryService.findSessionAuthoritySnapshot({
        accountId: resolvedSourceAccountId,
      }),
      this.organizationMembershipQueryService.listMembershipsForBinding({
        accountId: resolvedSourceAccountId,
      }),
      this.readImporterAdminLevel(query.importerAccountId),
    ]);

    return evaluateRecordPackageSourceIdentity({
      sourceAccountId: query.sourceAccountId,
      portable,
      resolvedSourceAccountId,
      identityBasis: portableDecision.basis,
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
