// src/adapters/api/graphql/local-runtime/local-backup.resolver.ts

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
  LocalBackupRecordDetailDTO,
  LocalBackupRecordPageDTO,
  LocalBackupSettingDTO,
  LocalBackupRecordPaginationInput,
  LocalRestoreCapabilityDTO,
  LocalRestorePrecheckResultDTO,
  StartManualLocalBackupResultDTO,
  toLocalBackupRecordDetailDTO,
  toLocalBackupRecordDTO,
  toLocalBackupSettingDTO,
} from '@src/adapters/api/graphql/local-runtime/dto/local-backup.dto';
import { RESTORE_EXECUTION_UNAVAILABLE_REASON } from '@core/local-runtime/policy/restore-precheck.policy';
import { GetLocalBackupRecordUsecase } from '@src/usecases/local-runtime/get-local-backup-record.usecase';
import { GetLocalBackupSettingsUsecase } from '@src/usecases/local-runtime/get-local-backup-settings.usecase';
import { ListLocalBackupRecordsUsecase } from '@src/usecases/local-runtime/list-local-backup-records.usecase';
import { PrecheckLocalRestoreUsecase } from '@src/usecases/local-runtime/precheck-local-restore.usecase';
import { StartManualLocalBackupUsecase } from '@src/usecases/local-runtime/start-manual-local-backup.usecase';

/**
 * 备份与恢复解析器（任务 09 S3，R081／R074-01～03）。
 *
 * - 备份记录与详情：公司范围由服务端按 Session 裁决，前端不传公司参数；
 * - 自动备份设置：只读展示计划、下次时间与最近结果；
 * - 手动备份：真实执行受保护包生成；上云与清理阶段如实返回实际状态，
 *   不以"已提交"冒充"已上云"。
 */
@Resolver()
export class LocalBackupResolver {
  constructor(
    private readonly listLocalBackupRecordsUsecase: ListLocalBackupRecordsUsecase,
    private readonly getLocalBackupRecordUsecase: GetLocalBackupRecordUsecase,
    private readonly getLocalBackupSettingsUsecase: GetLocalBackupSettingsUsecase,
    private readonly startManualLocalBackupUsecase: StartManualLocalBackupUsecase,
    private readonly precheckLocalRestoreUsecase: PrecheckLocalRestoreUsecase,
  ) {}

  /** 备份记录列表：本公司范围（一级管理员为全局范围） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => LocalBackupRecordPageDTO, {
    name: 'localBackupRecords',
    description: '本机备份记录列表（二级管理员与工程师限本公司；一级管理员为全局范围）',
  })
  async localBackupRecords(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('pagination', { nullable: true }) pagination?: LocalBackupRecordPaginationInput,
  ): Promise<LocalBackupRecordPageDTO> {
    const page = await this.listLocalBackupRecordsUsecase.execute({
      session: this.toSession(user),
      pagination: pagination
        ? {
            page: pagination.page ?? 1,
            pageSize: pagination.pageSize ?? 20,
            withTotal: pagination.withTotal ?? true,
          }
        : undefined,
    });
    return {
      items: page.items.map(toLocalBackupRecordDTO),
      total: page.total ?? null,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /** 备份记录详情：清单元数据，不含包正文与密钥材料 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => LocalBackupRecordDetailDTO, {
    name: 'localBackupRecord',
    description: '本机备份记录详情（范围外与不存在同码返回）',
  })
  async localBackupRecord(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('backupId', { type: () => String }) backupId: string,
  ): Promise<LocalBackupRecordDetailDTO> {
    const detail = await this.getLocalBackupRecordUsecase.execute({
      session: this.toSession(user),
      backupId,
    });
    return toLocalBackupRecordDetailDTO(detail);
  }

  /** 自动备份设置：下次时间、最近结果与只读周期/保留窗口 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => [LocalBackupSettingDTO], {
    name: 'localBackupSettings',
    description: '本机自动备份设置（本公司范围；首次初始化前为空）',
  })
  async localBackupSettings(
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<LocalBackupSettingDTO[]> {
    const settings = await this.getLocalBackupSettingsUsecase.execute({
      session: this.toSession(user),
    });
    return settings.map(toLocalBackupSettingDTO);
  }

  /** 手动备份：真实生成受保护包；上云与清理阶段如实返回实际状态 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => StartManualLocalBackupResultDTO, {
    name: 'startManualLocalBackup',
    description: '手动备份并清理本地备份包（当前实现完成生成阶段；无完整云端回执时不清理本地包）',
  })
  async startManualLocalBackup(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('organizationId', { type: () => Int, nullable: true }) organizationId?: number,
  ): Promise<StartManualLocalBackupResultDTO> {
    const result = await this.startManualLocalBackupUsecase.execute({
      session: this.toSession(user),
      organizationId: organizationId ?? null,
    });
    return {
      runId: result.runId,
      organizationId: result.organizationId,
      status: result.status,
      backupId: result.backupId,
      manifestChecksum: result.manifestChecksum,
      byteSize: result.byteSize,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      uploadStatus: result.uploadStatus,
      cleanupStatus: result.cleanupStatus,
    };
  }

  /** 恢复预检：目标核对＋包完整性＋保护副本；恢复执行入口保持如实不可用 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => LocalRestorePrecheckResultDTO, {
    name: 'precheckLocalRestore',
    description:
      '恢复预检（管理员专属）：核对目标设备与公司、逐文件校验备份包，并生成当前范围的保护副本',
  })
  async precheckLocalRestore(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('backupId', { type: () => String }) backupId: string,
  ): Promise<LocalRestorePrecheckResultDTO> {
    const result = await this.precheckLocalRestoreUsecase.execute({
      session: this.toSession(user),
      backupId,
    });
    const snapshot = result.snapshot;
    return {
      restoreId: result.restoreId,
      outcome: result.outcome,
      checkedAt: new Date(snapshot.checked_at),
      targetBackupId: snapshot.target.backupId,
      targetOrganizationId: snapshot.target.organizationId,
      targetInstallationId: snapshot.target.installationId,
      manifestChecksum: snapshot.target.manifestChecksum,
      packageReadable: snapshot.package.readable,
      fileCount: snapshot.package.fileCount,
      originalCount: snapshot.package.originalCount,
      verifiedFileCount: snapshot.package.verifiedFileCount,
      protectionBackupId: snapshot.protection.backupId,
      protectionCreated: snapshot.protection.created,
      findings: snapshot.findings.map((finding) => ({
        code: finding.code,
        message: finding.message,
      })),
    };
  }

  /** 恢复执行能力状态：如实告知当前环境是否可执行恢复 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => LocalRestoreCapabilityDTO, {
    name: 'localRestoreCapability',
    description: '恢复执行能力状态（当前环境缺少写入/同步闸门与失败回滚补偿时如实不可用）',
  })
  localRestoreCapability(): LocalRestoreCapabilityDTO {
    return {
      executionAvailable: false,
      reason: RESTORE_EXECUTION_UNAVAILABLE_REASON,
    };
  }
  private toSession(user: AuthenticatedSessionUser): UsecaseSession {
    return mapJwtToUsecaseSession(user);
  }
}
