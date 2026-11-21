// src/modules/lithography/local-backup-upload.service.ts

import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';

import { decideBackupUploadAttempt } from '@core/local-runtime/policy/local-backup-upload.policy';

import {
  LOCAL_BACKUP_UPLOADER,
  type LocalBackupUploader,
} from '@src/usecases/local-runtime/local-backup-upload.contract';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { LocalCompanySettingEntity } from './entities/local-company-setting.entity';

/** 上传在途超过该时长（分钟）视为进程中断残留，改判失败并按退避重试 */
const UPLOADING_STALE_MINUTES = 10;

export type LocalBackupUploadCycleResult = {
  /** 本轮实际发起的上传尝试数 */
  attempted: number;
  succeeded: number;
  failed: number;
  /** 因退避未到期而跳过的资产数 */
  waiting: number;
  /** 因开关关闭／授权失效／已成功／不可重试而跳过的资产数 */
  skipped: number;
  /** 因云接收端未接入而跳过的资产数（不计入尝试，不增长尝试次数） */
  receiverMissing: number;
  /** 本轮改判的进程中断残留数 */
  compensated: number;
};

/**
 * 自动上云重试执行器（任务 09 S3.2）。
 *
 * 关键口径：
 * - 重试锚点是**既有的 backup_asset 行**，同一 backupId 在重试过程中不产生新的资产、
 *   也不重新生成备份包（R076「自动重试原包不生新包」）；
 * - 退避与检测周期由 core 策略裁决，本层只负责读事实、调用接收端、落事实；
 * - 进程重启后残留的 UPLOADING 改判失败并按退避重试（不丢任务、不重复生成）；
 * - 云接收端未接入时**如实跳过**，不增长尝试次数、不伪造成功、不改动资产状态；
 * - 自动上云成功**不触发**本地包清理（清理属手动三阶段流程）。
 */
@Injectable()
export class LocalBackupUploadService {
  private readonly uploader: LocalBackupUploader | null;

  constructor(
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository: Repository<BackupAssetEntity>,
    @InjectRepository(LocalCompanySettingEntity)
    private readonly settingRepository: Repository<LocalCompanySettingEntity>,
    @Optional()
    @Inject(LOCAL_BACKUP_UPLOADER)
    uploader?: LocalBackupUploader | null,
  ) {
    // Nest 对未提供的可选依赖注入 undefined，这里统一归一为 null：
    // "没有云接收端"与"接收端存在但失败"必须是两种不同的事实。
    this.uploader = uploader ?? null;
  }

  /** 执行一轮自动上云扫描（now 为可控时钟，便于以固定时刻验证退避边界） */
  async runOnce(now: Date = new Date()): Promise<LocalBackupUploadCycleResult> {
    const result: LocalBackupUploadCycleResult = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      waiting: 0,
      skipped: 0,
      receiverMissing: 0,
      compensated: 0,
    };

    result.compensated = await this.compensateStaleUploading(now);

    const candidates = await this.listRetryableAssets();
    if (this.uploader === null) {
      // 云接收端未接入：如实跳过，不伪造尝试。
      result.receiverMissing = candidates.length;
      return result;
    }

    const settings = await this.settingRepository.find({ where: { isCurrent: true } });
    const settingByOrganization = new Map<number, LocalCompanySettingEntity>();
    for (const setting of settings) {
      settingByOrganization.set(setting.organizationId, setting);
    }

    for (const asset of candidates) {
      const setting = settingByOrganization.get(asset.organizationId) ?? null;
      const decision = decideBackupUploadAttempt({
        cloudStatus: asset.cloudStatus,
        attemptCount: asset.attemptCount,
        lastAttemptAt: asset.lastAttemptAt,
        autoUploadEnabled: setting?.autoUploadEnabled ?? false,
        authorizationValid: setting !== null,
        now,
      });

      if (decision.action === 'WAIT') {
        result.waiting += 1;
        continue;
      }
      if (decision.action === 'SKIP') {
        result.skipped += 1;
        continue;
      }
      if (decision.action !== 'RETRY') {
        continue;
      }

      result.attempted += 1;
      const outcome = await this.attemptUpload(asset, now);
      if (outcome === 'succeeded') {
        result.succeeded += 1;
      } else {
        result.failed += 1;
      }
    }

    return result;
  }

  /** 可重试资产：云端状态为 PENDING／FAILED；按创建时间升序，先到先重试 */
  private async listRetryableAssets(): Promise<BackupAssetEntity[]> {
    return this.backupAssetRepository.find({
      where: { cloudStatus: In(['PENDING', 'FAILED']) },
      order: { createdAt: 'ASC', backupId: 'ASC' },
    });
  }

  /**
   * 进程中断补偿：残留的 UPLOADING 改判 FAILED。
   *
   * 改判失败而不是直接回到 PENDING，是为了让退避按「已尝试过」计算，
   * 避免重启后立刻连续重试。
   */
  private async compensateStaleUploading(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - UPLOADING_STALE_MINUTES * 60_000);
    const stale = await this.backupAssetRepository.find({
      where: { cloudStatus: 'UPLOADING', lastAttemptAt: LessThan(cutoff) },
    });
    for (const asset of stale) {
      await this.backupAssetRepository.update(
        { backupId: asset.backupId },
        {
          cloudStatus: 'FAILED',
          failureReason: '上传过程被进程中断，将按退避重试同一备份包',
        },
      );
    }
    return stale.length;
  }

  /** 单次上传尝试：先置 UPLOADING 并累加尝试次数，再调用接收端，最后落终态 */
  private async attemptUpload(
    asset: BackupAssetEntity,
    now: Date,
  ): Promise<'succeeded' | 'failed'> {
    await this.backupAssetRepository.update(
      { backupId: asset.backupId },
      {
        cloudStatus: 'UPLOADING',
        attemptCount: asset.attemptCount + 1,
        lastAttemptAt: now,
        failureReason: null,
      },
    );

    const uploader = this.uploader;
    if (uploader === null) {
      return 'failed';
    }

    try {
      const result = await uploader.upload({
        backupId: asset.backupId,
        organizationId: asset.organizationId,
        installationId: asset.installationId ?? '',
        packagePath: asset.localReference ?? '',
        manifestChecksum: asset.manifestChecksum ?? asset.fileSha256,
        byteSize: Number(asset.byteSize ?? 0),
      });

      if (result.status === 'SUCCEEDED') {
        await this.backupAssetRepository.update(
          { backupId: asset.backupId },
          {
            cloudStatus: 'SUCCEEDED',
            cloudReference: result.cloudReference,
            cloudReceipt: result.receipt,
            failureReason: null,
            verifiedAt: now,
          },
        );
        return 'succeeded';
      }

      await this.backupAssetRepository.update(
        { backupId: asset.backupId },
        {
          cloudStatus: 'FAILED',
          failureReason: result.reason,
        },
      );
      return 'failed';
    } catch (error) {
      const message = error instanceof Error ? error.message : '云端上传失败';
      await this.backupAssetRepository.update(
        { backupId: asset.backupId },
        {
          cloudStatus: 'FAILED',
          failureReason: message,
        },
      );
      return 'failed';
    }
  }
}
