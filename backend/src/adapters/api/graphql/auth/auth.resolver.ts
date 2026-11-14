// src/adapters/api/graphql/auth/auth.resolver.ts

import {
  type AuthenticatedSessionUser,
  SessionRestriction,
} from '@app-types/auth/session-restriction.types';
import { AuthLoginModel, LoginResultModel, UserInfoView } from '@app-types/models/auth.types';
import { GeographicInfo } from '@app-types/models/user-info.types';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { FetchUserInfoUsecase } from '@usecases/account/fetch-user-info.usecase';
import type { CompleteUserData } from '@usecases/account/fetch-user-info.types';
import { LoginWithPasswordUsecase } from '@usecases/auth/login-with-password.usecase';
import { LoginResult } from '../account/dto/login-result.dto';
import { SessionIdentityDTO } from '../account/dto/session-identity.dto';
import { UserInfoDTO } from '../account/dto/user-info.dto';
import { currentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthLoginInput } from './dto/auth-login.input';

/**
 * 认证相关的 GraphQL Resolver
 */
@Resolver()
export class AuthResolver {
  constructor(
    private readonly loginWithPasswordUsecase: LoginWithPasswordUsecase,
    private readonly fetchUserInfoUsecase: FetchUserInfoUsecase,
  ) {}

  @Mutation(() => LoginResult)
  async login(@Args('input') input: AuthLoginInput): Promise<LoginResult> {
    // 将 DTO 转换为领域模型
    const authLoginModel: AuthLoginModel = {
      loginName: input.loginName,
      loginPassword: input.loginPassword,
      type: input.type,
      ip: input.ip,
      audience: input.audience,
      allowRestrictedSession: input.allowRestrictedSession,
    };

    // 调用 usecase
    const result: LoginResultModel = await this.loginWithPasswordUsecase.execute(authLoginModel);

    // 获取用户信息
    const userInfo = await this.getUserInfoForGraphQL(result.accountId);

    // 将领域模型转换回 DTO
    const loginResult: LoginResult = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accountId: result.accountId,
      role: result.role,
      userInfo,
      restriction: result.restriction ?? SessionRestriction.NONE,
      adminLevel: result.adminLevel ?? null,
      customerOrganizationId: result.customerOrganizationId ?? null,
      engineerOrganizationId: result.engineerOrganizationId ?? null,
      adminOrganizationId: result.adminOrganizationId ?? null,
      registrationOrganizationId: result.registrationOrganizationId ?? null,
    };

    return loginResult;
  }

  /**
   * 读取当前会话身份与限制状态。
   *
   * 会话事实已由 `JwtStrategy` → `ValidateAccessTokenSessionUsecase` 每请求计算并挂在
   * `request.user` 上，本入口只做薄映射，不再查库。
   */
  @UseGuards(JwtAuthGuard)
  @Query(() => SessionIdentityDTO, {
    name: 'mySessionIdentity',
    description: '读取当前会话身份与限制状态',
  })
  mySessionIdentity(@currentUser() user: AuthenticatedSessionUser): SessionIdentityDTO {
    return {
      accountId: user.accountId,
      role: user.role ?? null,
      adminLevel: user.adminLevel ?? null,
      customerOrganizationId: user.customerOrganizationId ?? null,
      engineerOrganizationId: user.engineerOrganizationId ?? null,
      adminOrganizationId: user.adminOrganizationId ?? null,
      registrationOrganizationId: user.registrationOrganizationId ?? null,
      restriction: user.restriction,
    };
  }

  /**
   * 获取用于 GraphQL 响应的用户信息
   * 使用现有的安全验证流程，确保 accessGroup 和 metaDigest 已完成比对
   */
  private async getUserInfoForGraphQL(accountId: number): Promise<UserInfoDTO> {
    // 使用现有的 executeForLoginFlow 方法，它已经包含了安全验证
    const completeUserData: CompleteUserData = await this.fetchUserInfoUsecase.executeForLoginFlow({
      accountId,
    });

    // 安全验证已在 executeForLoginFlow 中完成
    // 现在将 userInfoView 转换为安全的 DTO（移除 metaDigest）
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

      // 标签和地理位置 - 需要序列化为字符串
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
   * @param geographic 地理位置信息对象
   * @returns 序列化后的字符串或 null
   */
  private serializeGeographic(geographic: GeographicInfo | null): string | null {
    if (!geographic) return null;

    const parts: string[] = [];
    if (geographic.province) parts.push(geographic.province);
    if (geographic.city) parts.push(geographic.city);

    return parts.length > 0 ? parts.join(', ') : null;
  }
}
