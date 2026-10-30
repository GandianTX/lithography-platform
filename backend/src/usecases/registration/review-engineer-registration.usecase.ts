// src/usecases/registration/review-engineer-registration.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  EngineerRegistrationReviewAction,
  EngineerRegistrationApplicationStatus,
} from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import {
  ADMIN_USER_ERROR,
  DomainError,
  ENGINEER_REGISTRATION_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { EngineerRegistrationService } from '@src/modules/lithography/engineer-registration.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import type {
  ReviewEngineerRegistrationCommand,
  ReviewEngineerRegistrationResult,
} from './admin-engineer-registration.types';
import {
  normalizeEngineerRegistrationApplicationId,
  normalizeEngineerRegistrationReviewComment,
  normalizeEngineerRegistrationReviewAction,
} from './registration-input.normalize';
import {
  assertEngineerRegistrationReviewPermission,
  assertRegistrationAdminSession,
} from './engineer-registration-review-permission';

/**
 * 所属组织管理员对工程师注册申请做一次性终态决策。
 *
 * 权限与组织范围：精确 SUPER_ADMIN + 可信组织管理员身份；申请不属于该组织一律
 * `APPLICATION_NOT_FOUND`，不使用客户端自报 organizationId。
 *
 * 事务与锁序（与拒绝后重提共用同一顺序，避免死锁）：
 * 1. 事务内解析可信组织（成员事实按事务连接读取）；
 * 2. 读取申请取得申请人主键并校验归属；
 * 3. **先锁申请人账号行，再锁申请行**（`pessimistic_write`）；
 * 4. 锁内复核申请仍为 PENDING、仍属本组织；申请人三源角色收敛为 ENGINEER、
 *    双状态同为 PENDING/PENDING、且无有效成员关系——任何一项不成立即失败关闭，零写入；
 * 5. 终态写入：
 *    - `APPROVE`：建立 `ENGINEER` 成员关系 + 账号 `ACTIVE` + 资料 `ACTIVE` +
 *      申请 `APPROVED`，全部同一事务；
 *    - `REJECT`：仅写申请 `REJECTED` 与必填审核意见，账号保持 `PENDING/PENDING`，
 *      可凭本人凭据重提（历史拒绝记录永久保留）；
 * 6. 决策条件更新只允许从 PENDING 迁出；并发第二次决策命中 0 行 →
 *    `APPLICATION_STATE_CONFLICT`（对外 CONFLICT），不覆盖已写入的终态。
 *
 * 不新增角色、不创建管理员、不修改登录凭据；审核通过后账号才具备登录能力
 * （登录与令牌复核链路由 S1 统一阻断待审账号）。
 */
