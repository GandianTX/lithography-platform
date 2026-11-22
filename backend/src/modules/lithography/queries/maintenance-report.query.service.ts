// src/modules/lithography/queries/maintenance-report.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, Not, ObjectLiteral, Raw, Repository, type FindOptionsWhere } from 'typeorm';
import { MaintenanceReportStatus } from '@app-types/models/maintenance-report.types';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { MaintenanceReportAlarmEntity } from '../entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from '../entities/maintenance-report-attachment.entity';
import { MaintenanceReportFaultEntity } from '../entities/maintenance-report-fault.entity';
import { MaintenanceReportReviewEntity } from '../entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from '../entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from '../entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from '../entities/maintenance-report-version.entity';
import { MaintenanceReportEntity } from '../entities/maintenance-report.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import {
  toMaintenanceReportAlarmSnapshot,
  toMaintenanceReportAttachmentSnapshot,
  toMaintenanceReportFaultSnapshot,
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
  MaintenanceReportListFilter,
  MaintenanceReportOwnershipFacts,
  MaintenanceReportReadScope,
  MaintenanceReportReviewSnapshot,
  MaintenanceReportSnapshot,
  MaintenanceReportStepSnapshot,
  MaintenanceReportSummaryView,
  MaintenanceReportVersionAttachmentSnapshot,
  MaintenanceReportVersionSnapshot,
  WorkOrderSummaryCandidateView,
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

