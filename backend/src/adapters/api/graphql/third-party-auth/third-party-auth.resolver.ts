// src/adapters/api/graphql/third-party-auth/third-party-auth.resolver.ts

import { JwtPayload } from '@app-types/jwt.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  ThirdPartyLoginProviderEnum,
  ThirdPartyProviderEnum,
} from '@app-types/models/account.types';
import { LoginResultModel, UserInfoView } from '@app-types/models/auth.types';
import { GeographicInfo } from '@app-types/models/user-info.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { LoginResult } from '@src/adapters/api/graphql/account/dto/login-result.dto';
import { UserInfoDTO } from '@src/adapters/api/graphql/account/dto/user-info.dto';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { SessionRestrictionGuard } from '@src/adapters/api/graphql/guards/session-restriction.guard';
import { BindThirdPartyInput } from '@src/adapters/api/graphql/third-party-auth/dto/bind-third-party.input';
import { GenerateWeappQrcodeInput } from '@src/adapters/api/graphql/third-party-auth/dto/generate-weapp-qrcode.input';
import { GenerateWeappQrcodeResultDTO } from '@src/adapters/api/graphql/third-party-auth/dto/generate-weapp-qrcode.result';
import { GetWeappPhoneInput } from '@src/adapters/api/graphql/third-party-auth/dto/get-weapp-phone.input';
import { ThirdPartyAuthDTO } from '@src/adapters/api/graphql/third-party-auth/dto/third-party-auth.dto';
import { ThirdPartyLoginInput } from '@src/adapters/api/graphql/third-party-auth/dto/third-party-login.input';
import { UnbindThirdPartyInput } from '@src/adapters/api/graphql/third-party-auth/dto/unbind-third-party.input';
import { WeappPhoneResultDTO } from '@src/adapters/api/graphql/third-party-auth/dto/weapp-phone-result.dto';
import { FetchUserInfoUsecase } from '@usecases/account/fetch-user-info.usecase';
import type { CompleteUserData } from '@usecases/account/fetch-user-info.types';
import { LoginWithThirdPartyUsecase } from '@usecases/auth/login-with-third-party.usecase';
import type { ThirdPartyLoginParams } from '@usecases/auth/login-with-third-party.types';
import { BindThirdPartyAccountUsecase } from '@usecases/third-party-accounts/bind-third-party-account.usecase';
import { GenerateWeappQrcodeUsecase } from '@usecases/third-party-accounts/generate-weapp-qrcode.usecase';
import type { GenerateWeappQrcodeResult } from '@usecases/third-party-accounts/generate-weapp-qrcode.types';
import { GetThirdPartyAuthsUsecase } from '@usecases/third-party-accounts/get-third-party-auths.usecase';
import { GetWeappPhoneUsecase } from '@usecases/third-party-accounts/get-weapp-phone.usecase';
import type { GetWeappPhoneParams } from '@usecases/third-party-accounts/get-weapp-phone.types';
import { UnbindThirdPartyAccountUsecase } from '@usecases/third-party-accounts/unbind-third-party-account.usecase';

/**
 * 第三方认证 GraphQL 解析器
 * 提供第三方登录、绑定、解绑等 GraphQL 接口
 */
@Resolver()
export class ThirdPartyAuthResolver {
  constructor(
    private readonly loginWithThirdPartyUsecase: LoginWithThirdPartyUsecase,
    private readonly getWeappPhoneUsecase: GetWeappPhoneUsecase, // 注入新的 usecase
    private readonly generateWeappQrcodeUsecase: GenerateWeappQrcodeUsecase,
    private readonly fetchUserInfoUsecase: FetchUserInfoUsecase,
    private readonly bindThirdPartyAccountUsecase: BindThirdPartyAccountUsecase,
    private readonly unbindThirdPartyAccountUsecase: UnbindThirdPartyAccountUsecase,
    private readonly getThirdPartyAuthsUsecase: GetThirdPartyAuthsUsecase,
  ) {}

