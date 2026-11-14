// src/adapters/api/graphql/account/my-account-settings.resolver.ts

import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UpdateMyAccountSettingsInput } from '@src/adapters/api/graphql/account/dto/update-my-account-settings.input';
import {
  UpdateMyAccountSettingsResultDTO,
  toUpdateMyAccountSettingsResultDTO,
} from '@src/adapters/api/graphql/account/dto/update-my-account-settings-result.dto';
import { ChangeMyPasswordInput } from '@src/adapters/api/graphql/account/dto/change-my-password.input';
import {
  ChangeMyPasswordResultDTO,
  toChangeMyPasswordResultDTO,
} from '@src/adapters/api/graphql/account/dto/change-my-password-result.dto';
import {
  MyAccountSettingsDTO,
  toMyAccountSettingsDTO,
} from '@src/adapters/api/graphql/account/dto/my-account-settings.dto';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { SessionRestrictionGuard } from '@src/adapters/api/graphql/guards/session-restriction.guard';
import { ChangeMyPasswordUsecase } from '@src/usecases/account/change-my-password.usecase';
import { GetMyAccountSettingsUsecase } from '@src/usecases/account/get-my-account-settings.usecase';
import { UpdateMyAccountSettingsUsecase } from '@src/usecases/account/update-my-account-settings.usecase';

/**
 * 当前用户账号设置解析器（P1 只读 + P2 设置更新 + P3 自助改密）。
 *
 * 职责边界（`docs/api/adapters.rules.md`）：
 * - 只做协议映射、Guard/Session 传递与 View → DTO 薄映射；三源角色收敛、双字段状态一致性、
 *   资料缺失失败关闭、凭据合并 / 唯一性预检查 / 事务全部归 Usecase / QueryService；
 * - 不依赖 modules(service)、QueryService、Repository 或 infrastructure；
 * - 错误不在此捕获：DomainError 直接上抛进入全局 GraphQL exception filter。
 *
 * 准入：`JwtAuthGuard` 一层即可——`SUPER_ADMIN` / `ENGINEER` / `CUSTOMER` 均可管理**自己的**
 * 账号设置（契约见 `docs/api/account-write-current.md`），故不加 `@Roles`。目标账号只能来自
 * 已认证 Session，三个入口（1 Query + 2 Mutation）**刻意不接收任何目标账号 ID 参数**，
 * 结构上杜绝读取 / 修改他人设置的入口。
 */
@Resolver()
export class MyAccountSettingsResolver {
  constructor(
    private readonly getMyAccountSettingsUsecase: GetMyAccountSettingsUsecase,
    private readonly updateMyAccountSettingsUsecase: UpdateMyAccountSettingsUsecase,
    private readonly changeMyPasswordUsecase: ChangeMyPasswordUsecase,
  ) {}

  /**
   * 读取当前登录用户自己的账号设置（只读）。
   * 角色与状态为只读展示字段；响应不含 accountId、密码、Token、identityHint 等敏感字段。
   */
  @UseGuards(JwtAuthGuard)
  @Query(() => MyAccountSettingsDTO, {
    name: 'myAccountSettings',
    description: '读取当前登录用户的账号设置（只读）',
  })
  async myAccountSettings(@currentUser() user: JwtPayload): Promise<MyAccountSettingsDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.getMyAccountSettingsUsecase.execute({ session });
    return toMyAccountSettingsDTO(view);
  }

  /**
   * 更新当前登录用户自己的账号设置（登录名 / 登录邮箱 / 昵称 / 公司名称 / 电话 / 联系邮箱）。
   * 三态语义见 `UpdateMyAccountSettingsInput`；「至少保留一个登录方式」、唯一性预检查与
   * 数据库唯一索引竞争裁决全部由 Usecase 在事务内完成，本方法不做任何业务判断。
   */
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  @Mutation(() => UpdateMyAccountSettingsResultDTO, {
    name: 'updateMyAccountSettings',
    description: '更新当前登录用户的账号设置',
  })
  @ValidateInput()
  async updateMyAccountSettings(
    @Args('input') input: UpdateMyAccountSettingsInput,
    @currentUser() user: JwtPayload,
  ): Promise<UpdateMyAccountSettingsResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.updateMyAccountSettingsUsecase.execute({
      session,
      loginName: input.loginName,
      loginEmail: input.loginEmail,
      nickname: input.nickname,
      companyName: input.companyName,
      phone: input.phone,
      contactEmail: input.contactEmail,
    });
    return toUpdateMyAccountSettingsResultDTO(result);
  }

  /**
   * 当前登录用户自助修改登录密码。当前密码校验、新密码策略与哈希落库由 Usecase 完成；
   * 成功结果不声称服务端撤销了已签发 Token（旧 Token 按现有契约自然过期）。
   */
  @UseGuards(JwtAuthGuard)
  @Mutation(() => ChangeMyPasswordResultDTO, {
    name: 'changeMyPassword',
    description: '当前登录用户修改自己的登录密码',
  })
  @ValidateInput()
  async changeMyPassword(
    @Args('input') input: ChangeMyPasswordInput,
    @currentUser() user: JwtPayload,
  ): Promise<ChangeMyPasswordResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.changeMyPasswordUsecase.execute({
      session,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    return toChangeMyPasswordResultDTO(result);
  }
}
