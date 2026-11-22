// src/modules/lithography/local-backup-upload.service.ts

import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';

import { decideBackupUploadAttempt } from '@core/local-runtime/policy/local-backup-upload.policy';
import {
  isControlledFailureReason,
  LOCAL_BACKUP_FAILURE_REASON,
} from '@core/local-runtime/policy/local-backup-failure-reason';
import {
  LOCAL_CREDENTIAL_PURPOSE,
  hasCredentialPurpose,
} from '@core/local-runtime/policy/local-credential-purpose.policy';

import {
  LOCAL_BACKUP_UPLOADER,
  type LocalBackupUploader,
} from '@src/usecases/common/ports/local-backup-upload.contract';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { LocalAccountAuthorizationEntity } from './entities/local-account-authorization.entity';
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
    @InjectRepository(LocalAccountAuthorizationEntity)
    private readonly authorizationRepository: Repository<LocalAccountAuthorizationEntity>,
    private readonly logger: PinoLogger,
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
      // 云接收端未接入：如实跳过，**不伪造尝试**（不改上云状态、不增长尝试次数）；
      // 同时把受控原因码落到资产行，否则页面只能看到"待上传"而看不到"为什么没上传"。
      result.receiverMissing = candidates.length;
      for (const asset of candidates) {
        await this.backupAssetRepository.update(
          { backupId: asset.backupId },
          { failureReason: LOCAL_BACKUP_FAILURE_REASON.UPLOAD_RECEIVER_MISSING },
        );
      }
      return result;
    }

    const settings = await this.settingRepository.find({ where: { isCurrent: true } });
    const settingByOrganization = new Map<number, LocalCompanySettingEntity>();
    for (const setting of settings) {
      settingByOrganization.set(setting.organizationId, setting);
    }

    // 授权有效性按**真实授权事实**判定：该组织在本机存在 ACTIVE 授权才算有效。
    // （此前用"是否存在公司设置行"代替授权判定：设置行存在但授权已被撤销时，
    //   仍会把公司数据继续上传云端，策略层的 AUTHORIZATION_INVALID 分支永不可达。）
    const authorizedOrganizations = new Set<number>();
    const authorizations = await this.authorizationRepository.find({
      where: { authorizationStatus: 'ACTIVE' },
    });
    for (const authorization of authorizations) {
      // 用途维度（S4）：上云只认**云备份用途**的凭据；业务同步授权不得充数。
      // 用途不可核验（声明缺失/不可解析）→ 同样不算数（失败关闭，不静默复用）。
      if (
        hasCredentialPurpose(
          typeof authorization.signedClaims === 'string' ? authorization.signedClaims : null,
          LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP,
        )
      ) {
        authorizedOrganizations.add(authorization.organizationId);
      }
    }

    for (const asset of candidates) {
      const setting = settingByOrganization.get(asset.organizationId) ?? null;
      const decision = decideBackupUploadAttempt({
        cloudStatus: asset.cloudStatus,
        attemptCount: asset.attemptCount,
        lastAttemptAt: asset.lastAttemptAt,
        autoUploadEnabled: setting?.autoUploadEnabled ?? false,
        authorizationValid: authorizedOrganizations.has(asset.organizationId),
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

      // 接收端返回的原因必须先过形态校验：不合受控形态的一律降级为通用码，
      // 原始文本只进服务端日志（避免接收端实现回显自由文本导致外泄）
      const failureReason = isControlledFailureReason(result.reason)
        ? result.reason
        : LOCAL_BACKUP_FAILURE_REASON.UPLOAD_FAILED;
      if (!isControlledFailureReason(result.reason)) {
        this.logger.error(
          { backupId: asset.backupId, reason: result.reason },
          '云接收端返回了非受控失败原因，已降级为通用原因码',
        );
      }

      await this.backupAssetRepository.update(
        { backupId: asset.backupId },
        {
          cloudStatus: 'FAILED',
          failureReason,
        },
      );
      return 'failed';
    } catch (error) {
      // 原始异常（含本机绝对路径与可能的接收端细节）只进服务端日志；
      // 对外与落库只给受控原因码
      this.logger.error({ backupId: asset.backupId, err: error }, '本地备份包上云失败');
      await this.backupAssetRepository.update(
        { backupId: asset.backupId },
        {
          cloudStatus: 'FAILED',
          failureReason: LOCAL_BACKUP_FAILURE_REASON.UPLOAD_FAILED,
        },
      );
      return 'failed';
    }
  }
}
