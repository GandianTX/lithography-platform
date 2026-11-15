// src/usecases/registration/register-with-email.usecase.ts

import { AccountStatus, IdentityTypeEnum, UserAccountView } from '@app-types/models/account.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  RegisterWithEmailParams,
  RegisterWithEmailResult,
  RegistrationEntryChannel,
  RegistrationOutcomeStatus,
} from '@app-types/models/registration.types';
import { RegisterTypeEnum } from '@app-types/services/register.types';
import { ACCOUNT_ERROR, AUTH_ERROR, DomainError } from '@core/common/errors';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { Inject, Injectable } from '@nestjs/common';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { isDuplicateKeyError } from '@src/modules/common/utils/database-error.util';
import { EngineerRegistrationService } from '@src/modules/lithography/engineer-registration.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  assertWebRegistrationColumnLimits,
  normalizeEngineerRegistrationProfile,
  normalizeLegacyEngineerRegistrationProfile,
  normalizeRegisterWithEmailInput,
  normalizeRegistrationApplicationNote,
  normalizeRegistrationNicknameCandidatesInput,
  resolveLegacyRegistrationOrganizationChoice,
  resolveRegistrationOrganizationChoice,
  WEB_REGISTRATION_NICKNAME_BASE_MAX_LENGTH,
  type RegistrationOrganizationChoice,
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
 * 输入与资格口径由 `entryChannel` 决定，两条通道复用同一事务与写入顺序：
 * - `LEGACY`（旧 `register`）：组织主键必填、只要求 `ACTIVE`、不支持手填公司、
 *   工程师姓名/电话可省略、客户不写 `customer_organization_id`；
 * - `WEB`（`registerWeb`）：工程师必填姓名/电话，公司须为 `ACTIVE + 受管`，
 *   客户可选公司或手填且写可信公司归属。
 *
 * 所选公司（`organizationId`）必须在事务内按对应通道的资格口径复核；客户端自报值只作
 * 申请参数，绝不作为公司归属的最终凭证。任一步失败整体回滚，不留下半成品状态组合。
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
    private readonly organizationService: OrganizationService,
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
      realName,
      phone,
      type = RegisterTypeEnum.CUSTOMER,
      entryChannel,
      organizationId,
      organizationName,
      applicationNote,
      inviteToken,
      clientIp,
    } = params;
    const normalizedInput = normalizeRegisterWithEmailInput({ loginEmail, nickname });
    const normalizedLoginEmail = normalizedInput.loginEmail;
    const normalizedNickname = normalizedInput.nickname;
    const role = this.mapRegisterTypeToRole(type);
    const isWebEntry = entryChannel === RegistrationEntryChannel.WEB;
    // Web 入口在归一化之后、任何公司/账号写入之前完成列宽边界判断；
    // 旧 register 入口维持原输入契约，不因共享 helper 被动收紧
    if (isWebEntry) {
      assertWebRegistrationColumnLimits({ loginName, loginEmail: normalizedLoginEmail });
    }
    // 公司分支：Web 允许选公司或手填且互斥；旧入口只接受必填组织主键
    const organizationChoice = isWebEntry
      ? resolveRegistrationOrganizationChoice({ organizationId, organizationName, role })
      : resolveLegacyRegistrationOrganizationChoice({ organizationId, organizationName });
    // 姓名/电话仅工程师注册采集：Web 工程师必填；旧入口可省略。
    // 客户注册不采集、不写入资料
    const engineerProfile =
      role === IdentityTypeEnum.ENGINEER
        ? isWebEntry
          ? normalizeEngineerRegistrationProfile({ realName, phone })
          : normalizeLegacyEngineerRegistrationProfile({ realName, phone })
        : null;
    // 申请说明仅工程师待审申请使用；客户注册忽略该字段
    const normalizedApplicationNote =
      role === IdentityTypeEnum.ENGINEER
        ? normalizeRegistrationApplicationNote(applicationNote)
        : null;

    try {
      const finalClientIp = clientIp ?? '';

      // 检查账户是否已存在
      await this.checkAccountExists({
        loginName,
        loginEmail: normalizedLoginEmail,
        entryChannel,
      });

      // 准备注册数据
      const preparedData = await this.prepareRegisterData({
        loginName,
        loginEmail: normalizedLoginEmail,
        loginPassword,
        nickname: normalizedNickname,
        role,
        isWebEntry,
      });

      // 创建账户（客户直接开通；工程师落待审申请）
      const outcome = await this.createAccount({
        preparedData,
        entryChannel,
        organizationChoice,
        applicationNote: normalizedApplicationNote,
        engineerProfile,
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

      // 并发注册可能同时通过预检查，最终由唯一索引兜底；映射为可操作的业务错误
      if (isDuplicateAccountEntryError(error)) {
        throw this.createDuplicateAccountError(entryChannel);
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
    entryChannel,
  }: {
    loginName?: string | null;
    loginEmail: string;
    entryChannel: RegistrationEntryChannel;
  }): Promise<void> {
    const exists = await this.accountQueryService.checkAccountExists({
      loginName,
      loginEmail,
    });

    if (exists) {
      throw this.createDuplicateAccountError(entryChannel);
    }
  }

  /**
   * 重复账号事实的唯一定点：按入口选择稳定错误类别。
   *
   * - 旧 `register`：`ACCOUNT_ALREADY_EXISTS` → `BAD_USER_INPUT`（基线契约，兼容既有客户端）；
   * - Web `registerWeb`：`REGISTRATION_ACCOUNT_EXISTS` → `CONFLICT`。
   *
   * 预检查与唯一索引兜底两条路径都经此方法，避免同事实在两个入口漂移。
   */
  private createDuplicateAccountError(entryChannel: RegistrationEntryChannel): DomainError {
    return entryChannel === RegistrationEntryChannel.WEB
      ? new DomainError(ACCOUNT_ERROR.REGISTRATION_ACCOUNT_EXISTS, '该登录名或邮箱已被注册')
      : new DomainError(ACCOUNT_ERROR.ACCOUNT_ALREADY_EXISTS, '该登录名或邮箱已被注册');
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
    isWebEntry,
  }: {
    loginName?: string | null;
    loginEmail: string;
    loginPassword: string;
    nickname?: string;
    role: IdentityTypeEnum.CUSTOMER | IdentityTypeEnum.ENGINEER;
    isWebEntry: boolean;
  }) {
    const nicknameCandidates = normalizeRegistrationNicknameCandidatesInput({
      providedNickname: nickname,
      fallbackOptions: [loginName ?? undefined, loginEmail.split('@')[0], '用户'],
      // Web 默认昵称候选需为冲突后缀预留空间，保证追加后仍在 nickname 列宽内；
      // 旧入口与小程序入口维持既有候选行为
      maxFallbackLength: isWebEntry ? WEB_REGISTRATION_NICKNAME_BASE_MAX_LENGTH : undefined,
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
   * 顺序：复核/新建公司 → 密码策略 → 账号行 → 密码哈希 → 资料行 →
   * 客户建 CUSTOMER 成员与可信公司归属 / 工程师落 PENDING 申请 → 同事务回读账号视图。
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
    entryChannel: RegistrationEntryChannel;
    organizationChoice: RegistrationOrganizationChoice;
    applicationNote: string | null;
    /** 工程师真实姓名与联系电话；客户注册或旧入口省略时为 null，不写资料 */
    engineerProfile: { realName: string; phone: string } | null;
  }): Promise<RegisterOutcome> {
    const { preparedData, entryChannel, organizationChoice, applicationNote, engineerProfile } =
      params;
    const { loginName, loginEmail, loginPassword, role, status, userState, nickname, email } =
      preparedData;
    const isWebEntry = entryChannel === RegistrationEntryChannel.WEB;

    return await this.transactionRunner.run(async (transactionContext) => {
      // 公司资格先于账号写入 fail-fast：Web 要求启用且受管，旧入口只要求启用
      const organizationId = await this.resolveOrganizationId({
        entryChannel,
        organizationChoice,
        transactionContext,
      });

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
          // 客户可信公司归属：仅 Web 入口写；旧入口保持主线「不写该字段」的行为
          customerOrganizationId:
            role === IdentityTypeEnum.CUSTOMER && isWebEntry ? organizationId : null,
          // 工程师姓名与联系电话随资料一同落库；客户不采集
          realName: engineerProfile?.realName ?? null,
          phone: engineerProfile?.phone ?? null,
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

  /**
   * 解析本次注册的公司主键。
   *
   * - `EXISTING` + `WEB`：事务内按 Web 注册资格复核（`ACTIVE` 且受管，共享行锁）；
   * - `EXISTING` + `LEGACY`：事务内只复核 `ACTIVE`，与主线旧请求口径一致；
   * - `SELF_FILLED`：同一事务内新建「启用、未受管、无维修资格」的公司档（仅 Web）。
   *
   * 复核失败抛出 `ORGANIZATION_NOT_AVAILABLE`，整体事务回滚，不留下任何写入。
   */
  private async resolveOrganizationId(params: {
    entryChannel: RegistrationEntryChannel;
    organizationChoice: RegistrationOrganizationChoice;
    transactionContext: PersistenceTransactionContext;
  }): Promise<number> {
    if (params.organizationChoice.kind === 'SELF_FILLED') {
      const created = await this.organizationService.createSelfRegisteredCompany({
        name: params.organizationChoice.organizationName,
        transactionContext: params.transactionContext,
      });
      return created.id;
    }

    const organization =
      params.entryChannel === RegistrationEntryChannel.WEB
        ? await this.organizationQueryService.findEligibleRegistrationOption({
            organizationId: params.organizationChoice.organizationId,
            transactionContext: params.transactionContext,
          })
        : await this.organizationQueryService.findActiveRegistrationOption({
            organizationId: params.organizationChoice.organizationId,
            transactionContext: params.transactionContext,
          });
    if (organization === null) {
      throw new DomainError(
        ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE,
        params.entryChannel === RegistrationEntryChannel.WEB
          ? '所选公司不存在、已停用或不具备注册资格'
          : '所选组织不存在或已停用',
      );
    }
    return organization.id;
  }
}

/**
 * 并发注册的唯一索引冲突识别：`login_email` / `login_name` 重复时映射为
 * `ACCOUNT_ALREADY_EXISTS`；其他唯一键冲突维持通用注册失败。
 *
 * 驱动错误解包复用 `isDuplicateKeyError`（`ER_DUP_ENTRY` / 1062 沿 `driverError`、
 * `cause` 递归识别），本函数只追加「账号唯一索引」这一领域收窄。
 */
function isDuplicateAccountEntryError(error: unknown): boolean {
  if (!isDuplicateKeyError(error)) {
    return false;
  }

  const candidate = error as {
    message?: unknown;
    driverError?: { message?: unknown };
  };
  const driver = candidate.driverError;
  const message =
    typeof driver?.message === 'string'
      ? driver.message
      : typeof candidate.message === 'string'
        ? candidate.message
        : '';

  return message.includes('uk_login_email') || message.includes('uk_login_name');
}
