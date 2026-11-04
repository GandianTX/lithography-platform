// src/usecases/registration/weapp-register.usecase.ts

import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  ThirdPartyProviderEnum,
  UserAccountView,
} from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { RegistrationOutcomeStatus } from '@app-types/models/registration.types';
import {
  ACCOUNT_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  THIRDPARTY_ERROR,
} from '@core/common/errors/domain-error';
import { ThirdPartyAuthQueryService } from '@modules/third-party-auth/queries/third-party-auth.query.service';
import { ThirdPartyAuthService } from '@modules/third-party-auth/third-party-auth.service';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  ThirdPartyRegisterParams,
  ThirdPartyRegisterResult,
} from './register-with-third-party.usecase';
import {
  normalizeRegistrationNicknameCandidatesInput,
  normalizeRegistrationOrganizationId,
  normalizeWeappRegisterInput,
  normalizeWeappRegisterParams,
} from './registration-input.normalize';

// 工具类型：用新类型覆盖原类型的指定字段
type Overwrite<T, U> = Omit<T, keyof U> & U;

/**
 * 验证后的微信小程序注册参数
 */
/**
 * 微信小程序注册参数
 * 扩展通用第三方注册参数
 */
type WeappRegisterParams = Overwrite<
  ThirdPartyRegisterParams,
  {
    audience: AudienceTypeEnum; // 明确要求 audience 为必需参数
    weAppData?: {
      phoneCode?: string;
    }; // 确保 weAppData 在类型中存在
  }
>;

/**
 * 微信小程序注册 Usecase
 * 专门处理微信小程序的注册逻辑
 */
@Injectable()
export class WeappRegisterUsecase {
  constructor(
    private readonly tpa: ThirdPartyAuthService,
    private readonly thirdPartyAuthQueryService: ThirdPartyAuthQueryService,
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipService: OrganizationMembershipService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(WeappRegisterUsecase.name);
  }

