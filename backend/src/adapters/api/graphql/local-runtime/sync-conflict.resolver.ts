// src/adapters/api/graphql/local-runtime/sync-conflict.resolver.ts

import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import {
  syncConflictActionEnum,
  type SyncConflictAction,
} from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import {
  SyncConflictDTO,
  SyncConflictPageDTO,
  SyncConflictResolveResultDTO,
  toSyncConflictDTO,
  toSyncConflictPageDTO,
  toSyncConflictResolveResultDTO,
} from '@src/adapters/api/graphql/local-runtime/dto/sync-conflict.dto';
import { GetSyncConflictUsecase } from '@src/usecases/local-runtime/get-sync-conflict.usecase';
import { ListSyncConflictsUsecase } from '@src/usecases/local-runtime/list-sync-conflicts.usecase';
import { ResolveSyncConflictUsecase } from '@src/usecases/local-runtime/resolve-sync-conflict.usecase';
import { ApplyLocalSyncConflictResolutionUsecase } from '@src/usecases/admin-document-database/apply-local-sync-conflict-resolution.usecase';

/**
 * 同步冲突解析器（任务 09 S2.1／S2.2，R066–R069）。
 *
 * - 协议映射层只做 Guard/Session 传递与 View → DTO 薄映射；
 * - 公司范围（一级全局／二级与工程师本公司）由 usecase 依据 Session 裁决，
 *   不接受客户端公司参数；
 * - 确认人取自 Session，客户端无传入口；
 * - "保留本地"走来源业务受控写入入口（任务 04 的工单受控修订入口，管理员动作），
 *   不做静默覆盖；"稍后处理"保持待处理且不写确认人；
 * - 裁决结果只返回冲突摘要，不返回本地/云端两份正文快照。
 */
@Resolver()
export class SyncConflictResolver {
  constructor(
    private readonly listSyncConflictsUsecase: ListSyncConflictsUsecase,
    private readonly getSyncConflictUsecase: GetSyncConflictUsecase,
    private readonly resolveSyncConflictUsecase: ResolveSyncConflictUsecase,
    private readonly applyLocalSyncConflictResolutionUsecase: ApplyLocalSyncConflictResolutionUsecase,
  ) {}

  private toSession(user: AuthenticatedSessionUser): UsecaseSession {
    return mapJwtToUsecaseSession(user);
  }

  /** 冲突清单（分页；默认只看待处理入口由前端通过 statusOnlyPending 控制） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => SyncConflictPageDTO, {
    name: 'syncConflicts',
    description: '同步冲突清单（工程师本公司、一级管理员全局，分页）',
  })
  async syncConflicts(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('statusOnlyPending', { nullable: true, type: () => Boolean })
    statusOnlyPending?: boolean,
    @Args('page', { nullable: true, type: () => Int, defaultValue: 1 }) page?: number,
    @Args('pageSize', { nullable: true, type: () => Int, defaultValue: 20 }) pageSize?: number,
  ): Promise<SyncConflictPageDTO> {
    const result = await this.listSyncConflictsUsecase.execute({
      session: this.toSession(user),
      statusOnlyPending,
      pagination: { page: page ?? 1, pageSize: pageSize ?? 20, withTotal: true },
    });
    return toSyncConflictPageDTO(result);
  }

  /** 冲突详情：三方版本与本地/云端快照 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => SyncConflictDTO, {
    name: 'syncConflict',
    description: '同步冲突详情（范围内才可见；范围外与不存在同码返回）',
  })
  async syncConflict(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('conflictId', { type: () => String }) conflictId: string,
  ): Promise<SyncConflictDTO> {
    const conflict = await this.getSyncConflictUsecase.execute({
      session: this.toSession(user),
      conflictId,
    });
    return toSyncConflictDTO(conflict);
  }

  /** 冲突裁决：使用云端（写确认人）/ 保留本地（待受控入口）/ 稍后处理（保持待处理） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => SyncConflictResolveResultDTO, {
    name: 'resolveSyncConflict',
    description: '裁决同步冲突；重复相同方向返回既有事实，换方向显式拒绝，稍后处理不写确认人',
  })
  async resolveSyncConflict(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('conflictId', { type: () => String }) conflictId: string,
    @Args('action', { type: () => syncConflictActionEnum }) action: SyncConflictAction,
  ): Promise<SyncConflictResolveResultDTO> {
    const session = this.toSession(user);
    // 保留本地是管理员动作：由管理员文档库域的受控修订入口执行（任务 09 R-03）；
    // 使用云端／稍后处理留在本地运行域（那里有冲突读侧的授权与范围口径）。
    if (action === 'LOCAL') {
      const localResult = await this.applyLocalSyncConflictResolutionUsecase.execute({
        session,
        conflictId,
      });
      return toSyncConflictResolveResultDTO(localResult);
    }
    const result = await this.resolveSyncConflictUsecase.execute({
      session,
      conflictId,
      action,
    });
    return toSyncConflictResolveResultDTO(result);
  }
}
