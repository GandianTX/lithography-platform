// src/usecases/auth/resolve-session-restriction.usecase.ts

import type { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { resolveSessionRestriction } from '@core/account/policy/session-restriction.policy';
import { Injectable } from '@nestjs/common';
import type { AccountSessionAuthoritySnapshot } from '@src/modules/account/account.types';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import type { OrganizationMembershipFact } from '@src/modules/lithography/organization.types';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';

/**
 * 会话限制与可信组织身份的统一解析结果。
 *
 * - `restriction`：供登录签发、每请求复核与凭据式门禁共用；
 * - `latestEngineerApplication`：账号最新一份工程师申请（非工程师身份为 null）；
 * - `engineerOrganizationId` / `adminOrganizationId`：唯一有效成员组织，0 条或多条均为 null；
 * - 申请目标组织只经 `latestEngineerApplication.organizationId` 表达，不在此授予任何权限。
 */
export interface SessionRestrictionResolution {
  readonly restriction: SessionRestriction;
  readonly latestEngineerApplication: EngineerRegistrationApplicationSnapshot | null;
  readonly engineerOrganizationId: number | null;
  readonly adminOrganizationId: number | null;
}

/**
 * 会话限制事实的唯一读取入口。
 *
 * 登录（`LoginWithPasswordUsecase`）与每请求复核（`ValidateAccessTokenSessionUsecase`）
 * 必须共用本用例，保证「签发时」与「后续请求时」按同一规则重算——资格变化（申请状态、
 * 成员关系、组织停用、双状态）会立即体现在旧令牌的下一次请求上。
 *
 * 只读：不写库、不加锁、不签发令牌；账号主键由调用方从可信链路取得。
 */
@Injectable()
export class ResolveSessionRestrictionUsecase {
  constructor(
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
  ) {}

  async execute(params: {
    readonly accountId: number;
    readonly snapshot: AccountSessionAuthoritySnapshot;
  }): Promise<SessionRestrictionResolution> {
    const { accountId, snapshot } = params;

    const memberships =
      await this.organizationMembershipQueryService.listActiveMembershipsByAccount({
        accountId,
      });
    const latestEngineerApplication =
      snapshot.identityHint === IdentityTypeEnum.ENGINEER
        ? await this.engineerRegistrationQueryService.findLatestByAccountId(accountId)
        : null;

    const engineerOrganizationIds = collectOrganizationIds(memberships, IdentityTypeEnum.ENGINEER);
    const adminOrganizationIds = collectOrganizationIds(memberships, IdentityTypeEnum.SUPER_ADMIN);

    const restriction = resolveSessionRestriction({
      mustChangePassword: snapshot.mustChangePassword,
      identityHint: snapshot.identityHint,
      accountStatus: snapshot.accountStatus,
      userState: snapshot.userInfo?.userState ?? null,
      latestEngineerApplicationStatus: latestEngineerApplication?.status ?? null,
      latestEngineerApplicationOrganizationId: latestEngineerApplication?.organizationId ?? null,
      effectiveEngineerOrganizationIds: engineerOrganizationIds,
    });

    return {
      restriction,
      latestEngineerApplication,
      engineerOrganizationId: pickUniqueOrganizationId(engineerOrganizationIds),
      adminOrganizationId: pickUniqueOrganizationId(adminOrganizationIds),
    };
  }
}

/** 按成员角色收窄可信组织集合（成员与组织有效性已由 QueryService 过滤） */
function collectOrganizationIds(
  memberships: readonly OrganizationMembershipFact[],
  memberRole: IdentityTypeEnum,
): number[] {
  return memberships
    .filter((membership) => membership.memberRole === String(memberRole))
    .map((membership) => membership.organizationId);
}

/** 只有恰好一条成员关系时可确定可信组织；0 条（无归属）与多条（歧义）一律 null */
function pickUniqueOrganizationId(organizationIds: readonly number[]): number | null {
  return organizationIds.length === 1 ? organizationIds[0] : null;
}
