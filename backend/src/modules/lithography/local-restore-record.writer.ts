// src/modules/lithography/local-restore-record.writer.ts

/**
 * 恢复执行的**业务数据受控写入实现**（任务 09 S2-2／S2-4）。
 *
 * 归属：本机备份/恢复域（业务表由 lithography 模块拥有）。恢复编排
 * （`LocalRestoreExecutionService`）只按端口令牌调用本实现，**不直接写业务表**
 * ——与记录包导入同一条纪律。
 *
 * 语义（**替换**而非合并）：
 * - 目标公司数据区在本次恢复中被**整体替换**为备份载荷的内容；
 * - 清空按**逆外键顺序**（先子后父），写回按**正外键顺序**（先父后子），
 *   否则真实外键约束会在写回途中失败，留下"写了一半"的库；
 * - 全部清空＋写回在**同一事务**内完成：任一表失败即整体回滚，
 *   不会出现"部分表已替换、部分表还是旧值"的自相矛盾状态；
 * - 载荷缺少某张表的**子表**时**失败关闭**（替换父表会让子表外键悬空）。
 *
 * 原件字节不在本层：业务表恢复后由恢复编排按包内 `files/` 与清单校验值
 * 还原字节（见 `LocalRestoreExecutionService`）。
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Repository, type ObjectLiteral } from 'typeorm';

import {
  BACKUP_RESTORE_TABLE_ORDER,
  BACKUP_TABLE_DESCRIPTORS,
  type BackupScopeTable,
} from '@core/local-runtime/policy/protected-backup.policy';

import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@usecases/common/ports/stored-file-storage.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@usecases/common/ports/transaction-runner.contract';
import type {
  LocalRestoreRecordTable,
  LocalRestoreRecordWriteOutcome,
  LocalRestoreRecordWriteRequest,
  LocalRestoreRecordWriter,
} from '@usecases/common/ports/local-restore-record-writer.contract';

import { LocalUploadTaskEntity } from './entities/local-upload-task.entity';
import { MaintenanceReportAlarmEntity } from './entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import { MaintenanceReportFaultEntity } from './entities/maintenance-report-fault.entity';
import { MaintenanceReportStepEntity } from './entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from './entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { ReferenceDocumentRevisionEntity } from './entities/reference-document-revision.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestRevisionEntity } from './entities/repair-request-revision.entity';
import { StoredFileEntity } from './entities/stored-file.entity';

/** 可恢复表（按外键顺序；运行事实表不进恢复范围） */
const RESTORE_TABLES: readonly LocalRestoreRecordTable[] = BACKUP_RESTORE_TABLE_ORDER.filter(
  (table): table is LocalRestoreRecordTable => table !== 'local_backup_run',
);

@Injectable()
export class LocalRestoreRecordWriterService implements LocalRestoreRecordWriter {
  readonly supportedTables: readonly LocalRestoreRecordTable[] = RESTORE_TABLES;

  constructor(
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(RepairRequestRevisionEntity)
    private readonly repairRequestRevisionRepository: Repository<RepairRequestRevisionEntity>,
    @InjectRepository(MaintenanceReportEntity)
    private readonly maintenanceReportRepository: Repository<MaintenanceReportEntity>,
    @InjectRepository(MaintenanceReportVersionEntity)
    private readonly reportVersionRepository: Repository<MaintenanceReportVersionEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly reportAttachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
    @InjectRepository(MaintenanceReportVersionAttachmentEntity)
    private readonly reportVersionAttachmentRepository: Repository<MaintenanceReportVersionAttachmentEntity>,
    @InjectRepository(MaintenanceReportAlarmEntity)
    private readonly reportAlarmRepository: Repository<MaintenanceReportAlarmEntity>,
    @InjectRepository(MaintenanceReportStepEntity)
    private readonly reportStepRepository: Repository<MaintenanceReportStepEntity>,
    @InjectRepository(MaintenanceReportFaultEntity)
    private readonly reportFaultRepository: Repository<MaintenanceReportFaultEntity>,
    @InjectRepository(ReferenceDocumentEntity)
    private readonly referenceDocumentRepository: Repository<ReferenceDocumentEntity>,
    @InjectRepository(ReferenceDocumentRevisionEntity)
    private readonly documentRevisionRepository: Repository<ReferenceDocumentRevisionEntity>,
    @InjectRepository(StoredFileEntity)
    private readonly storedFileRepository: Repository<StoredFileEntity>,
    @InjectRepository(LocalUploadTaskEntity)
    private readonly uploadTaskRepository: Repository<LocalUploadTaskEntity>,
    @Inject(STORED_FILE_STORAGE)
    private readonly fileStorage: StoredFileStorage,
    // 事务边界端口是**全局**提供的；离线装配（无全局根模块）下可能缺席，
    // 此时本实现**失败关闭**（不写任何业务行），而不是无事务硬写。
    @Optional()
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner | null,
  ) {}

