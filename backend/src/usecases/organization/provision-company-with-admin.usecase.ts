// src/usecases/organization/provision-company-with-admin.usecase.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import {
  DomainError,
  isDomainError,
  ORGANIZATION_MANAGEMENT_ERROR,
} from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import {
  ADMIN_ORGANIZATION_PROVISIONING_PURPOSE,
  computeProvisioningInputFingerprint,
  deriveProvisionedAdminLoginName,
  deriveProvisionedAdminNickname,
  generateTemporaryPasswordCandidate,
  normalizeProvisioningSubmissionKey,
} from '@core/organization/policy/admin-organization-provisioning.policy';
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PinoLogger } from 'nestjs-pino';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import {
  AdminOrganizationProvisioningService,
  DuplicateProvisioningRequestError,
  type ProvisioningRequestFact,
} from '@src/modules/lithography/admin-organization-provisioning.service';
import { isDuplicateKeyError } from '@src/modules/common/utils/database-error.util';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { normalizeAdminOrganizationCreateInput } from './admin-organization.input.normalize';
import type {
  CompanyProvisioningResult,
  CompanyProvisioningSubmission,
  ProvisionCompanyWithAdminCommand,
  ProvisionedAdminSummary,
} from './company-provisioning.types';

/** 账号插入时的占位密码；同一事务内必被真实哈希覆盖，提交前不会留下可用占位口令。 */
const PLACEHOLDER_LOGIN_PASSWORD = 'temp';

/** 临时密码候选的最大策略重试次数。 */
const TEMPORARY_PASSWORD_MAX_ATTEMPTS = 5;

/**
 * 一级管理员「新增公司并开通二级管理员」用例。
 *
 * 执行顺序固定：
 * 1. 一级管理员作用域断言（先于任何输入规范化与数据库访问）；
 * 2. 公司输入规范化；
 * 3. 提交标识归一化（`undefined` = 旧入口无幂等；`null` = 新入口缺标识即失败）；
 * 4. 有标识时事务外预读并直接回放；
 * 5. 单一事务内：提交行（若有）→ 公司 → 账号 → 密码哈希 → 资料 → 成员关系 → 回读视图 → 完成提交行；
 * 6. 事务外收敛并发重复键：回读已提交行，同指纹回放、异指纹冲突。
 *
 * 事务内先插提交行是本用例的串行点：后到的同标识请求会阻塞到先到事务提交，
 * 随后以唯一键冲突退出，避免两个请求各自算出同一登录名而互相撞 `uk_login_name`。
 *
 * 本用例不返回 ORM Entity、不记录口令/哈希/指纹原文；`temporaryPassword` 只在首次成功返回一次。
 */
