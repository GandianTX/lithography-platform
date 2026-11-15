// 文件位置：src/adapters/api/graphql/account/user-info.resolver.ts
import { UserInfoView } from '@app-types/models/auth.types';
import { type GeographicInfo } from '@app-types/models/user-info.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { GetVisibleUserInfoUsecase } from '@src/usecases/account/get-visible-user-info.usecase';
import { UpdateVisibleUserInfoUsecase } from '@src/usecases/account/update-visible-user-info.usecase';
import { currentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { SessionRestrictionGuard } from '../guards/session-restriction.guard';
import { BasicUserInfoDTO } from './dto/basic-user-info.dto';
import { UserInfoDTO } from './dto/user-info.dto';
import { UpdateUserInfoInput, UpdateUserInfoResult } from './dto/user-info.update.input';

/**
 * 用户信息 GraphQL 解析器
 * 适配 `GetVisibleUserInfoUsecase`，提供按可见性规则读取用户信息的查询。
 */
@Resolver()
export class UserInfoResolver {
  constructor(
    private readonly getVisibleUserInfoUsecase: GetVisibleUserInfoUsecase,
    private readonly updateVisibleUserInfoUsecase: UpdateVisibleUserInfoUsecase,
  ) {}

  /**
   * 按可见性读取用户信息（完整）
   * @param user 当前登录用户的 JWT 载荷
   * @param accountId 目标账户 ID
   */
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  @Query(() => UserInfoDTO, { name: 'userInfo' })
  async userInfo(
    @currentUser() user: JwtPayload,
    @Args('accountId', { type: () => Int }) accountId: number,
  ): Promise<UserInfoDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.getVisibleUserInfoUsecase.execute({
      session,
      targetAccountId: accountId,
      detail: 'FULL',
    });
    return this.mapViewToDTO(view);
  }

  /**
   * 按可见性读取用户信息（基础版）
   * @param user 当前登录用户的 JWT 载荷
   * @param accountId 目标账户 ID
   */
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  @Query(() => BasicUserInfoDTO, { name: 'basicUserInfo' })
  async basicUserInfo(
    @currentUser() user: JwtPayload,
    @Args('accountId', { type: () => Int }) accountId: number,
  ): Promise<BasicUserInfoDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.getVisibleUserInfoUsecase.execute({
      session,
      targetAccountId: accountId,
      detail: 'BASIC',
    });
    return this.mapViewToBasicDTO(view);
  }

  /**
   * 将领域视图映射为 GraphQL 完整 DTO
   */
  private mapViewToDTO(view: UserInfoView): UserInfoDTO {
    return {
      id: view.accountId,
      accountId: view.accountId,
      nickname: view.nickname,
      gender: view.gender,
      birthDate: view.birthDate,
      avatarUrl: view.avatarUrl,
      email: view.email,
      signature: view.signature,
      accessGroup: view.accessGroup,
      address: view.address,
      phone: view.phone,
      tags: view.tags,
      geographic: this.serializeGeographic(view.geographic),
      notifyCount: view.notifyCount,
      unreadCount: view.unreadCount,
      userState: view.userState,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  }

  /**
   * 将领域视图映射为 GraphQL 基础 DTO
   */
  private mapViewToBasicDTO(view: UserInfoView): BasicUserInfoDTO {
    return {
      id: view.accountId,
      accountId: view.accountId,
      nickname: view.nickname,
      gender: view.gender,
      avatarUrl: view.avatarUrl,
      phone: view.phone,
    };
  }

  private serializeGeographic(
    geo: { province?: string | null; city?: string | null } | null,
  ): string | null {
    if (!geo) return null;
    const parts: string[] = [];
    if (geo.province) parts.push(geo.province);
    if (geo.city) parts.push(geo.city);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * 更新用户信息（按可见性与权限策略）
   *
   * `UpdateUserInfoInput` 不含 `identityHint`（普通用户角色只在管理员创建账号时
   * 单选一次，创建后角色只读，无公开角色修改 Mutation），
   * 也不再暴露 `userState`（启用/停用走 `adminSetUserStatus`，双字段同事务同步）。
   *
   * @param user 当前登录用户
   * @param input 更新输入
   */
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  @Mutation(() => UpdateUserInfoResult, { name: 'updateUserInfo' })
  async updateUserInfo(
    @currentUser() user: JwtPayload,
    @Args('input') input: UpdateUserInfoInput,
  ): Promise<UpdateUserInfoResult> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const targetAccountId =
      typeof input.accountId === 'number' ? input.accountId : session.accountId;
    const geoPatch: GeographicInfo | null | undefined =
      typeof input.geographic === 'undefined'
        ? undefined
        : input.geographic === null
          ? null
          : {
              province: input.geographic.province ?? undefined,
              city: input.geographic.city ?? undefined,
            };
    const { view, isUpdated } = await this.updateVisibleUserInfoUsecase.execute({
      session,
      targetAccountId,
      patch: {
        nickname: input.nickname,
        gender: input.gender,
        birthDate: input.birthDate,
        avatarUrl: input.avatarUrl,
        email: input.email,
        signature: input.signature,
        address: input.address,
        phone: input.phone,
        tags: input.tags,
        geographic: geoPatch,
      },
    });
    return {
      isUpdated,
      userInfo: this.mapViewToDTO(view),
    };
  }
}