  /**
   * 第三方平台登录
   * - DTO -> 用例输入的薄映射
   * - 用例只抛 DomainError；全局 GQL Filter 统一映射为 GraphQL 错误
   */
  @Mutation(() => LoginResult, { description: '第三方登录' })
  async thirdPartyLogin(@Args('input') input: ThirdPartyLoginInput): Promise<LoginResult> {
    const params: ThirdPartyLoginParams = {
      provider: this.mapLoginProvider(input.provider),
      authCredential: input.authCredential,
      audience: input.audience,
      ip: input.ip,
    };

    const result: LoginResultModel = await this.loginWithThirdPartyUsecase.execute(params);

    // 获取用户信息（与密码登录保持一致，包含安全验证）
    const userInfo = await this.getUserInfoForGraphQL(result.accountId);

    // 用例结果 -> GraphQL DTO 的薄映射（补齐 userInfo）
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accountId: result.accountId,
      role: result.role,
      userInfo,
      restriction: result.restriction ?? SessionRestriction.NONE,
      adminLevel: result.adminLevel ?? null,
      customerOrganizationId: result.customerOrganizationId ?? null,
    };
  }

  /**
   * 将登录输入平台映射为内部平台枚举
   */
  private mapLoginProvider(provider: ThirdPartyLoginProviderEnum): ThirdPartyProviderEnum {
    if (provider === ThirdPartyLoginProviderEnum.WEAPP) {
      return ThirdPartyProviderEnum.WEAPP;
    }

    throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '不支持的第三方登录平台');
  }

  /**
   * 绑定第三方账户
   * 将当前登录用户与第三方平台账户建立绑定关系
   * @param input 绑定参数 (包含第三方平台信息)
   * @param user 当前登录用户信息 (通过 JWT 认证获取)
   * @returns 绑定后的第三方认证信息
   * @throws HttpException 当绑定冲突时抛出异常
   */
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  @Mutation(() => ThirdPartyAuthDTO, { description: '绑定第三方账户' })
  async bindThirdParty(
    @Args('input') input: BindThirdPartyInput,
    @currentUser() user: JwtPayload,
  ): Promise<ThirdPartyAuthDTO> {
    const result = await this.bindThirdPartyAccountUsecase.execute({
      accountId: user.sub,
      provider: input.provider,
      providerUserId: input.providerUserId,
      unionId: input.unionId || undefined,
      accessToken: input.accessToken || undefined,
    });
    return {
      id: result.id,
      accountId: result.accountId,
      provider: result.provider,
      providerUserId: result.providerUserId,
      unionId: result.unionId,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }

  /**
   * 解绑第三方账户
   * 删除当前登录用户与指定第三方平台的绑定关系
   * @param input 解绑参数 (包含要解绑的第三方平台类型)
   * @param user 当前登录用户信息 (通过 JWT 认证获取)
   * @returns 解绑操作是否成功
   * @throws HttpException 当绑定记录不存在时抛出异常
   */
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  @Mutation(() => Boolean, { description: '解绑第三方账户' })
  async unbindThirdParty(
    @Args('input') input: UnbindThirdPartyInput,
    @currentUser() user: JwtPayload,
  ): Promise<boolean> {
    return await this.unbindThirdPartyAccountUsecase.execute({
      accountId: user.sub,
      id: input.id,
      provider: input.provider,
    });
  }

  /**
   * 获取我的第三方绑定列表
   * 查询当前登录用户的所有第三方平台绑定记录
   * @param user 当前登录用户信息 (通过 JWT 认证获取)
   * @returns 第三方绑定列表
   */
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  @Query(() => [ThirdPartyAuthDTO], { description: '获取我的第三方绑定列表' })
  async myThirdPartyAuths(@currentUser() user: JwtPayload): Promise<ThirdPartyAuthDTO[]> {
    const records = await this.getThirdPartyAuthsUsecase.execute({ accountId: user.sub });
    return records.map((record) => ({
      id: record.id,
      accountId: record.accountId,
      provider: record.provider,
      providerUserId: record.providerUserId,
      unionId: record.unionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  /**
   * 获取微信小程序手机号
   * 通过微信小程序的 phoneCode 获取用户手机号信息
   * @param input 包含 phoneCode 和 audience 的输入参数
   * @returns 手机号信息
   */
  @Mutation(() => WeappPhoneResultDTO, { description: '获取微信小程序手机号' })
  async getWeappPhone(@Args('input') input: GetWeappPhoneInput): Promise<WeappPhoneResultDTO> {
    const params: GetWeappPhoneParams = {
      phoneCode: input.phoneCode,
      audience: input.audience,
    };

    const result = await this.getWeappPhoneUsecase.execute(params);

    // 用例结果 -> GraphQL DTO 的薄映射
    return {
      phoneNumber: result.phoneInfo.phoneNumber,
      purePhoneNumber: result.phoneInfo.purePhoneNumber,
      countryCode: result.phoneInfo.countryCode,
    };
  }

  /**
   * 生成微信小程序二维码
   * 通过 appid + secret 换取 access_token，然后调用微信 getwxacodeunlimit
   * @param input 生成参数（scene、page、width 等）
   * @returns 图片内容类型与 Base64/二进制
   */
  @Mutation(() => GenerateWeappQrcodeResultDTO, { description: '生成微信小程序二维码' })
  async generateWeappQrcode(
    @Args('input') input: GenerateWeappQrcodeInput,
  ): Promise<GenerateWeappQrcodeResultDTO> {
    const result: GenerateWeappQrcodeResult = await this.generateWeappQrcodeUsecase.execute({
      audience: input.audience,
      scene: input.scene,
      page: input.page,
      width: input.width,
      checkPath: input.checkPath,
      envVersion: input.envVersion,
      isHyaline: input.isHyaline,
      encodeBase64: input.encodeBase64,
    });

    return {
      contentType: result.contentType,
      imageBase64: result.imageBase64,
      imageBufferBase64: result.imageBuffer ? result.imageBuffer.toString('base64') : undefined,
    };
  }

  /**
   * 获取用于 GraphQL 响应的用户信息
   * 使用现有的安全验证流程，确保 accessGroup 和 metaDigest 已完成比对
   */
  private async getUserInfoForGraphQL(accountId: number): Promise<UserInfoDTO> {
    const completeUserData: CompleteUserData = await this.fetchUserInfoUsecase.executeForLoginFlow({
      accountId,
    });
    return this.mapUserInfoViewToSecureDTO(completeUserData.userInfoView);
  }

  /**
   * 将 UserInfoView 映射为安全的 UserInfoDTO
   * 移除敏感字段（如 metaDigest），确保不会泄露给前端
   */
  private mapUserInfoViewToSecureDTO(userInfoView: UserInfoView): UserInfoDTO {
    return {
      // 基础字段映射
      id: userInfoView.accountId,
      accountId: userInfoView.accountId,
      nickname: userInfoView.nickname,
      gender: userInfoView.gender,
      birthDate: userInfoView.birthDate,
      avatarUrl: userInfoView.avatarUrl,
      email: userInfoView.email,
      signature: userInfoView.signature,

      // 联系方式字段
      address: userInfoView.address,
      phone: userInfoView.phone,

      // 标签和地理位置
      tags: userInfoView.tags,
      geographic: this.serializeGeographic(userInfoView.geographic),

      // 访问组和通知
      accessGroup: userInfoView.accessGroup,
      notifyCount: userInfoView.notifyCount,
      unreadCount: userInfoView.unreadCount,

      // 状态和时间戳
      userState: userInfoView.userState,
      createdAt: userInfoView.createdAt,
      updatedAt: userInfoView.updatedAt,
    };
  }

  /**
   * 将 GeographicInfo 对象序列化为字符串
   */
  private serializeGeographic(geographic: GeographicInfo | null): string | null {
    if (!geographic) return null;
    const parts: string[] = [];
    if (geographic.province) parts.push(geographic.province);
    if (geographic.city) parts.push(geographic.city);
    return parts.length > 0 ? parts.join(', ') : null;
  }
}
