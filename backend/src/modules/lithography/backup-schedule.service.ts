// src/modules/lithography/backup-schedule.service.ts

import { LocalWriteHoldService } from './local-write-hold.service';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';

import { LOCAL_BACKUP_FAILURE_REASON } from '@core/local-runtime/policy/local-backup-failure-reason';

import {
  hasCredentialPurpose,
  LOCAL_CREDENTIAL_PURPOSE,
} from '@core/local-runtime/policy/local-credential-purpose.policy';

import { LocalAccountAuthorizationEntity } from '@src/modules/lithography/entities/local-account-authorization.entity';
import { LocalCompanySettingEntity } from '@src/modules/lithography/entities/local-company-setting.entity';
import { LocalBackupRunEntity } from '@src/modules/lithography/entities/local-backup-run.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';

/** 自动备份计划默认周期（小时）：需求固定口径约 72 小时 */
export const DEFAULT_BACKUP_INTERVAL_HOURS = 72;

/**
 * 72h 持久计划执行器（任务 09 S3.1，D-8：Worker 引导内定时扫描，不依赖页面登录）。
 *
 * 单次扫描（runOnce）三步，全部幂等、可重复执行：
 * 1. 恢复运行补偿：进程重启后残留的 RUNNING（超过补偿时限未结束）改判 INTERRUPTED，
 *    计划随后按"补一次"语义重新触发；
 * 2. 计划初始化（D-11 属 S3 落地）：对无当前计划的公司按默认 72h **建立启用计划**，
 *    首次到期＝初始化时刻＋72h；本地自动计划默认启用，云自动上云默认关闭且单独控制；
 * 3. 到期触发：backup_enabled=1 且 next_backup_at 到期的计划逐个执行：
 *    建 RUNNING（同公司互斥，冲突本轮跳过）→ 生成受保护包 → 结束运行并推进 next_backup_at；
 *    **仅成功后推进下次时间**（R076-01），失败只更新失败事实、不更新成功时间。
 */
@Injectable()
export class BackupScheduleService {
  /** RUNNING 运行超过该时长视为中断残留（默认 60 分钟） */
  private readonly compensationMinutes = 60;

  constructor(
    @InjectRepository(LocalCompanySettingEntity)
    private readonly settingRepository: Repository<LocalCompanySettingEntity>,
    @InjectRepository(LocalAccountAuthorizationEntity)
    private readonly authorizationRepository: Repository<LocalAccountAuthorizationEntity>,
    @InjectRepository(LocalBackupRunEntity)
    private readonly backupRunRepository: Repository<LocalBackupRunEntity>,
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    private readonly protectedBackupService: ProtectedBackupService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly logger: PinoLogger,
  ) {}

  /** 执行一轮调度扫描（Worker 定时调用；亦可由内部入口手动触发） */
  async runOnce(now: Date = new Date()): Promise<{
    compensated: number;
    initialized: number;
    triggered: number;
    succeeded: number;
    failed: number;
    skipped: number;
  }> {
    const compensated = await this.compensateInterruptedRuns(now);
    const initialized = await this.initializeMissingPlans(now);
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const due = await this.settingRepository.find({
      where: { backupEnabled: true, nextBackupAt: LessThanOrEqual(now) },
    });
    for (const plan of due) {
      // 单个计划的异常不中断整轮扫描：其余公司计划照常推进
      let result: 'succeeded' | 'failed' | 'skipped';
      try {
        result = await this.runDuePlan(plan, now);
      } catch (error) {
        this.logger.error(
          { organizationId: plan.organizationId, err: error },
          '本地备份计划执行异常，本轮跳过该计划',
        );
        result = 'failed';
      }
      if (result === 'succeeded') {
        succeeded += 1;
      } else if (result === 'failed') {
        failed += 1;
      } else {
        skipped += 1; // 同公司已有 RUNNING，互斥跳过
      }
    }
    const triggered = succeeded + failed;
    return { compensated, initialized, triggered, succeeded, failed, skipped };
  }

