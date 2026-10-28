// src/modules/lithography/content-submission.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  CONTENT_SUBMISSION_ERROR,
  DomainError,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import {
  ContentSubmissionAttachmentInsertData,
  ContentSubmissionAttachmentUploadSnapshot,
  ContentSubmissionInsertData,
  ContentSubmissionKind,
  ContentSubmissionLockSnapshot,
  ContentSubmissionReviewInsertData,
  ContentSubmissionRevisionInsertData,
  ContentSubmissionStatus,
  FaultCaseSubmissionDetailWriteData,
  MaterialSubmissionDetailWriteData,
} from './content-submission.types';
import { ContentSubmissionAttachmentEntity } from './entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from './entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from './entities/content-submission-review.entity';
import { ContentSubmissionRevisionEntity } from './entities/content-submission-revision.entity';
import { FaultCaseSubmissionDetailEntity } from './entities/fault-case-submission-detail.entity';
import { MaterialSubmissionDetailEntity } from './entities/material-submission-detail.entity';

/**
 * 内容投稿写服务（A-PR0 计划 §2.2/§3.1）
 *
 * 职责范围：
 * - 草稿原子创建：投稿主表 + 对应类别明细同事务写入（1:1，主键即外键）
 * - 状态敏感动作的投稿行锁读取（pessimistic_write）：更新前锁定并重新校验当前状态，
 *   避免并发送审后仍写草稿（§3.3：持有投稿行锁串行化状态敏感动作）
 * - 明细全量覆盖更新（草稿更新：写入数据由 usecase 完成补丁合并与全部校验），
 *   并同事务触碰主表 updated_at（列表排序按主表 updated_at DESC 的口径依赖此）
 * - 单附件变更（上传/替换/移除）：先退役旧 CURRENT 再登记新 CURRENT（§3.3），
 *   与调用方的草稿状态检查在同一事务；调用方已持投稿行锁串行化附件变更
 * - 送审冻结与审核写入（S4）：完整快照插入（revision）+ 主状态流转
 *   （送审/退回）+ 审核记录插入；版本号与状态均由调用方在行锁内裁决后传入
 *
 * 不包含：
 * - 权限判断、输入规范化、补丁合并、状态可编辑性裁决（归 usecase）
 * - 组织解析（可信组织上下文由 usecase 解析后传入，本层不接受客户端自报）
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有）
 * - 文件存储 I/O 与失败补偿编排（归 usecase：附件行只落元数据与存储引用）
 */
@Injectable()
export class ContentSubmissionService {
  constructor(
    @InjectRepository(ContentSubmissionEntity)
    private readonly submissionRepository: Repository<ContentSubmissionEntity>,
    @InjectRepository(MaterialSubmissionDetailEntity)
    private readonly materialDetailRepository: Repository<MaterialSubmissionDetailEntity>,
    @InjectRepository(FaultCaseSubmissionDetailEntity)
    private readonly faultCaseDetailRepository: Repository<FaultCaseSubmissionDetailEntity>,
    @InjectRepository(ContentSubmissionAttachmentEntity)
    private readonly attachmentRepository: Repository<ContentSubmissionAttachmentEntity>,
    @InjectRepository(ContentSubmissionRevisionEntity)
    private readonly revisionRepository: Repository<ContentSubmissionRevisionEntity>,
    @InjectRepository(ContentSubmissionReviewEntity)
    private readonly reviewRepository: Repository<ContentSubmissionReviewEntity>,
  ) {}

