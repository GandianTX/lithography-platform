// src/usecases/local-runtime/renew-my-local-authorization.usecase.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import type {
  RenewMyLocalAuthorizationCommand,
  RenewMyLocalAuthorizationResult,
} from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

/**
 * 本人同公司授权续期（任务 09 R065；补验 S1.3"同公司授权续期"）。
 *
 * - 只允许续期**本人**在本公司数据区内的授权，不接受续期他人；
 * - 一级管理员没有公司数据区（organizationId=null），不适用本人续期；
 * - 续期只更新签名凭据、权限版本与最近校验时间，待传任务/公司配置/备份运行不动；
 * - `lastVerifiedAt` 由服务端生成，不信任客户端时间；
 * - 未接入 GraphQL：真实凭据来自可信接收端（X07／云），接入后再暴露入口，
 *   避免出现"任何人都能改自己凭据"的入口。
 */
@Injectable()
export class RenewMyLocalAuthorizationUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly syncConflictService: SyncConflictService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: RenewMyLocalAuthorizationCommand,
  ): Promise<RenewMyLocalAuthorizationResult> {
    const scope = await this.scopeResolver.resolve(command.session);

    // 先收敛到局部常量：闭包内的属性收窄不跨回调保持
    const scopeOrganizationId = scope.organizationId;
    if (scopeOrganizationId === null) {
      throw new DomainError(
        SYNC_ERROR.INVALID_PARAMS,
        '全局范围没有本人公司数据区，不适用本人授权续期',
      );
    }

    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(SYNC_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }

    return this.transactionRunner.run(async (transactionContext) => {
      const result = await this.syncConflictService.renewAccountAuthorization(
        {
          installationId: installation.installationId,
          accountId: command.session.accountId,
          organizationId: scopeOrganizationId,
        },
        {
          signedClaims: command.signedClaims,
          permissionVersion: command.permissionVersion,
          lastVerifiedAt: new Date(),
        },
        transactionContext,
      );
      return { renewedAuthorizationId: result.renewedAuthorizationId };
    });
  }
}