@Injectable()
export class ProvisionCompanyWithAdminUsecase {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipService: OrganizationMembershipService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly provisioningService: AdminOrganizationProvisioningService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(ProvisionCompanyWithAdminUsecase.name);
  }

  async execute(command: ProvisionCompanyWithAdminCommand): Promise<CompanyProvisioningResult> {
    resolveLevelOneAdminScope(command.session, '新增公司档案');

    const data = normalizeAdminOrganizationCreateInput({
      name: command.name,
      contactPhone: command.contactPhone,
      shortName: command.shortName,
      contactName: command.contactName,
      contactEmail: command.contactEmail,
      address: command.address,
      remark: command.remark,
      status: command.status,
      isServiceProvider: command.isServiceProvider,
    });

    const actorAccountId = command.session.accountId;
    // `undefined` 保留为旧入口无幂等路径；`null` 与非法字符串在归一化时失败关闭。
    const submissionKey =
      command.submissionKey === undefined
        ? null
        : normalizeProvisioningSubmissionKey(command.submissionKey);
    const fingerprint = computeProvisioningInputFingerprint(data);

    if (submissionKey !== null) {
      const existing = await this.provisioningService.findByKey({
        purpose: ADMIN_ORGANIZATION_PROVISIONING_PURPOSE,
        submissionKey,
        actorAccountId,
      });
      if (existing !== null) {
        return this.replay({ fact: existing, fingerprint });
      }
    }

    try {
      const result = await this.transactionRunner.run(async (transactionContext) => {
        const requestId =
          submissionKey === null
            ? null
            : await this.provisioningService.reserve({
                purpose: ADMIN_ORGANIZATION_PROVISIONING_PURPOSE,
                submissionKey,
                actorAccountId,
                inputFingerprint: fingerprint,
                transactionContext,
              });

        const created = await this.organizationService.createManagedCompany(
          data,
          transactionContext,
        );
        const temporaryPassword = this.generatePolicyCompliantPassword();
        const loginName = deriveProvisionedAdminLoginName(created.organizationCode);
        const nickname = deriveProvisionedAdminNickname(data.name);
        const now = new Date();

        const outcome = await this.accountService.insertAccount({
          transactionContext,
          accountData: {
            loginName,
            // 不使用联系人邮箱作登录邮箱：登录走稳定登录名。
            loginEmail: null,
            loginPassword: PLACEHOLDER_LOGIN_PASSWORD,
            status: AccountStatus.ACTIVE,
            identityHint: IdentityTypeEnum.SUPER_ADMIN,
            adminLevel: 2,
            mustChangePassword: true,
            createdAt: now,
            updatedAt: now,
          },
        });

        if (outcome.kind === 'CREDENTIAL_CONFLICT') {
          throw new DomainError(
            ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_CONFLICT,
            '开通管理员账号与既有账号冲突，请稍后重试',
          );
        }

        await this.accountService.updateAccountPasswordHash({
          accountId: outcome.accountId,
          passwordHash: AccountService.hashPasswordWithTimestamp(
            temporaryPassword,
            outcome.createdAt,
          ),
          transactionContext,
        });

        // `meta_digest` 由 FieldEncryptionSubscriber 自动加密，本用例只传明文数组。
        await this.accountService.insertUserInfo({
          transactionContext,
          userInfoData: {
            accountId: outcome.accountId,
            nickname,
            customerOrganizationId: created.id,
            companyName: data.name,
            email: data.contactEmail,
            phone: data.contactPhone,
            accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
            metaDigest: [IdentityTypeEnum.SUPER_ADMIN],
            userState: UserState.ACTIVE,
            createdAt: now,
            updatedAt: now,
          },
        });

        await this.organizationMembershipService.insertMembership(
          {
            organizationId: created.id,
            accountId: outcome.accountId,
            memberRole: IdentityTypeEnum.SUPER_ADMIN,
          },
          transactionContext,
        );

        const organization = await this.organizationQueryService.findAdminOrganizationView({
          organizationId: created.id,
          transactionContext,
        });
        if (organization === null) {
          throw new DomainError(
            ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
            '公司创建后读取失败，请稍后重试',
            undefined,
            { diagnostic: 'CREATED_ORGANIZATION_NOT_READABLE', organizationId: created.id },
          );
        }

        if (requestId !== null) {
          await this.provisioningService.complete({
            requestId,
            organizationId: created.id,
            adminAccountId: outcome.accountId,
            transactionContext,
          });
        }

        return {
          organization,
          admin: {
            accountId: outcome.accountId,
            loginName,
            nickname,
            mustChangePassword: true,
          } satisfies ProvisionedAdminSummary,
          submission: {
            submissionId: requestId,
            replayed: false,
          } satisfies CompanyProvisioningSubmission,
          temporaryPassword,
          requestId,
        };
      });

      this.logger.info(
        {
          organizationId: result.organization.id,
          adminAccountId: result.admin.accountId,
          replayed: false,
        },
        '一级管理员新增公司并开通二级管理员成功',
      );

      return {
        organization: result.organization,
        admin: result.admin,
        submission: {
          submissionId: result.submission.submissionId,
          replayed: false,
        },
        temporaryPassword: result.temporaryPassword,
      };
    } catch (error) {
      if (error instanceof DuplicateProvisioningRequestError && submissionKey !== null) {
        const fact = await this.provisioningService.findByKey({
          purpose: ADMIN_ORGANIZATION_PROVISIONING_PURPOSE,
          submissionKey,
          actorAccountId,
        });
        if (fact === null) {
          throw new DomainError(
            ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
            '本次提交与已提交记录不一致，请刷新后重试',
          );
        }
        return this.replay({ fact, fingerprint });
      }

      if (isDomainError(error)) {
        throw error;
      }

      if (isDuplicateKeyError(error)) {
        throw new DomainError(
          ORGANIZATION_MANAGEMENT_ERROR.CODE_CONFLICT,
          '公司编号冲突，请重试',
          undefined,
          error,
        );
      }

      this.logger.error(
        {
          errorName: error instanceof Error ? error.name : 'UNKNOWN',
        },
        '一级管理员新增公司并开通二级管理员失败',
      );
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
        '新增公司失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 回放已提交结果：只返回安全引用，永不返回首次临时密码。
   *
   * 任一校验不通过（指纹不同、状态未完成、公司/账号缺失、角色或归属复核失败）
   * 统一 `SUBMISSION_CONFLICT`，不泄露差异细节。
   */
  private async replay(params: {
    fact: ProvisioningRequestFact;
    fingerprint: string;
  }): Promise<CompanyProvisioningResult> {
    const { fact } = params;

    if (
      fact.state !== 'COMPLETED' ||
      fact.inputFingerprint !== params.fingerprint ||
      fact.organizationId === null ||
      fact.adminAccountId === null
    ) {
      throw this.conflict();
    }

    const organizationId = fact.organizationId;
    const adminAccountId = fact.adminAccountId;

    const organization = await this.organizationQueryService.findAdminOrganizationView({
      organizationId,
    });
    if (organization === null) {
      throw this.conflict();
    }

    const snapshot = await this.accountQueryService.findSessionAuthoritySnapshot({
      accountId: adminAccountId,
    });
    const converged =
      snapshot.userInfo === null
        ? null
        : convergeAccountRole({
            identityHint: snapshot.identityHint,
            accessGroup: snapshot.userInfo.accessGroup,
            metaDigest: snapshot.userInfo.metaDigest,
          });

    const roleValid =
      converged !== null && converged.converged && converged.role === IdentityTypeEnum.SUPER_ADMIN;
    const accountValid =
      snapshot.accountStatus === AccountStatus.ACTIVE &&
      snapshot.identityHint === IdentityTypeEnum.SUPER_ADMIN &&
      snapshot.adminLevel === 2 &&
      snapshot.userInfo !== null &&
      snapshot.userInfo.userState === UserState.ACTIVE &&
      snapshot.userInfo.customerOrganizationId === organizationId;

    if (!roleValid || !accountValid) {
      throw this.conflict();
    }

    const membership = await this.organizationMembershipQueryService.findActiveMembership({
      accountId: adminAccountId,
      organizationId,
    });
    if (membership === null || membership.memberRole !== String(IdentityTypeEnum.SUPER_ADMIN)) {
      throw this.conflict();
    }

    const adminUser = await this.adminUserQueryService.findAdminUserViewById({
      accountId: adminAccountId,
    });
    if (adminUser === null) {
      throw this.conflict();
    }

    this.logger.info(
      { organizationId, adminAccountId, replayed: true },
      '一级管理员新增公司并开通二级管理员回放成功',
    );

    return {
      organization,
      admin: {
        accountId: adminAccountId,
        loginName:
          adminUser.loginName ?? deriveProvisionedAdminLoginName(organization.organizationCode),
        nickname: adminUser.nickname,
        // 回放返回账号当前事实：首次改密完成后不得再宣称仍需改密。
        mustChangePassword: snapshot.mustChangePassword,
      },
      submission: { submissionId: fact.id, replayed: true },
      temporaryPassword: null,
    };
  }

  private conflict(): DomainError {
    return new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_CONFLICT,
      '本次提交与已提交记录不一致，请刷新后重试',
    );
  }

  /** 生成满足策略的临时密码候选；失败不以任何形式外泄候选值。 */
  private generatePolicyCompliantPassword(): string {
    for (let attempt = 0; attempt < TEMPORARY_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
      const candidate = generateTemporaryPasswordCandidate(randomBytes);
      if (this.passwordPolicyService.validatePassword(candidate).isValid) {
        return candidate;
      }
    }

    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
      '临时密码生成失败，请稍后重试',
      undefined,
      { diagnostic: 'TEMPORARY_PASSWORD_POLICY_UNSATISFIED' },
    );
  }
}