@Injectable()
export class ReviewEngineerRegistrationUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly organizationMembershipService: OrganizationMembershipService,
    private readonly engineerRegistrationService: EngineerRegistrationService,
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
    private readonly organizationContext: TrustedOrganizationContextQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(ReviewEngineerRegistrationUsecase.name);
  }

  async execute(
    command: ReviewEngineerRegistrationCommand,
  ): Promise<ReviewEngineerRegistrationResult> {
    const applicationId = normalizeEngineerRegistrationApplicationId(command.applicationId);
    const action = normalizeEngineerRegistrationReviewAction(command.action);
    const reviewComment = normalizeEngineerRegistrationReviewComment(command.reviewComment);
    if (action === EngineerRegistrationReviewAction.REJECT && reviewComment === null) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
        '拒绝注册申请时必须填写审核意见',
        { field: 'reviewComment' },
      );
    }

    const actionLabel = action === EngineerRegistrationReviewAction.APPROVE ? '通过' : '拒绝';
    // 会话级权限是纯内存判定：先拒绝，不为越权调用开启事务；
    // 事务内仍走共享断言（含可信组织成员事实复核），两者口径一致。
    assertRegistrationAdminSession(command.session, actionLabel);

    try {
      return await this.transactionRunner.run(async (transactionContext) => {
        const organization = await assertEngineerRegistrationReviewPermission({
          session: command.session,
          actionLabel,
          organizationContext: this.organizationContext,
          transactionContext,
        });

        const application = await this.engineerRegistrationQueryService.findById(
          applicationId,
          transactionContext,
        );
        if (application === null || application.organizationId !== organization.organizationId) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND,
            '注册申请不存在',
          );
        }

        // 锁序：账号行在前、申请行在后，与重提流程一致
        const lockedCredential = await this.accountService.lockMyAccountCredentialSnapshot({
          accountId: application.accountId,
          transactionContext,
        });
        if (lockedCredential === null) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
            '申请关联账号已不存在，无法审核',
            undefined,
            { diagnostic: 'APPLICANT_ACCOUNT_MISSING', applicationId },
          );
        }

        const lockedApplication = await this.engineerRegistrationService.lockApplicationById(
          applicationId,
          transactionContext,
        );
        if (lockedApplication === null) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND,
            '注册申请不存在',
          );
        }
        if (lockedApplication.organizationId !== organization.organizationId) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND,
            '注册申请不存在',
          );
        }
        if (lockedApplication.status !== EngineerRegistrationApplicationStatus.PENDING) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
            '该申请已被处理，请刷新后查看最新状态',
          );
        }

        await this.assertPendingEngineerApplicant(
          application.accountId,
          applicationId,
          transactionContext,
        );

        const reviewedAt = new Date();
        const reviewedByAccountId = command.session.accountId;

        if (action === EngineerRegistrationReviewAction.APPROVE) {
          // 同事务：有效成员关系、账号启用、资料启用、申请通过四步同成同败
          await this.organizationMembershipService.insertMembership(
            {
              organizationId: organization.organizationId,
              accountId: application.accountId,
              memberRole: IdentityTypeEnum.ENGINEER,
            },
            transactionContext,
          );
          await this.accountService.updateAccount(
            application.accountId,
            { status: AccountStatus.ACTIVE, updatedAt: reviewedAt },
            transactionContext,
          );
          await this.accountService.updateUserInfoFields({
            accountId: application.accountId,
            patch: { userState: UserState.ACTIVE },
            transactionContext,
          });
        }

        const decision = await this.engineerRegistrationService.updateApplicationDecision(
          {
            applicationId,
            status:
              action === EngineerRegistrationReviewAction.APPROVE
                ? EngineerRegistrationApplicationStatus.APPROVED
                : EngineerRegistrationApplicationStatus.REJECTED,
            reviewedByAccountId,
            reviewedAt,
            reviewComment,
          },
          transactionContext,
        );
        if (!decision.updated) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
            '该申请已被处理，请刷新后查看最新状态',
          );
        }

        const reviewedApplication = await this.engineerRegistrationQueryService.findById(
          applicationId,
          transactionContext,
        );
        if (reviewedApplication === null) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.READ_FAILED,
            '审核结果读取失败，请稍后重试',
            undefined,
            { diagnostic: 'REVIEWED_APPLICATION_NOT_READABLE', applicationId },
          );
        }
        const applicant = await this.adminUserQueryService.findAdminUserViewById({
          accountId: application.accountId,
          transactionContext,
        });
        if (applicant === null) {
          throw new DomainError(
            ADMIN_USER_ERROR.READ_FAILED,
            '申请人账号资料读取失败，请稍后重试',
            undefined,
            { diagnostic: 'APPLICANT_VIEW_NOT_READABLE', accountId: application.accountId },
          );
        }

        this.logger.info(
          {
            applicationId,
            accountId: application.accountId,
            organizationId: organization.organizationId,
            action,
          },
          '工程师注册申请审核完成',
        );

        return { application: reviewedApplication, applicant };
      });
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.WRITE_FAILED,
        '审核注册申请失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 锁内复核申请人确实是「待审工程师」，且尚未获得组织成员关系。
   *
   * 任何一项不成立都说明申请与账号事实已漂移（或已被并发启用），
   * 统一失败关闭为 `APPLICATION_STATE_CONFLICT`，绝不自动修复、绝不继续写入。
   */
  private async assertPendingEngineerApplicant(
    accountId: number,
    applicationId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const statusFacts = await this.adminUserQueryService.findAdminUserStatusFacts({
      accountId,
      transactionContext,
    });
    if (
      statusFacts === null ||
      statusFacts.accountStatus !== AccountStatus.PENDING ||
      statusFacts.userState !== UserState.PENDING
    ) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
        '申请人账号当前状态不允许审核',
        undefined,
        { diagnostic: 'APPLICANT_NOT_PENDING', applicationId },
      );
    }

    const bootstrap = await this.accountQueryService.getLoginBootstrapSnapshot({
      accountId,
      transactionContext,
    });
    const convergence = convergeAccountRole({
      identityHint: bootstrap.account.identityHint,
      accessGroup: bootstrap.userInfo.accessGroup,
      metaDigest: bootstrap.userInfo.metaDigest,
    });
    if (!convergence.converged || convergence.role !== IdentityTypeEnum.ENGINEER) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
        '申请人账号角色不允许审核',
        undefined,
        { diagnostic: 'APPLICANT_ROLE_NOT_ENGINEER', applicationId },
      );
    }

    const memberships =
      await this.organizationMembershipQueryService.listActiveMembershipsByAccount({
        accountId,
        transactionContext,
      });
    if (memberships.length > 0) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
        '申请人已存在有效组织成员关系，无法重复审核',
        undefined,
        { diagnostic: 'APPLICANT_ALREADY_MEMBER', applicationId },
      );
    }
  }
}
