// src/usecases/registration/register-with-email.usecase.ts

import { AccountStatus, IdentityTypeEnum, UserAccountView } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  RegisterWithEmailParams,
  RegisterWithEmailResult,
  RegistrationOutcomeStatus,
} from '@app-types/models/registration.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import { ACCOUNT_ERROR, AUTH_ERROR, DomainError } from '@core/common/errors';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { Inject, Injectable } from '@nestjs/common';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerRegistrationService } from '@src/modules/lithography/engineer-registration.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  normalizeRegisterWithEmailInput,
  normalizeRegistrationApplicationNote,
  normalizeRegistrationNicknameCandidatesInput,
  normalizeRegistrationOrganizationId,
} from './registration-input.normalize';

/** 注册事务内的写入结果：账号视图 + 工程师待审申请主键（客户为 null） */
type RegisterOutcome = {
  account: UserAccountView;
  applicationId: number | null;
};

/**
 * 邮箱注册用例
 * 负责处理用户通过邮箱注册的完整业务流程
 *
 * 两类注册共用同一凭据校验与账号/资料写入路径，差异只在**开通结果**：
 * - `CUSTOMER`：账号与资料在创建事务内即写为 `ACTIVE / ACTIVE`，并绑定所选有效组织为
 *   `CUSTOMER` 成员；注册成功返回后账号立即可用；
 * - `ENGINEER`：账号保持 `PENDING / PENDING`，不建成员关系、不签发登录态，只在同一事务内
 *   落一份 `PENDING` 待审申请（含申请说明）。所选组织管理员审核通过后，
 *   才由审批用例同事务启用账号并建立 `ENGINEER` 成员关系。
 *
 * 所选组织（`organizationId`）必须在事务内复核为 `ACTIVE`；客户端自报值只作申请参数，
 * 绝不作为组织归属的最终凭证。任一步失败整体回滚，不留下半成品状态组合。
 *
 * 管理员代建入口（`AdminCreateUserUsecase`）不受本用例影响，继续使用可信组织解析绑定。
 */
