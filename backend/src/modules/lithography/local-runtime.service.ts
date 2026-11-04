// src/modules/lithography/local-runtime.service.ts
// 本地运行数据写服务：安装设置更新、上传任务幂等登记与状态机写入、备份运行清单写入。
//
// 不包含：权限裁决、输入规范化、分页（归 usecase/query service）；
// 不接触云端地址/凭据（真实接收端接入前，只记录本地意图、尝试与回执）。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { FindOneOptions, ObjectLiteral, Repository } from 'typeorm';
import { LocalBackupRunEntity } from './entities/local-backup-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalUploadTaskEntity } from './entities/local-upload-task.entity';
import { isDuplicateKeyError } from './database-error.helpers';
import {
  toLocalBackupRunSnapshot,
  toLocalInstallationSnapshot,
  toLocalUploadTaskSnapshot,
} from './local-runtime.mapper';
import {
  LocalBackupRunFinishData,
  LocalBackupRunSnapshot,
  LocalBackupRunStartData,
  LocalInstallationSettingsWriteData,
  LocalInstallationSnapshot,
  LocalUploadFailureData,
  LocalUploadSuccessData,
  LocalUploadTaskInsertData,
  LocalUploadTaskSnapshot,
} from './local-runtime.types';

const INSTALLATION_SINGLETON_ID = 1;

@Injectable()
export class LocalRuntimeService {
  constructor(
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    @InjectRepository(LocalUploadTaskEntity)
    private readonly uploadTaskRepository: Repository<LocalUploadTaskEntity>,
    @InjectRepository(LocalBackupRunEntity)
    private readonly backupRunRepository: Repository<LocalBackupRunEntity>,
  ) {}

  /**
   * 锁定单行安装记录：设置更新必须先锁后合并，避免并发补丁各自基于旧值整体覆盖。
   * 单行缺失返回 null（由调用方按初始化异常失败关闭）。
   */
  async lockInstallation(
    transactionContext: PersistenceTransactionContext,
  ): Promise<LocalInstallationSnapshot | null> {
    const repository = this.getRepository(this.installationRepository, transactionContext);
    const entity = await repository.findOne({
      where: { id: INSTALLATION_SINGLETON_ID },
      lock: { mode: 'pessimistic_write' },
    });
    return entity ? toLocalInstallationSnapshot(entity) : null;
  }

