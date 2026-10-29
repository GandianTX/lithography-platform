// src/modules/lithography/queries/local-runtime.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { ObjectLiteral, Repository } from 'typeorm';
import { LocalBackupRunEntity } from '../entities/local-backup-run.entity';
import { LocalInstallationEntity } from '../entities/local-installation.entity';
import { LocalUploadTaskEntity } from '../entities/local-upload-task.entity';
import {
  toLocalBackupRunSnapshot,
  toLocalInstallationSnapshot,
  toLocalUploadTaskSnapshot,
} from '../local-runtime.mapper';
import {
  LocalBackupRunSnapshot,
  LocalInstallationSnapshot,
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

  private pickRepository<T extends ObjectLiteral>(
    repository: Repository<T>,
    transactionContext?: PersistenceTransactionContext,
  ): Repository<T> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(repository.target) : repository;
  }
}
