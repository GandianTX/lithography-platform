// src/modules/lithography/queries/maintenance-report.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, ObjectLiteral, Repository } from 'typeorm';
import { MaintenanceReportStatus } from '@app-types/models/maintenance-report.types';
import { MaintenanceReportAlarmEntity } from '../entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from '../entities/maintenance-report-attachment.entity';
import { MaintenanceReportReviewEntity } from '../entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from '../entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from '../entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from '../entities/maintenance-report-version.entity';
import { MaintenanceReportEntity } from '../entities/maintenance-report.entity';
import {
  toMaintenanceReportAlarmSnapshot,
  toMaintenanceReportAttachmentSnapshot,
  toMaintenanceReportReviewSnapshot,
  toMaintenanceReportSnapshot,
  toMaintenanceReportStepSnapshot,
  toMaintenanceReportVersionAttachmentSnapshot,
  toMaintenanceReportVersionSnapshot,
} from '../maintenance-report.mapper';
import {
  MaintenanceReportAlarmSnapshot,
  MaintenanceReportAttachmentSnapshot,
  MaintenanceReportDetailView,
  MaintenanceReportDraftDetailView,
  MaintenanceReportReviewSnapshot,
  MaintenanceReportSnapshot,
  MaintenanceReportStepSnapshot,
  MaintenanceReportSummaryView,
  MaintenanceReportVersionAttachmentSnapshot,
  MaintenanceReportVersionSnapshot,
} from '../maintenance-report.types';

/** 本人列表/审核队列分页参数（默认与上限由调用方按契约传入） */
export type MaintenanceReportListPagination = {
  page: number;
  pageSize: number;
  withTotal?: boolean;
};

