// src/usecases/registration/resubmit-engineer-registration.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import {
  ACCOUNT_ERROR,
  ENGINEER_REGISTRATION_ERROR,
  DomainError,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { EngineerRegistrationService } from '@src/modules/lithography/engineer-registration.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import { isEngineerRegistrationPasswordVerified } from './engineer-registration-credential';
import type {
  ResubmitEngineerRegistrationCommand,
  ResubmitEngineerRegistrationResult,
} from './engineer-registration.types';
import {
  normalizeEngineerRegistrationCredential,
  normalizeRegistrationApplicationNote,
  normalizeRegistrationOrganizationId,
} from './registration-input.normalize';

/**
 * 拒绝后重提工程师注册申请。
 *
 * 身份证明：与本人状态查询同口径（密码凭据证明），不放行登录、不签发 Token。
 *
 * 事务与锁序（与审批流程共用同一顺序，避免死锁）：
 * 1. 事务内先锁申请人账号行（`pessimistic_write`）；
 * 2. 再锁账号最新一份申请行；读取结果决定可重提性：
 *    - 无历史 / 已通过 → `RESUBMIT_NOT_ALLOWED`；
 *    - 已有待审 → `PENDING_APPLICATION_EXISTS`；
 *    - 最新为已拒绝 → 插入一份新的 PENDING 申请；
 * 3. 插入后同事务回读，返回新申请最小事实。
 *
 * 重提**不修改**历史申请行：原拒绝记录与审核意见永久保留，新增一份 PENDING，
 * 因此审核历史完整、可追溯。
 *
 * 前置事实复核（任何一项不成立即拒绝，防止绕过）：
 * - 账号三源角色必须收敛为 ENGINEER（不是工程师账号则没有可重提的申请）；
 * - 账号双状态必须为 `PENDING / PENDING`（已开通/停用账号不得再申请）；
 * - 账号不得已有有效组织成员关系（避免以重提方式绕过既有成员边界）；
 * - 所选组织必须仍为 ACTIVE。
 *
 * 不新增角色、不创建管理员、不改变账号双状态。
 */
@Injectable()
export class ResubmitEngineerRegistrationUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly engineerRegistrationService: EngineerRegistrationService,
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(ResubmitEngineerRegistrationUsecase.name);
  }

  async execute(
    command: ResubmitEngineerRegistrationCommand,
  ): Promise<ResubmitEngineerRegistrationResult> {
    const credentialInput = normalizeEngineerRegistrationCredential({
      accountIdentifier: command.accountIdentifier,
      password: command.password,
    });
    const organizationId = normalizeRegistrationOrganizationId(command.organizationId);
    const applicationNote = normalizeRegistrationApplicationNote(command.applicationNote);

    // 事务外只解析账号主键；真正的凭据验证与全部裁决都在锁内完成
    const credential = await this.accountQueryService.findCredentialByLoginName({
      loginName: credentialInput.accountIdentifier,
    });
    if (credential === null) {
      throw new DomainError(ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH, '账号或密码不正确');
    }

    try {
      return await this.transactionRunner.run(async (transactionContext) => {
        const lockedCredential = await this.accountService.lockMyAccountCredentialSnapshot({
          accountId: credential.id,
          transactionContext,
        });
        if (
          lockedCredential === null ||
          !isEngineerRegistrationPasswordVerified(credentialInput.password, lockedCredential)
        ) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH,
            '账号或密码不正确',
          );
        }

        await this.assertPendingEngineerAccount(credential.id, transactionContext);

        const organization = await this.organizationQueryService.findActiveRegistrationOption({
          organizationId,
          transactionContext,
        });
        if (organization === null) {
          throw new DomainError(ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE, '所选组织不存在或已停用');
        }

        const memberships =
          await this.organizationMembershipQueryService.listActiveMembershipsByAccount({
            accountId: credential.id,
            transactionContext,
          });
        if (memberships.length > 0) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.RESUBMIT_NOT_ALLOWED,
            '账号已开通组织成员关系，无需重新申请',
          );
        }

        const latest = await this.engineerRegistrationService.lockLatestApplicationByAccountId(
          credential.id,
          transactionContext,
        );
        if (latest === null) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.RESUBMIT_NOT_ALLOWED,
            '没有可重提的已拒绝申请',
          );
        }
        if (latest.status === EngineerRegistrationApplicationStatus.PENDING) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.PENDING_APPLICATION_EXISTS,
            '已有待审核的注册申请，请等待审核结果',
          );
        }
        if (latest.status !== EngineerRegistrationApplicationStatus.REJECTED) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.RESUBMIT_NOT_ALLOWED,
            '仅被拒绝的申请允许重新提交',
          );
        }

        const submittedAt = new Date();
        const { applicationId } = await this.engineerRegistrationService.insertApplication(
          {
            accountId: credential.id,
            organizationId,
            applicationNote,
            submittedAt,
          },
          transactionContext,
        );

        const snapshot = await this.engineerRegistrationQueryService.findById(
          applicationId,
          transactionContext,
        );
        if (snapshot === null) {
          throw new DomainError(
            ENGINEER_REGISTRATION_ERROR.READ_FAILED,
            '注册申请提交后读取失败，请稍后重试',
            undefined,
            { diagnostic: 'CREATED_APPLICATION_NOT_READABLE', applicationId },
          );
        }

        this.logger.info(
          { accountId: credential.id, applicationId, organizationId },
          '工程师注册申请重提成功',
        );
        return {
          applicationId,
          organizationId: snapshot.organizationId,
          status: snapshot.status,
          submittedAt: snapshot.submittedAt,
        };
      });
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.WRITE_FAILED,
        '注册申请重提失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 复核账号确实是「待审工程师」：三源角色收敛为 ENGINEER 且双状态同为 PENDING。
   *
   * 该复核同时覆盖「审核前登录/业务权限阻断」的另一面——已开通或已停用的账号
   * 即使掌握密码也不得再提交申请，避免以重提方式制造第二份待审申请。
   */
  private async assertPendingEngineerAccount(
    accountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
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
        ENGINEER_REGISTRATION_ERROR.ACCOUNT_NOT_PENDING,
        '该账号不是待审核的工程师账号',
      );
    }

    const statusFacts = await this.adminUserQueryService.findAdminUserStatusFacts({
      accountId,
      transactionContext,
    });
    if (
      statusFacts === null ||
      statusFacts.accountStatus !== AccountStatus.PENDING ||
      statusFacts.userState !== UserState.PENDING
    ) {
      throw new DomainError(ENGINEER_REGISTRATION_ERROR.ACCOUNT_NOT_PENDING, '账号不在待审核状态');
    }
  }
}
