// src/modules/lithography/queries/content-submission.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, Raw, Repository, type FindOptionsOrder } from 'typeorm';
import {
  ContentSubmissionAccessFacts,
  ContentSubmissionAttachmentDownloadRef,
  ContentSubmissionAttachmentMetaView,
  ContentSubmissionKind,
  ContentSubmissionListFilter,
  ContentSubmissionListPage,
  ContentSubmissionListItemView,
  ContentSubmissionListPagination,
  ContentSubmissionLatestReviewView,
  ContentSubmissionMineDetailView,
  ContentSubmissionPublishedDocumentView,
  ContentSubmissionReviewDetailView,
  ContentSubmissionReviewHistoryItemView,
  ContentSubmissionRevisionPublishSource,
  ContentSubmissionRevisionView,
  ContentSubmissionStatus,
  ContentSubmissionStatusSnapshot,
  FaultCaseSubmissionDetailView,
  FaultCaseSubmissionDetailWriteData,
  MaterialSubmissionDetailView,
  MaterialSubmissionDetailWriteData,
} from '../content-submission.types';
import { ContentSubmissionAttachmentEntity } from '../entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from '../entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from '../entities/content-submission-review.entity';
import { ContentSubmissionRevisionEntity } from '../entities/content-submission-revision.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { FaultCaseSubmissionDetailEntity } from '../entities/fault-case-submission-detail.entity';
import { MaterialSubmissionDetailEntity } from '../entities/material-submission-detail.entity';
import { ReferenceDocumentEntity } from '../entities/reference-document.entity';

/** 本人列表固定排序（A-PR0 §2.3 补充口径 7）：updated_at DESC, id DESC */
export const MINE_LIST_ORDER: FindOptionsOrder<ContentSubmissionEntity> = {
  updatedAt: 'DESC',
  id: 'DESC',
};

/**
 * 审核队列固定排序（A-PR0 §2.3 补充口径 7）：按最近送审时间
 * last_submitted_at DESC, id DESC。主表查询对应实体属性为 lastSubmittedAt
 * （冻结版本行内的 submitted_at 属于 revision 表，本查询不改主表列名）。
 * 类型收窄到实体排序约束：不存在的属性在编译期即失败，不依赖运行时兜底。
 */
export const REVIEW_LIST_ORDER: FindOptionsOrder<ContentSubmissionEntity> = {
  lastSubmittedAt: 'DESC',
  id: 'DESC',
};

/** 标题模糊搜索：转义 LIKE 通配符，避免用户输入 % / _ 意外扩大匹配范围 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 内容投稿本人读侧查询服务（A-PR0 §4.1 `myContentSubmissions` / `myContentSubmission`）
 *
 * 职责范围：
 * - 本人投稿列表：仅 `submitted_by_account_id + owner_organization_id` 双过滤的记录，
 *   标题关键字跨两类明细模糊匹配，支持类别/状态等值筛选，OFFSET 分页
 * - 本人投稿详情：当前稿（按类别装配明细）、当前附件安全元数据、最近审核、
 *   已发布正式资料关联（ID + 可用性）
 *
 * 不包含：
 * - 角色准入与本人归属裁决（归 usecase：本层只按传入的账号/组织过滤，
 *   读不到即 NOT_FOUND，不区分「不存在」「他人投稿」「跨组织」）
 * - 组织解析（可信组织上下文由 usecase 解析后传入）
 * - 附件文件内容与存储引用输出（storageBackend/storageReference 不进入任何视图）
 *
 * 详情读取同样服务审核链路（S5）与本人链路，但各自的权限入口必须显式：
 * 本服务不因共用方法而放宽任何调用方校验。
 */
@Injectable()
export class ContentSubmissionQueryService {
  constructor(
    @InjectRepository(ContentSubmissionEntity)
    private readonly submissionRepository: Repository<ContentSubmissionEntity>,
    @InjectRepository(MaterialSubmissionDetailEntity)
    private readonly materialDetailRepository: Repository<MaterialSubmissionDetailEntity>,
    @InjectRepository(FaultCaseSubmissionDetailEntity)
    private readonly faultCaseDetailRepository: Repository<FaultCaseSubmissionDetailEntity>,
    @InjectRepository(EquipmentModelEntity)
    private readonly equipmentModelRepository: Repository<EquipmentModelEntity>,
    @InjectRepository(ContentSubmissionAttachmentEntity)
    private readonly attachmentRepository: Repository<ContentSubmissionAttachmentEntity>,
    @InjectRepository(ContentSubmissionReviewEntity)
    private readonly reviewRepository: Repository<ContentSubmissionReviewEntity>,
    @InjectRepository(ContentSubmissionRevisionEntity)
    private readonly revisionRepository: Repository<ContentSubmissionRevisionEntity>,
    @InjectRepository(ReferenceDocumentEntity)
    private readonly referenceDocumentRepository: Repository<ReferenceDocumentEntity>,
  ) {}

