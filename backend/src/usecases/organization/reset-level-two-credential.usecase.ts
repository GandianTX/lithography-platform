// src/usecases/organization/reset-level-two-credential.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import {
  DomainError,
  isDomainError,
  ORGANIZATION_MANAGEMENT_ERROR,
} from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  ADMIN_CREDENTIAL_RESET_REASON_MAX_LENGTH,
  normalizeAccountId,
  normalizeOrganizationId,
  normalizeRequiredText,
} from './admin-organization.input.normalize';
import type { LevelTwoCredentialResult } from './company-admin-binding.types';
import {
  generatePolicyCompliantTemporaryPassword,
  loadBoundLevelTwoAdminForUpdate,
  maskedLoginNameOf,
  type LockedBoundLevelTwoAdmin,
} from './level-two-credential.support';

export type ResetLevelTwoCredentialCommand = {
  readonly session: UsecaseSession;
  readonly organizationId: unknown;
  readonly adminAccountId: unknown;
  readonly reason: unknown;
};

/**
 * 一级管理员二级专用重置（S3）。
 *
 * 与补发的差异：允许对**已首次改密**的合法目标重新开通（`must_change_password`
 * 为 true 或 false 均可），但必须提供必填原因，用于审计追溯。
 *
 * 授权与复核：仅一级管理员；`organizationId + adminAccountId` 必须同时命中该公司
 * 唯一合法绑定（一级账号、非管理员、错误组织、错绑、冲突、公司停用、账号停用一律拒绝）。
 *
 * 写入顺序（同一事务）：锁公司与绑定 → 写新哈希 + 置强制改密 + 递增凭据代次 →
 * 追加 `RESET_LEVEL2_CREDENTIAL` 审计（detail 含原因与脱敏登录名）。审计失败整事务回滚。
 */
@Injectable()
export class ResetLevelTwoCredentialUsecase {
  constructor(
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly accountService: AccountService,
    private readonly managementAuditService: ManagementAuditService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(ResetLevelTwoCredentialUsecase.name);
  }

  async execute(command: ResetLevelTwoCredentialCommand): Promise<LevelTwoCredentialResult> {
    const scope = resolveLevelOneAdminScope(command.session, '重置二级管理员密码');
    const organizationId = normalizeOrganizationId(command.organizationId);
    const adminAccountId = normalizeAccountId(command.adminAccountId);
    const reason = normalizeRequiredText(
      command.reason,
      'reason',
      ADMIN_CREDENTIAL_RESET_REASON_MAX_LENGTH,
      '重置原因',
    );

    try {
      const result = await this.transactionRunner.run(async (transactionContext) => {
        const bound = await loadBoundLevelTwoAdminForUpdate({
          deps: {
            organizationQueryService: this.organizationQueryService,
            organizationMembershipQueryService: this.organizationMembershipQueryService,
            adminUserQueryService: this.adminUserQueryService,
            accountService: this.accountService,
          },
          organizationId,
          transactionContext,
          expectedAccountId: adminAccountId,
        });

        const temporaryPassword = generatePolicyCompliantTemporaryPassword(
          this.passwordPolicyService,
        );

        await this.accountService.updateAccountPasswordHash({
          accountId: bound.accountId,
          passwordHash: AccountService.hashPasswordWithTimestamp(
            temporaryPassword,
            bound.credentialCreatedAt,
          ),
          transactionContext,
          setMustChangePassword: true,
          incrementCredentialVersion: true,
        });

        await this.managementAuditService.append({
          actorAccountId: command.session.accountId,
          actorAdminLevel: scope.level,
          organizationId: bound.organizationId,
          targetAccountId: bound.accountId,
          operation: 'RESET_LEVEL2_CREDENTIAL',
          transactionContext,
          reason,
          loginNameMasked: maskedLoginNameOf(bound),
        });

        return toResult(bound, temporaryPassword);
      });

      this.logger.info(
        { organizationId: result.organizationId, adminAccountId: result.adminAccountId },
        '一级管理员重置二级管理员密码成功',
      );
      return result;
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      this.logger.error(
        {
          organizationId,
          errorName: error instanceof Error ? error.name : 'UNKNOWN',
        },
        '一级管理员重置二级管理员密码失败',
      );
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
        '重置管理员密码失败，请稍后重试',
        undefined,
        error,
      );
    }
  }
}

function toResult(
  bound: LockedBoundLevelTwoAdmin,
  temporaryPassword: string,
): LevelTwoCredentialResult {
  return {
    organizationId: bound.organizationId,
    adminAccountId: bound.accountId,
    loginName: bound.loginName,
    nickname: bound.nickname,
    mustChangePassword: true,
    temporaryPassword,
  };
}
