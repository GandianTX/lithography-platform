// src/usecases/registration/get-engineer-registration-status.usecase.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import { ENGINEER_REGISTRATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  applyDefaults,
  enforceMaxPageSize,
  isOffsetMode,
} from '@core/pagination/pagination.policy';
import type { OffsetParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { isEngineerRegistrationPasswordVerified } from './engineer-registration-credential';
import { normalizeEngineerRegistrationCredential } from './registration-input.normalize';
import type {
  EngineerRegistrationStatusResult,
  GetEngineerRegistrationStatusCommand,
} from './engineer-registration.types';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐 */
const MAX_PAGE_SIZE = 100;
/** 本人申请历史默认页大小 */
const DEFAULT_PAGE_SIZE = 10;

/**
 * 本人工程师注册申请状态查询（待审账号尚未获得登录态，因此不能依赖 JWT）。
 *
 * 身份证明口径：复用密码凭据验证（`AccountService.verifyPassword()`），
 * 只证明调用者掌握该账号的登录凭据，**不签发 Token、不放行登录、不改变任何状态**。
 * 验证失败（账号不存在 / 密码错误 / 密码形态异常）统一收敛为 `CREDENTIAL_MISMATCH`，
 * 不区分原因以避免账户枚举。
 *
 * 可见范围：仅按已证明的账号主键读取本人在该账号下的申请历史与最新记录，
 * 不含其他账号记录、不含组织审核意见以外的内部资料。
 *
 * 只读：不开启业务事务、不写库、不加锁。
 */
@Injectable()
export class GetEngineerRegistrationStatusUsecase {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
  ) {}

  async execute(
    command: GetEngineerRegistrationStatusCommand,
  ): Promise<EngineerRegistrationStatusResult> {
    const credentialInput = normalizeEngineerRegistrationCredential({
      accountIdentifier: command.accountIdentifier,
      password: command.password,
    });

    if (command.pagination.mode !== 'OFFSET') {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
        '申请状态查询仅支持 OFFSET 分页',
        { mode: command.pagination.mode },
      );
    }
    const resolvedPagination = enforceMaxPageSize(
      applyDefaults(command.pagination, { pageSize: DEFAULT_PAGE_SIZE }),
      MAX_PAGE_SIZE,
    );
    if (!isOffsetMode(resolvedPagination)) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
        '申请状态查询仅支持 OFFSET 分页',
      );
    }
    const { page, pageSize }: OffsetParams = resolvedPagination;

    const credential = await this.accountQueryService.findCredentialByLoginName({
      loginName: credentialInput.accountIdentifier,
    });
    if (
      credential === null ||
      !isEngineerRegistrationPasswordVerified(credentialInput.password, credential)
    ) {
      throw new DomainError(ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH, '账号或密码不正确');
    }

    const view = await this.accountQueryService.getUserAccountViewById({
      accountId: credential.id,
    });
    // 非工程师账号不存在自助注册申请；对已证明本人身份的调用方直言账号类型即可
    if (view.identityHint !== IdentityTypeEnum.ENGINEER) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND,
        '该账号不是工程师注册账号',
      );
    }

    const latest = await this.engineerRegistrationQueryService.findLatestByAccountId(credential.id);
    const applications = await this.engineerRegistrationQueryService.listByAccountId(
      credential.id,
      { page, pageSize },
    );

    return { accountId: credential.id, latest, applications };
  }
}
