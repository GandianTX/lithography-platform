// src/adapters/api/graphql/local-runtime/local-runtime.resolver.ts

import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import {
  LocalRuntimeCompanySettingDTO,
  LocalRuntimeStatusDTO,
  toLocalRuntimeStatusDTO,
} from '@src/adapters/api/graphql/local-runtime/dto/local-runtime-status.dto';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { GetLocalRuntimeStatusUsecase } from '@src/usecases/local-runtime/get-local-runtime-status.usecase';
import { UpdateLocalBackupPlanUsecase } from '@src/usecases/local-runtime/update-local-backup-plan.usecase';

/**
 * 本地运行数据解析器（任务 09 S1）。
 *
 * 职责边界（`docs/api/adapters.rules.md`）：
 * - 只做协议映射、Guard/Session 传递与 View → DTO 薄映射；
 * - 角色口径（1 级全局 / 2 级本公司 / 工程师本公司）由 usecase + core 策略裁决，
 *   本层只做粗粒度准入（工程师或管理员），不复制范围逻辑；
 * - 错误不在此捕获：DomainError 直接上抛进入全局 GraphQL exception filter。
 *
 * 当前只暴露只读状态查询。上传/备份/恢复等写入口按 S2–S4 分别接入，
 * 不把内部代理用例直接映射为公开字段。
 */
@Resolver()
export class LocalRuntimeResolver {
  constructor(
    private readonly getLocalRuntimeStatusUsecase: GetLocalRuntimeStatusUsecase,
    private readonly updateLocalBackupPlanUsecase: UpdateLocalBackupPlanUsecase,
  ) {}

  /**
   * 读取本机运行状态（本地设置页，R064）。
   *
   * 无入参：目标只能来自已认证 Session；不接受客户端指定公司或安装标识，
   * 从结构上杜绝跨公司 / 跨设备读取。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => LocalRuntimeStatusDTO, {
    name: 'localRuntimeStatus',
    description: '读取本机运行状态与默认保存位置（只读，工程师/管理员）',
  })
  async localRuntimeStatus(
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<LocalRuntimeStatusDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.getLocalRuntimeStatusUsecase.execute({ session });
    return toLocalRuntimeStatusDTO(view);
  }

  /**
   * 修改公司维度的本地备份计划开关（任务 09 S4）。
   *
   * - 本地自动备份与云自动上云**两个开关分开控制**，互不影响；
   * - 改开关不重置周期，也不触发任何备份动作（计划仍只由后台扫描的"自动成功"推进）；
   * - 准入由 usecase 裁决（工程师拒绝；一级管理员可改任意公司；二级管理员仅本公司）。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => LocalRuntimeCompanySettingDTO, {
    name: 'updateLocalBackupPlan',
    description:
      '修改公司维度的本地备份计划开关（本地自动备份 / 云自动上云分开控制；不重置周期、不触发备份）',
  })
  async updateLocalBackupPlan(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('organizationId', { type: () => Int }) organizationId: number,
    @Args('backupEnabled', { type: () => Boolean, nullable: true }) backupEnabled?: boolean | null,
    @Args('autoUploadEnabled', { type: () => Boolean, nullable: true })
    autoUploadEnabled?: boolean | null,
  ): Promise<LocalRuntimeCompanySettingDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const plan = await this.updateLocalBackupPlanUsecase.execute({
      session,
      organizationId,
      backupEnabled: backupEnabled ?? undefined,
      autoUploadEnabled: autoUploadEnabled ?? undefined,
    });
    return {
      organizationId: plan.organizationId,
      backupEnabled: plan.backupEnabled,
      backupIntervalHours: plan.backupIntervalHours,
      nextBackupAt: plan.nextBackupAt,
      autoUploadEnabled: plan.autoUploadEnabled,
      initializedAt: plan.initializedAt,
    };
  }
}
