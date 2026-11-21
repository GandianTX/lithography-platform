// src/modules/lithography/queries/local-runtime.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { ObjectLiteral, Repository } from 'typeorm';
import { LocalAccountAuthorizationEntity } from '../entities/local-account-authorization.entity';
import { LocalBackupRunEntity } from '../entities/local-backup-run.entity';
import { LocalInstallationEntity } from '../entities/local-installation.entity';
import { LocalUploadTaskEntity } from '../entities/local-upload-task.entity';
import {
  toLocalBackupRunSnapshot,
  toLocalInstallationSnapshot,
  toLocalUploadTaskSnapshot,
} from '../local-runtime.mapper';
import {
  LocalAuthorizationSummary,
  LocalBackupRunSnapshot,
  LocalInstallationSnapshot,
  LocalTaskStatusSummary,
  LocalUploadTaskSnapshot,
  LocalUploadTaskStatus,
} from '../local-runtime.types';

export type LocalRuntimeListPagination = {
  page: number;
  pageSize: number;
  withTotal?: boolean;
};

export type LocalRuntimeListPage<T> = {
  items: T[];
  total?: number;
  page: number;
  pageSize: number;
};

/** 本地运行数据只读服务：安装身份/设置、上传任务清单、备份运行清单。 */
@Injectable()
export class LocalRuntimeQueryService {
  constructor(
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    @InjectRepository(LocalUploadTaskEntity)
    private readonly uploadTaskRepository: Repository<LocalUploadTaskEntity>,
    @InjectRepository(LocalBackupRunEntity)
    private readonly backupRunRepository: Repository<LocalBackupRunEntity>,
    @InjectRepository(LocalAccountAuthorizationEntity)
    private readonly authorizationRepository: Repository<LocalAccountAuthorizationEntity>,
  ) {}