  /**
   * 还原原件字节（任务 09 S2-3）。
   *
   * - 只按包内**相对路径**读文件，路径逃逸即拒绝；
   * - 逐个核对字节数与 SHA-256，不符即该原件失败（不写入半截字节）；
   * - 本机已有同引用且可读、字节一致时不重复写入；
   * - 写回后把业务行上的存储引用指向新字节（登记事实与字节保持一致）。
   */
  async restoreOriginals(input: {
    organizationId: number;
    restoreId: string;
    packageRoot: string;
    originals: readonly {
      source: string;
      storage_reference: string;
      sha256: string | null;
    }[];
    files: readonly { relative_path: string; sha256: string; byte_size: number }[];
  }): Promise<{ restored: number; failed: number; reason: string | null }> {
    const fileFacts = new Map(input.files.map((file) => [file.relative_path, file]));
    let restored = 0;
    let failed = 0;
    for (const original of input.originals) {
      try {
        const relativePath = `files/${original.storage_reference}`;
        const fact = fileFacts.get(relativePath);
        if (fact === undefined) {
          failed += 1;
          continue;
        }
        const absolutePath = nodePath.resolve(input.packageRoot, relativePath);
        const root = nodePath.resolve(input.packageRoot);
        if (!absolutePath.startsWith(root + nodePath.sep) || !existsSync(absolutePath)) {
          failed += 1;
          continue;
        }
        const bytes = readFileSync(absolutePath);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (bytes.byteLength !== fact.byte_size || digest !== fact.sha256.toLowerCase()) {
          failed += 1;
          continue;
        }
        const storageReference = await this.writeOriginalBytes(
          original.storage_reference,
          bytes,
          digest,
        );
        if (storageReference === null) {
          failed += 1;
          continue;
        }
        const updated = await this.bindOriginalToRow(
          original.source,
          storageReference,
          digest,
          bytes.byteLength,
        );
        if (!updated) {
          failed += 1;
          continue;
        }
        restored += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      restored,
      failed,
      reason: failed === 0 ? null : `有 ${failed} 份原件未能按包内清单还原`,
    };
  }

  /**
   * 写入原件字节。
   *
   * 本机同引用**且字节与包内清单一致**时直接复用（避免留下孤儿副本）；
   * 本机同引用但字节**不一致**（备份后被替换／截断）时**必须按包内字节重写**——
   * 否则会把"登记摘要＝备份摘要、实际字节＝本机旧字节"的错配写进业务行，
   * 后续完整性核对必然失败。
   */
  private async writeOriginalBytes(
    originalReference: string,
    bytes: Buffer,
    expectedSha256: string,
  ): Promise<string | null> {
    try {
      const identical = await this.fileStorage.verifyIntegrity(
        originalReference,
        expectedSha256,
        bytes.byteLength,
      );
      if (identical) {
        return originalReference;
      }
    } catch {
      // 本机已无该引用（或不可读）：按包内字节重新写入
    }
    const extension = nodePath.extname(originalReference).slice(0, 20);
    try {
      return await this.fileStorage.save(bytes, extension);
    } catch {
      return null;
    }
  }

  /** 把新写入的字节绑定回业务行（存储引用、校验值、字节数） */
  private async bindOriginalToRow(
    source: string,
    storageReference: string,
    sha256: string,
    byteSize: number,
  ): Promise<boolean> {
    void sha256;
    void byteSize;
    const [kind, identifier] = source.split(':');
    const id = Number(identifier);
    if (kind === 'stored_file' && identifier !== undefined && identifier !== '') {
      const result = await this.storedFileRepository.update(
        { fileId: identifier },
        { storageReference, checksumSha256: sha256, byteSize: String(byteSize) },
      );
      return (result.affected ?? 0) > 0;
    }
    if (kind === 'reference_document' && Number.isInteger(id) && id > 0) {
      // 资料行只登记存储引用（无独立校验值／字节数列），按引用更新
      const result = await this.referenceDocumentRepository.update({ id }, { storageReference });
      return (result.affected ?? 0) > 0;
    }
    if (kind === 'maintenance_report_attachment' && Number.isInteger(id) && id > 0) {
      // 报告附件**自带**存储引用与校验值：必须一并指向还原后的字节，
      // 否则附件仍指向备份前（可能已被清理）的旧引用。
      const result = await this.reportAttachmentRepository.update(
        { id },
        { storageReference, checksumSha256: sha256, byteSize },
      );
      return (result.affected ?? 0) > 0;
    }
    return false;
  }

  async write(request: LocalRestoreRecordWriteRequest): Promise<LocalRestoreRecordWriteOutcome> {
    const consistency = this.checkScopeConsistency(request);
    if (consistency !== null) {
      return { status: 'FAILED', written: 0, counts: {}, reason: consistency };
    }

    if (this.transactionRunner === null) {
      return {
        status: 'FAILED',
        written: 0,
        counts: {},
        reason: '事务边界不可用，不能在无事务条件下恢复业务数据',
      };
    }

    try {
      return await this.transactionRunner.run(async () => {
        const counts: Record<string, number> = {};
        // ① 清空：逆外键顺序（先子后父），只清载荷里出现的表
        const payloadTables = request.tables.map((entry) => entry.table);
        for (const table of [...RESTORE_TABLES].reverse()) {
          if (!payloadTables.includes(table)) {
            continue;
          }
          await this.clearCompanyScope(table, request.organizationId);
        }
        // ② 写回：正外键顺序（先父后子）
        let written = 0;
        for (const table of RESTORE_TABLES) {
          const entry = request.tables.find((candidate) => candidate.table === table);
          if (entry === undefined) {
            continue;
          }
          const count = await this.insertRows(table, entry.rows);
          counts[table] = count;
          written += count;
        }
        return { status: 'WRITTEN', written, counts, reason: null };
      });
    } catch (error) {
      return {
        status: 'FAILED',
        written: 0,
        counts: {},
        reason: error instanceof Error ? error.message : '业务数据恢复写入失败',
      };
    }
  }

  async count(input: { organizationId: number; table: LocalRestoreRecordTable }): Promise<number> {
    const repository = this.repositoryForTable(input.table);
    if (repository === null) {
      return 0;
    }
    const queryBuilder = repository.createQueryBuilder('t');
    this.applyScopeFilter(queryBuilder, input.table, input.organizationId);
    return queryBuilder.getCount();
  }

  /**
   * 载荷范围一致性检查（失败关闭）。
   *
   * - 载荷出现范围外的表 ⇒ 拒绝（不接受"多出来的"业务行）；
   * - 载荷缺少某张表的**子表** ⇒ 拒绝（清空父表会让子表外键悬空，
   *   写回后数据库不自洽）。
   */
  private checkScopeConsistency(request: LocalRestoreRecordWriteRequest): string | null {
    const payloadTables = new Set(request.tables.map((entry) => entry.table));
    for (const table of payloadTables) {
      if (!this.supportedTables.includes(table)) {
        return `备份载荷包含本机不支持恢复的业务表（${table}），该次恢复已拒绝`;
      }
    }
    for (const table of this.supportedTables) {
      if (!payloadTables.has(table)) {
        continue;
      }
      const children = this.supportedTables.filter(
        (candidate) => BACKUP_TABLE_DESCRIPTORS[candidate].parentTable === table,
      );
      const missingChild = children.find((child) => !payloadTables.has(child));
      if (missingChild !== undefined) {
        return (
          `备份载荷缺少子表数据（${missingChild}），无法安全替换父表（${table}）：` +
          '该备份包未包含报告版本等业务历史数据，恢复会丢失这些事实，请重新生成备份后再恢复'
        );
      }
    }
    return null;
  }

  /** 清空本公司在该表的全部行（按逐表口径圈定范围） */
  private async clearCompanyScope(
    table: LocalRestoreRecordTable,
    organizationId: number,
  ): Promise<void> {
    const repository = this.repositoryForTable(table);
    if (repository === null) {
      return;
    }
    const queryBuilder = repository.createQueryBuilder('t');
    this.applyScopeFilter(queryBuilder, table, organizationId);
    await queryBuilder.delete().execute();
  }

  /** 写回一表的全行（主键按备份原值保留，恢复后业务身份不漂移） */
  private async insertRows(
    table: LocalRestoreRecordTable,
    rows: readonly Record<string, unknown>[],
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const repository = this.repositoryForTable(table);
    if (repository === null) {
      throw new Error(`恢复写入缺少仓储：${table}`);
    }
    const entities = rows.map((row) => repository.create(row as ObjectLiteral));
    await repository.insert(entities);
    return entities.length;
  }

  /** 按逐表口径圈定本公司数据区（根表按公司列，子表按父表公司归属） */
  private applyScopeFilter(
    queryBuilder: ReturnType<Repository<ObjectLiteral>['createQueryBuilder']>,
    table: BackupScopeTable,
    organizationId: number,
  ): void {
    const descriptor = BACKUP_TABLE_DESCRIPTORS[table];
    if (descriptor.scope === 'ALL_DEVICE') {
      return;
    }
    if (descriptor.scope === 'OWNER_ORGANIZATION') {
      queryBuilder.where('t.owner_organization_id = :organizationId', { organizationId });
      return;
    }
    const parentTable = descriptor.parentTable;
    const parentColumn = descriptor.parentColumn;
    if (parentTable === undefined || parentColumn === undefined) {
      throw new Error(`恢复范围口径缺少父表定义：${table}`);
    }
    queryBuilder.where(
      `t.${parentColumn} IN (SELECT p.id FROM ${parentTable} p WHERE p.owner_organization_id = :organizationId)`,
      { organizationId },
    );
  }

  private repositoryForTable(table: string): Repository<ObjectLiteral> | null {
    switch (table) {
      case 'repair_request':
        return this.repairRequestRepository;
      case 'repair_request_revision':
        return this.repairRequestRevisionRepository;
      case 'maintenance_report':
        return this.maintenanceReportRepository;
      case 'maintenance_report_version':
        return this.reportVersionRepository;
      case 'maintenance_report_attachment':
        return this.reportAttachmentRepository;
      case 'maintenance_report_version_attachment':
        return this.reportVersionAttachmentRepository;
      case 'maintenance_report_alarm':
        return this.reportAlarmRepository;
      case 'maintenance_report_step':
        return this.reportStepRepository;
      case 'maintenance_report_fault':
        return this.reportFaultRepository;
      case 'reference_document':
        return this.referenceDocumentRepository;
      case 'reference_document_revision':
        return this.documentRevisionRepository;
      case 'stored_file':
        return this.storedFileRepository;
      case 'local_upload_task':
        return this.uploadTaskRepository;
      default:
        return null;
    }
  }
}
