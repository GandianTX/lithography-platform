// 文件位置：src/usecases/account/get-visible-user-info.usecase.ts
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UserInfoView } from '@app-types/models/auth.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { canViewUserInfo } from '@core/account/policy/user-info-visibility.policy';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { UsecaseSession } from '@app-types/auth/session.types';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { FetchUserInfoUsecase } from './fetch-user-info.usecase';
import { assertVisibleUserInfoTargetOrganization } from './visible-user-info-organization';

export type VisibleDetailMode = 'BASIC' | 'FULL';

@Injectable()
export class GetVisibleUserInfoUsecase {
  constructor(
    private readonly fetchUserInfoUsecase: FetchUserInfoUsecase,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
  ) {}

  /**
   * 执行按可见性读取用户信息
   * - 角色策略（非本人目标的准入前提）：
   *   - SUPER_ADMIN：可查看其他账户的用户信息
   *   - ENGINEER：可查看其他账户的用户信息
   *   - CUSTOMER：仅可查看自己
   * - 组织范围（非本人目标）：操作者必须有唯一有效组织，且目标在同一有效组织内；
   *   跨组织 / 目标无有效成员关系与目标不存在使用同一拒绝口径，不泄露存在性
   * - 本人路径：保留原有自查权限，不要求历史无组织账号先加入组织
   * - 读取实现：统一通过 Account 域的 UserInfo 读取，保持与账户绑定
   * - 按需反馈：支持 'BASIC' 与 'FULL' 两种详情级别
   */
  async execute(params: {
    session: UsecaseSession;
    targetAccountId: number;
    detail?: VisibleDetailMode;
  }): Promise<UserInfoView> {
    const { session, targetAccountId } = params;
    const detail: VisibleDetailMode = params.detail ?? 'FULL';

    if (!Number.isInteger(targetAccountId) || targetAccountId <= 0) {
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '非法的目标账户 ID');
    }

    const allowed = this.isAllowedToView(session, targetAccountId);
    if (!allowed) {
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '无权限查看该用户信息');
    }

    // 非本人目标：角色策略通过后仍需同一有效组织，跨组织统一按目标不存在拒绝。
    // 本人路径不进入组织解析，保留历史无组织账号的自查能力。
    if (session.accountId !== targetAccountId) {
      await assertVisibleUserInfoTargetOrganization({
        organizationContextQueryService: this.organizationContextQueryService,
        organizationMembershipQueryService: this.organizationMembershipQueryService,
        operatorAccountId: session.accountId,
        targetAccountId,
      });
    }

    const view = await this.fetchUserInfoUsecase.executeStrict({ accountId: targetAccountId });

    if (detail === 'BASIC') {
      return this.maskToBasic(view);
    }
    return view;
  }

  /**
   * 角色可见性策略判定
   */
  private isAllowedToView(session: UsecaseSession, targetAccountId: number): boolean {
    const isSelf = session.accountId === targetAccountId;
    if (isSelf) return true;
    if (hasRole(session.roles, IdentityTypeEnum.SUPER_ADMIN)) return true;
    return canViewUserInfo(session.roles, { isSelf });
  }

  /**
   * 按需反馈：将完整视图收敛为基础字段视图
   */
  private maskToBasic(view: UserInfoView): UserInfoView {
    return {
      accountId: view.accountId,
      nickname: view.nickname,
      gender: view.gender,
      birthDate: view.birthDate,
      avatarUrl: view.avatarUrl,
      email: null,
      signature: null,
      accessGroup: view.accessGroup,
      address: null,
      phone: view.phone,
      tags: null,
      geographic: null,
      metaDigest: null,
      notifyCount: 0,
      unreadCount: 0,
      userState: view.userState,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  }
}
