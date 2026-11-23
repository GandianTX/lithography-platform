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
import { PinoLogger } from 'nestjs-pino';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Repository, type ObjectLiteral } from 'typeorm';

import { LOCAL_BACKUP_FAILURE_REASON } from '@core/local-runtime/policy/local-backup-failure-reason';
import {
  BACKUP_RESTORE_TABLE_ORDER,
  BACKUP_TABLE_DESCRIPTORS,
  buildOrganizationScopePredicate,
  type BackupScopeTable,
  type BackupTableSuppression,
} from '@core/local-runtime/policy/protected-backup.policy';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
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

import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageAnalysisEntity } from './entities/ai-message-analysis.entity';
import { AiMessageEntity } from './entities/ai-message.entity';
import { AiReportEntity } from './entities/ai-report.entity';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { IntakeAnalysisAttemptEntity } from './entities/intake-analysis-attempt.entity';
import { LocalUploadTaskEntity } from './entities/local-upload-task.entity';
import { MaintenanceReportAlarmEntity } from './entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import { MaintenanceReportFaultEntity } from './entities/maintenance-report-fault.entity';
import { MaintenanceReportReviewEntity } from './entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from './entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from './entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { ReferenceDocumentCaseDetailEntity } from './entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { ReferenceDocumentRevisionEntity } from './entities/reference-document-revision.entity';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairRequestDiagnosticStepEntity } from './entities/repair-request-diagnostic-step.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestFaultPanelEntity } from './entities/repair-request-fault-panel.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from './entities/repair-request-revision.entity';
import { StoredFileEntity } from './entities/stored-file.entity';

/** 可恢复表（按外键顺序；本机运行事实表 `local_backup_run` 不进恢复范围） */
const RESTORE_TABLES: readonly LocalRestoreRecordTable[] = BACKUP_RESTORE_TABLE_ORDER;

/**
 * 需要**延后回填**外键的表（任务 09 新计划第 03 项）。
 *
 * `repair_request.intake_id → repair_request_intake.id` 与
 * `repair_request_intake.converted_request_id → repair_request.id` 构成**双向**外键，
 * 单趟插入无法同时满足 ⇒ 先写 intake（`convertedRequestId` 置空），
 * 再写工单，最后按 intake 主键回填 `convertedRequestId`。
 *
 * 注意：载荷里的行是**实体实例**（备份侧由 `getMany()` 产出），
 * 属性名是**驼峰**（`convertedRequestId`），不是数据库列名。
 */
const DEFERRED_FOREIGN_KEY_TABLE = 'repair_request_intake';
const DEFERRED_FOREIGN_KEY_COLUMN = 'convertedRequestId';

/**
 * 抑制事实（删除／下架）的一行快照。
 *
 * 存**整行实体**（不是几个列）：删除事实是复合事实，
 * 只还原部分列会撞库级 CHECK（见 core 的 `BackupTableSuppression` 注释）。
 */
type SuppressionFact = {
  table: LocalRestoreRecordTable;
  entity: Record<string, unknown>;
};

/** 该行当前是否"已被抑制"（删除／下架） */
function isSuppressed(row: Record<string, unknown>, suppression: BackupTableSuppression): boolean {
  return suppression.indicators.some((indicator) => {
    const value = row[indicator.column];
    if (indicator.notNull === true) {
      return value !== null && value !== undefined;
    }
    if (indicator.notZero === true) {
      return value !== null && value !== undefined && Number(value) !== 0;
    }
    if (indicator.equals !== undefined) {
      return value === indicator.equals;
    }
    return false;
  });
}

@Injectable()
export class LocalRestoreRecordWriterService implements LocalRestoreRecordWriter {
  readonly supportedTables: readonly LocalRestoreRecordTable[] = RESTORE_TABLES;