/** LIKE 通配符转义（与其他 QueryService 同惯例：本服务私有，防用户输入 %/_ 展开通配） */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

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
    @InjectRepository(MaintenanceReportFaultEntity)
    private readonly faultRepository: Repository<MaintenanceReportFaultEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(EquipmentModelEntity)
    private readonly equipmentModelRepository: Repository<EquipmentModelEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly attachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
    @InjectRepository(MaintenanceReportVersionEntity)
    private readonly versionRepository: Repository<MaintenanceReportVersionEntity>,
    @InjectRepository(MaintenanceReportVersionAttachmentEntity)
    private readonly versionAttachmentRepository: Repository<MaintenanceReportVersionAttachmentEntity>,
    @InjectRepository(MaintenanceReportReviewEntity)
    private readonly reviewRepository: Repository<MaintenanceReportReviewEntity>,
  ) {}

  /**
   * 最小归属事实读取（只读授权前置）：只取报告 id / 负责人 / 所属组织 / 状态，
   * 不加载报警、步骤、附件、版本与审核历史。
   */
  async readReportOwnership(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportOwnershipFacts | null> {
    const entity = await this.getReportRepository(transactionContext).findOne({
      where: { id: reportId },
      select: {
        id: true,
        maintenanceEngineerAccountId: true,
        ownerOrganizationId: true,
        status: true,
      },
    });
    if (!entity) return null;
    return {
      reportId: entity.id,
      maintenanceEngineerAccountId: entity.maintenanceEngineerAccountId,
      ownerOrganizationId: entity.ownerOrganizationId,
      // 实体列以 string 承载（CHECK 约束限定状态域）；授权分支按领域状态枚举裁决
      status: entity.status as MaintenanceReportStatus,
    };
  }

  async readReport(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
    scope?: MaintenanceReportReadScope,
  ): Promise<MaintenanceReportSnapshot | null> {
    const where: FindOptionsWhere<MaintenanceReportEntity> = { id: reportId };
    if (scope) {
      // 一级管理员（平台级角色）只携带作者谓词，不携带公司谓词；
      // 工程师/二级管理员的公司谓词仅在调用方提供时生效。
      if (scope.ownerOrganizationId !== undefined) {
        where.ownerOrganizationId = scope.ownerOrganizationId;
      }
      if (scope.maintenanceEngineerAccountId !== undefined) {
        where.maintenanceEngineerAccountId = scope.maintenanceEngineerAccountId;
      }
    }
    const entity = await this.getReportRepository(transactionContext).findOne({ where });
    return entity ? toMaintenanceReportSnapshot(entity) : null;
  }

  /**
   * 工作态草稿详情：报告根 + 报警 + 步骤 + 当前附件 + 最近一次退回意见。
   *
   * 供编辑/提交用例在报告行锁保护下读取当前草稿事实；也供本人详情读取。
   * 传入 `scope` 时根查询按授权范围过滤，作为调用方首次授权检查之外的第二道约束。
   */
  async readDraftDetail(
    reportId: number,
    transactionContext?: PersistenceTransactionContext,
    scope?: MaintenanceReportReadScope,
  ): Promise<MaintenanceReportDraftDetailView | null> {
    const report = await this.readReport(reportId, transactionContext, scope);
    if (!report) return null;
    const [alarms, steps, faults, attachments, latestReturn] = await Promise.all([
      this.getAlarmRepository(transactionContext).find({
        where: { reportId },
        order: { alarmIndex: 'ASC' },
      }),
      this.getStepRepository(transactionContext).find({
        where: { reportId },
        order: { stepNo: 'ASC' },
      }),
      this.getFaultRepository(transactionContext).find({
        where: { reportId },
        order: { id: 'ASC' },
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
      faults: faults.map(toMaintenanceReportFaultSnapshot),
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
    scope?: MaintenanceReportReadScope,
  ): Promise<MaintenanceReportDetailView | null> {
    const draft = await this.readDraftDetail(reportId, transactionContext, scope);
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
      faults: draft.faults,
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
    ownerOrganizationId: number | undefined,
    pagination: MaintenanceReportListPagination,
    filter: MaintenanceReportListFilter = {},
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportListPage<MaintenanceReportSummaryView>> {
    const reportRepository = this.getReportRepository(transactionContext);
    // R052 / 页面 V6.5 §9.2（2026-11-21 页面设计确认）：页面只展示「本人创建且本人有权
    // 访问」的记录——所有分支必带作者谓词；他人草稿、他人待审与他人正式记录一律
    // 不出现在本页面（一级/二级管理员查看他人正式资料走参考资料库与管理员文档
    // 数据库，按 R055/R056 资源权限裁决）。
    // - 本人分支覆盖本人全部非草稿状态（含历史 PENDING_REVIEW，保持既有口径）；
    //   不枚举具体正式状态，兼容任务 06 新增的 SUBMITTED。
    // - 公司谓词由调用方按角色提供：工程师/二级管理员传可信本公司（作者换公司后
    //   旧公司记录不再可见，不自动转移归属）；一级管理员为平台级角色、无业务所属
    //   公司，不传公司谓词（undefined），只按作者本人读取，无记录时正常空态。
    const organizationPredicate: { ownerOrganizationId?: number } =
      ownerOrganizationId !== undefined ? { ownerOrganizationId } : {};
    const draftPhaseStatuses = [MaintenanceReportStatus.DRAFT, MaintenanceReportStatus.RETURNED];
    const ownNonDraftWhere: FindOptionsWhere<MaintenanceReportEntity> = {
      maintenanceEngineerAccountId: engineerAccountId,
      ...organizationPredicate,
      status: Not(In(draftPhaseStatuses)),
    };
    const ownDraftWhere: FindOptionsWhere<MaintenanceReportEntity> = {
      maintenanceEngineerAccountId: engineerAccountId,
      ...organizationPredicate,
      status: In(draftPhaseStatuses),
    };
    if (filter.sourceType) {
      ownDraftWhere.sourceType = filter.sourceType;
      ownNonDraftWhere.sourceType = filter.sourceType;
    }
    if (filter.titleKeyword) {
      // 标题关键词（任务 07 页面搜索）：恒在归属谓词内全量匹配，值经转义后参数注入
      const titleCondition = Raw((alias) => `${alias} LIKE :pattern`, {
        pattern: `%${escapeLikePattern(filter.titleKeyword)}%`,
      });
      ownDraftWhere.title = titleCondition;
      ownNonDraftWhere.title = titleCondition;
    }
    let where:
      FindOptionsWhere<MaintenanceReportEntity> | FindOptionsWhere<MaintenanceReportEntity>[];
    if (filter.recordKind === 'DRAFT') {
      where = ownDraftWhere;
    } else if (filter.recordKind === 'FORMAL') {
      where = ownNonDraftWhere;
    } else {
      where = [ownDraftWhere, ownNonDraftWhere];
    }
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

  /** 型号库只读引用：工单总结入口带出设备型号用 */
  async findEquipmentModelRef(
    equipmentModelId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ id: number; modelCode: string; modelName: string } | null> {
    const entity = await this.pickRepository(
      this.equipmentModelRepository,
      transactionContext,
    ).findOne({
      where: { id: equipmentModelId },
      select: { id: true, modelCode: true, modelName: true },
    });
    return entity === null
      ? null
      : { id: entity.id, modelCode: entity.modelCode, modelName: entity.modelName };
  }

  /** 按工单定位报告归属事实（一工单至多一份总结根，唯一键兜底） */
  async findOwnershipByRepairRequestId(
    repairRequestId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportOwnershipFacts | null> {
    const entity = await this.getReportRepository(transactionContext).findOne({
      where: { repairRequestId },
      select: {
        id: true,
        maintenanceEngineerAccountId: true,
        ownerOrganizationId: true,
        status: true,
      },
    });
    if (!entity) return null;
    return {
      reportId: entity.id,
      maintenanceEngineerAccountId: entity.maintenanceEngineerAccountId,
      ownerOrganizationId: entity.ownerOrganizationId,
      status: entity.status as MaintenanceReportStatus,
    };
  }

  /**
   * R051-01 幂等定位：按「操作者 + 公司 + 提交标识」定位已有提交结果。
   * 与 uk_maintenance_report_submission 同口径；直接提交路径在并发竞争下
   * 由本读侧 + 唯一键共同保证只返回同一份报告。
   */
  async findBySubmissionKey(
    params: {
      createdByAccountId: number;
      ownerOrganizationId: number;
      submissionRequestId: string;
    },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportSnapshot | null> {
    const entity = await this.getReportRepository(transactionContext).findOne({
      where: {
        createdByAccountId: params.createdByAccountId,
        ownerOrganizationId: params.ownerOrganizationId,
        submissionRequestId: params.submissionRequestId,
      },
    });
    return entity ? toMaintenanceReportSnapshot(entity) : null;
  }

  /** 幂等重试读侧：按报告与版本号定位冻结版本 ID（用于回链正式资料） */
  async findVersionIdByReportAndVersionNo(
    reportId: number,
    versionNo: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<number | null> {
    const entity = await this.getVersionRepository(transactionContext).findOne({
      where: { reportId, versionNo },
      select: { id: true },
    });
    return entity?.id ?? null;
  }

  /**
   * 工单维修总结待填写候选：本人已接单、已结单、同组织且尚未正式提交的工单。
   *
   * 报告存在性在同一查询内左连接判定，避免先分页后过滤；
   * 仅 DRAFT/RETURNED（可续填）进入候选，正式提交或进入旧审核流后被移出。
   */
  async listWorkOrderSummaryCandidates(
    params: {
      engineerAccountId: number;
      ownerOrganizationId: number;
      pagination: MaintenanceReportListPagination;
    },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportListPage<WorkOrderSummaryCandidateView>> {
    const requestRepository = this.pickRepository(this.repairRequestRepository, transactionContext);
    const pagination = params.pagination;
    const query = requestRepository
      .createQueryBuilder('request')
      .leftJoin(MaintenanceReportEntity, 'report', 'report.repair_request_id = request.id')
      // 故障现象取客户原始报修（intake 唯一有效行；2026-11-21 列表对齐 Demo 增列）
      .leftJoin(
        RepairRequestIntakeEntity,
        'intake',
        'intake.converted_request_id = request.id AND intake.deleted_at IS NULL',
      )
      .where('request.accepted_by_engineer_account_id = :engineerAccountId', {
        engineerAccountId: params.engineerAccountId,
      })
      .andWhere('request.owner_organization_id = :ownerOrganizationId', {
        ownerOrganizationId: params.ownerOrganizationId,
      })
      .andWhere('request.deprecated = :deprecated', { deprecated: false })
      .andWhere('request.closure_status = :closureStatus', { closureStatus: 'CLOSED' })
      .andWhere("(report.id IS NULL OR report.status IN ('DRAFT', 'RETURNED'))");

    const totalPromise = pagination.withTotal
      ? query.clone().getCount()
      : Promise.resolve(undefined);
    const rows = await query
      .select('request.id', 'repairRequestId')
      .addSelect('request.request_no', 'requestNo')
      .addSelect('request.closed_at', 'closedAt')
      .addSelect('request.handling_result', 'handlingResult')
      .addSelect('request.equipment_model_id', 'equipmentModelId')
      .addSelect('intake.fault_description', 'intakeFaultDescription')
      .addSelect('report.id', 'reportId')
      .addSelect('report.status', 'reportStatus')
      .addSelect('report.updated_at', 'reportUpdatedAt')
      .orderBy('request.closed_at', 'DESC')
      .addOrderBy('request.id', 'DESC')
      .offset((pagination.page - 1) * pagination.pageSize)
      .limit(pagination.pageSize)
      .getRawMany<WorkOrderSummaryCandidateRawRow>();
    const total = await totalPromise;

    const modelIds = [...new Set(rows.map((row) => Number(row.equipmentModelId)))];
    const models =
      modelIds.length === 0
        ? []
        : await this.pickRepository(this.equipmentModelRepository, transactionContext).find({
            where: { id: In(modelIds) },
            select: { id: true, modelCode: true, modelName: true },
          });
    const modelById = new Map(models.map((model) => [model.id, model]));

    return {
      items: rows.map((row) => {
        const model = modelById.get(Number(row.equipmentModelId));
        return {
          repairRequestId: Number(row.repairRequestId),
          requestNo: row.requestNo,
          equipmentModelCode: model?.modelCode ?? null,
          equipmentModelName: model?.modelName ?? null,
          intakeFaultDescription: row.intakeFaultDescription ?? null,
          closedAt: row.closedAt === null ? null : new Date(row.closedAt),
          handlingResult: row.handlingResult ?? null,
          reportId: row.reportId === null ? null : Number(row.reportId),
          reportStatus: (row.reportStatus ?? null) as WorkOrderSummaryCandidateView['reportStatus'],
          reportUpdatedAt: row.reportUpdatedAt === null ? null : new Date(row.reportUpdatedAt),
        };
      }),
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

  private getFaultRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaintenanceReportFaultEntity> {
    return this.pickRepository(this.faultRepository, transactionContext);
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

/** 工单总结候选的原始行形状（QueryBuilder 显式列别名，避免隐式命名漂移） */
interface WorkOrderSummaryCandidateRawRow {
  repairRequestId: string | number;
  requestNo: string;
  closedAt: Date | string | null;
  handlingResult: string | null;
  equipmentModelId: string | number;
  intakeFaultDescription: string | null;
  reportId: string | number | null;
  reportStatus: string | null;
  reportUpdatedAt: Date | string | null;
}

function toMaintenanceReportSummary(entity: MaintenanceReportEntity): MaintenanceReportSummaryView {
  return {
    id: entity.id,
    // 归属公司来自资源行本身：同步状态匹配键的公司来源（不进入公开 DTO）
    ownerOrganizationId: entity.ownerOrganizationId,
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
