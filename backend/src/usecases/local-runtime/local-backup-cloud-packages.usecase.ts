// src/usecases/local-runtime/local-backup-cloud-packages.usecase.ts

/**
 * 云端备份包的元数据与下载（任务 09 S4 第 3 条）。
 *
 * - **受授权**：范围＝可信 session 的公司数据区；一级管理员可查任意公司，
 *   其余仅本公司；范围外与不存在同码返回（不泄露他人草稿）；
 * - **本地已清理但云包可用时仍能查找并下载**：本链路**不依赖本机包目录**，
 *   只按公司范围向云端取元数据与字节；
 * - **下载权限 ≠ 恢复权限**：下载只给字节与文件名，**不产生任何恢复动作**
 *   （恢复仍需管理员准入 ＋ 恢复预检 ＋ 保护副本）；
 * - **不暴露密钥**：只透出受控元数据；
 * - 生产云服务未接入（R-02）时按受控原因码失败关闭，**不伪造可用云包**。
 */

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { ModuleRef } from '@nestjs/core';
import { Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import {
  LOCAL_BACKUP_CLOUD_PROVIDER,
  type LocalBackupCloudPackageDownload,
  type LocalBackupCloudPackageSummary,
  type LocalBackupCloudProvider,
} from '@usecases/common/ports/local-backup-cloud-provider.contract';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

export type ListLocalBackupCloudPackagesCommand = {
  session: UsecaseSession;
  /** 目标公司数据区；缺省＝会话本公司（一级管理员可显式指定） */
  organizationId?: number | null;
};

export type DownloadLocalBackupCloudPackageCommand = {
  session: UsecaseSession;
  packageId: string;
  organizationId?: number | null;
};

@Injectable()
export class ListLocalBackupCloudPackagesUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly moduleRef: ModuleRef,
  ) {}

  async execute(
    command: ListLocalBackupCloudPackagesCommand,
  ): Promise<{ organizationId: number; packages: LocalBackupCloudPackageSummary[] }> {
    const scope = await this.scopeResolver.resolve(command.session);
    const organizationId = this.resolveOrganizationId(scope.organizationId, command.organizationId);
    const provider = this.resolveProvider();

    const packages = await provider.listPackages(command.session, { organizationId });
    return {
      organizationId,
      // 只回本公司的包：实现方越界也不外泄
      packages: packages.filter((item) => item.organizationId === organizationId),
    };
  }

  /** 调用期惰性查找云端包读取实现（未注册＝云服务未接入，失败关闭） */
  private resolveProvider(): LocalBackupCloudProvider {
    try {
      const resolved = this.moduleRef.get<LocalBackupCloudProvider>(LOCAL_BACKUP_CLOUD_PROVIDER, {
        strict: false,
      });
      if (resolved) {
        return resolved;
      }
    } catch {
      // 未注册：按"云服务未接入"失败关闭
    }
    throw new DomainError(
      LOCAL_RUNTIME_ERROR.CLOUD_PACKAGES_UNAVAILABLE,
      '云端备份包服务未接入，无法列出或下载云端包',
    );
  }

  /** 解析目标公司：一级管理员全局；其余仅本公司 */
  private resolveOrganizationId(
    scopeOrganizationId: number | null,
    requested: number | null | undefined,
  ): number {
    if (requested !== undefined && requested !== null) {
      if (scopeOrganizationId === null) {
        // 一级管理员（全局范围）：可指定任意公司
        return requested;
      }
      if (requested !== scopeOrganizationId) {
        throw new DomainError(
          LOCAL_RUNTIME_ERROR.CLOUD_PACKAGES_UNAVAILABLE,
          '记录包不存在或不在授权范围内',
        );
      }
      return requested;
    }
    if (scopeOrganizationId === null) {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.CLOUD_PACKAGES_UNAVAILABLE,
        '请指定要查看的公司数据区',
      );
    }
    return scopeOrganizationId;
  }
}

@Injectable()
export class DownloadLocalBackupCloudPackageUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly moduleRef: ModuleRef,
  ) {}

  async execute(
    command: DownloadLocalBackupCloudPackageCommand,
  ): Promise<LocalBackupCloudPackageDownload> {
    const listUsecase = new ListLocalBackupCloudPackagesUsecase(this.scopeResolver, this.moduleRef);
    const { organizationId } = await listUsecase.execute({
      session: command.session,
      organizationId: command.organizationId ?? null,
    });

    let provider: LocalBackupCloudProvider;
    try {
      const resolved = this.moduleRef.get<LocalBackupCloudProvider>(LOCAL_BACKUP_CLOUD_PROVIDER, {
        strict: false,
      });
      if (!resolved) {
        throw new Error('未注册');
      }
      provider = resolved;
    } catch {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.CLOUD_PACKAGES_UNAVAILABLE,
        '云端备份包服务未接入，无法下载云端包',
      );
    }

    const download = await provider.downloadPackage(command.session, {
      organizationId,
      packageId: command.packageId,
    });
    return download;
  }
}
