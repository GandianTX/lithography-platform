// src/usecases/registration/register-with-third-party.usecase.ts
import { AudienceTypeEnum, ThirdPartyProviderEnum } from '@app-types/models/account.types';
import { RegistrationOutcomeStatus } from '@app-types/models/registration.types';
import { DomainError, THIRDPARTY_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { normalizeRegisterWithThirdPartyInput } from './registration-input.normalize';
import { WeappRegisterUsecase } from './weapp-register.usecase';

export interface ThirdPartyRegisterParams {
  provider: ThirdPartyProviderEnum;
  authCredential: string;
  /** 客户端类型：adapter 必填；合法性由具体 provider 的 usecase 统一 normalize 校验 */
  audience: AudienceTypeEnum;
  // nickname?: string; // 移除此字段 - 昵称应通过第三方平台获取，而非前端传递
  email?: string | null;
  /** 所选有效组织主键：第三方注册仅开通客户，注册成功后绑定为该组织的 CUSTOMER 成员 */
  organizationId?: number | null;
  weAppData?: {
    phoneCode?: string;
  };
}

export interface ThirdPartyRegisterResult {
  success: boolean;
  message: string;
  accountId: number;
  /** 第三方注册只创建客户账号，固定为已开通 */
  registrationStatus: RegistrationOutcomeStatus;
  /** 第三方注册不产生待审申请 */
  applicationId: number | null;
}

/**
 * 第三方注册分发器
 * 根据不同的第三方平台分发到对应的注册逻辑
 */
@Injectable()
export class RegisterWithThirdPartyUsecase {
  constructor(
    private readonly weappRegisterUsecase: WeappRegisterUsecase,
    // 未来可以注入其他平台的注册 usecase
  ) {}

  /**
   * 执行第三方注册
   * 根据 provider 分发到对应的注册逻辑
   */
  async execute(params: ThirdPartyRegisterParams): Promise<ThirdPartyRegisterResult> {
    const normalizedInput = normalizeRegisterWithThirdPartyInput({ email: params.email });
    const normalizedParams: ThirdPartyRegisterParams = {
      ...params,
      email: normalizedInput.email,
    };
    const { provider } = normalizedParams;

    // 组织绑定对所有第三方客户注册一视同仁：在此显式守卫，避免后续新增 provider 时静默漏绑。
    // adapter 已把 organizationId 声明为非空，这里只兜住内部调用方绕过边界的情形。
    if (normalizedParams.organizationId === undefined || normalizedParams.organizationId === null) {
      throw new DomainError(THIRDPARTY_ERROR.INVALID_PARAMS, '第三方注册必须选择有效组织', {
        field: 'organizationId',
      });
    }

    switch (provider) {
      case ThirdPartyProviderEnum.WEAPP:
        return this.weappRegisterUsecase.execute(normalizedParams);

      // 未来扩展其他平台
      // case ThirdPartyProviderEnum.WECHAT:
      //   return this.wechatRegisterUsecase.execute(params);

      default:
        throw new DomainError(
          THIRDPARTY_ERROR.PROVIDER_NOT_SUPPORTED,
          `不支持的第三方平台: ${provider}`,
          { provider },
        );
    }
  }
}
