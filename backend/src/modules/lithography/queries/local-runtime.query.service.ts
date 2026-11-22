// src/modules/lithography/queries/local-runtime.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { resolveCredentialPurposes } from '@core/local-runtime/policy/local-credential-purpose.policy';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, ObjectLiteral, Repository } from 'typeorm';
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

  /**
   * 列出业务同步任务（按状态过滤，按创建顺序取前若干条）。
   *
   * 只列 `task_kind = 'BUSINESS_SYNC'`：备份上云任务（BACKUP_UPLOAD）与历史遗留
   * 用途不明的行（NULL）都不参与业务同步派发。
   */
  async listBusinessSyncTasks(
    installationId: string,
    statuses: readonly LocalUploadTaskStatus[],
    limit: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalUploadTaskSnapshot[]> {
    const repository = this.pickRepository(this.uploadTaskRepository, transactionContext);
    const rows = await repository.find({
      where: { installationId, taskKind: 'BUSINESS_SYNC', status: In([...statuses]) },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: limit,
    });
    return rows.map(toLocalUploadTaskSnapshot);
  }

  /** 按稳定键列出业务同步任务（用于核对某条来源记录的待办与历史） */
  async listBusinessSyncTasksByRecordUuid(
    installationId: string,
    recordUuid: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalUploadTaskSnapshot[]> {
    const repository = this.pickRepository(this.uploadTaskRepository, transactionContext);
    const rows = await repository.find({
      where: { installationId, recordUuid, taskKind: 'BUSINESS_SYNC' },
      order: { id: 'DESC' },
    });
    return rows.map(toLocalUploadTaskSnapshot);
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
      select: {
        organizationId: true,
        authorizationStatus: true,
        lastVerifiedAt: true,
        signedClaims: true,
      },
      order: { organizationId: 'ASC' },
    });

    const byOrganization = new Map<number, LocalAuthorizationSummary>();
    for (const row of rows) {
      const summary = byOrganization.get(row.organizationId) ?? {
        organizationId: row.organizationId,
        activeCount: 0,
        revokedCount: 0,
        lastVerifiedAt: null,
        // 用途维度（S4）：按**实际授权声明**汇总，不再对外谎报单一用途
        credentialPurposes: [] as string[],
      };
      if (row.authorizationStatus === 'ACTIVE') {
        summary.activeCount += 1;
        const verdict = resolveCredentialPurposes(
          typeof row.signedClaims === 'string' ? row.signedClaims : null,
        );
        for (const purpose of verdict.purposes) {
          if (!summary.credentialPurposes.includes(purpose)) {
            summary.credentialPurposes.push(purpose);
          }
        }
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
  /**
   * 任务计数摘要。
   *
   * `organizationId` 缺省＝**全设备口径**（一级管理员全局范围）；
   * 给定公司时＝**本公司口径**：上传任务与备份运行都按 `organization_id` 过滤。
   *
   * 归属列已由增量迁移 `1775503000000` 落到 `local_upload_task` 与 `local_backup_run`
   * （历史行保持 NULL）——历史行**不计入任何公司**（归属未知不猜），
   * 因此公司口径的计数只会偏少，不会把别家公司的数字暴露出去。
   */
  async readTaskStatusSummary(
    installationId: string,
    options: { organizationId?: number | null } = {},
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalTaskStatusSummary> {
    const uploadRepository = this.pickRepository(this.uploadTaskRepository, transactionContext);
    const backupRepository = this.pickRepository(this.backupRunRepository, transactionContext);
    const scopedOrganizationId = options.organizationId ?? null;
    const uploadWhere = (status: LocalUploadTaskStatus): Record<string, unknown> =>
      scopedOrganizationId === null
        ? { installationId, status }
        : { installationId, status, organizationId: scopedOrganizationId };
    const backupWhere =
      scopedOrganizationId === null
        ? { installationId }
        : { installationId, organizationId: scopedOrganizationId };
    const countUpload = (status: LocalUploadTaskStatus): Promise<number> =>
      uploadRepository.count({ where: uploadWhere(status) });

    const [pending, uploading, failed, succeeded, runningBackupCount, latestBackup] =
      await Promise.all([
        countUpload('PENDING'),
        countUpload('UPLOADING'),
        countUpload('FAILED'),
        countUpload('SUCCEEDED'),
        backupRepository.count({ where: { ...backupWhere, status: 'RUNNING' } }),
        backupRepository.findOne({
          where: backupWhere,
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
