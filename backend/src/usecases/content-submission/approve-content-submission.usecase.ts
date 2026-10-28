// src/usecases/content-submission/approve-content-submission.usecase.ts

import * as path from 'node:path';
import type { Readable } from 'node:stream';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONTENT_SUBMISSION_HANDLING_STATUSES,
  type ContentSubmissionAttachmentPublishRef,
  type ContentSubmissionHandlingStatus,
  type ContentSubmissionRevisionPublishSource,
  type FaultCaseSubmissionDetailWriteData,
  type MaterialSubmissionDetailWriteData,
} from '@src/modules/lithography/content-submission.types';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { ReferenceDocumentCaseDetailService } from '@src/modules/lithography/reference-document-case-detail.service';
import { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import {
  CONTENT_SUBMISSION_ATTACHMENT_STORAGE,
  type ContentSubmissionAttachmentStorage,
} from './content-submission-attachment-storage.contract';
import {
  CONTENT_SUBMISSION_FAULT_CASE_TYPE,
  formatFaultCaseReferenceContent,
  normalizeOptionalReviewComment,
} from './content-submission-fields.normalize';
import { lockReviewableSubmissionAndAssertRevision } from './content-submission-review-guard';
import {
  assertContentSubmissionReviewRole,
  assertRevisionIdValid,
  assertSubmissionIdValid,
} from './content-submission-roles';
import {
  ApproveContentSubmissionCommand,
  ContentSubmissionReviewDecisionResult,
} from './content-submission.types';

/**
 * 发布字段：送审校验保证的必填字段在类型层面收窄，供正式写入直接消费；
 * 可空语义只在草稿/快照边界存在，发布链路不再重新解释。
 */
type ApprovedMaterialFields = Omit<MaterialSubmissionDetailWriteData, 'title' | 'documentType'> & {
  title: string;
  documentType: string;
};

type ApprovedFaultCaseFields = Omit<
  FaultCaseSubmissionDetailWriteData,
  'title' | 'phenomenon' | 'reproductionSteps' | 'handlingStatus'
> & {
  title: string;
  phenomenon: string;
  reproductionSteps: string;
  handlingStatus: ContentSubmissionHandlingStatus;
};

/** 冻结快照解析结果：正式正文计划值 + 按类别的明细字段（恰好一类非 null） */
type ParsedApprovedPayload = {
  contentText: string | null;
  material: ApprovedMaterialFields | null;
  faultCase: ApprovedFaultCaseFields | null;
};

/**
 * 审核通过（唯一发布）用例（A-PR0 §4.1 `reviewContentSubmissionDecision`
 * 的 APPROVE 分支；S5）
 *
 * 业务流程（顺序即安全边界）：
 * 1. 角色决策：仅真实 SUPER_ADMIN（精确匹配 activeRole）；通过意见可选
 *    （空白折叠为 null）；publishAttachment 必须为布尔值
 * 2. 组织范围先解析（先于任何读与文件 I/O）：跨组织/不存在统一 NOT_FOUND
 * 3. 版本来源事实：revision 行冻结不可变；发布决定校验——无文件版本
 *    publishAttachment 只能为 false（S5.1）；正文缺失的资料必须发布附件，
 *    否则正式资料将没有内容来源（S5.1）
 * 4. 复制前预检（F3，事务外独立读取）：旧版本/已流转状态在触盘前拒绝，
 *    不产生文件 I/O；预检只减少无效复制，不替代事务内行锁重核
 * 5. 文件发布准备（事务外、授权通过后才触盘）：打开当次获准原件流 →
 *    复制为新正式存储引用；来源不可用/保存失败受控收敛。正式下载永远指向
 *    本次复制的新引用，不会指向可变当前草稿文件（S5.3）
 * 6. 事务内重核后才写入（S5.4）：行锁重核投稿状态仍为待审、目标版本仍是
 *    当前版本（并发两次审批最多一次成功，失败方 STATE_NOT_EDITABLE）；
 *    插入唯一审核记录（uk 版本唯一）→ 插入正式资料（ingest_method=
 *    REVIEWED_SUBMISSION + 唯一来源回链；案例另插结构化明细并由同一份
 *    字段生成可读正文）→ 投稿流转 PUBLISHED（同事务）
 * 7. 失败补偿（F3）：按唯一来源反查正式资料的精确文件引用（含软删）与
 *    本次副本比对——本次副本被引用则保留；确定未引用且回调未完成则精确
 *    清理；提交终局不明/核查失败则保留并记录待核查（S5.5）
 */
@Injectable()
export class ApproveContentSubmissionUsecase {
  private readonly logger = new Logger(ApproveContentSubmissionUsecase.name);

  constructor(
    private readonly contentSubmissionService: ContentSubmissionService,
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly referenceDocumentService: ReferenceDocumentService,
    private readonly referenceDocumentCaseDetailService: ReferenceDocumentCaseDetailService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(CONTENT_SUBMISSION_ATTACHMENT_STORAGE)
    private readonly storage: ContentSubmissionAttachmentStorage,
  ) {}

  async execute(
    command: ApproveContentSubmissionCommand,
  ): Promise<ContentSubmissionReviewDecisionResult> {
    assertContentSubmissionReviewRole(command.session);
    assertSubmissionIdValid(command.submissionId);
    assertRevisionIdValid(command.revisionId);
    if (typeof command.publishAttachment !== 'boolean') {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '发布附件决定必须为布尔值');
    }
    const comment = normalizeOptionalReviewComment(command.comment);

    // 组织范围先解析（先于任何读与文件 I/O）：无有效成员关系/多关系歧义在此拒绝
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    const facts = await this.contentSubmissionQueryService.findSubmissionAccessFacts({
      submissionId: command.submissionId,
    });
    if (facts === null || facts.ownerOrganizationId !== membership.organizationId) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿不存在或不可审核', {
        id: command.submissionId,
      });
    }

    // 版本来源（revision 冻结不可变；事务内仍会行锁重核状态与版本归属）
    const source = await this.contentSubmissionQueryService.findRevisionPublishSource({
      submissionId: command.submissionId,
      revisionId: command.revisionId,
    });
    if (source === null) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿版本不存在或不可审核', {
        submissionId: command.submissionId,
        revisionId: command.revisionId,
      });
    }

    // 发布决定与内容来源校验（S5.1）
    if (command.publishAttachment && source.attachment === null) {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
        '该版本没有附件，不能选择发布附件',
      );
    }
    const parsed = this.parseApprovedPayload(source);
    if (parsed.contentText === null && !command.publishAttachment) {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
        '仅附件资料必须选择发布附件，否则正式资料没有内容来源',
      );
    }

    // 复制前预检（F3；事务外独立读取）：已处理请求在触盘前拒绝。
    // 与事务内重核同一错误口径；预检不替代事务内行锁重核（S5.4）
    const precheck = await this.contentSubmissionQueryService.findReviewPrecheckFacts({
      submissionId: command.submissionId,
    });
    if (precheck === null) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿不存在或不可审核', {
        id: command.submissionId,
      });
    }
    if (precheck.status !== 'PENDING_REVIEW') {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE, '当前状态的投稿不可审核', {
        id: command.submissionId,
        status: precheck.status,
      });
    }
    if (precheck.currentRevisionNo !== source.revisionNo) {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
        '目标版本不是当前待审版本，不能审核',
        { id: command.submissionId, revisionId: command.revisionId },
      );
    }

    // 文件发布准备（事务外；授权全部通过后才触盘）
    const publishedStorageReference =
      command.publishAttachment && source.attachment !== null
        ? await this.copyApprovedAttachment(source.attachment)
        : null;

    // 事务回调完成标记（F3）：回调完成后抛错，错误只能来自 COMMIT 阶段
    // （提交确认丢失/连接异常），数据库是否提交不明；回调未完成即抛错时
    // COMMIT 从未发出，事务必然回滚。
    let callbackCompleted = false;
    try {
      return await this.transactionRunner.run(async (transactionContext) => {
        // 行锁重核：投稿仍为待审且目标版本仍是当前版本（并发最多一次成功）
        const { lock } = await lockReviewableSubmissionAndAssertRevision({
          contentSubmissionService: this.contentSubmissionService,
          contentSubmissionQueryService: this.contentSubmissionQueryService,
          organizationContextService: this.organizationContextService,
          accountId: command.session.accountId,
          submissionId: command.submissionId,
          revisionId: command.revisionId,
          transactionContext,
        });

        await this.contentSubmissionService.insertReview(
          {
            submissionId: command.submissionId,
            revisionId: command.revisionId,
            decision: 'APPROVE',
            reviewedByAccountId: command.session.accountId,
            comment,
            publishAttachment: command.publishAttachment,
          },
          transactionContext,
        );

        const documentId = await this.publishDocument({
          submissionId: command.submissionId,
          source,
          parsed,
          publishedStorageReference,
          accountId: command.session.accountId,
          ownerOrganizationId: lock.ownerOrganizationId,
          transactionContext,
        });

        await this.contentSubmissionService.markSubmissionPublished({
          submissionId: command.submissionId,
          transactionContext,
        });

        const status = await this.contentSubmissionQueryService.readStatusSnapshot({
          submissionId: command.submissionId,
          transactionContext,
        });
        const result = {
          submissionId: command.submissionId,
          status: status.status,
          documentId,
        };
        // 回调体已完整执行；此后 run() 才进入 COMMIT，此标记即「提交阶段」分界
        callbackCompleted = true;
        return result;
      });
    } catch (error) {
      await this.compensatePublishedCopy(
        command.submissionId,
        publishedStorageReference,
        callbackCompleted,
      );
      throw error;
    }
  }

  /**
   * 正式资料插入（与审核记录/状态流转同事务）：
   * 普通资料复制标题/类型/机型/说明/正文；案例以受控类型 FAULT_CASE 入库、
   * 可读正文由同一份冻结字段生成、结构化明细同步落库（S5.2）。
   */
  private async publishDocument(params: {
    submissionId: number;
    source: ContentSubmissionRevisionPublishSource;
    parsed: ParsedApprovedPayload;
    publishedStorageReference: string | null;
    accountId: number;
    ownerOrganizationId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<number> {
    // 正式文件四列同空或同有（chk_reference_document_storage_pair）：
    // 未发布附件时四列全空，正文承担唯一内容来源
    const attachment = params.publishedStorageReference === null ? null : params.source.attachment;
    const sharedStorageFields = {
      originalFilename: attachment === null ? null : attachment.originalFilename,
      mimeType: attachment === null ? null : attachment.mimeType,
      storageBackend: attachment === null ? null : 'local',
      storageReference: params.publishedStorageReference,
    };

    if (params.source.submissionKind === 'MATERIAL') {
      const material = params.parsed.material as ApprovedMaterialFields;
      const { id: documentId } = await this.referenceDocumentService.insertDocument(
        {
          title: params.source.titleSnapshot,
          documentType: material.documentType,
          equipmentModelId: material.equipmentModelId,
          equipmentModelText: material.equipmentModelText,
          description: material.description,
          contentText: material.contentText,
          ...sharedStorageFields,
          createdByAccountId: params.accountId,
          ownerOrganizationId: params.ownerOrganizationId,
          ingestMethod: 'REVIEWED_SUBMISSION',
          sourceSubmissionId: params.submissionId,
          sourceRevisionId: params.source.revisionId,
        },
        params.transactionContext,
      );
      return documentId;
    }

    const faultCase = params.parsed.faultCase as ApprovedFaultCaseFields;
    const { id: documentId } = await this.referenceDocumentService.insertDocument(
      {
        title: params.source.titleSnapshot,
        documentType: CONTENT_SUBMISSION_FAULT_CASE_TYPE,
        equipmentModelId: faultCase.equipmentModelId,
        equipmentModelText: faultCase.equipmentModelText,
        // 说明列留空：案例语义全部由结构化明细与可读正文表达
        description: null,
        contentText: params.parsed.contentText,
        ...sharedStorageFields,
        createdByAccountId: params.accountId,
        ownerOrganizationId: params.ownerOrganizationId,
        ingestMethod: 'REVIEWED_SUBMISSION',
        sourceSubmissionId: params.submissionId,
        sourceRevisionId: params.source.revisionId,
      },
      params.transactionContext,
    );
    await this.referenceDocumentCaseDetailService.insertCaseDetail(
      {
        documentId,
        errorCode: faultCase.errorCode,
        handlingStatus: faultCase.handlingStatus,
        phenomenon: faultCase.phenomenon,
        conditionText: faultCase.conditionText,
        reproductionSteps: faultCase.reproductionSteps,
        diagnosis: faultCase.diagnosis,
        actionTaken: faultCase.actionTaken,
        resolution: faultCase.resolution,
        casePayloadJson: null,
      },
      params.transactionContext,
    );
    return documentId;
  }

  /**
   * 冻结快照 → 发布字段解析：快照由送审用例受控写入，缺失/类型不符属
   * 系统故障，受控收敛（不泄露快照内容），失败关闭而不是折叠默认值。
   */
  private parseApprovedPayload(
    source: ContentSubmissionRevisionPublishSource,
  ): ParsedApprovedPayload {
    if (source.submissionKind === 'MATERIAL') {
      const material: ApprovedMaterialFields = {
        title: this.requireSnapshotString(source, 'title'),
        documentType: this.requireSnapshotString(source, 'documentType'),
        equipmentModelId: this.optionalSnapshotInteger(source, 'equipmentModelId'),
        equipmentModelText: this.optionalSnapshotString(source, 'equipmentModelText'),
        description: this.optionalSnapshotString(source, 'description'),
        contentText: this.optionalSnapshotString(source, 'contentText'),
      };
      return { contentText: material.contentText, material, faultCase: null };
    }

    const faultCase: ApprovedFaultCaseFields = {
      title: this.requireSnapshotString(source, 'title'),
      equipmentModelId: this.optionalSnapshotInteger(source, 'equipmentModelId'),
      equipmentModelText: this.optionalSnapshotString(source, 'equipmentModelText'),
      errorCode: this.optionalSnapshotString(source, 'errorCode'),
      phenomenon: this.requireSnapshotString(source, 'phenomenon'),
      conditionText: this.optionalSnapshotString(source, 'conditionText'),
      reproductionSteps: this.requireSnapshotString(source, 'reproductionSteps'),
      diagnosis: this.optionalSnapshotString(source, 'diagnosis'),
      actionTaken: this.optionalSnapshotString(source, 'actionTaken'),
      handlingStatus: this.requireSnapshotHandlingStatus(source),
      resolution: this.optionalSnapshotString(source, 'resolution'),
    };
    // 可读正文与结构化明细由同一份字段生成（S5.2）：必填字段保证正文非空
    return { contentText: formatFaultCaseReferenceContent(faultCase), material: null, faultCase };
  }

  /** 快照必填字符串读取（送审已校验非空；缺失/类型不符 = 系统故障，失败关闭） */
  private requireSnapshotString(
    source: ContentSubmissionRevisionPublishSource,
    key: string,
  ): string {
    const value = source.payloadSnapshot[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw this.snapshotDamagedError(source.revisionId);
    }
    return value;
  }

  /** 快照可选字符串读取：null/undefined → null；非字符串 = 系统故障 */
  private optionalSnapshotString(
    source: ContentSubmissionRevisionPublishSource,
    key: string,
  ): string | null {
    const value = source.payloadSnapshot[key];
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string') {
      throw this.snapshotDamagedError(source.revisionId);
    }
    return value;
  }

  /** 快照可选正整数读取：null/undefined → null；非整数值 = 系统故障 */
  private optionalSnapshotInteger(
    source: ContentSubmissionRevisionPublishSource,
    key: string,
  ): number | null {
    const value = source.payloadSnapshot[key];
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw this.snapshotDamagedError(source.revisionId);
    }
    return value;
  }

  /** 快照处理状态读取：受控值域外 = 系统故障 */
  private requireSnapshotHandlingStatus(
    source: ContentSubmissionRevisionPublishSource,
  ): ContentSubmissionHandlingStatus {
    const value = source.payloadSnapshot['handlingStatus'];
    if (
      typeof value !== 'string' ||
      !CONTENT_SUBMISSION_HANDLING_STATUSES.includes(value as ContentSubmissionHandlingStatus)
    ) {
      throw this.snapshotDamagedError(source.revisionId);
    }
    return value as ContentSubmissionHandlingStatus;
  }

  private snapshotDamagedError(revisionId: number): DomainError {
    return new DomainError(
      CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
      '送审版本快照数据不完整，无法发布',
      { revisionId },
    );
  }

  /**
   * 文件发布复制：打开当次获准原件流 → 聚合字节 → 保存为新正式引用
   * （附件上限 20 MiB 内，内存聚合安全）。源不可用/读取/保存失败均受控收敛，
   * 不泄露存储实现细节。
   */
  private async copyApprovedAttachment(
    attachment: ContentSubmissionAttachmentPublishRef,
  ): Promise<string> {
    let content: Readable;
    try {
      content = await this.storage.open(attachment.storageReference);
    } catch {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE,
        '获准原件当前不可用，无法发布',
        { attachmentId: attachment.id },
      );
    }

    let buffer: Buffer;
    try {
      buffer = await this.readAllBytes(content);
    } catch {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE,
        '获准原件读取失败，无法发布',
        { attachmentId: attachment.id },
      );
    }

    const extension = path.extname(attachment.originalFilename).slice(1).toLowerCase();
    try {
      return await this.storage.save(buffer, extension);
    } catch {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
        '正式文件保存失败，请稍后重试',
      );
    }
  }

  private async readAllBytes(content: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
    }
    return Buffer.concat(chunks);
  }

  /**
   * 发布失败补偿（F3）：仅处理本请求新生成、且未被正式资料引用的副本。
   *
   * 失败后以独立读取核查「来源投稿对应正式资料的精确文件引用」（含软删除
   * 资料；uk_reference_document_source_submission 唯一约束保证至多一行）：
   *
   * - 正式资料引用本次副本：本请求实则已提交（提交确认丢失），保留；客户端
   *   重新查询投稿状态恢复
   * - 正式资料已经确定不使用本次副本（引用其他副本/本身无文件）：本次提交
   *   必然未成功（若提交成功，正式资料引用的必然是本次副本），精确清理
   * - 无正式资料引用且回调未完成：COMMIT 从未发出、事务必然回滚，精确清理
   * - 无正式资料引用但回调已完成：COMMIT 结果不明（单次读取为空不能当作
   *   终局回滚证据），保留并记录待人工核查
   * - 核查读取失败：同上保留并记录
   *
   * 仅处理本次新生成的副本，不触碰冻结原件、成功方正式文件或其他历史文件；
   * 补偿失败不静默：记错误日志并附可清理的精确引用。
   */
  private async compensatePublishedCopy(
    submissionId: number,
    storageReference: string | null,
    callbackCompleted: boolean,
  ): Promise<void> {
    if (storageReference === null) {
      return;
    }

    let publishedRef: { documentId: number; storageReference: string | null } | null;
    try {
      publishedRef =
        await this.contentSubmissionQueryService.findPublishedDocumentFileRefBySourceSubmission({
          submissionId,
        });
    } catch (probeError) {
      this.logger.error(
        `投稿发布失败后核查正式资料引用失败，提交终局不明，保留文件待人工核查 storageReference=${storageReference}`,
        probeError instanceof Error ? probeError.stack : String(probeError),
      );
      return;
    }

    if (publishedRef !== null) {
      if (publishedRef.storageReference === storageReference) {
        this.logger.warn(
          `投稿审核发布事务抛错但正式资料已引用本次副本（提交确认丢失），保留文件 storageReference=${storageReference}`,
        );
        return;
      }
      // 唯一来源约束闭环：正式资料已引用其他副本（或无文件），本次提交必然
      // 未成功、本次副本确定未被使用 → 精确清理
      await this.deleteUnreferencedPublishedCopy(storageReference);
      return;
    }

    if (callbackCompleted) {
      this.logger.error(
        `投稿审核发布事务提交结果不确定，核查暂无正式资料引用，保留文件待人工核查 storageReference=${storageReference}`,
      );
      return;
    }

    await this.deleteUnreferencedPublishedCopy(storageReference);
  }

  /**
   * 精确删除已确认未被任何正式资料引用的本次副本（补偿终态）。
   * 删除失败必须可观测且可清理，绝不静默吞掉。
   */
  private async deleteUnreferencedPublishedCopy(storageReference: string): Promise<void> {
    try {
      await this.storage.delete(storageReference);
    } catch (deleteError) {
      this.logger.error(
        `投稿发布失败后的补偿删除失败，存在需清理的孤儿文件 storageReference=${storageReference}`,
        deleteError instanceof Error ? deleteError.stack : String(deleteError),
      );
    }
  }
}
