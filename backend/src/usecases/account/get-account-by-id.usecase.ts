// 文件位置：src/usecases/account/get-account-by-id.usecase.ts
import { IdentityTypeEnum, UserAccountView } from '@app-types/models/account.types';
import { UsecaseSession } from '@app-types/auth/session.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { ACCOUNT_ERROR, DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  assertVisibleUserInfoTargetOrganization,
  throwVisibleUserInfoTargetUnavailable,
} from './visible-user-info-organization';

type AccountDetail = UserAccountView;

@Injectable()
export class GetAccountByIdUsecase {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
  ) {}

  /**
   * 获取账户详情（旧 `account(id)` 查询）。
   *
   * 授权顺序（不可交换，且全部先于账号行读取）：
   * 1. 本人查询保留原行为：`session.accountId === targetAccountId` 直接放行，
   *    不要求组织归属（历史无组织账号仍可自查）；
   * 2. 非本人查询沿用**原有管理员权限**（`roles` 含 SUPER_ADMIN），不放宽给 ENGINEER /
   *    CUSTOMER；权限不足在读取前即 `ACCESS_DENIED`，调用方无法用目标 ID 探测存在性；
   * 3. 管理员通过后叠加**可信同组织校验**（复用 `userInfo` / `updateUserInfo` 的共享实现）：
   *    操作者必须有唯一有效组织，目标必须在该组织内有有效成员关系；组织缺失、歧义、
   *    组织停用或成员已 LEFT 一律失败关闭；
   * 4. 跨组织目标与不存在的目标使用同一拒绝口径（`USER_INFO_NOT_FOUND` → NOT_FOUND），
   *    不泄露目标存在性；只有通过授权后才读取账号行并返回登录邮箱、角色与登录历史；
   * 5. 授权后账号行消失（并发删除等）按同一「目标不可用」口径处理，不塌缩为
   *    `ACCOUNT_NOT_FOUND`（该码与 `AUTH_ERROR.ACCOUNT_NOT_FOUND` 同值，会被映射为
   *    UNAUTHENTICATED）。
   *
   * 依赖方向（`usecase.rules.md`）：组织事实跨域读取在此编排；account 域 QueryService
   * 只按主键做纯读投影，不含授权判断；Resolver 不加业务判断。
   */
  async execute(params: {
    session: UsecaseSession;
    targetAccountId: number;
  }): Promise<AccountDetail> {
    const { session, targetAccountId } = params;

    if (!Number.isInteger(targetAccountId) || targetAccountId <= 0) {
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '非法的目标账户 ID');
    }

    const isSelf = session.accountId === targetAccountId;

    if (!isSelf) {
      // 原有管理员权限保持不变：仅 SUPER_ADMIN 可查看他人账号，ENGINEER / CUSTOMER 仍拒绝
      if (!hasRole(session.roles, IdentityTypeEnum.SUPER_ADMIN)) {
        throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '无权限查看该账户信息');
      }

      // 叠加可信同组织校验；失败关闭且早于任何账号行读取
      await assertVisibleUserInfoTargetOrganization({
        organizationContextQueryService: this.organizationContextQueryService,
        organizationMembershipQueryService: this.organizationMembershipQueryService,
        operatorAccountId: session.accountId,
        targetAccountId,
      });
    }

    const account = await this.accountQueryService.findAccountSnapshotById({
      accountId: targetAccountId,
    });
    if (!account) {
      if (isSelf) {
        throw new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账户不存在');
      }
      return throwVisibleUserInfoTargetUnavailable();
    }
    return account;
  }
}