@Injectable()
export class RegisterWithEmailUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipService: OrganizationMembershipService,
    private readonly engineerRegistrationService: EngineerRegistrationService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(RegisterWithEmailUsecase.name);
  }

  /**
   * 执行邮箱注册流程
   * @param params 注册参数
   * @returns 注册结果
   */
  async execute(params: RegisterWithEmailParams): Promise<RegisterWithEmailResult> {
    const {
      loginName,
      loginEmail,
      loginPassword,
      nickname,
      type = RegisterTypeEnum.CUSTOMER,
      organizationId,
      applicationNote,
      inviteToken,
      clientIp,
    } = params;
    const normalizedInput = normalizeRegisterWithEmailInput({ loginEmail, nickname });
    const normalizedLoginEmail = normalizedInput.loginEmail;
    const normalizedNickname = normalizedInput.nickname;
    const role = this.mapRegisterTypeToRole(type);
    // 组织 ID 只做形态校验；有效性在事务内复核
    const normalizedOrganizationId = normalizeRegistrationOrganizationId(organizationId);
    // 申请说明仅工程师待审申请使用；客户注册忽略该字段
    const normalizedApplicationNote =
      role === IdentityTypeEnum.ENGINEER
        ? normalizeRegistrationApplicationNote(applicationNote)
        : null;

    try {
      const finalClientIp = clientIp ?? '';

      // 检查账户是否已存在
      await this.checkAccountExists({ loginName, loginEmail: normalizedLoginEmail });

      // 准备注册数据
      const preparedData = await this.prepareRegisterData({
        loginName,
        loginEmail: normalizedLoginEmail,
        loginPassword,
        nickname: normalizedNickname,
        role,
      });

      // 创建账户（客户直接开通；工程师落待审申请）
      const outcome = await this.createAccount({
        preparedData,
        organizationId: normalizedOrganizationId,
        applicationNote: normalizedApplicationNote,
      });

      if (inviteToken) {
        this.logger.warn(
          { accountId: outcome.account.id },
          '注册请求携带 inviteToken，但通用邀请流程尚未启用，已忽略',
        );
      }

      this.logger.info(
        {
          accountId: outcome.account.id,
          registrationStatus:
            role === IdentityTypeEnum.ENGINEER
              ? RegistrationOutcomeStatus.PENDING_REVIEW
              : RegistrationOutcomeStatus.REGISTERED,
          registrationIp: finalClientIp,
        },
        '用户注册成功',
      );

      return {
        success: true,
        message:
          role === IdentityTypeEnum.ENGINEER ? '注册申请已提交，等待组织管理员审核' : '注册成功',
        accountId: outcome.account.id,
        registrationStatus:
          role === IdentityTypeEnum.ENGINEER
            ? RegistrationOutcomeStatus.PENDING_REVIEW
            : RegistrationOutcomeStatus.REGISTERED,
        applicationId: outcome.applicationId,
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }

      if (error instanceof Error) {
        this.logger.error(`用户注册失败: ${error.message}`);
      }

      throw new DomainError(ACCOUNT_ERROR.REGISTRATION_FAILED, '注册失败');
    }
  }

  /**
   * 检查账户是否已存在
   */
  private async checkAccountExists({
    loginName,
    loginEmail,
  }: {
    loginName?: string | null;
    loginEmail: string;
  }): Promise<void> {
    const exists = await this.accountQueryService.checkAccountExists({
      loginName,
      loginEmail,
    });

    if (exists) {
      throw new DomainError(ACCOUNT_ERROR.ACCOUNT_ALREADY_EXISTS, '该登录名或邮箱已被注册');
    }
  }

  /**
   * 准备注册数据
   */
  private async prepareRegisterData({
    loginName,
    loginEmail,
    loginPassword,
    nickname,
    role,
  }: {
    loginName?: string | null;
    loginEmail: string;
    loginPassword: string;
    nickname?: string;
    role: IdentityTypeEnum.CUSTOMER | IdentityTypeEnum.ENGINEER;
  }) {
    const nicknameCandidates = normalizeRegistrationNicknameCandidatesInput({
      providedNickname: nickname,
      fallbackOptions: [loginName ?? undefined, loginEmail.split('@')[0]],
    });

    const finalNickname = await this.accountQueryService.pickAvailableNickname({
      providedNickname: nicknameCandidates.providedNickname,
      fallbackOptions: nicknameCandidates.fallbackOptions,
    });

    if (!finalNickname) {
      throw new DomainError(
        ACCOUNT_ERROR.NICKNAME_ALREADY_EXISTS,
        '昵称已被使用或不合规，请选择其他昵称',
      );
    }

    return {
      loginName,
      loginEmail,
      loginPassword,
      role,
      status: role === IdentityTypeEnum.ENGINEER ? AccountStatus.PENDING : AccountStatus.ACTIVE,
      userState: role === IdentityTypeEnum.ENGINEER ? UserState.PENDING : UserState.ACTIVE,
      nickname: finalNickname,
      email: loginEmail,
    };
  }

  private mapRegisterTypeToRole(
    type: RegisterTypeEnum,
  ): IdentityTypeEnum.CUSTOMER | IdentityTypeEnum.ENGINEER {
    if (type === RegisterTypeEnum.CUSTOMER) {
      return IdentityTypeEnum.CUSTOMER;
    }
    if (type === RegisterTypeEnum.ENGINEER) {
      return IdentityTypeEnum.ENGINEER;
    }
    throw new DomainError(ACCOUNT_ERROR.REGISTRATION_FAILED, '仅允许注册客户或工程师账号');
  }

  /**
   * 创建账户（单一事务）
   *
   * 顺序：复核组织有效 → 密码策略 → 账号行 → 密码哈希 → 资料行 →
   * 客户建 CUSTOMER 成员 / 工程师落 PENDING 申请 → 同事务回读账号视图。
   * 角色三源（`identity_hint` / `access_group` / `meta_digest`）写同一个单元素角色；
   * 工程师的双状态同写 PENDING，杜绝「已启用但待审」或反之的组合。
   *
   * @param preparedData 准备好的注册数据
   * @returns 账号视图与申请主键
   */
  private async createAccount(params: {
    preparedData: {
      loginName?: string | null;
      loginEmail: string;
      loginPassword: string;
      role: IdentityTypeEnum.CUSTOMER | IdentityTypeEnum.ENGINEER;
      status: AccountStatus;
      userState: UserState;
      nickname: string;
      email: string;
    };
    organizationId: number;
    applicationNote: string | null;
  }): Promise<RegisterOutcome> {
    const { preparedData, organizationId, applicationNote } = params;
    const { loginName, loginEmail, loginPassword, role, status, userState, nickname, email } =
      preparedData;

    return await this.transactionRunner.run(async (transactionContext) => {
      // 组织有效性先于任何写入 fail-fast：所选组织不存在/停用时账号零落库
      const organization = await this.organizationQueryService.findActiveRegistrationOption({
        organizationId,
        transactionContext,
      });
      if (organization === null) {
        throw new DomainError(ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE, '所选组织不存在或已停用');
      }

      const passwordValidation = this.passwordPolicyService.validatePassword(loginPassword);
      if (!passwordValidation.isValid) {
        throw new DomainError(
          AUTH_ERROR.INVALID_PASSWORD,
          `密码不符合安全要求: ${passwordValidation.errors.join(', ')}`,
        );
      }

      const account = this.accountService.createAccountEntity({
        transactionContext,
        accountData: {
          loginName,
          loginEmail,
          loginPassword: 'temp',
          status,
          identityHint: role,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const savedAccount = await this.accountService.saveAccount({ account, transactionContext });

      await this.accountService.updateAccountPasswordHash({
        accountId: savedAccount.id,
        passwordHash: AccountService.hashPasswordWithTimestamp(
          loginPassword,
          savedAccount.createdAt,
        ),
        transactionContext,
      });

      const userInfo = this.accountService.createUserInfoEntity({
        transactionContext,
        userInfoData: {
          accountId: savedAccount.id,
          nickname,
          email,
          accessGroup: [role],
          metaDigest: [role],
          userState,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await this.accountService.saveUserInfo({ userInfo, transactionContext });

      let applicationId: number | null = null;
      if (role === IdentityTypeEnum.CUSTOMER) {
        // 客户直接开通：同事务绑定所选组织为 CUSTOMER 成员
        await this.organizationMembershipService.insertMembership(
          {
            organizationId,
            accountId: savedAccount.id,
            memberRole: IdentityTypeEnum.CUSTOMER,
          },
          transactionContext,
        );
      } else {
        // 工程师待审：不建成员关系，只落一份待审申请；重复待审由唯一键兜底
        const inserted = await this.engineerRegistrationService.insertApplication(
          {
            accountId: savedAccount.id,
            organizationId,
            applicationNote,
            submittedAt: new Date(),
          },
          transactionContext,
        );
        applicationId = inserted.applicationId;
      }

      return {
        account: await this.accountQueryService.getUserAccountViewById({
          accountId: savedAccount.id,
          transactionContext,
        }),
        applicationId,
      };
    });
  }
}