  /**
   * 草稿原子创建：主表 + 明细同事务写入。
   *
   * 初始状态由本方法统一保证：`status = 'DRAFT'`、`current_revision_no = 0`、
   * `last_submitted_at` / `published_at` 为 NULL（实体
   * `chk_content_submission_revision_consistency` / `chk_content_submission_publish_consistency` 兜底）。
   * 创建人 / 组织由 usecase 从可信来源传入，本层不复核也不推断。
   *
   * @param data 已完成业务判定的写入数据
   * @param transactionContext 事务上下文（必须，主表与明细同成同败）
   * @returns 写入完成后的投稿主键
   */
  async insertSubmission(
    data: ContentSubmissionInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ submissionId: number }> {
    this.assertDetailMatchesKind(data);
    try {
      const submissionRepository = this.getSubmissionRepository(transactionContext);
      const submission = await submissionRepository.save(
        submissionRepository.create({
          submissionKind: data.submissionKind,
          ownerOrganizationId: data.ownerOrganizationId,
          submittedByAccountId: data.submittedByAccountId,
          status: 'DRAFT',
          currentRevisionNo: 0,
          lastSubmittedAt: null,
          publishedAt: null,
        }),
      );

      if (data.submissionKind === 'MATERIAL') {
        const repository = this.getMaterialDetailRepository(transactionContext);
        const detail = data.material as MaterialSubmissionDetailWriteData;
        await repository.save(
          repository.create({
            submissionId: submission.id,
            title: detail.title,
            documentType: detail.documentType,
            equipmentModelId: detail.equipmentModelId,
            equipmentModelText: detail.equipmentModelText,
            description: detail.description,
            contentText: detail.contentText,
          }),
        );
      } else {
        const repository = this.getFaultCaseDetailRepository(transactionContext);
        const detail = data.faultCase as FaultCaseSubmissionDetailWriteData;
        await repository.save(
          repository.create({
            submissionId: submission.id,
            title: detail.title,
            equipmentModelId: detail.equipmentModelId,
            equipmentModelText: detail.equipmentModelText,
            errorCode: detail.errorCode,
            phenomenon: detail.phenomenon,
            conditionText: detail.conditionText,
            reproductionSteps: detail.reproductionSteps,
            diagnosis: detail.diagnosis,
            actionTaken: detail.actionTaken,
            handlingStatus: detail.handlingStatus,
            resolution: detail.resolution,
          }),
        );
      }
      return { submissionId: submission.id };
    } catch (error) {
      // 客户端可见的 details 不得携带原始数据库错误（可能含表名/约束/输入内容）；
      // 底层异常仅以 cause 保留供服务端日志与排查使用
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
        '投稿草稿创建失败，请稍后重试',
        { submissionKind: data.submissionKind },
        error,
      );
    }
  }

  /**
   * 投稿行锁读取（pessimistic_write）：状态敏感写动作在事务内的统一入口。
   *
   * 只返回裁决所需的最小事实（类别/组织/投稿人/当前状态），不做权限、
   * 组织归属或可编辑性判断（归 usecase，失败关闭）。行锁把「校验当前状态」
   * 与「后续写入」串行化：并发送审与并发编辑不会互相穿透。
   *
   * @param submissionId 目标投稿主键
   * @param transactionContext 事务上下文（必须与后续写入同事务，否则锁立即释放）
   * @returns 最小锁定事实；投稿不存在时为 null
   */
  async lockSubmissionForWrite(
    submissionId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ContentSubmissionLockSnapshot | null> {
    try {
      const repository = this.getSubmissionRepository(transactionContext);
      const entity = await repository.findOne({
        where: { id: submissionId },
        select: {
          id: true,
          submissionKind: true,
          ownerOrganizationId: true,
          submittedByAccountId: true,
          status: true,
          currentRevisionNo: true,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entity) {
        return null;
      }
      return {
        id: entity.id,
        // 值域由实体 chk_content_submission_kind / chk_content_submission_status 约束保证
        submissionKind: entity.submissionKind as ContentSubmissionKind,
        ownerOrganizationId: entity.ownerOrganizationId,
        submittedByAccountId: entity.submittedByAccountId,
        status: entity.status as ContentSubmissionStatus,
        currentRevisionNo: entity.currentRevisionNo,
      };
    } catch (error) {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
        '投稿更新失败，请稍后重试',
        { submissionId },
        error,
      );
    }
  }

  /**
   * 普通资料明细全量覆盖更新 + 主表 updated_at 触碰（同事务）。
   *
   * 全列写入：usecase 已把行锁内读到的当前明细与补丁合并为完整状态，
   * 本层不做 undefined/null 语义再解释（写入数据全部已是最终列值）。
   * 明细行缺失（1:1 不定式被破坏）按系统故障防御，不猜测业务语义。
   */
  async updateMaterialSubmissionDetail(params: {
    submissionId: number;
    detail: MaterialSubmissionDetailWriteData;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    await this.runDetailUpdate(params.submissionId, params.transactionContext, async () => {
      const repository = this.getMaterialDetailRepository(params.transactionContext);
      const result = await repository.update(
        { submissionId: params.submissionId },
        {
          title: params.detail.title,
          documentType: params.detail.documentType,
          equipmentModelId: params.detail.equipmentModelId,
          equipmentModelText: params.detail.equipmentModelText,
          description: params.detail.description,
          contentText: params.detail.contentText,
        },
      );
      return result.affected ?? 0;
    });
  }

  /** 故障案例明细全量覆盖更新 + 主表 updated_at 触碰（同事务）；口径同上 */
  async updateFaultCaseSubmissionDetail(params: {
    submissionId: number;
    detail: FaultCaseSubmissionDetailWriteData;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    await this.runDetailUpdate(params.submissionId, params.transactionContext, async () => {
      const repository = this.getFaultCaseDetailRepository(params.transactionContext);
      const result = await repository.update(
        { submissionId: params.submissionId },
        {
          title: params.detail.title,
          equipmentModelId: params.detail.equipmentModelId,
          equipmentModelText: params.detail.equipmentModelText,
          errorCode: params.detail.errorCode,
          phenomenon: params.detail.phenomenon,
          conditionText: params.detail.conditionText,
          reproductionSteps: params.detail.reproductionSteps,
          diagnosis: params.detail.diagnosis,
          actionTaken: params.detail.actionTaken,
          handlingStatus: params.detail.handlingStatus,
          resolution: params.detail.resolution,
        },
      );
      return result.affected ?? 0;
    });
  }

  /**
   * 附件登记（上传/替换，A-PR0 §4.2/§3.3）：先退役旧 CURRENT 再登记新 CURRENT，
   * 与调用方的草稿状态检查在同一事务；调用方已持投稿行锁串行化附件变更
   * （T08：并发替换后最多一个 CURRENT）。
   *
   * 历史冻结引用保留：退役只改数据库标记与退役时间，不删除存储文件。
   * 存储引用由 usecase 在授权/状态校验通过后编排生成（本层不接触文件 I/O）。
   * 落库失败全部收敛为 CREATION_FAILED（附件登记属创建语义）；
   * 调用方负责补偿删除本次新生成、尚未被任何冻结版本引用的存储文件。
   */
  async replaceCurrentAttachment(
    data: ContentSubmissionAttachmentInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ContentSubmissionAttachmentUploadSnapshot> {
    try {
      const repository = this.getAttachmentRepository(transactionContext);
      // 条件式退役：行锁串行化保证最多一份 CURRENT；UPDATE 对历史行宽容（全部退役）
      await repository.update(
        { submissionId: data.submissionId, status: 'CURRENT' },
        { status: 'RETIRED', retiredAt: () => 'CURRENT_TIMESTAMP(3)' },
      );
      const saved = await repository.save(
        repository.create({
          submissionId: data.submissionId,
          originalFilename: data.originalFilename,
          mimeType: data.mimeType,
          byteSize: data.byteSize,
          storageBackend: data.storageBackend,
          storageReference: data.storageReference,
          uploadedByAccountId: data.uploadedByAccountId,
          status: 'CURRENT',
          retiredAt: null,
        }),
      );
      await this.touchSubmissionUpdatedAt(data.submissionId, transactionContext);
      return {
        attachmentId: saved.id,
        originalFilename: data.originalFilename,
        mimeType: data.mimeType,
        byteSize: data.byteSize,
      };
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
        '附件保存失败，请稍后重试',
        { submissionId: data.submissionId },
        error,
      );
    }
  }

  /**
   * 当前附件退役（移除，A-PR0 §4.2）：只退役数据库记录，不删除存储文件
   * （历史冻结引用保留）；无 CURRENT 附件时幂等成功（retired=false）；
   * 仅在实际退役时触碰主表 updated_at（无变化不产生排序时间噪声）。
   */
  async retireCurrentAttachment(params: {
    submissionId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<{ retired: boolean }> {
    try {
      const repository = this.getAttachmentRepository(params.transactionContext);
      const result = await repository.update(
        { submissionId: params.submissionId, status: 'CURRENT' },
        { status: 'RETIRED', retiredAt: () => 'CURRENT_TIMESTAMP(3)' },
      );
      const retired = (result.affected ?? 0) > 0;
      if (retired) {
        await this.touchSubmissionUpdatedAt(params.submissionId, params.transactionContext);
      }
      return { retired };
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
        '附件移除失败，请稍后重试',
        { submissionId: params.submissionId },
        error,
      );
    }
  }

  /**
   * 版本快照插入（A-PR0 §4.1 送审/重提）：调用方已持投稿行锁并完成状态裁决，
   * 版本号由调用方按锁内 current_revision_no + 1 传入（uk 投稿+版本号 兜底）。
   * confirmed_at / submitted_at 使用数据库时钟（系统事件时间，与既有写入口径一致）；
   * 冻结后不允许更新——本服务不提供任何版本更新方法。
   */
  async insertRevision(
    data: ContentSubmissionRevisionInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ revisionId: number }> {
    try {
      const repository = this.getRevisionRepository(transactionContext);
      const result = await repository.insert({
        submissionId: data.submissionId,
        revisionNo: data.revisionNo,
        // TypeORM 对 JSON 列的 QueryDeepPartialEntity 深度映射不接受 unknown 值类型；
        // 快照已由 usecase 组装为可 JSON 序列化的纯对象字面量，此处仅收窄类型
        payloadSnapshot: data.payloadSnapshot as Record<string, never>,
        schemaVersion: data.schemaVersion,
        titleSnapshot: data.titleSnapshot,
        attachmentId: data.attachmentId,
        noticeVersion: data.noticeVersion,
        confirmedByAccountId: data.confirmedByAccountId,
        confirmedAt: () => 'CURRENT_TIMESTAMP(3)',
        submittedAt: () => 'CURRENT_TIMESTAMP(3)',
      });
      const revisionId = result.identifiers[0]?.id as number | undefined;
      if (typeof revisionId !== 'number') {
        throw new DomainError(
          CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
          '送审版本保存失败，请稍后重试',
          {
            submissionId: data.submissionId,
          },
        );
      }
      return { revisionId };
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
        '送审版本保存失败，请稍后重试',
        { submissionId: data.submissionId },
        error,
      );
    }
  }

  /**
   * 主状态流转为待审（送审/重提）：status + current_revision_no + last_submitted_at
   * 一次性写入（实体 chk_content_submission_revision_consistency 要求三者同变）。
   * 调用方持行锁并已裁决 DRAFT/RETURNED，此处不再重复状态条件。
   */
  async markSubmissionPendingReview(params: {
    submissionId: number;
    revisionNo: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    try {
      const result = await this.getSubmissionRepository(params.transactionContext).update(
        { id: params.submissionId },
        {
          status: 'PENDING_REVIEW',
          currentRevisionNo: params.revisionNo,
          lastSubmittedAt: () => 'CURRENT_TIMESTAMP(3)',
          updatedAt: () => 'CURRENT_TIMESTAMP(3)',
        },
      );
      if ((result.affected ?? 0) !== 1) {
        throw new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '投稿送审失败，请稍后重试', {
          submissionId: params.submissionId,
        });
      }
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
        '投稿送审失败，请稍后重试',
        { submissionId: params.submissionId },
        error,
      );
    }
  }

  /**
   * 主状态流转为已退回：只改状态与 updated_at；last_submitted_at、
   * current_revision_no 与 published_at 均保持（退回不撤销送审事实与版本号）。
   */
  async markSubmissionReturned(params: {
    submissionId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    try {
      const result = await this.getSubmissionRepository(params.transactionContext).update(
        { id: params.submissionId },
        { status: 'RETURNED', updatedAt: () => 'CURRENT_TIMESTAMP(3)' },
      );
      if ((result.affected ?? 0) !== 1) {
        throw new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '投稿退回失败，请稍后重试', {
          submissionId: params.submissionId,
        });
      }
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
        '投稿退回失败，请稍后重试',
        { submissionId: params.submissionId },
        error,
      );
    }
  }

  /**
   * 主状态流转为已发布：status=PUBLISHED + published_at + updated_at 同语句写入。
   *
   * 不回写快照（PUBLISHED 只读本人投稿与获准版本）；正式资料关联由
   * reference_document.source_submission_id 唯一来源反查承担（本表不冗余列，
   * 也保证发布事实与正式资料插入同事务一致）。
   */
  async markSubmissionPublished(params: {
    submissionId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<void> {
    try {
      const result = await this.getSubmissionRepository(params.transactionContext).update(
        { id: params.submissionId },
        {
          status: 'PUBLISHED',
          publishedAt: () => 'CURRENT_TIMESTAMP(3)',
          updatedAt: () => 'CURRENT_TIMESTAMP(3)',
        },
      );
      if ((result.affected ?? 0) !== 1) {
        throw new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '投稿发布失败，请稍后重试', {
          submissionId: params.submissionId,
        });
      }
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
        '投稿发布失败，请稍后重试',
        { submissionId: params.submissionId },
        error,
      );
    }
  }

  /**
   * 审核记录插入（A-PR0 §3.1）：版本 ID 唯一（uk 复核同一版本不可重复审核）；
   * 调用方已裁决「仅当前待审版本」；退回理由必填与退回 publish=false
   * 由实体 CHECK 兜底。
   */
  async insertReview(
    data: ContentSubmissionReviewInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ reviewId: number }> {
    try {
      const repository = this.getReviewRepository(transactionContext);
      const result = await repository.insert({
        submissionId: data.submissionId,
        revisionId: data.revisionId,
        decision: data.decision,
        reviewedByAccountId: data.reviewedByAccountId,
        comment: data.comment,
        publishAttachment: data.publishAttachment,
        reviewedAt: () => 'CURRENT_TIMESTAMP(3)',
      });
      const reviewId = result.identifiers[0]?.id as number | undefined;
      if (typeof reviewId !== 'number') {
        throw new DomainError(
          CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
          '审核记录保存失败，请稍后重试',
          {
            submissionId: data.submissionId,
          },
        );
      }
      return { reviewId };
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
        '审核记录保存失败，请稍后重试',
        { submissionId: data.submissionId },
        error,
      );
    }
  }

  /** 明细写入的统一防御与错误收敛：affected != 1 与驱动异常都收敛为 UPDATE_FAILED */
  private async runDetailUpdate(
    submissionId: number,
    transactionContext: PersistenceTransactionContext,
    execute: () => Promise<number>,
  ): Promise<void> {
    try {
      const affected = await execute();
      if (affected !== 1) {
        throw new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '投稿更新失败，请稍后重试', {
          submissionId,
        });
      }
      await this.touchSubmissionUpdatedAt(submissionId, transactionContext);
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
        '投稿更新失败，请稍后重试',
        { submissionId },
        error,
      );
    }
  }

  /**
   * 触碰主表 updated_at：明细更新在另一张表，主表 updated_at 不会随之变化，
   * 而「本人列表按 updated_at DESC, id DESC」的口径依赖主表时间。
   * 使用数据库时钟（CURRENT_TIMESTAMP(3)）与既有软删除写入口径一致。
   */
  private async touchSubmissionUpdatedAt(
    submissionId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getSubmissionRepository(transactionContext);
    const result = await repository.update(
      { id: submissionId },
      { updatedAt: () => 'CURRENT_TIMESTAMP(3)' },
    );
    if ((result.affected ?? 0) !== 1) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '投稿更新失败，请稍后重试', {
        submissionId,
      });
    }
  }

  /** 创建数据的类别与明细匹配防御：两类明细恰好一个非 null 且与 kind 对应 */
  private assertDetailMatchesKind(data: ContentSubmissionInsertData): void {
    const expectedPresent = data.submissionKind === 'MATERIAL' ? data.material : data.faultCase;
    const unexpectedPresent = data.submissionKind === 'MATERIAL' ? data.faultCase : data.material;
    if (expectedPresent === null || unexpectedPresent !== null) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '投稿类别与明细数据不匹配', {
        submissionKind: data.submissionKind,
      });
    }
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

  private getAttachmentRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ContentSubmissionAttachmentEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ContentSubmissionAttachmentEntity)
      : this.attachmentRepository;
  }

  private getRevisionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ContentSubmissionRevisionEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(ContentSubmissionRevisionEntity)
      : this.revisionRepository;
  }

  private getReviewRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ContentSubmissionReviewEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(ContentSubmissionReviewEntity) : this.reviewRepository;
  }
}