  /** 更新单行安装设置；单行缺失视为初始化异常（失败关闭） */
  async updateInstallationSettings(
    data: LocalInstallationSettingsWriteData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.installationRepository, transactionContext);
    try {
      const result = await repository.update(
        { id: INSTALLATION_SINGLETON_ID },
        {
          localSiteName: data.localSiteName,
          autoUploadEnabled: data.autoUploadEnabled,
          backupIntervalDays: data.backupIntervalDays,
        },
      );
      if (!result.affected) {
        throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPDATE_FAILED,
        '本地设置更新失败',
        undefined,
        error,
      );
    }
  }

  /**
   * 幂等登记上传意图。
   *
   * 命中 `idempotency_key` 或 `(installation, entityType, entityLocalId, entityVersion)`
   * 唯一键时返回既有任务（created=false），保证重试不产生重复意图。
   *
   * 预检使用普通读：对不存在的唯一键做 `SELECT ... FOR UPDATE` 会在 REPEATABLE READ 下
   * 取得间隙锁，两个并发登记互相持有间隙后再插入即形成 1213 死锁。因此只在唯一键冲突后
   * 才用锁定读回读既有行（锁定读才能看到并发胜者刚提交的行）。
   */
  async enqueueUploadTask(
    data: LocalUploadTaskInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ task: LocalUploadTaskSnapshot; created: boolean }> {
    const repository = this.getRepository(this.uploadTaskRepository, transactionContext);
    const existing = await this.findUploadTaskByKey(repository, data);
    if (existing) {
      return { task: toLocalUploadTaskSnapshot(existing), created: false };
    }
    try {
      const saved = await repository.save(
        repository.create({
          installationId: data.installationId,
          entityType: data.entityType,
          entityLocalId: data.entityLocalId,
          entityVersion: data.entityVersion,
          idempotencyKey: data.idempotencyKey,
          status: 'PENDING',
          attemptCount: 0,
          lastAttemptAt: null,
          remoteId: null,
          remoteReceipt: null,
          errorCode: null,
          errorMessage: null,
        }),
      );
      return { task: toLocalUploadTaskSnapshot(saved), created: true };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const raced = await this.findUploadTaskByKey(repository, data, { lock: true });
        if (raced) {
          return { task: toLocalUploadTaskSnapshot(raced), created: false };
        }
      }
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPLOAD_TASK_FAILED,
        '上传任务登记失败',
        undefined,
        error,
      );
    }
  }

  /**
   * 开始一次上传尝试：仅 PENDING/FAILED 可重试，计数 +1 并清空上次错误。
   * 返回更新后的任务快照；不存在/状态冲突均为业务拒绝。
   */
  async startUploadAttempt(
    taskId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<LocalUploadTaskSnapshot> {
    const repository = this.getRepository(this.uploadTaskRepository, transactionContext);
    const task = await this.lockUploadTask(repository, taskId);
    if (task.status !== 'PENDING' && task.status !== 'FAILED') {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPLOAD_TASK_CONFLICT,
        '当前状态的上传任务不可开始',
        { taskId, status: task.status },
      );
    }
    try {
      await repository.update(
        { id: taskId },
        {
          status: 'UPLOADING',
          attemptCount: () => 'attempt_count + 1',
          lastAttemptAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      );
    } catch (error) {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPLOAD_TASK_FAILED,
        '上传任务状态写入失败',
        undefined,
        error,
      );
    }
    return toLocalUploadTaskSnapshot(await this.reloadUploadTask(repository, taskId));
  }

  /** 标记上传成功：仅 UPLOADING 可完成；回执只记录云端标识，不反写业务主键 */
  async completeUploadTask(
    taskId: number,
    data: LocalUploadSuccessData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<LocalUploadTaskSnapshot> {
    const repository = this.getRepository(this.uploadTaskRepository, transactionContext);
    const task = await this.lockUploadTask(repository, taskId);
    if (task.status !== 'UPLOADING') {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPLOAD_TASK_CONFLICT,
        '仅上传中的任务可以标记成功',
        { taskId, status: task.status },
      );
    }
    try {
      await repository.update(
        { id: taskId },
        {
          status: 'SUCCEEDED',
          remoteId: data.remoteId,
          remoteReceipt: data.remoteReceipt,
          errorCode: null,
          errorMessage: null,
        },
      );
    } catch (error) {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPLOAD_TASK_FAILED,
        '上传任务回执写入失败',
        undefined,
        error,
      );
    }
    return toLocalUploadTaskSnapshot(await this.reloadUploadTask(repository, taskId));
  }

  /** 标记上传失败：仅 UPLOADING/PENDING 可失败；错误码与说明必填且不得含凭据 */
  async failUploadTask(
    taskId: number,
    data: LocalUploadFailureData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<LocalUploadTaskSnapshot> {
    const repository = this.getRepository(this.uploadTaskRepository, transactionContext);
    const task = await this.lockUploadTask(repository, taskId);
    if (task.status !== 'UPLOADING' && task.status !== 'PENDING') {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPLOAD_TASK_CONFLICT,
        '当前状态的上传任务不可标记失败',
        { taskId, status: task.status },
      );
    }
    try {
      await repository.update(
        { id: taskId },
        {
          status: 'FAILED',
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
          lastAttemptAt: new Date(),
        },
      );
    } catch (error) {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.UPLOAD_TASK_FAILED,
        '上传任务失败状态写入失败',
        undefined,
        error,
      );
    }
    return toLocalUploadTaskSnapshot(await this.reloadUploadTask(repository, taskId));
  }

  /**
   * 开始备份运行：同一安装同时只允许一个 RUNNING（生成列唯一键兜底）。
   * 先锁读运行中清单给出业务冲突，再插入；并发插入冲突同样映射为已运行中。
   */
  async insertBackupRun(
    data: LocalBackupRunStartData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<LocalBackupRunSnapshot> {
    const repository = this.getRepository(this.backupRunRepository, transactionContext);
    const installation = await this.getRepository(
      this.installationRepository,
      transactionContext,
    ).findOne({ where: { installationId: data.installationId } });
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }
    const active = await repository.findOne({
      where: { installationId: data.installationId, status: 'RUNNING' },
      lock: { mode: 'pessimistic_write' },
    });
    if (active) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.BACKUP_ALREADY_RUNNING, '已有运行中的备份', {
        runId: active.id,
      });
    }
    try {
      const saved = await repository.save(
        repository.create({
          installationId: data.installationId,
          triggerType: data.triggerType,
          status: 'RUNNING',
          startedAt: data.startedAt,
          finishedAt: null,
          manifestPath: data.manifestPath,
          manifestChecksum: null,
          byteSize: null,
          attachmentCount: null,
          schemaVersion: null,
          errorCode: null,
          errorMessage: null,
        }),
      );
      return toLocalBackupRunSnapshot(saved);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new DomainError(LOCAL_RUNTIME_ERROR.BACKUP_ALREADY_RUNNING, '已有运行中的备份');
      }
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.BACKUP_FAILED,
        '备份运行登记失败',
        undefined,
        error,
      );
    }
  }

  /**
   * 结束备份运行：仅 RUNNING 可结束；成功时要求清单校验值，
   * 失败时要求错误码与说明。成功会刷新安装设置的最近成功备份时间。
   */
  async finishBackupRun(
    runId: number,
    data: LocalBackupRunFinishData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<LocalBackupRunSnapshot> {
    const repository = this.getRepository(this.backupRunRepository, transactionContext);
    const run = await repository.findOne({
      where: { id: runId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!run) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.BACKUP_RUN_NOT_FOUND, '备份运行不存在', {
        runId,
      });
    }
    if (run.status !== 'RUNNING') {
      throw new DomainError(LOCAL_RUNTIME_ERROR.BACKUP_STATE_CONFLICT, '仅运行中的备份可以结束', {
        runId,
        status: run.status,
      });
    }
    try {
      await repository.update(
        { id: runId },
        {
          status: data.status,
          finishedAt: data.finishedAt,
          // 未显式提供清单路径时保留开始时的值，避免失败/中断把路径清空
          ...(data.manifestPath === undefined ? {} : { manifestPath: data.manifestPath }),
          manifestChecksum: data.manifestChecksum,
          byteSize: data.byteSize,
          attachmentCount: data.attachmentCount,
          schemaVersion: data.schemaVersion,
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
        },
      );
      if (data.status === 'SUCCEEDED') {
        await this.getRepository(this.installationRepository, transactionContext).update(
          { installationId: run.installationId },
          { lastBackupCompletedAt: data.finishedAt },
        );
      }
    } catch (error) {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.BACKUP_FAILED,
        '备份运行结束写入失败',
        undefined,
        error,
      );
    }
    return toLocalBackupRunSnapshot(await this.reloadBackupRun(repository, runId));
  }

  /** 按幂等键或实体版本键查找既有任务；`lock` 为真时使用锁定读（仅冲突回读场景） */
  private async findUploadTaskByKey(
    repository: Repository<LocalUploadTaskEntity>,
    data: LocalUploadTaskInsertData,
    options: { lock: boolean } = { lock: false },
  ): Promise<LocalUploadTaskEntity | null> {
    const lockOptions: FindOneOptions<LocalUploadTaskEntity> = options.lock
      ? { lock: { mode: 'pessimistic_write' } }
      : {};
    const byIdempotency = await repository.findOne({
      where: { idempotencyKey: data.idempotencyKey },
      ...lockOptions,
    });
    if (byIdempotency) return byIdempotency;
    return repository.findOne({
      where: {
        installationId: data.installationId,
        entityType: data.entityType,
        entityLocalId: data.entityLocalId,
        entityVersion: data.entityVersion,
      },
      ...lockOptions,
    });
  }

  private async lockUploadTask(
    repository: Repository<LocalUploadTaskEntity>,
    taskId: number,
  ): Promise<LocalUploadTaskEntity> {
    const task = await repository.findOne({
      where: { id: taskId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!task) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.UPLOAD_TASK_NOT_FOUND, '上传任务不存在', {
        taskId,
      });
    }
    return task;
  }

  private async reloadUploadTask(
    repository: Repository<LocalUploadTaskEntity>,
    taskId: number,
  ): Promise<LocalUploadTaskEntity> {
    const task = await repository.findOne({ where: { id: taskId } });
    if (!task) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.UPLOAD_TASK_NOT_FOUND, '上传任务不存在', {
        taskId,
      });
    }
    return task;
  }

  private async reloadBackupRun(
    repository: Repository<LocalBackupRunEntity>,
    runId: number,
  ): Promise<LocalBackupRunEntity> {
    const run = await repository.findOne({ where: { id: runId } });
    if (!run) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.BACKUP_RUN_NOT_FOUND, '备份运行不存在', {
        runId,
      });
    }
    return run;
  }

  private getRepository<T extends ObjectLiteral>(
    repository: Repository<T>,
    transactionContext: PersistenceTransactionContext,
  ): Repository<T> {
    const manager = getTypeOrmEntityManager(transactionContext);
    return manager.getRepository(repository.target);
  }
}
