// src/modules/lithography/local-backup-plan.service.ts

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LocalCompanySettingEntity } from './entities/local-company-setting.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';

/**
 * 公司维度的本地备份计划开关写入（任务 09 S4）。
 *
 * 为什么单独成服务：`BackupScheduleService` 是 **Worker 侧**的后台调度器
 * （Worker 模块自带装配），若把写入口挂在它上面，本机设置页所在的
 * API 模块就得依赖 Worker 装配，会出现两份实例。故拆出唯一写入方：
 * - **开关写入只在这里**（调度器只负责建行与推进，不改开关）；
 * - 调度器的"初始化建行"与这里的"改开关"是两件事，不构成二次实现。
 *
 * 口径：
 * - 只改 `is_current=1` 的当前计划行：历史计划行是既成事实，不回写；
 * - 两个开关**分开控制**：本地自动备份与云自动上云互不影响；
 * - 改开关**不重置周期**：`next_backup_at` 保持原值。
 */
@Injectable()
export class LocalBackupPlanService {
  constructor(
    @InjectRepository(LocalCompanySettingEntity)
    private readonly settingRepository: Repository<LocalCompanySettingEntity>,
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
  ) {}

  /** 修改公司当前备份计划的开关；返回 null 表示该公司尚无当前计划行 */
  async updateCompanyBackupPlan(input: {
    organizationId: number;
    backupEnabled?: boolean;
    autoUploadEnabled?: boolean;
  }): Promise<{
    organizationId: number;
    backupEnabled: boolean;
    backupIntervalHours: number;
    nextBackupAt: Date | null;
    autoUploadEnabled: boolean;
    initializedAt: Date;
  } | null> {
    const installation = await this.installationRepository.findOne({ where: { id: 1 } });
    if (!installation) {
      return null;
    }
    const plan = await this.settingRepository.findOne({
      where: {
        installationId: installation.installationId,
        organizationId: input.organizationId,
        isCurrent: true,
      },
    });
    if (!plan) {
      return null;
    }
    const patch: Partial<LocalCompanySettingEntity> = {};
    if (input.backupEnabled !== undefined) {
      patch.backupEnabled = input.backupEnabled;
    }
    if (input.autoUploadEnabled !== undefined) {
      patch.autoUploadEnabled = input.autoUploadEnabled;
    }
    if (Object.keys(patch).length > 0) {
      await this.settingRepository.update({ id: plan.id }, patch);
    }
    return {
      organizationId: plan.organizationId,
      backupEnabled: patch.backupEnabled ?? plan.backupEnabled,
      backupIntervalHours: plan.backupIntervalHours,
      nextBackupAt: plan.nextBackupAt,
      autoUploadEnabled: patch.autoUploadEnabled ?? plan.autoUploadEnabled,
      initializedAt: plan.initializedAt,
    };
  }
}