  /** 表名 → 注入仓储（构造期建立；缺失的表一律失败关闭，不静默跳过） */
  private readonly repositoryByTable: Record<string, Repository<ObjectLiteral>>;

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
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly repairRequestIntakeRepository: Repository<RepairRequestIntakeEntity>,
    @InjectRepository(IntakeAnalysisAttemptEntity)
    private readonly intakeAnalysisAttemptRepository: Repository<IntakeAnalysisAttemptEntity>,
    @InjectRepository(RepairProcessEntryEntity)
    private readonly repairProcessEntryRepository: Repository<RepairProcessEntryEntity>,
    @InjectRepository(RepairRequestDiagnosticStepEntity)
    private readonly repairRequestDiagnosticStepRepository: Repository<RepairRequestDiagnosticStepEntity>,
    @InjectRepository(RepairRequestFaultPanelEntity)
    private readonly repairRequestFaultPanelRepository: Repository<RepairRequestFaultPanelEntity>,
    @InjectRepository(MaintenanceReportReviewEntity)
    private readonly maintenanceReportReviewRepository: Repository<MaintenanceReportReviewEntity>,
    @InjectRepository(ReferenceDocumentCaseDetailEntity)
    private readonly referenceDocumentCaseDetailRepository: Repository<ReferenceDocumentCaseDetailEntity>,
    @InjectRepository(AiConversationEntity)
    private readonly aiConversationRepository: Repository<AiConversationEntity>,
    @InjectRepository(AiMessageEntity)
    private readonly aiMessageRepository: Repository<AiMessageEntity>,
    @InjectRepository(AiMessageAnalysisEntity)
    private readonly aiMessageAnalysisRepository: Repository<AiMessageAnalysisEntity>,
    @InjectRepository(AiReportEntity)
    private readonly aiReportRepository: Repository<AiReportEntity>,
    @InjectRepository(EngineerResponseEntity)
    private readonly engineerResponseRepository: Repository<EngineerResponseEntity>,
    @Inject(STORED_FILE_STORAGE)
    private readonly fileStorage: StoredFileStorage,
    // 事务边界端口是**全局**提供的；离线装配（无全局根模块）下可能缺席，
    // 此时本实现**失败关闭**（不写任何业务行），而不是无事务硬写。
    @Optional()
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner | null,
    private readonly logger: PinoLogger,
  ) {
    // 表 → 注入仓储的映射：**构造期一次建立**（不用 switch 逐表分派）。
    //
    // 为什么不用 switch：switch 会让"表名 → 仓储"这份清单与上面的注入清单
    // 成为两处需要同步维护的地方，漏一处就会静默拿到错误仓储；
    // 这里由注入参数直接生成映射，新增表时只要补上注入即可。
    this.repositoryByTable = {
      repair_request: this.repairRequestRepository,
      repair_request_revision: this.repairRequestRevisionRepository,
      repair_request_intake: this.repairRequestIntakeRepository,
      intake_analysis_attempt: this.intakeAnalysisAttemptRepository,
      maintenance_report: this.maintenanceReportRepository,
      maintenance_report_version: this.reportVersionRepository,
      maintenance_report_attachment: this.reportAttachmentRepository,
      maintenance_report_version_attachment: this.reportVersionAttachmentRepository,
      maintenance_report_alarm: this.reportAlarmRepository,
      maintenance_report_step: this.reportStepRepository,
      maintenance_report_fault: this.reportFaultRepository,
      maintenance_report_review: this.maintenanceReportReviewRepository,
      reference_document: this.referenceDocumentRepository,
      reference_document_revision: this.documentRevisionRepository,
      reference_document_case_detail: this.referenceDocumentCaseDetailRepository,
      ai_conversation: this.aiConversationRepository,
      ai_message: this.aiMessageRepository,
      ai_message_analysis: this.aiMessageAnalysisRepository,
      ai_report: this.aiReportRepository,
      engineer_response: this.engineerResponseRepository,
      repair_process_entry: this.repairProcessEntryRepository,
      repair_request_diagnostic_step: this.repairRequestDiagnosticStepRepository,
      repair_request_fault_panel: this.repairRequestFaultPanelRepository,
      stored_file: this.storedFileRepository,
      local_upload_task: this.uploadTaskRepository,
    };
  }

  /**
   * 还原原件字节（任务 09 S2-3）。
   *
   * - 只按包内**相对路径**读文件，路径逃逸即拒绝；
   * - 逐个核对字节数与 SHA-256，不符即该原件失败（不写入半截字节）；
   * - 本机已有同引用且可读、字节一致时不重复写入；
   * - 写回后把业务行上的存储引用指向新字节（登记事实与字节保持一致）。
   *
   * **两段式**（文件与数据库非同事务）：
   * ① 逐份核对并把字节**暂存**到本机存储（文件写入不可回滚）；
   * ② 在**单个事务**内批量绑定行引用（全成或全败）。
   * ②失败 ⇒ 事务整体回滚（没有任何一份引用生效）＋ 回收本次**新建**的字节，
   * 不留下"存储里有字节、却没有行引用它"的孤儿状态。
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
    // 第一步：逐份核对并**暂存字节**（文件写入不可回滚）；
    //         行引用**先不落库**，避免出现"部分行指向新字节、部分行仍是旧引用"。
    const staged = await this.stageOriginalBytes(input, fileFacts);
    const failed = staged.failed;
    const bindings = staged.bindings;
    // 行绑定失败（事务回滚）的份数：与"包内字节/清单核对失败"**分开计数**，
    // 因为两者对运维的含义完全不同（前者是包的问题，后者是绑定事务的问题）。
    let bindingFailed = 0;

    // 第二步：行绑定在**单个事务**内完成（全成或全败）：
    //         字节已经落盘，引用一旦半途失败会出现"部分行指向新字节"的错配。
    if (bindings.length > 0) {
      if (this.transactionRunner === null) {
        bindingFailed = bindings.length;
        await this.discardUnboundBytes(bindings);
        return {
          restored: 0,
          failed: failed + bindingFailed,
          reason: '原件字节已按包内清单还原，但事务边界不可用，不能在无事务条件下绑定原件引用',
        };
      }
      try {
        await this.transactionRunner.run(async (transactionContext) => {
          for (const binding of bindings) {
            const updated = await this.bindOriginalToRow(
              binding.source,
              binding.storageReference,
              binding.sha256,
              binding.byteSize,
              transactionContext,
            );
            if (!updated) {
              throw new Error(`原件引用绑定失败：${binding.source}`);
            }
          }
        });
      } catch {
        // 事务已整体回滚 ⇒ **没有任何一份引用生效**；
        // 已新建的字节随即回收，不留下"存储里有字节、却没有行引用它"的孤儿状态。
        bindingFailed = bindings.length;
        await this.discardUnboundBytes(bindings);
      }
    }

    // 绑定事务失败 ⇒ 没有任何一份原件还原成功（restored 必须是 0，不能是"部分成功"）
    const restored = bindingFailed === 0 ? bindings.length : 0;
    if (bindingFailed > 0) {
      return {
        restored,
        failed: failed + bindingFailed,
        reason:
          '原件字节已按包内清单还原，但原件行引用的绑定事务失败并已整体回滚' + '（原件引用未生效）',
      };
    }
    return {
      restored,
      failed,
      reason: failed === 0 ? null : `有 ${failed} 份原件未能按包内清单还原`,
    };
  }

  /**
   * 第一阶段：逐份核对包内原件并把字节**暂存**到本机存储。
   *
   * 核对不通过（清单未登记／路径逃逸／字节数或摘要不符／写入失败）的原件
   * **不写半截字节**，只计入失败数；核对通过的暂存结果进入第二阶段绑定。
   */
  private async stageOriginalBytes(
    input: {
      packageRoot: string;
      originals: readonly {
        source: string;
        storage_reference: string;
        sha256: string | null;
      }[];
    },
    fileFacts: ReadonlyMap<string, { sha256: string; byte_size: number }>,
  ): Promise<{
    failed: number;
    bindings: {
      source: string;
      storageReference: string;
      sha256: string;
      byteSize: number;
      /** 本次是否**新建**了字节文件：只有新建的才允许在绑定失败时回收 */
      created: boolean;
    }[];
  }> {
    let failed = 0;
    const bindings: {
      source: string;
      storageReference: string;
      sha256: string;
      byteSize: number;
      created: boolean;
    }[] = [];
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
        const written = await this.writeOriginalBytes(original.storage_reference, bytes, digest);
        if (written === null) {
          failed += 1;
          continue;
        }
        bindings.push({
          source: original.source,
          storageReference: written.storageReference,
          sha256: digest,
          byteSize: bytes.byteLength,
          created: written.created,
        });
      } catch {
        failed += 1;
      }
    }
    return { failed, bindings };
  }

  /**
   * 写入原件字节。
   *
   * 本机同引用**且字节与包内清单一致**时直接复用（避免留下孤儿副本）；
   * 本机同引用但字节**不一致**（备份后被替换／截断）时**必须按包内字节重写**——
   * 否则会把"登记摘要＝备份摘要、实际字节＝本机旧字节"的错配写进业务行，
   * 后续完整性核对必然失败。
   *
   * 返回值带 `created`：只有**本次新建**的字节才允许在绑定失败时被回收，
   * 复用既有引用的字节属于恢复前的原有数据，删除它会造成数据丢失。
   */
  private async writeOriginalBytes(
    originalReference: string,
    bytes: Buffer,
    expectedSha256: string,
  ): Promise<{ storageReference: string; created: boolean } | null> {
    try {
      const identical = await this.fileStorage.verifyIntegrity(
        originalReference,
        expectedSha256,
        bytes.byteLength,
      );
      if (identical) {
        return { storageReference: originalReference, created: false };
      }
    } catch {
      // 本机已无该引用（或不可读）：按包内字节重新写入
    }
    const extension = nodePath.extname(originalReference).slice(0, 20);
    try {
      const storageReference = await this.fileStorage.save(bytes, extension);
      return { storageReference, created: true };
    } catch {
      return null;
    }
  }

  /**
   * 回收**本次新建**但未绑定成功的原件字节（补偿清理）。
   *
   * 只回收 `created = true` 的引用：**复用**本机既有引用的字节属于原有数据，
   * 删除它会把恢复前的原件一并弄丢。
   *
   * 清理是**尽力而为**：失败只记日志，不掩盖主失败原因（原件未还原才是主因）。
   */
  private async discardUnboundBytes(
    bindings: readonly { storageReference: string; created: boolean }[],
  ): Promise<void> {
    for (const binding of bindings) {
      if (!binding.created) {
        continue;
      }
      try {
        await this.fileStorage.delete(binding.storageReference);
      } catch (error) {
        this.logger.warn(
          { err: error, storageReference: binding.storageReference },
          '原件行绑定失败后的孤儿字节回收失败',
        );
      }
    }
  }

  /** 把新写入的字节绑定回业务行（存储引用、校验值、字节数） */
  private async bindOriginalToRow(
    source: string,
    storageReference: string,
    sha256: string,
    byteSize: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<boolean> {
    const [kind, identifier] = source.split(':');
    const id = Number(identifier);
    if (kind === 'stored_file' && identifier !== undefined && identifier !== '') {
      const repository = this.repositoryForTable('stored_file', transactionContext);
      if (repository === null) {
        return false;
      }
      const result = await repository.update(
        { fileId: identifier },
        { storageReference, checksumSha256: sha256, byteSize: String(byteSize) },
      );
      return (result.affected ?? 0) > 0;
    }
    if (kind === 'reference_document' && Number.isInteger(id) && id > 0) {
      // 资料行只登记存储引用（无独立校验值／字节数列），按引用更新
      const repository = this.repositoryForTable('reference_document', transactionContext);
      if (repository === null) {
        return false;
      }
      const result = await repository.update({ id }, { storageReference });
      return (result.affected ?? 0) > 0;
    }
    if (kind === 'maintenance_report_attachment' && Number.isInteger(id) && id > 0) {
      // 报告附件**自带**存储引用与校验值：必须一并指向还原后的字节，
      // 否则附件仍指向备份前（可能已被清理）的旧引用。
      const repository = this.repositoryForTable(
        'maintenance_report_attachment',
        transactionContext,
      );
      if (repository === null) {
        return false;
      }
      const result = await repository.update(
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
      return await this.transactionRunner.run(async (transactionContext) => {
        const counts: Record<string, number> = {};
        // ① 清空：逆外键顺序（先子后父），只清载荷里出现的表
        const payloadTables = request.tables.map((entry) => entry.table);
        // ①-0 采集**抑制事实**（删除／下架／历史标记）：
        //      备份之后才被删除的记录，恢复后不得复活（R086「不复活删除下架」）。
        //
        //      **必须先于打断循环外键采集**（顺序敏感）：
        //      `repair_request_intake` 的范围口径是 `SERVICE_OR_PARENT_ORGANIZATION`
        //      （自身服务公司 ∪ 引用了本公司工单的行），打断循环外键会把
        //      `converted_request_id` 置空 ⇒ 那些"服务公司为空、只靠父行归属"的原稿
        //      会**掉出范围** ⇒ 采集不到其删除事实（删除的报修原稿会被旧包复活）；
        //      且采集到的行会带着 `converted_request_id = null`，
        //      后面回填抑制事实时会把**已还原的"原稿 → 工单"关联覆盖回空**（事实丢失）。
        const suppressionFacts = await this.captureSuppressionFacts(
          request.organizationId,
          request.installationId,
          transactionContext,
        );
        // ①-1 打断循环外键：`repair_request_intake.converted_request_id → repair_request.id`
        //      与 `repair_request.intake_id → repair_request_intake.id` 互指，
        //      任何删除顺序都会被其中一侧挡住（真实库 `ER_ROW_IS_REFERENCED_2`）。
        //      先把"指向本次将被清空的工单"的引用置空——被置空的行都在恢复范围内，
        //      随写回按原值还原（延后外键回填），业务事实不丢。
        await this.breakCircularForeignKeys(
          request.organizationId,
          request.installationId,
          transactionContext,
        );
        for (const table of [...RESTORE_TABLES].reverse()) {
          if (!payloadTables.includes(table)) {
            continue;
          }
          await this.clearCompanyScope(
            table,
            request.organizationId,
            request.installationId,
            transactionContext,
          );
        }
        // ② 写回：正外键顺序（先父后子）
        let written = 0;
        const deferred: { id: number; value: number | null }[] = [];
        for (const table of RESTORE_TABLES) {
          const entry = request.tables.find((candidate) => candidate.table === table);
          if (entry === undefined) {
            continue;
          }
          const count = await this.insertRows(table, entry.rows, deferred, transactionContext);
          counts[table] = count;
          written += count;
        }
        // ③ 回填延后外键（`repair_request_intake.converted_request_id`）：
        //    双向外键无法单趟插入 ⇒ 写完工单后再按 intake 主键回填。
        await this.applyDeferredForeignKeys(deferred, transactionContext);
        // ④ 回填抑制事实：当前事实优先 ⇒ 已删除／已下架的内容不会被旧包复活。
        await this.applySuppressionFacts(suppressionFacts, transactionContext);
        return { status: 'WRITTEN', written, counts, reason: null };
      });
    } catch (error) {
      // 原始异常（约束名／SQL 片段／绝对路径）**只进服务端日志**；
      // 对外只给受控原因码，避免把数据库内部结构暴露到 API 响应。
      this.logger.error({ err: error }, '恢复写入失败');
      return {
        status: 'FAILED',
        written: 0,
        counts: {},
        reason: LOCAL_BACKUP_FAILURE_REASON.RESTORE_WRITE_FAILED,
      };
    }
  }

  async count(input: {
    organizationId: number;
    installationId: string;
    table: LocalRestoreRecordTable;
  }): Promise<number> {
    const repository = this.repositoryForTable(input.table);
    if (repository === null) {
      return 0;
    }
    const queryBuilder = repository.createQueryBuilder('t');
    this.applyScopeFilter(queryBuilder, input.table, input.organizationId, input.installationId);
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
    installationId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.repositoryForTable(table, transactionContext);
    if (repository === null) {
      // 失败关闭：清空被静默跳过 ⇒ 该表旧数据残留 ⇒ 出现"部分表已替换、
      // 部分表还是旧值"的自相矛盾状态（正是本文件头注释明令要避免的）。
      throw new Error(`恢复写入缺少仓储：${table}`);
    }
    const queryBuilder = repository.createQueryBuilder('t');
    // DELETE 语句没有表别名 ⇒ 范围过滤必须用**不带别名**的列名
    this.applyScopeFilter(queryBuilder, table, organizationId, installationId, null);
    await queryBuilder.delete().execute();
  }

  /**
   * 采集**抑制事实**（删除／下架）。
   *
   * 为什么要采集：恢复把公司数据区**整体替换**成备份时刻的内容，
   * 若不额外处理，**备份之后才被删除的记录会被旧包复活**（R086 明令"不复活删除下架"）。
   *
   * 口径＝"**当前事实优先**"：命中抑制的行，**整行**按恢复当下的事实还原
   * （删除事实是复合事实：工单还要求 `deprecated = 1` ⇒ `is_accepted = 0` ＋ 接单人与接单时间为空，
   * 只还原部分列会撞库级 CHECK）；未命中抑制的行**完全按备份载荷写回**。
   *
   * 采集范围＝本次将被清空的表范围（与清库口径完全一致，不多不少）。
   */
  private async captureSuppressionFacts(
    organizationId: number,
    installationId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<SuppressionFact[]> {
    const facts: SuppressionFact[] = [];
    for (const table of RESTORE_TABLES) {
      const suppression = BACKUP_TABLE_DESCRIPTORS[table].suppression;
      if (suppression === undefined) {
        continue;
      }
      const repository = this.repositoryForTable(table, transactionContext);
      if (repository === null) {
        // 失败关闭：采集被静默跳过 ⇒ 备份之后才被删除／下架的记录**采集不到**
        // 抑制事实 ⇒ 会被旧包复活（违反 R086「不复活删除下架」）。
        throw new Error(`恢复写入缺少仓储：${table}`);
      }
      const queryBuilder = repository.createQueryBuilder('t');
      this.applyScopeFilter(queryBuilder, table, organizationId, installationId);
      const rows = await queryBuilder.getMany();
      for (const row of rows) {
        if (!isSuppressed(row, suppression)) {
          continue;
        }
        facts.push({ table, entity: row });
      }
    }
    return facts;
  }

  /**
   * 回填抑制事实：把恢复当下的**整行事实**写回（已删除／已下架的内容不被旧包复活）。
   *
   * 只处理**载荷里也存在的行**：备份之后才新建又删除的行不在载荷内，
   * 随恢复一起消失（恢复＝回到备份时刻），不会以"未删除"形态复活。
   */
  private async applySuppressionFacts(
    facts: readonly SuppressionFact[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    for (const fact of facts) {
      const repository = this.repositoryForTable(fact.table, transactionContext);
      if (repository === null) {
        // 失败关闭：回填被静默跳过 ⇒ 抑制事实丢失 ⇒ 删除／下架的记录被旧包复活。
        throw new Error(`恢复写入缺少仓储：${fact.table}`);
      }
      await repository.save(fact.entity as never);
    }
  }

  /**
   * 打断循环外键（`repair_request_intake` ⇄ `repair_request`）。
   *
   * 双向外键无法靠删除顺序解决：清空工单行时，
   * 引用它的 intake 行会挡住删除（真实库 `ER_ROW_IS_REFERENCED_2`）。
   *
   * 口径：只把"引用了**本次将被清空的工单**"的 `converted_request_id` 置空——
   * 正好是那些阻塞者；它们都在恢复范围内，会随写回按原值还原，
   * 因此**业务事实不丢**（还原值来自备份载荷，见延后外键回填）。
   */
  private async breakCircularForeignKeys(
    organizationId: number,
    installationId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const parentPredicate = buildOrganizationScopePredicate('repair_request', 'p');
    const intakeRepository = this.repositoryForTable('repair_request_intake', transactionContext);
    if (intakeRepository === null) {
      throw new Error('恢复写入缺少仓储：repair_request_intake');
    }
    await intakeRepository
      .createQueryBuilder()
      .update()
      .set({ convertedRequestId: null })
      .where(
        `converted_request_id IN (SELECT p.id FROM repair_request p WHERE ${parentPredicate})`,
        { organizationId, installationId },
      )
      .execute();
  }

  /**
   * 写回一表的全行（主键按备份原值保留，恢复后业务身份不漂移）。
   *
   * `repair_request_intake` 的 `converted_request_id` 与工单互为外键（双向），
   * 插入时先置空、登记到 `deferred`，待工单写入完成后回填。
   */
  private async insertRows(
    table: LocalRestoreRecordTable,
    rows: readonly Record<string, unknown>[],
    deferred: { id: number; value: number | null }[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const repository = this.repositoryForTable(table, transactionContext);
    if (repository === null) {
      throw new Error(`恢复写入缺少仓储：${table}`);
    }
    const prepared = rows.map((row) => ({ ...row }));
    if (table === DEFERRED_FOREIGN_KEY_TABLE) {
      for (const row of prepared) {
        const value = row[DEFERRED_FOREIGN_KEY_COLUMN];
        if (value === null || value === undefined) {
          continue;
        }
        deferred.push({ id: row.id as number, value: value as number | null });
        delete row[DEFERRED_FOREIGN_KEY_COLUMN];
      }
    }
    const entities = prepared.map((row) => repository.create(row));
    await repository.insert(entities);
    return entities.length;
  }

  /** 回填延后外键（双向外键的另一半） */
  private async applyDeferredForeignKeys(
    deferred: readonly { id: number; value: number | null }[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    if (deferred.length === 0) {
      return;
    }
    const repository = this.repositoryForTable('repair_request_intake', transactionContext);
    if (repository === null) {
      throw new Error('恢复写入缺少仓储：repair_request_intake');
    }
    for (const item of deferred) {
      if (typeof item.id !== 'number') {
        throw new Error('延后外键回填缺少 intake 主键');
      }
      await repository.update({ id: item.id }, { convertedRequestId: item.value });
    }
  }

  /**
   * 按**逐表口径**圈定本公司数据区。
   *
   * 谓词由 core 的 `buildOrganizationScopePredicate` 统一生成（备份侧同源）：
   * 根表按公司列、子表按父表公司归属（递归）、本机运行数据按安装 × 公司。
   */
  private applyScopeFilter(
    queryBuilder: ReturnType<Repository<ObjectLiteral>['createQueryBuilder']>,
    table: BackupScopeTable,
    organizationId: number,
    installationId: string,
    /**
     * 表别名：**DELETE 语句没有别名**（`DELETE FROM t WHERE ...` 里的 `t.` 不是表别名）。
     * 之前清库路径复用 SELECT 的别名写法 ⇒ 真实库上
     * `Unknown column 't.document_id' in 'IN/ALL/ANY subquery'` ⇒ 恢复写入必然失败。
     */
    alias: string | null = 't',
  ): void {
    queryBuilder.where(buildOrganizationScopePredicate(table, alias), {
      organizationId,
      installationId,
    });
  }

  /**
   * 取某张表的仓储。
   *
   * **有事务上下文时必须取事务内的仓储**（`manager.getRepository`）：
   * 注入的普通仓储走的是数据源默认连接，**不在事务里**，
   * 会让"事务已开但写在事务外自动提交"⇒ 中途失败留下半截数据。
   * 实体类型从注入仓储的 `target` 取，避免维护两套表→实体映射。
   */
  private repositoryForTable(
    table: string,
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ObjectLiteral> | null {
    const injected = this.injectedRepositoryForTable(table);
    if (injected === null) {
      return null;
    }
    if (transactionContext === undefined) {
      return injected;
    }
    return getTypeOrmEntityManager(transactionContext).getRepository(injected.target);
  }

  private injectedRepositoryForTable(table: string): Repository<ObjectLiteral> | null {
    return this.repositoryByTable[table] ?? null;
  }
}