  /**
   * 执行微信小程序注册
   */
  async execute(params: WeappRegisterParams): Promise<ThirdPartyRegisterResult> {
    // 1. 参数验证
    const validatedParams = this.validateParams(params);
    const { authCredential, audience } = validatedParams;
    const normalizedInput = normalizeWeappRegisterInput();
    // 组织 ID 只做形态校验；有效性在创建事务内复核
    const organizationId = normalizeRegistrationOrganizationId(params.organizationId);

    try {
      // 2. 解析身份信息
      const session = await this.tpa.resolveIdentity({
        provider: ThirdPartyProviderEnum.WEAPP,
        authCredential,
        audience,
      });

      // 3. 检查是否已绑定
      await this.checkNotAlreadyBound(session.providerUserId);

      // 4. 准备账户数据
      const { accountData, userInfoData } = await this.prepareAccountData({
        defaultNickname: normalizedInput.defaultNickname,
        phoneCode: params.weAppData?.phoneCode,
        audience,
      });

      // 5. 创建账户
      const account = await this.createAccount({
        accountData,
        userInfoData,
        organizationId,
      });

      // 6. 创建第三方绑定关系
      await this.tpa.bindThirdPartyForRegistration({
        accountId: account.id,
        provider: ThirdPartyProviderEnum.WEAPP,
        session,
      });

      // 账号与资料已在创建事务内写为 ACTIVE / ACTIVE，注册成功后立即可用；
      // 此处不再有任何事务外的状态补救写。
      this.logger.info(`微信小程序注册成功: ${account.id}`);

      return {
        success: true,
        message: '注册成功',
        accountId: account.id,
        // 小程序注册只创建客户账号，注册事务内已绑定所选组织的 CUSTOMER 成员关系
        registrationStatus: RegistrationOutcomeStatus.REGISTERED,
        applicationId: null,
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }

      if (error instanceof HttpException) {
        throw new DomainError(
          THIRDPARTY_ERROR.PROVIDER_API_ERROR,
          error.message || '第三方服务调用失败',
        );
      }

      this.logger.error(
        `微信小程序注册失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new DomainError(THIRDPARTY_ERROR.REGISTRATION_FAILED, '微信小程序注册失败');
    }
  }

  /**
   * 检查用户是否已绑定
   */
  private async checkNotAlreadyBound(providerUserId: string): Promise<void> {
    const existingBinding = await this.thirdPartyAuthQueryService.findAccountByThirdParty({
      provider: ThirdPartyProviderEnum.WEAPP,
      providerUserId,
    });

    if (existingBinding) {
      throw new DomainError(THIRDPARTY_ERROR.ACCOUNT_ALREADY_BOUND, '该微信账号已绑定其他账户');
    }
  }

  /**
   * 准备账户数据
   * 使用 AccountQueryService 生成唯一昵称
   */
  private async prepareAccountData(params: {
    defaultNickname: string;
    phoneCode?: string;
    audience: AudienceTypeEnum;
  }) {
    const { defaultNickname, phoneCode, audience } = params;

    const nicknameCandidates = normalizeRegistrationNicknameCandidatesInput({
      providedNickname: defaultNickname,
      fallbackOptions: [],
    });

    const nickname = await this.accountQueryService.pickAvailableNickname({
      providedNickname: nicknameCandidates.providedNickname,
      fallbackOptions: nicknameCandidates.fallbackOptions,
      provider: ThirdPartyProviderEnum.WEAPP,
    });

    if (!nickname) {
      throw new DomainError(THIRDPARTY_ERROR.REGISTRATION_FAILED, '生成用户昵称失败');
    }

    // 获取手机号 - 简化调用
    let phone: string | undefined;
    if (phoneCode) {
      try {
        const phoneInfo = await this.tpa.getWeappPhoneNumber({
          phoneCode: phoneCode,
          audience,
        });

        phone = phoneInfo.phoneNumber;

        this.logger.info('成功获取用户手机号', { phoneNumber: phone });
      } catch (error) {
        this.logger.error('获取手机号失败', { error, phoneCode: '[REDACTED]' });
        // 注册流程中手机号获取失败不应该阻止注册，只是记录日志
      }
    }

    // 准备账户数据
    const accountData = {
      status: AccountStatus.ACTIVE,
      audience,
      loginEmail: `weapp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@local`,
      loginPassword: `Tmp#${Date.now()}Aa1`,
      identityHint: IdentityTypeEnum.CUSTOMER,
    };

    // 准备用户信息数据（userState 显式写 ACTIVE，不依赖 Entity 列默认值 PENDING）
    const userInfoData = {
      nickname,
      phone,
      accessGroup: [IdentityTypeEnum.CUSTOMER],
      metaDigest: [IdentityTypeEnum.CUSTOMER],
      userState: UserState.ACTIVE,
    };

    return { accountData, userInfoData };
  }

  /**
   * 验证参数
   */
  private validateParams(params: WeappRegisterParams): {
    authCredential: string;
    audience: AudienceTypeEnum;
  } {
    try {
      return normalizeWeappRegisterParams({
        authCredential: params.authCredential,
        audience: params.audience,
      });
    } catch (error) {
      this.mapWeappRegisterNormalizeError(error);
    }
  }

  private mapWeappRegisterNormalizeError(error: unknown): never {
    if (error instanceof DomainError) {
      if (error.code === INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY) {
        throw new DomainError(THIRDPARTY_ERROR.INVALID_CREDENTIAL, '身份凭证不能为空');
      }
      if (error.code === INPUT_NORMALIZE_ERROR.INVALID_TEXT) {
        throw new DomainError(THIRDPARTY_ERROR.INVALID_CREDENTIAL, '身份凭证无效');
      }
      if (error.code === INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE) {
        throw new DomainError(THIRDPARTY_ERROR.INVALID_AUDIENCE, '无效的客户端类型');
      }
    }
    throw error;
  }

  /**
   * 创建账户与用户信息，并绑定所选组织为 CUSTOMER 成员
   *
   * 顺序：复核组织有效 → 账号行 → 密码哈希 → 资料行 → 成员关系 → 同事务回读。
   * 组织有效性先于任何写入 fail-fast，避免留下无归属的账号。
   *
   * @param params 创建参数
   * @returns 账户视图
   */
  private async createAccount(params: {
    accountData: {
      status: AccountStatus;
      audience: AudienceTypeEnum;
      loginEmail: string;
      loginPassword: string;
      identityHint: IdentityTypeEnum;
    };
    userInfoData: {
      nickname: string;
      phone?: string;
      accessGroup: IdentityTypeEnum[];
      metaDigest: IdentityTypeEnum[];
      userState: UserState;
    };
    organizationId: number;
  }): Promise<UserAccountView> {
    const { accountData, userInfoData, organizationId } = params;
    return await this.transactionRunner.run(async (transactionContext) => {
      const organization = await this.organizationQueryService.findActiveRegistrationOption({
        organizationId,
        transactionContext,
      });
      if (organization === null) {
        throw new DomainError(ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE, '所选组织不存在或已停用');
      }

      const account = this.accountService.createAccountEntity({
        transactionContext,
        accountData: {
          ...accountData,
          loginPassword: 'temp',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const savedAccount = await this.accountService.saveAccount({ account, transactionContext });

      await this.accountService.updateAccountPasswordHash({
        accountId: savedAccount.id,
        passwordHash: AccountService.hashPasswordWithTimestamp(
          accountData.loginPassword,
          savedAccount.createdAt,
        ),
        transactionContext,
      });

      const userInfo = this.accountService.createUserInfoEntity({
        transactionContext,
        userInfoData: {
          accountId: savedAccount.id,
          ...userInfoData,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await this.accountService.saveUserInfo({ userInfo, transactionContext });

      await this.organizationMembershipService.insertMembership(
        {
          organizationId,
          accountId: savedAccount.id,
          memberRole: IdentityTypeEnum.CUSTOMER,
        },
        transactionContext,
      );

      return await this.accountQueryService.getUserAccountViewById({
        accountId: savedAccount.id,
        transactionContext,
      });
    });
  }
}