export type MaintenanceReportListPage<T> = {
  items: T[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 维修报告读取服务。
 *
 * 只返回安全视图：附件读取结果包含存储引用（供授权下载适配层使用），
 * 但不会包含其他组织的报告；组织/角色裁决在 usecase。
 *
 * QueryService 只做普通读，不加锁、不产生副作用。写用例的快照一致性由
 * usecase 的守卫顺序保证：事务内第一次读取必须是报告行锁定读，
 * 之后的普通读才会落在同一 REPEATABLE-READ 读视图内（详见
 * maintenance-report-write-guard.ts）。
 */
@Injectable()
export class MaintenanceReportQueryService {
  constructor(
    @InjectRepository(MaintenanceReportEntity)
    private readonly reportRepository: Repository<MaintenanceReportEntity>,
    @InjectRepository(MaintenanceReportAlarmEntity)
    private readonly alarmRepository: Repository<MaintenanceReportAlarmEntity>,
    @InjectRepository(MaintenanceReportStepEntity)
    private readonly stepRepository: Repository<MaintenanceReportStepEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly attachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
    @InjectRepository(MaintenanceReportVersionEntity)
    private readonly versionRepository: Repository<MaintenanceReportVersionEntity>,
    @InjectRepository(MaintenanceReportVersionAttachmentEntity)
    private readonly versionAttachmentRepository: Repository<MaintenanceReportVersionAttachmentEntity>,
    @InjectRepository(MaintenanceReportReviewEntity)
    private readonly reviewRepository: Repository<MaintenanceReportReviewEntity>,
  ) {}

  async readReport(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportSnapshot | null> {
    const entity = await this.getReportRepository(transactionContext).findOne({
      where: { id: reportId },
    });
    return entity ? toMaintenanceReportSnapshot(entity) : null;
  }

  /**
   * 工作态草稿详情：报告根 + 报警 + 步骤 + 当前附件 + 最近一次退回意见。
   *
   * 供编辑/提交用例在报告行锁保护下读取当前草稿事实；也供本人详情读取。
   */
  async readDraftDetail(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportDraftDetailView | null> {
    const report = await this.readReport(reportId, transactionContext);
    if (!report) return null;
    const [alarms, steps, attachments, latestReturn] = await Promise.all([
      this.getAlarmRepository(transactionContext).find({
        where: { reportId },
        order: { alarmIndex: 'ASC' },
      }),
      this.getStepRepository(transactionContext).find({
        where: { reportId },
        order: { stepNo: 'ASC' },
      }),
      this.getAttachmentRepository(transactionContext).find({
        where: { reportId, status: 'CURRENT' },
        order: { sortOrder: 'ASC' },
      }),
      this.getReviewRepository(transactionContext).findOne({
        where: { reportId, decision: 'RETURN' },
        order: { reviewedAt: 'DESC' },
      }),
    ]);
    return {
      report,
      alarms: alarms.map(toMaintenanceReportAlarmSnapshot),
      steps: steps.map(toMaintenanceReportStepSnapshot),
      attachments: attachments.map(toMaintenanceReportAttachmentSnapshot),
      latestReturnComment: latestReturn?.comment ?? null,
    };
  }

  /**
   * 送审冻结用当前附件事实。
   *
   * 调用方必须先取得报告行锁再调用本方法；同事务内的首次读取为锁定读，
   * 因此这里的普通读已落在锁后读视图上，不会冻结进已退役/移除前的旧集合。
   * 快照内容只来自真实 CURRENT 行，不接受客户端自报。
   */
  async readCurrentAttachmentsForSubmit(
    reportId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportAttachmentSnapshot[]> {
    const rows = await this.getAttachmentRepository(transactionContext).find({
      where: { reportId, status: 'CURRENT' },
      order: { sortOrder: 'ASC' },
    });
    return rows.map(toMaintenanceReportAttachmentSnapshot);
  }

  async readCurrentAttachment(
    reportId: number,
    attachmentId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportAttachmentSnapshot | null> {
    const row = await this.getAttachmentRepository(transactionContext).findOne({
      where: { id: attachmentId, reportId, status: 'CURRENT' },
    });
    return row ? toMaintenanceReportAttachmentSnapshot(row) : null;
  }

  async readCurrentAttachmentCount(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<number> {
    return this.getAttachmentRepository(transactionContext).count({
      where: { reportId, status: 'CURRENT' },
    });
  }

  async readVersion(
    reportId: number,
    versionNo: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportVersionSnapshot | null> {
    const row = await this.getVersionRepository(transactionContext).findOne({
      where: { reportId, versionNo },
    });
    return row ? toMaintenanceReportVersionSnapshot(row) : null;
  }

  async readVersionById(
    reportId: number,
    versionId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportVersionSnapshot | null> {
    const row = await this.getVersionRepository(transactionContext).findOne({
      where: { id: versionId, reportId },
    });
    return row ? toMaintenanceReportVersionSnapshot(row) : null;
  }

  async readVersionAttachments(
    versionId: number,
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportVersionAttachmentSnapshot[]> {
    const rows = await this.getVersionAttachmentRepository(transactionContext).find({
      where: { versionId, reportId },
      order: { sortOrder: 'ASC' },
    });
    return rows.map(toMaintenanceReportVersionAttachmentSnapshot);
  }

  /** 冻结版本附件清单中的安全元数据（按附件 ID 批量装配，供历史授权下载展示） */
  async readAttachmentsByIds(
    reportId: number,
    attachmentIds: readonly number[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportAttachmentSnapshot[]> {
    if (attachmentIds.length === 0) return [];
    const rows = await this.getAttachmentRepository(transactionContext).find({
      where: { reportId, id: In(attachmentIds) },
    });
    return rows.map(toMaintenanceReportAttachmentSnapshot);
  }

  async readReviewByVersion(
    versionId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportReviewSnapshot | null> {
    const row = await this.getReviewRepository(transactionContext).findOne({
      where: { versionId },
    });
    return row ? toMaintenanceReportReviewSnapshot(row) : null;
  }

  async readReviewHistory(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportReviewSnapshot[]> {
    const rows = await this.getReviewRepository(transactionContext).find({
      where: { reportId },
      order: { reviewedAt: 'ASC' },
    });
    return rows.map(toMaintenanceReportReviewSnapshot);
  }

  async hasWorkOrderSummary(
    repairRequestId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<boolean> {
    const total = await this.getReportRepository(transactionContext).count({
      where: { repairRequestId },
    });
    return total > 0;
  }

  /**
   * 完整报告详情读取（本人/审核共用装配，权限由调用方裁决）：
   * 工作态草稿内容 + 当前冻结版本（含版本附件与审核）+ 历史审核。
   *
   * `currentVersionNo=0` 时冻结版本为 null；冻结版本行缺失属数据不定式破坏，
   * 失败关闭（不静默返回残缺报告）。
   */
  async readReportDetail(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportDetailView | null> {
    const draft = await this.readDraftDetail(reportId, transactionContext);
    if (!draft) return null;
    const { report } = draft;
    const reviewHistory = await this.readReviewHistory(reportId, transactionContext);
    let currentVersion: MaintenanceReportVersionSnapshot | null = null;
    let currentVersionAttachments: MaintenanceReportVersionAttachmentSnapshot[] = [];
    let currentReview: MaintenanceReportReviewSnapshot | null = null;
    if (report.currentVersionNo > 0) {
      currentVersion = await this.readVersion(
        reportId,
        report.currentVersionNo,
        transactionContext,
      );
      if (!currentVersion) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
          '维修报告当前版本行缺失',
          { reportId, currentVersionNo: report.currentVersionNo },
        );
      }
      [currentVersionAttachments, currentReview] = await Promise.all([
        this.readVersionAttachments(currentVersion.id, reportId, transactionContext),
        this.readReviewByVersion(currentVersion.id, transactionContext),
      ]);
    }
    return {
      report,
      alarms: draft.alarms,
      steps: draft.steps,
      currentAttachments: draft.attachments,
      latestReturnComment: draft.latestReturnComment,
      currentVersion,
      currentVersionAttachments,
      currentReview,
      reviewHistory,
      canEdit:
        report.status === MaintenanceReportStatus.DRAFT ||
        report.status === MaintenanceReportStatus.RETURNED,
    };
  }

  async listMine(
    engineerAccountId: number,
    ownerOrganizationId: number,
    pagination: MaintenanceReportListPagination,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportListPage<MaintenanceReportSummaryView>> {
    const reportRepository = this.getReportRepository(transactionContext);
    const where = { maintenanceEngineerAccountId: engineerAccountId, ownerOrganizationId };
    const [rows, total] = await Promise.all([
      reportRepository.find({
        where,
        order: { updatedAt: 'DESC', id: 'DESC' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      pagination.withTotal ? reportRepository.count({ where }) : Promise.resolve(undefined),
    ]);
    return {
      items: rows.map(toMaintenanceReportSummary),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    };
  }

  async listReviewQueue(
    ownerOrganizationId: number,
    pagination: MaintenanceReportListPagination,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportListPage<MaintenanceReportSummaryView>> {
    const reportRepository = this.getReportRepository(transactionContext);
    const where = { ownerOrganizationId, status: 'PENDING_REVIEW' };
    const [rows, total] = await Promise.all([
      reportRepository.find({
        where,
        order: { lastSubmittedAt: 'ASC', id: 'ASC' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      pagination.withTotal ? reportRepository.count({ where }) : Promise.resolve(undefined),
    ]);
    return {
      items: rows.map(toMaintenanceReportSummary),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    };
  }

  /** 工作态报警原始快照（含内部 ID，供 usecase 合并补丁；不进入公开 DTO） */
  async readAlarmSnapshots(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportAlarmSnapshot[]> {
    const rows = await this.getAlarmRepository(transactionContext).find({
      where: { reportId },
      order: { alarmIndex: 'ASC' },
    });
    return rows.map(toMaintenanceReportAlarmSnapshot);
  }

  async readStepSnapshots(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportStepSnapshot[]> {
    const rows = await this.getStepRepository(transactionContext).find({
      where: { reportId },
      order: { stepNo: 'ASC' },
    });
    return rows.map(toMaintenanceReportStepSnapshot);
  }

  private getReportRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportEntity> {
    return this.pickRepository(this.reportRepository, transactionContext);
  }

  private getAlarmRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportAlarmEntity> {
    return this.pickRepository(this.alarmRepository, transactionContext);
  }

  private getStepRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportStepEntity> {
    return this.pickRepository(this.stepRepository, transactionContext);
  }

  private getAttachmentRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportAttachmentEntity> {
    return this.pickRepository(this.attachmentRepository, transactionContext);
  }

  private getVersionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportVersionEntity> {
    return this.pickRepository(this.versionRepository, transactionContext);
  }

  private getVersionAttachmentRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportVersionAttachmentEntity> {
    return this.pickRepository(this.versionAttachmentRepository, transactionContext);
  }

  private getReviewRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportReviewEntity> {
    return this.pickRepository(this.reviewRepository, transactionContext);
  }

  private pickRepository<T extends ObjectLiteral>(
    repository: Repository<T>,
    transactionContext?: PersistenceTransactionContext,
  ): Repository<T> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(repository.target) : repository;
  }
}

function toMaintenanceReportSummary(entity: MaintenanceReportEntity): MaintenanceReportSummaryView {
  return {
    id: entity.id,
    sourceType: entity.sourceType as MaintenanceReportSummaryView['sourceType'],
    repairRequestId: entity.repairRequestId,
    title: entity.title,
    status: entity.status as MaintenanceReportSummaryView['status'],
    currentVersionNo: entity.currentVersionNo,
    maintenanceDate: entity.maintenanceDate,
    maintenanceEngineerAccountId: entity.maintenanceEngineerAccountId,
    updatedAt: entity.updatedAt,
  };
}