  /**
   * 本人投稿列表：主表分页 + 批量装配标题（明细表 1:1）。
   *
   * 双过滤（投稿人 + 组织）必须由 usecase 传入可信值；读侧不返回他人记录、
   * 不返回半个组织范围的记录。默认含全部状态（本人列表不限定待审）。
   */
  async listMine(params: {
    submittedByAccountId: number;
    ownerOrganizationId: number;
    filter: ContentSubmissionListFilter;
    pagination: ContentSubmissionListPagination;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<
    Omit<ContentSubmissionListPage, 'items'> & { items: ContentSubmissionListItemView[] }
  > {
    const repository = this.getSubmissionRepository(params.transactionContext);
    const where: Record<string, unknown> = {
      submittedByAccountId: params.submittedByAccountId,
      ownerOrganizationId: params.ownerOrganizationId,
    };
    if (params.filter.submissionKind !== undefined) {
      where.submissionKind = params.filter.submissionKind;
    }
    if (params.filter.status !== undefined) {
      where.status = params.filter.status;
    }
    if (params.filter.title !== undefined) {
      // 标题在两类明细表中（主表无标题列）：EXISTS 命中任一明细即可；
      // 筛选值恒以参数注入（防注入），明细表名与列名为本服务固定字面量
      where.id = Raw(
        (alias) =>
          `(EXISTS (SELECT 1 FROM material_submission_detail md WHERE md.submission_id = ${alias} AND md.title LIKE :titlePattern) OR EXISTS (SELECT 1 FROM fault_case_submission_detail fd WHERE fd.submission_id = ${alias} AND fd.title LIKE :titlePattern))`,
        { titlePattern: `%${escapeLikePattern(params.filter.title)}%` },
      );
    }

    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);
    const [entities, total] = await Promise.all([
      repository.find({
        where,
        order: MINE_LIST_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      params.pagination.withTotal ? repository.count({ where }) : Promise.resolve(undefined),
    ]);
    return {
      items: await this.attachListTitles(entities, params.transactionContext),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 审核队列列表（A-PR0 §4.1 `reviewContentSubmissions`）：
   * 组织范围由 usecase 传入可信值；「默认待审」由 usecase 决定
   * （filter.status 缺省时传 'PENDING_REVIEW'），排序固定 submitted_at DESC,
   * id DESC（口径 7）；标题关键字跨两类明细模糊匹配，类别/状态等值筛选。
   */
  async listReviewQueue(params: {
    ownerOrganizationId: number;
    filter: ContentSubmissionListFilter;
    pagination: ContentSubmissionListPagination;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<
    Omit<ContentSubmissionListPage, 'items'> & { items: ContentSubmissionListItemView[] }
  > {
    const repository = this.getSubmissionRepository(params.transactionContext);
    const where: Record<string, unknown> = {
      ownerOrganizationId: params.ownerOrganizationId,
    };
    if (params.filter.submissionKind !== undefined) {
      where.submissionKind = params.filter.submissionKind;
    }
    if (params.filter.status !== undefined) {
      where.status = params.filter.status;
    }
    if (params.filter.title !== undefined) {
      // 与本人列表同口径：EXISTS 命中任一明细标题；筛选值恒以参数注入（防注入）
      where.id = Raw(
        (alias) =>
          `(EXISTS (SELECT 1 FROM material_submission_detail md WHERE md.submission_id = ${alias} AND md.title LIKE :titlePattern) OR EXISTS (SELECT 1 FROM fault_case_submission_detail fd WHERE fd.submission_id = ${alias} AND fd.title LIKE :titlePattern))`,
        { titlePattern: `%${escapeLikePattern(params.filter.title)}%` },
      );
    }

    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);
    const [entities, total] = await Promise.all([
      repository.find({
        where,
        order: REVIEW_LIST_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      params.pagination.withTotal ? repository.count({ where }) : Promise.resolve(undefined),
    ]);
    return {
      items: await this.attachListTitles(entities, params.transactionContext),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 本人投稿详情：双过滤（投稿人 + 组织）读不到统一 NOT_FOUND，
   * 不区分「不存在」「他人投稿」「跨组织」——同组织其他工程师的投稿也不是公开数据。
   *
   * 携带 transactionContext 时改用事务内 EntityManager 的 Repository，
   * 供写用例在同一事务连接上回读保存后的真实状态。
   *
   * @throws DomainError CONTENT_SUBMISSION_ERROR.NOT_FOUND / READ_FAILED
   */
  async findMineDetail(params: {
    submissionId: number;
    submittedByAccountId: number;
    ownerOrganizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<ContentSubmissionMineDetailView> {
    const repository = this.getSubmissionRepository(params.transactionContext);
    const entity = await repository.findOne({
      where: {
        id: params.submissionId,
        submittedByAccountId: params.submittedByAccountId,
        ownerOrganizationId: params.ownerOrganizationId,
      },
    });
    if (!entity) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿不存在或不可访问', {
        id: params.submissionId,
      });
    }

    const kind = entity.submissionKind as ContentSubmissionKind;
    const details = await this.loadMineDetailViews(entity.id, kind, params.transactionContext);

    const associations = await this.loadMineAssociations(entity.id, params.transactionContext);

    return {
      id: entity.id,
      submissionKind: kind,
      status: entity.status as ContentSubmissionStatus,
      currentRevisionNo: entity.currentRevisionNo,
      lastSubmittedAt: entity.lastSubmittedAt,
      publishedAt: entity.publishedAt,
      material: details.material,
      faultCase: details.faultCase,
      currentAttachment: associations.currentAttachment,
      latestReview: associations.latestReview,
      publishedDocument: associations.publishedDocument,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  /**
   * 写动作后的最小状态快照回读（写用例在事务内调用）：
   * 返回真实落库的状态事实（契约「返回真实保存状态」，不回显请求入参）。
   * 行缺失属写链路异常（刚写入的行读不到），失败关闭。
   */
  async readStatusSnapshot(params: {
    submissionId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<ContentSubmissionStatusSnapshot> {
    const entity = await this.getSubmissionRepository(params.transactionContext).findOne({
      where: { id: params.submissionId },
      select: { id: true, submissionKind: true, status: true, updatedAt: true },
    });
    if (!entity) {
      throw this.inconsistentDetailError(params.submissionId);
    }
    return {
      id: entity.id,
      submissionKind: entity.submissionKind as ContentSubmissionKind,
      status: entity.status as ContentSubmissionStatus,
      updatedAt: entity.updatedAt,
    };
  }

  /**
   * 审核发布预检事实（F3 修复配套；事务外、独立读取）：
   * 当前状态与当前版本号——用于在复制正式文件前尽早拒绝已处理请求
   * （旧版本/已流转状态），减少无效文件 I/O。
   *
   * 预检不能替代事务内行锁重核（S5.4 唯一裁决点）：预检与重核之间仍可能
   * 发生并发流转，行锁内的状态/版本重核始终是写入前的最后防线。
   * 投稿不存在（防御分支）返回 null，由调用方按 NOT_FOUND 收敛。
   */
  async findReviewPrecheckFacts(params: { submissionId: number }): Promise<{
    status: ContentSubmissionStatus;
    currentRevisionNo: number;
  } | null> {
    const entity = await this.submissionRepository.findOne({
      where: { id: params.submissionId },
      select: { id: true, status: true, currentRevisionNo: true },
    });
    if (!entity) {
      return null;
    }
    return {
      status: entity.status as ContentSubmissionStatus,
      currentRevisionNo: entity.currentRevisionNo,
    };
  }

  /**
   * 普通资料明细当前态读取（草稿更新/送审用例在事务内、主表行锁保护下调用）：
   * 返回与写入数据同形的当前值，供 usecase 合并补丁；行缺失（1:1 被破坏）失败关闭。
   *
   * 使用 `pessimistic_write` 当前读：调用方已持投稿主表行锁，但本事务更早的
   * 普通读可能已在 REPEATABLE-READ 下建立旧快照，普通 findOne 会把并发保存
   * 已提交的列覆盖回旧值。锁定读始终读取最新已提交行，锁顺序为主表 → 明细。
   */
  async readMaterialDetailForWrite(params: {
    submissionId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<MaterialSubmissionDetailWriteData> {
    const detail = await this.loadMaterialDetailEntityForWrite(
      params.submissionId,
      params.transactionContext,
    );
    return {
      title: detail.title,
      documentType: detail.documentType,
      equipmentModelId: detail.equipmentModelId,
      equipmentModelText: detail.equipmentModelText,
      description: detail.description,
      contentText: detail.contentText,
    };
  }

  /** 故障案例明细当前态读取（口径同上：事务必填 + pessimistic_write 当前读） */
  async readFaultCaseDetailForWrite(params: {
    submissionId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<FaultCaseSubmissionDetailWriteData> {
    const detail = await this.loadFaultCaseDetailEntityForWrite(
      params.submissionId,
      params.transactionContext,
    );
    return {
      title: detail.title,
      equipmentModelId: detail.equipmentModelId,
      equipmentModelText: detail.equipmentModelText,
      errorCode: detail.errorCode,
      phenomenon: detail.phenomenon,
      conditionText: detail.conditionText,
      reproductionSteps: detail.reproductionSteps,
      diagnosis: detail.diagnosis,
      actionTaken: detail.actionTaken,
      // 值域由实体 chk_fault_case_submission_detail_handling_status 约束保证
      handlingStatus: detail.handlingStatus as FaultCaseSubmissionDetailWriteData['handlingStatus'],
      resolution: detail.resolution,
    };
  }

  /**
   * 投稿访问裁决事实（下载链路）：投稿人与组织归属的最小事实读取。
   * 不抛 NOT_FOUND——不存在时返回 null，是否可访问（本人/本组织审核员）
   * 由 usecase 用可信事实裁决；本层不做任何权限判断。
   */
  async findSubmissionAccessFacts(params: {
    submissionId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<ContentSubmissionAccessFacts | null> {
    const entity = await this.getSubmissionRepository(params.transactionContext).findOne({
      where: { id: params.submissionId },
      select: { submittedByAccountId: true, ownerOrganizationId: true },
    });
    if (!entity) {
      return null;
    }
    return {
      submittedByAccountId: entity.submittedByAccountId,
      ownerOrganizationId: entity.ownerOrganizationId,
    };
  }

  /**
   * 下载目标附件引用（A-PR0 §4.2：必须校验附件属于该投稿，不只下载「当前文件」）：
   * id + submission_id 双过滤（uk_content_submission_attachment_id_submission），
   * 不按状态过滤——历史 RETIRED 原件经授权同样可下载；返回含内部存储引用，
   * 仅 usecase 中转，不进入任何 DTO/视图（客户端不得获知存储引用）。
   */
  async findAttachmentForDownload(params: {
    submissionId: number;
    attachmentId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<ContentSubmissionAttachmentDownloadRef | null> {
    const attachment = await this.getAttachmentRepository(params.transactionContext).findOne({
      where: { id: params.attachmentId, submissionId: params.submissionId },
      select: { id: true, originalFilename: true, mimeType: true, storageReference: true },
    });
    if (!attachment) {
      return null;
    }
    return {
      id: attachment.id,
      originalFilename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      storageReference: attachment.storageReference,
    };
  }

  /**
   * 当次有效附件事实（送审冻结专用当前读，A-PR0 §4.1：快照文件来自当次真实
   * 附件 ID）：只读 CURRENT 状态（行锁串行化保证最多一份），返回 null 表示
   * 纯文本投稿；不接受客户端传入附件 ID。
   *
   * 事务必填 + `pessimistic_write` 当前读：同一事务更早的普通读可能建立了
   * REPEATABLE-READ 旧快照，普通 findOne 会把已替换/已移除的旧 CURRENT 冻结
   * 进版本。锁定读读取最新已提交事实；锁顺序为主表 → 明细/附件。
   */
  async readCurrentAttachmentsForSubmit(params: {
    submissionId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<{ attachmentId: number } | null> {
    // 直接经事务 manager 取 Repository：无有效事务上下文时 fail-closed
    const manager = getTypeOrmEntityManager(params.transactionContext);
    const attachment = await manager.getRepository(ContentSubmissionAttachmentEntity).findOne({
      where: { submissionId: params.submissionId, status: 'CURRENT' },
      select: { id: true },
      order: { id: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    return attachment ? { attachmentId: attachment.id } : null;
  }

  /**
   * 附件存储引用占用核查（上传失败补偿专用，F2 修复配套）：
   * 按本次新生成的精确 storageReference 在附件表查任意状态的行——
   * CURRENT/RETIRED 都算占用（旧附件行不删除、冻结历史引用保留，
   * 行存在即不可清理）。
   *
   * 刻意不提供 transactionContext 参数：失败补偿必须通过独立于失败事务的
   * 读取获得「已提交事实」，禁止复用失败事务上下文。返回 false 只代表
   * 「此刻无引用」，是否作为终局回滚证据由 usecase 结合错误语义裁决。
   */
  async isStorageReferenceReferenced(storageReference: string): Promise<boolean> {
    const count = await this.attachmentRepository.count({ where: { storageReference } });
    return count > 0;
  }

  /**
   * 版本身份最小事实（审核裁决用）：id + submission_id 双过滤
   * （uk_content_submission_revision_id_submission），只返回版本号供
   * usecase 校验「只审当前待审版本」；不存在/不属于该投稿均返回 null，
   * 不泄露版本是否存在。
   */
  async findRevisionIdentity(params: {
    submissionId: number;
    revisionId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<{ revisionId: number; revisionNo: number } | null> {
    const revision = await this.getRevisionRepository(params.transactionContext).findOne({
      where: { id: params.revisionId, submissionId: params.submissionId },
      select: { id: true, revisionNo: true },
    });
    return revision ? { revisionId: revision.id, revisionNo: revision.revisionNo } : null;
  }

  /**
   * 冻结版本稳定视图（A-PR0 §4.1 `contentSubmissionRevision`）：
   * 读侧只装配视图，公开性由调用方 usecase 先行裁决（本层不因共用而放宽）；
   * 附件只返回安全元数据（无 storageBackend/storageReference），
   * 审核记录至多一条（uk 版本 ID 唯一）。
   */
  async findRevisionView(params: {
    submissionId: number;
    revisionNo: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<ContentSubmissionRevisionView | null> {
    const revision = await this.getRevisionRepository(params.transactionContext).findOne({
      where: { submissionId: params.submissionId, revisionNo: params.revisionNo },
    });
    if (!revision) {
      return null;
    }

    const submission = await this.getSubmissionRepository(params.transactionContext).findOne({
      where: { id: params.submissionId },
      select: { id: true, submissionKind: true },
    });
    if (!submission) {
      throw this.inconsistentDetailError(params.submissionId);
    }

    const attachment =
      revision.attachmentId !== null
        ? await this.getAttachmentRepository(params.transactionContext).findOne({
            where: { id: revision.attachmentId, submissionId: params.submissionId },
            select: {
              id: true,
              originalFilename: true,
              mimeType: true,
              byteSize: true,
              uploadedAt: true,
            },
          })
        : null;

    const review = await this.getReviewRepository(params.transactionContext).findOne({
      where: { revisionId: revision.id, submissionId: params.submissionId },
    });

    return {
      revisionId: revision.id,
      submissionId: revision.submissionId,
      submissionKind: submission.submissionKind as ContentSubmissionKind,
      revisionNo: revision.revisionNo,
      schemaVersion: revision.schemaVersion,
      titleSnapshot: revision.titleSnapshot,
      payloadSnapshot: revision.payloadSnapshot,
      attachment: attachment
        ? {
            id: attachment.id,
            originalFilename: attachment.originalFilename,
            mimeType: attachment.mimeType,
            byteSize: attachment.byteSize,
            uploadedAt: attachment.uploadedAt,
          }
        : null,
      noticeVersion: revision.noticeVersion,
      confirmedAt: revision.confirmedAt,
      submittedAt: revision.submittedAt,
      review: review
        ? {
            decision: review.decision,
            comment: review.comment,
            publishAttachment: review.publishAttachment,
            reviewedAt: review.reviewedAt,
          }
        : null,
    };
  }

  /**
   * 发布用版本来源事实（审核通过事务外的文件复制准备）：
   * revision 行冻结不可变，但事务内仍须重新锁定并核对状态/版本
   * （A-PR0 S5.4）；附件引用含内部存储引用字段，仅供 usecase 中转，
   * 绝不进入任何视图/DTO（本层不因共用而放宽）。
   */
  async findRevisionPublishSource(params: {
    submissionId: number;
    revisionId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<ContentSubmissionRevisionPublishSource | null> {
    const revision = await this.getRevisionRepository(params.transactionContext).findOne({
      where: { id: params.revisionId, submissionId: params.submissionId },
    });
    if (!revision) {
      return null;
    }

    const submission = await this.getSubmissionRepository(params.transactionContext).findOne({
      where: { id: params.submissionId },
      select: { id: true, submissionKind: true },
    });
    if (!submission) {
      throw this.inconsistentDetailError(params.submissionId);
    }

    const attachment =
      revision.attachmentId !== null
        ? await this.getAttachmentRepository(params.transactionContext).findOne({
            where: { id: revision.attachmentId, submissionId: params.submissionId },
            select: {
              id: true,
              originalFilename: true,
              mimeType: true,
              storageReference: true,
            },
          })
        : null;

    return {
      revisionId: revision.id,
      revisionNo: revision.revisionNo,
      submissionKind: submission.submissionKind as ContentSubmissionKind,
      titleSnapshot: revision.titleSnapshot,
      payloadSnapshot: revision.payloadSnapshot,
      attachment: attachment
        ? {
            id: attachment.id,
            originalFilename: attachment.originalFilename,
            mimeType: attachment.mimeType,
            storageReference: attachment.storageReference,
          }
        : null,
    };
  }

  /**
   * 审核详情（A-PR0 §4.1 `reviewContentSubmission`）：投稿基础事实 +
   * 当前版本完整视图（current_revision_no=0 时为 null）+ 全部历史审核（新在前）。
   * 公开性由调用方 usecase 先行裁决；本层不做组织过滤。
   */
  async findReviewDetail(params: {
    submissionId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<ContentSubmissionReviewDetailView | null> {
    const entity = await this.getSubmissionRepository(params.transactionContext).findOne({
      where: { id: params.submissionId },
      select: {
        id: true,
        submissionKind: true,
        status: true,
        currentRevisionNo: true,
        lastSubmittedAt: true,
        submittedByAccountId: true,
      },
    });
    if (!entity) {
      return null;
    }

    const currentRevision =
      entity.currentRevisionNo > 0
        ? await this.findRevisionView({
            submissionId: params.submissionId,
            revisionNo: entity.currentRevisionNo,
            transactionContext: params.transactionContext,
          })
        : null;

    const reviewRows = await this.getReviewRepository(params.transactionContext).find({
      where: { submissionId: params.submissionId },
      order: { reviewedAt: 'DESC', id: 'DESC' },
    });
    // 版本号批量装配：一次 IN 查询覆盖全部审核行（review.revision_id 外键保证存在，
    // 缺失属系统故障，失败关闭而不是折叠默认值）
    const revisionRows =
      reviewRows.length > 0
        ? await this.getRevisionRepository(params.transactionContext).find({
            where: {
              id: In(reviewRows.map((row) => row.revisionId)),
              submissionId: params.submissionId,
            },
            select: { id: true, revisionNo: true },
          })
        : [];
    const revisionNoById = new Map(revisionRows.map((row) => [row.id, row.revisionNo] as const));
    const reviewHistory: ContentSubmissionReviewHistoryItemView[] = reviewRows.map((row) => {
      const revisionNo = revisionNoById.get(row.revisionId);
      if (revisionNo === undefined) {
        throw this.inconsistentDetailError(params.submissionId);
      }
      return {
        revisionId: row.revisionId,
        revisionNo,
        decision: row.decision,
        comment: row.comment,
        publishAttachment: row.publishAttachment,
        reviewedAt: row.reviewedAt,
      };
    });

    return {
      submissionId: entity.id,
      submissionKind: entity.submissionKind as ContentSubmissionKind,
      status: entity.status as ContentSubmissionStatus,
      currentRevisionNo: entity.currentRevisionNo,
      lastSubmittedAt: entity.lastSubmittedAt,
      submittedByAccountId: entity.submittedByAccountId,
      currentRevision,
      reviewHistory,
    };
  }

  /**
   * 发布补偿核查（F3 修复配套）：按唯一来源投稿反查正式资料的精确文件引用
   * （含已软删——唯一来源仍占用；不加软删过滤，补偿必须能看到「正式资料
   * 引用的是哪个副本」）。
   *
   * uk_reference_document_source_submission 唯一约束保证至多一行。
   * 核查走事务外默认连接（独立于失败事务）；返回 null 表示当前无正式资料。
   */
  async findPublishedDocumentFileRefBySourceSubmission(params: { submissionId: number }): Promise<{
    documentId: number;
    storageReference: string | null;
  } | null> {
    const document = await this.referenceDocumentRepository.findOne({
      where: { sourceSubmissionId: params.submissionId },
      select: { id: true, storageReference: true },
    });
    if (!document) {
      return null;
    }
    return { documentId: document.id, storageReference: document.storageReference };
  }

  /** 列表项标题批量装配：两条 IN 查询覆盖全部行，避免逐行读取（明细 1:1，缺失折叠为 null） */
  private async attachListTitles(
    entities: readonly ContentSubmissionEntity[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<ContentSubmissionListItemView[]> {
    if (entities.length === 0) {
      return [];
    }
    const materialIds = entities
      .filter((entity) => entity.submissionKind === 'MATERIAL')
      .map((entity) => entity.id);
    const faultCaseIds = entities
      .filter((entity) => entity.submissionKind === 'FAULT_CASE')
      .map((entity) => entity.id);
    const [materialRows, faultCaseRows] = await Promise.all([
      materialIds.length > 0
        ? this.getMaterialDetailRepository(transactionContext).find({
            where: { submissionId: In(materialIds) },
            select: { submissionId: true, title: true },
          })
        : Promise.resolve([]),
      faultCaseIds.length > 0
        ? this.getFaultCaseDetailRepository(transactionContext).find({
            where: { submissionId: In(faultCaseIds) },
            select: { submissionId: true, title: true },
          })
        : Promise.resolve([]),
    ]);
    const materialTitles = new Map(
      materialRows.map((row) => [row.submissionId, row.title] as const),
    );
    const faultCaseTitles = new Map(
      faultCaseRows.map((row) => [row.submissionId, row.title] as const),
    );

    return entities.map((entity) => ({
      id: entity.id,
      title:
        (entity.submissionKind === 'MATERIAL'
          ? materialTitles.get(entity.id)
          : faultCaseTitles.get(entity.id)) ?? null,
      submissionKind: entity.submissionKind as ContentSubmissionKind,
      status: entity.status as ContentSubmissionStatus,
      currentRevisionNo: entity.currentRevisionNo,
      lastSubmittedAt: entity.lastSubmittedAt,
      updatedAt: entity.updatedAt,
      createdAt: entity.createdAt,
    }));
  }

  /** 1:1 明细行缺失属数据不定式被破坏：失败关闭（系统侧），不静默返回残缺视图 */
  private inconsistentDetailError(submissionId: number): DomainError {
    return new DomainError(CONTENT_SUBMISSION_ERROR.READ_FAILED, '投稿数据读取失败，请稍后重试', {
      id: submissionId,
    });
  }

  /**
   * 按类别装载本人详情明细视图并装配机型名（1:1 明细缺失失败关闭）；
   * 与写用例的事务回读同连接（transactionContext 透传）。
   */
  private async loadMineDetailViews(
    submissionId: number,
    kind: ContentSubmissionKind,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{
    material: MaterialSubmissionDetailView | null;
    faultCase: FaultCaseSubmissionDetailView | null;
  }> {
    let material: MaterialSubmissionDetailView | null = null;
    let faultCase: FaultCaseSubmissionDetailView | null = null;
    let equipmentModelId: number | null;
    if (kind === 'MATERIAL') {
      const detail = await this.loadMaterialDetailEntity(submissionId, transactionContext);
      material = {
        title: detail.title,
        documentType: detail.documentType,
        equipmentModelId: detail.equipmentModelId,
        equipmentModelName: null,
        equipmentModelText: detail.equipmentModelText,
        description: detail.description,
        contentText: detail.contentText,
      };
      equipmentModelId = detail.equipmentModelId;
    } else {
      const detail = await this.loadFaultCaseDetailEntity(submissionId, transactionContext);
      faultCase = {
        title: detail.title,
        equipmentModelId: detail.equipmentModelId,
        equipmentModelName: null,
        equipmentModelText: detail.equipmentModelText,
        errorCode: detail.errorCode,
        phenomenon: detail.phenomenon,
        conditionText: detail.conditionText,
        reproductionSteps: detail.reproductionSteps,
        diagnosis: detail.diagnosis,
        actionTaken: detail.actionTaken,
        handlingStatus: detail.handlingStatus,
        resolution: detail.resolution,
      };
      equipmentModelId = detail.equipmentModelId;
    }

    const model =
      equipmentModelId !== null
        ? await this.getEquipmentModelRepository(transactionContext).findOne({
            where: { id: equipmentModelId },
          })
        : null;
    const equipmentModelName = model?.modelName ?? null;
    if (material) {
      material.equipmentModelName = equipmentModelName;
    }
    if (faultCase) {
      faultCase.equipmentModelName = equipmentModelName;
    }
    return { material, faultCase };
  }

  /** 当前附件安全元数据 / 最近审核 / 已发布正式资料关联（本人详情装配段） */
  private async loadMineAssociations(
    submissionId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{
    currentAttachment: ContentSubmissionAttachmentMetaView | null;
    latestReview: ContentSubmissionLatestReviewView | null;
    publishedDocument: ContentSubmissionPublishedDocumentView | null;
  }> {
    const attachment = await this.getAttachmentRepository(transactionContext).findOne({
      where: { submissionId, status: 'CURRENT' },
      order: { id: 'DESC' },
    });
    const latestReview = await this.getReviewRepository(transactionContext).findOne({
      where: { submissionId },
      order: { reviewedAt: 'DESC', id: 'DESC' },
    });
    // 已发布正式资料关联：来源投稿唯一（uk_reference_document_source_submission），
    // 软删后仍保留回链——available 表达「已下架」（A-PR0 §4.3：已下架资料不再通过库查询/下载返回）
    const publishedDocument = await this.getReferenceDocumentRepository(transactionContext).findOne(
      {
        where: { sourceSubmissionId: submissionId },
        select: { id: true, deprecated: true },
      },
    );
    return {
      currentAttachment: attachment
        ? {
            id: attachment.id,
            originalFilename: attachment.originalFilename,
            mimeType: attachment.mimeType,
            byteSize: attachment.byteSize,
            uploadedAt: attachment.uploadedAt,
          }
        : null,
      latestReview: latestReview
        ? {
            decision: latestReview.decision,
            comment: latestReview.comment,
            publishAttachment: latestReview.publishAttachment,
            reviewedAt: latestReview.reviewedAt,
          }
        : null,
      publishedDocument: publishedDocument
        ? { documentId: publishedDocument.id, available: !publishedDocument.deprecated }
        : null,
    };
  }

  /** 普通资料明细实体读取（普通详情/列表读，无锁）：行缺失（1:1 被破坏）失败关闭 */
  private async loadMaterialDetailEntity(
    submissionId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaterialSubmissionDetailEntity> {
    const detail = await this.getMaterialDetailRepository(transactionContext).findOne({
      where: { submissionId },
    });
    if (!detail) {
      throw this.inconsistentDetailError(submissionId);
    }
    return detail;
  }

  /** 故障案例明细实体读取（普通详情/列表读，无锁）：口径同上 */
  private async loadFaultCaseDetailEntity(
    submissionId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<FaultCaseSubmissionDetailEntity> {
    const detail = await this.getFaultCaseDetailRepository(transactionContext).findOne({
      where: { submissionId },
    });
    if (!detail) {
      throw this.inconsistentDetailError(submissionId);
    }
    return detail;
  }

  /** 写前普通资料明细当前读（事务必填，pessimistic_write）：行缺失失败关闭 */
  private async loadMaterialDetailEntityForWrite(
    submissionId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaterialSubmissionDetailEntity> {
    // 直接经事务 manager 取 Repository：无有效事务上下文时 fail-closed
    const manager = getTypeOrmEntityManager(transactionContext);
    const detail = await manager.getRepository(MaterialSubmissionDetailEntity).findOne({
      where: { submissionId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!detail) {
      throw this.inconsistentDetailError(submissionId);
    }
    return detail;
  }

  /** 写前故障案例明细当前读（口径同上） */
  private async loadFaultCaseDetailEntityForWrite(
    submissionId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<FaultCaseSubmissionDetailEntity> {
    // 直接经事务 manager 取 Repository：无有效事务上下文时 fail-closed
    const manager = getTypeOrmEntityManager(transactionContext);
    const detail = await manager.getRepository(FaultCaseSubmissionDetailEntity).findOne({
      where: { submissionId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!detail) {
      throw this.inconsistentDetailError(submissionId);
    }
    return detail;
  }

  private getSubmissionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ContentSubmissionEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(ContentSubmissionEntity) : this.submissionRepository;
  }

  private getMaterialDetailRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<MaterialSubmissionDetailEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(MaterialSubmissionDetailEntity)
      : this.materialDetailRepository;
  }

  private getFaultCaseDetailRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<FaultCaseSubmissionDetailEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(FaultCaseSubmissionDetailEntity)
      : this.faultCaseDetailRepository;
  }

  private getEquipmentModelRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<EquipmentModelEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(EquipmentModelEntity) : this.equipmentModelRepository;
  }

  private getAttachmentRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ContentSubmissionAttachmentEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ContentSubmissionAttachmentEntity)
      : this.attachmentRepository;
  }

  private getReviewRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ContentSubmissionReviewEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(ContentSubmissionReviewEntity) : this.reviewRepository;
  }

  private getRevisionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ContentSubmissionRevisionEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ContentSubmissionRevisionEntity)
      : this.revisionRepository;
  }

  private getReferenceDocumentRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ReferenceDocumentEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ReferenceDocumentEntity)
      : this.referenceDocumentRepository;
  }
}