  /** RUNNING 残留补偿：改判 INTERRUPTED（计划随后补一次） */
  private async compensateInterruptedRuns(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.compensationMinutes * 60_000);
    const stale = await this.backupRunRepository.find({
      where: { status: 'RUNNING' },
    });
    let compensated = 0;
    for (const run of stale) {
      if (run.startedAt.getTime() > cutoff.getTime()) {
        continue; // 仍在补偿时限内，可能是正在执行的备份
      }
      await this.backupRunRepository.update(
        { id: run.id },
        {
          status: 'INTERRUPTED',
          finishedAt: now,
          errorCode: 'BACKUP_INTERRUPTED_BY_RESTART',
          errorMessage: '进程重启导致备份运行中断，计划将补一次',
        },
      );
      compensated += 1;
    }
    return compensated;
  }

  /**
   * 计划初始化（D-11 属 S3 落地）：对"有活跃同步授权或已有计划行"的公司补齐当前计划行。
   *
   * 口径（R075-01／R076-01）：
   * - **首次建立启用计划**：本设备对应公司数据区首次初始化即建立**启用**的自动备份计划，
   *   周期约 72 小时，首次到期时间＝初始化时刻＋约 72 小时；
   * - **无关闭固定自动备份入口**：需求明确「备份页显示周期及下次计划，无关闭固定自动备份入口」，
   *   因此本地自动计划默认启用（此前默认关闭，导致计划永不触发）；
   * - **云开关单独控制**：`autoUploadEnabled` 默认关闭，只控制"新的自动上云"，
   *   与本地自动备份计划的启停互不影响；
   * - **旧行兼容**：只给"没有当前计划行"的公司建行。已存在的行（含历史迁移留下的
   *   `backup_enabled=false` 行）**不强行回填**——没有证据证明旧行应当被改写，
   *   保持已接受的历史迁移事实；
   * - **并发初始化**：唯一键 `uk_local_company_setting_scope(installation_id, organization_id)`
   *   冲突时按"已建"处理，不中断整轮扫描。
   */
  private async initializeMissingPlans(now: Date): Promise<number> {
    const installation = await this.installationRepository.findOne({ where: { id: 1 } });
    if (!installation) {
      return 0;
    }
    const existingPlans = await this.settingRepository.find({
      where: { installationId: installation.installationId, isCurrent: true },
    });
    const covered = existingPlans.map((setting) => setting.organizationId);
    const authorized = await this.authorizationRepository.find({
      where: { authorizationStatus: 'ACTIVE' },
    });
    const organizationIds: number[] = [];
    for (const authorization of authorized) {
      // 用途维度（S4）：云备份只认**云备份用途**的凭据；
      // 业务同步授权**不得**被拿来决定备份范围（"不复用业务同步授权"）。
      // 用途不可核验（声明缺失／不可解析）→ 同样不算数（失败关闭，不静默复用）。
      if (
        !hasCredentialPurpose(authorization.signedClaims, LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP)
      ) {
        continue;
      }
      const organizationId = authorization.organizationId;
      if (
        organizationId !== null &&
        !covered.includes(organizationId) &&
        !organizationIds.includes(organizationId)
      ) {
        organizationIds.push(organizationId);
      }
    }
    let initialized = 0;
    for (const organizationId of organizationIds) {
      try {
        await this.settingRepository.save(
          this.settingRepository.create({
            installationId: installation.installationId,
            organizationId,
            settingSource: 'LOCAL_MANUAL',
            isCurrent: true,
            backupIntervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
            // 首次建立启用计划：约 72 小时后首次触发
            backupEnabled: true,
            nextBackupAt: new Date(now.getTime() + DEFAULT_BACKUP_INTERVAL_HOURS * 3_600_000),
            // 云自动上云默认关闭，单独控制（只影响新自动上云）
            autoUploadEnabled: false,
          }),
        );
        initialized += 1;
      } catch (error) {
        // 并发初始化：唯一键冲突说明另一轮已建行，按"已建"处理，不中断整轮
        if (this.isUniqueConstraintViolation(error)) {
          this.logger.info({ organizationId }, '本地备份计划已由并发轮次建立，跳过重复初始化');
          continue;
        }
        this.logger.error({ organizationId, err: error }, '本地备份计划初始化失败');
      }
    }
    return initialized;
  }

  /** 是否是数据库唯一键冲突（并发初始化） */
  private isUniqueConstraintViolation(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT' || code === '23505') {
      return true;
    }
    const driverCode = (error as { driverError?: { code?: string } } | null)?.driverError?.code;
    return driverCode === 'ER_DUP_ENTRY' || driverCode === '23505';
  }

  /**
   * 写入冻结闸门：该公司数据区是否可写（恢复期冻结 ⇒ 不可写）。
   *
   * 判定失败**按"不可写"处理**（失败关闭）：拿不到冻结事实时不冒险生成备份包。
   */
  private async isCompanyWritable(organizationId: number): Promise<boolean> {
    try {
      await this.localWriteHoldService.assertCompanyWritable({ organizationId });
      return true;
    } catch {
      return false;
    }
  }

  /** 执行一个到期计划：建运行→生成包→结束推进；skipped 表示同公司互斥跳过 */
  private async runDuePlan(
    plan: LocalCompanySettingEntity,
    now: Date,
  ): Promise<'succeeded' | 'failed' | 'skipped'> {
    const existing = await this.backupRunRepository.findOne({
      where: { organizationId: plan.organizationId, status: 'RUNNING' },
    });
    if (existing) {
      // 同公司已有 RUNNING（上一轮遗留未到补偿时限）：本轮跳过，不改计划
      return 'skipped';
    }
    // 恢复期写入冻结：该公司数据区正在恢复时**不生成备份包**（数据出盘）。
    // 判定放在**建运行之前**：否则会留下一条假的 RUNNING 运行行
    // （互斥会让该公司备份停滞到补偿时限，且该脏行会被打进下一个包）。
    if (!(await this.isCompanyWritable(plan.organizationId))) {
      return 'skipped';
    }
    let run: LocalBackupRunEntity;
    try {
      run = await this.backupRunRepository.save(
        this.backupRunRepository.create({
          installationId: plan.installationId,
          organizationId: plan.organizationId,
          triggerType: 'SCHEDULED',
          status: 'RUNNING',
          startedAt: now,
          finishedAt: null,
          manifestPath: null,
          manifestChecksum: null,
          byteSize: null,
          attachmentCount: null,
          schemaVersion: null,
          errorCode: null,
          errorMessage: null,
        }),
      );
    } catch (error) {
      return this.onRunRegistrationFailed(plan, error);
    }
    const targetPath = this.protectedBackupService.resolvePackageTargetPath(
      plan.organizationId,
      'SCHEDULED',
      now,
      run.id,
    );
    try {
      const result = await this.protectedBackupService.generateProtectedBackup({
        organizationId: plan.organizationId,
        runId: run.id,
        targetPath,
        now,
      });
      await this.backupRunRepository.update(
        { id: run.id },
        {
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          manifestPath: result.packagePath,
          manifestChecksum: result.manifestChecksum,
          byteSize: result.byteSize,
        },
      );
      await this.settingRepository.update(
        { id: plan.id },
        {
          nextBackupAt: this.nextBackupAt(plan, now),
          lastAutoSuccessAt: new Date(),
          failureReason: null,
        },
      );
      this.logger.info(
        { organizationId: plan.organizationId, backupId: result.backupId },
        '本地备份计划执行成功',
      );
      return 'succeeded';
    } catch (error) {
      // 原始异常（含本机绝对路径）只进服务端日志；落库只给受控原因码
      this.logger.error(
        { organizationId: plan.organizationId, err: error },
        '本地备份计划执行失败',
      );
      const reason = LOCAL_BACKUP_FAILURE_REASON.BACKUP_GENERATION_FAILED;
      await this.backupRunRepository.update(
        { id: run.id },
        {
          status: 'FAILED',
          finishedAt: new Date(),
          errorCode: 'BACKUP_GENERATION_FAILED',
          errorMessage: reason,
        },
      );
      await this.settingRepository.update(
        { id: plan.id },
        {
          // 失败不推进下次时间（R076-01「仅成功后 UPDATE 最近自动成功及下次时间」）：
          // 计划仍处于到期态，下一轮扫描（约 5 分钟）自动补一次。
          lastAutoFailureAt: new Date(),
          failureReason: reason,
        },
      );
      return 'failed';
    }
  }

  /**
   * 运行登记失败的处理（review M6）。
   *
   * - 唯一键冲突：唯一键 `uk_local_backup_run_active_company` 保证同公司同时只有一条
   *   RUNNING，说明另一轮已经接手该公司的备份 → 本轮跳过，不改计划、不记失败；
   * - 其它错误：登记失败不是"备份失败"→ 如实记为失败，不改计划行的成功时间。
   */
  private onRunRegistrationFailed(
    plan: LocalCompanySettingEntity,
    error: unknown,
  ): 'skipped' | 'failed' {
    if (this.isUniqueConstraintViolation(error)) {
      this.logger.info(
        { organizationId: plan.organizationId },
        '本地备份运行登记冲突（并发已接手），本轮跳过',
      );
      return 'skipped';
    }
    this.logger.error({ organizationId: plan.organizationId, err: error }, '本地备份运行登记失败');
    return 'failed';
  }

  /** 计划推进：当前时间＋间隔小时（间隔取计划行真实值） */
  private nextBackupAt(plan: LocalCompanySettingEntity, now: Date): Date {
    const intervalHours = Number(plan.backupIntervalHours) || 72;
    return new Date(now.getTime() + intervalHours * 3_600_000);
  }
}

// nodePath 在顶部统一引入