  async readInstallation(
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalInstallationSnapshot | null> {
    const entity = await this.pickRepository(
      this.installationRepository,
      transactionContext,
    ).findOne({ where: { id: 1 } });
    return entity ? toLocalInstallationSnapshot(entity) : null;
  }

  async readUploadTask(
    taskId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalUploadTaskSnapshot | null> {
    const entity = await this.pickRepository(this.uploadTaskRepository, transactionContext).findOne(
      {
        where: { id: taskId },
      },
    );
    return entity ? toLocalUploadTaskSnapshot(entity) : null;
  }

  async listUploadTasks(
    pagination: LocalRuntimeListPagination,
    filters: { status?: LocalUploadTaskStatus } = {},
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalRuntimeListPage<LocalUploadTaskSnapshot>> {
    const repository = this.pickRepository(this.uploadTaskRepository, transactionContext);
    const where = filters.status ? { status: filters.status } : {};
    const [rows, total] = await Promise.all([
      repository.find({
        where,
        order: { createdAt: 'ASC', id: 'ASC' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      pagination.withTotal ? repository.count({ where }) : Promise.resolve(undefined),
    ]);
    return {
      items: rows.map(toLocalUploadTaskSnapshot),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    };
  }

  async readActiveBackupRun(
    installationId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalBackupRunSnapshot | null> {
    const entity = await this.pickRepository(this.backupRunRepository, transactionContext).findOne({
      where: { installationId, status: 'RUNNING' },
    });
    return entity ? toLocalBackupRunSnapshot(entity) : null;
  }

  async readBackupRun(
    runId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalBackupRunSnapshot | null> {
    const entity = await this.pickRepository(this.backupRunRepository, transactionContext).findOne({
      where: { id: runId },
    });
    return entity ? toLocalBackupRunSnapshot(entity) : null;
  }

  async listBackupRuns(
    pagination: LocalRuntimeListPagination,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalRuntimeListPage<LocalBackupRunSnapshot>> {
    const repository = this.pickRepository(this.backupRunRepository, transactionContext);
    const [rows, total] = await Promise.all([
      repository.find({
        order: { startedAt: 'DESC', id: 'DESC' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      pagination.withTotal ? repository.count() : Promise.resolve(undefined),
    ]);
    return {
      items: rows.map(toLocalBackupRunSnapshot),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    };
  }

  /**
   * 本机授权事实汇总（按公司聚合，只返回计数与最近校验时间）。
   *
   * - 只选 `organizationId / authorizationStatus / lastVerifiedAt` 三列：
   *   `signedClaims` 等凭据材料不进入查询计划，从物理上不可能被读模型带出；
   * - 范围口径与其它本地读模型一致：`organizationId === null` 表示一级管理员的
   *   全局授权范围，返回本设备全部公司；
   * - 行数上限是本机账号数 × 公司数，直接取行后在内存聚合，避免为一次只读
   *   页面引入 raw SQL 的列名耦合。
   */
  async readAuthorizationSummary(
    installationId: string,
    organizationId: number | null,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalAuthorizationSummary[]> {
    const rows = await this.pickRepository(this.authorizationRepository, transactionContext).find({
      where: organizationId === null ? { installationId } : { installationId, organizationId },
      select: { organizationId: true, authorizationStatus: true, lastVerifiedAt: true },
      order: { organizationId: 'ASC' },
    });

    const byOrganization = new Map<number, LocalAuthorizationSummary>();
    for (const row of rows) {
      const summary = byOrganization.get(row.organizationId) ?? {
        organizationId: row.organizationId,
        activeCount: 0,
        revokedCount: 0,
        lastVerifiedAt: null,
      };
      if (row.authorizationStatus === 'ACTIVE') {
        summary.activeCount += 1;
      } else if (row.authorizationStatus === 'REVOKED') {
        summary.revokedCount += 1;
      }
      if (
        row.lastVerifiedAt !== null &&
        (summary.lastVerifiedAt === null || row.lastVerifiedAt > summary.lastVerifiedAt)
      ) {
        summary.lastVerifiedAt = row.lastVerifiedAt;
      }
      byOrganization.set(row.organizationId, summary);
    }

    return [...byOrganization.values()].sort(
      (left, right) => left.organizationId - right.organizationId,
    );
  }

  /**
   * 本机后台任务状态汇总。
   *
   * 只做同安装标识的计数与最近一次备份时间读取，不触碰任何公司业务正文；
   * 供本地设置页展示"业务与队列已落库"的真实事实（S1.3 重启恢复的同一读数口径）。
   */
  async readTaskStatusSummary(
    installationId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalTaskStatusSummary> {
    const uploadRepository = this.pickRepository(this.uploadTaskRepository, transactionContext);
    const backupRepository = this.pickRepository(this.backupRunRepository, transactionContext);
    const countUpload = (status: LocalUploadTaskStatus): Promise<number> =>
      uploadRepository.count({ where: { installationId, status } });

    const [pending, uploading, failed, succeeded, runningBackupCount, latestBackup] =
      await Promise.all([
        countUpload('PENDING'),
        countUpload('UPLOADING'),
        countUpload('FAILED'),
        countUpload('SUCCEEDED'),
        backupRepository.count({ where: { installationId, status: 'RUNNING' } }),
        backupRepository.findOne({
          where: { installationId },
          order: { startedAt: 'DESC', id: 'DESC' },
        }),
      ]);

    return {
      pendingUploadCount: pending,
      uploadingUploadCount: uploading,
      failedUploadCount: failed,
      succeededUploadCount: succeeded,
      runningBackupCount,
      lastBackupStartedAt: latestBackup?.startedAt ?? null,
      lastBackupFinishedAt: latestBackup?.finishedAt ?? null,
    };
  }

  private pickRepository<T extends ObjectLiteral>(
    repository: Repository<T>,
    transactionContext?: PersistenceTransactionContext,
  ): Repository<T> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(repository.target) : repository;
  }
}
