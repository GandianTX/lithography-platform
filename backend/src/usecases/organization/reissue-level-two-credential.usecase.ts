// src/usecases/organization/reissue-level-two-credential.usecase.ts

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
import { normalizeOrganizationId } from './admin-organization.input.normalize';
import type { LevelTwoCredentialResult } from './company-admin-binding.types';
import {
  assertReissueAllowed,
  generatePolicyCompliantTemporaryPassword,
  loadBoundLevelTwoAdminForUpdate,
  maskedLoginNameOf,
  type LockedBoundLevelTwoAdmin,
} from './level-two-credential.support';

export type ReissueLevelTwoCredentialCommand = {
  readonly session: UsecaseSession;
  readonly organizationId: unknown;
};

/**
 * 一级管理员为「尚待首次改密」的二级管理员补发临时密码（S3）。
 *
 * 授权：仅一级管理员；目标以公司定位，服务端在事务内锁定并复核唯一合法绑定。
 *
 * 写入顺序（同一事务）：
 * 1. 锁公司 → 锁候选账号 → 锁成员关系 → 重新判定绑定（`loadBoundLevelTwoAdminForUpdate`）；
 * 2. 复核目标 `must_change_password = true`，已改密一律拒绝；
 * 3. 生成满足策略的新随机临时密码，同一 UPDATE 写新哈希、置强制改密、递增凭据代次；
 * 4. 同事务追加审计；审计失败直接抛出 → 整事务回滚，不返回成功。
 *
 * 新密码只在成功结果中返回一次；日志与审计不记录口令、哈希或派生值。
 */
@Injectable()
export class ReissueLevelTwoCredentialUsecase {
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
    this.logger.setContext(ReissueLevelTwoCredentialUsecase.name);
  }

  async execute(command: ReissueLevelTwoCredentialCommand): Promise<LevelTwoCredentialResult> {
    const scope = resolveLevelOneAdminScope(command.session, '补发二级管理员临时密码');
    const organizationId = normalizeOrganizationId(command.organizationId);

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
        });
        assertReissueAllowed(bound);

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
          operation: 'REISSUE_LEVEL2_CREDENTIAL',
          transactionContext,
          loginNameMasked: maskedLoginNameOf(bound),
        });

        return toResult(bound, temporaryPassword);
      });

      this.logger.info(
        { organizationId: result.organizationId, adminAccountId: result.adminAccountId },
        '一级管理员补发二级管理员临时密码成功',
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
        '一级管理员补发二级管理员临时密码失败',
      );
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
        '补发临时密码失败，请稍后重试',
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
