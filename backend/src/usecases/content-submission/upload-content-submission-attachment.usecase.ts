// src/usecases/content-submission/upload-content-submission-attachment.usecase.ts

import * as path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { EXTENSION_TO_MIME } from '@src/usecases/common/file-upload.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import {
  CONTENT_SUBMISSION_ATTACHMENT_STORAGE,
  type ContentSubmissionAttachmentStorage,
} from './content-submission-attachment-storage.contract';
import {
  CONTENT_SUBMISSION_ATTACHMENT_ALLOWED_MIME_TYPES,
  CONTENT_SUBMISSION_ATTACHMENT_UPLOAD_MAX_BYTES,
} from './content-submission-attachment-upload.contract';
import {
  assertContentSubmissionAuthorRole,
  assertSubmissionIdValid,
} from './content-submission-roles';
import { lockEditableSubmissionForAuthor } from './content-submission-write-guard';
import {
  ContentSubmissionAttachmentUploadResult,
  UploadContentSubmissionAttachmentCommand,
} from './content-submission.types';

/**
 * 上传/替换投稿单附件用例（A-PR0 §4.2 `POST /api/content-submissions/:id/attachment`）
 *
 * 业务流程（顺序即安全边界，不得重排）：
 * 1. 角色决策：仅真实 ENGINEER（精确匹配 activeRole，与草稿链路同一断言；
 *    管理员审核链路走独立入口，不自动继承本写入口）
 * 2. 上传策略单一真源（事务外、纯内存判定）：文件缺失/为空拒绝
 *    （UPLOAD_FILE_MISSING）；大小以服务端接收的实际字节数为准，不信任
 *    客户端声明值（UPLOAD_FILE_TOO_LARGE）；类型以扩展名为主判定、
 *    映射结果写入数据库 MIME，不信任客户端 Content-Type
 *    （UPLOAD_FILE_TYPE_NOT_ALLOWED）
 * 3. 事务内持投稿行锁后裁决（授权先于文件 I/O，无权限请求绝不触盘）：
 *    不存在/他人投稿/跨组织统一 NOT_FOUND；仅 DRAFT/RETURNED 可上传/替换
 *    （STATE_NOT_EDITABLE）——锁把状态检查与「退役旧 CURRENT + 登记新 CURRENT」
 *    串行化（T08：并发替换后最多一个 CURRENT）
 * 4. 校验全部通过后先写存储（服务端随机引用，失败 CREATION_FAILED），
 *    再登记附件行（先退役旧 CURRENT 再登记新，历史冻结引用保留）
 * 5. 事务失败补偿不做「抛错=已回滚」假设（F2）：以本层回调完成标记区分
 *    「COMMIT 未发出」（必然回滚）与「COMMIT 结果不明」；再以独立读取按本次
 *    精确存储引用核查附件占用（CURRENT/RETIRED 全状态）——确认回滚且未被
 *    引用才精确删除，其余情况保留文件并记录精确引用供人工核查；补偿过程
 *    不覆盖原错误，不向客户端泄露存储引用
 */
@Injectable()
export class UploadContentSubmissionAttachmentUsecase {
  private readonly logger = new Logger(UploadContentSubmissionAttachmentUsecase.name);
  private readonly uploadMaxBytes: number;
  private readonly allowedMimeTypes: readonly string[];

  constructor(
    private readonly contentSubmissionService: ContentSubmissionService,
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(CONTENT_SUBMISSION_ATTACHMENT_STORAGE)
    private readonly storage: ContentSubmissionAttachmentStorage,
    @Inject(CONTENT_SUBMISSION_ATTACHMENT_UPLOAD_MAX_BYTES)
    uploadMaxBytes: number,
    @Inject(CONTENT_SUBMISSION_ATTACHMENT_ALLOWED_MIME_TYPES)
    allowedMimeTypes: string[],
  ) {
    this.uploadMaxBytes = uploadMaxBytes;
    this.allowedMimeTypes = allowedMimeTypes;
  }

  async execute(
    command: UploadContentSubmissionAttachmentCommand,
  ): Promise<ContentSubmissionAttachmentUploadResult> {
    assertContentSubmissionAuthorRole(command.session);
    assertSubmissionIdValid(command.submissionId);

    // 协议层已粗筛缺失文件；本层兜底防御（直调用例时缺失/空文件同样拒绝）
    if (!Buffer.isBuffer(command.file.buffer) || command.file.buffer.byteLength === 0) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_MISSING, '上传文件缺失或为空');
    }
    // 大小上限以服务端实际字节数为准（不信任客户端声明的 size）
    if (command.file.buffer.byteLength > this.uploadMaxBytes) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TOO_LARGE, '上传文件超过大小限制');
    }
    // 类型以扩展名为主判定（不信任客户端 MIME 头），MIME 白名单沿用管理员上传配置
    const extension = path.extname(command.file.originalFilename).slice(1).toLowerCase();
    const mimeType = EXTENSION_TO_MIME[extension];
    if (mimeType === undefined || !this.allowedMimeTypes.includes(mimeType)) {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED,
        '不允许上传该类型的文件',
      );
    }

    let storageReference: string | null = null;
    // 事务回调完成标记（F2）：回调完成后抛错，错误只能来自 COMMIT 阶段
    // （提交确认丢失/连接异常），数据库是否提交不明；回调未完成即抛错时
    // COMMIT 从未发出，事务必然回滚（rollback 成功或连接断开由数据库自动回滚）。
    let callbackCompleted = false;
    try {
      return await this.transactionRunner.run(async (transactionContext) => {
        // 组织解析 → 行锁 → 归属/状态裁决（授权先于文件 I/O）
        await lockEditableSubmissionForAuthor({
          contentSubmissionService: this.contentSubmissionService,
          organizationContextService: this.organizationContextService,
          accountId: command.session.accountId,
          submissionId: command.submissionId,
          transactionContext,
        });

        // 授权与状态校验全部通过后才触盘（A-PR0 §2.1：无权限文件请求不得先写文件）
        let savedReference: string;
        try {
          savedReference = await this.storage.save(command.file.buffer, extension);
        } catch {
          throw new DomainError(
            CONTENT_SUBMISSION_ERROR.CREATION_FAILED,
            '文件保存失败，请稍后重试',
          );
        }
        storageReference = savedReference;

        const result = await this.contentSubmissionService.replaceCurrentAttachment(
          {
            submissionId: command.submissionId,
            originalFilename: command.file.originalFilename,
            mimeType,
            byteSize: command.file.buffer.byteLength,
            // 存储后端标识随实现固定（与参考资料上传共用同一本地存储实现）
            storageBackend: 'local',
            storageReference: savedReference,
            uploadedByAccountId: command.session.accountId,
          },
          transactionContext,
        );
        // 回调体已完整执行；此后 run() 才进入 COMMIT，此标记即「提交阶段」分界
        callbackCompleted = true;
        return result;
      });
    } catch (error) {
      if (storageReference !== null) {
        await this.compensateUncertainCommit(storageReference, callbackCompleted);
      }
      throw error;
    }
  }

  /**
   * 事务失败后的补偿（F2）：不假设「事务抛错必然已回滚」。
   *
   * 通过独立读取（非失败事务，由查询服务默认 manager 读取）按本次精确
   * storageReference 核查附件表占用（CURRENT/RETIRED 全状态，行存在即视为
   * 被引用——旧附件行不删除、冻结历史引用保留）：
   *
   * - 已被引用：提交已落库（提交确认丢失场景），保留文件；客户端应重新
   *   查询投稿状态恢复，不做自动重复写入
   * - 未被引用且回调未完成：COMMIT 从未发出、事务必然回滚，精确删除本次副本
   * - 未被引用但回调已完成：COMMIT 结果不明（单次读取为空不能当作终局回滚
   *   证据，可能存在仍在完成的提交），保留文件并记录精确引用供人工核查
   * - 核查读取失败：同上保留并记录
   *
   * 原错误不被覆盖；删除失败只记入错误日志（附可清理的精确引用），不静默。
   */
  private async compensateUncertainCommit(
    storageReference: string,
    callbackCompleted: boolean,
  ): Promise<void> {
    let referenced: boolean;
    try {
      referenced =
        await this.contentSubmissionQueryService.isStorageReferenceReferenced(storageReference);
    } catch (probeError) {
      this.logger.error(
        `投稿附件上传失败后核查存储引用失败，提交终局不明，保留文件待人工核查 storageReference=${storageReference}`,
        probeError instanceof Error ? probeError.stack : String(probeError),
      );
      return;
    }

    if (referenced === true) {
      this.logger.warn(
        `投稿附件上传事务抛错但文件已被附件记录引用（提交确认丢失），保留文件 storageReference=${storageReference}`,
      );
      return;
    }

    if (callbackCompleted) {
      this.logger.error(
        `投稿附件上传事务提交结果不确定，核查暂无引用，保留文件待人工核查 storageReference=${storageReference}`,
      );
      return;
    }

    await this.deleteUnreferencedCopy(storageReference);
  }

  /**
   * 精确删除已确认回滚且未被引用的本次副本。
   * 删除失败必须可观测且可清理，绝不静默吞掉。
   */
  private async deleteUnreferencedCopy(storageReference: string): Promise<void> {
    try {
      await this.storage.delete(storageReference);
    } catch (deleteError) {
      this.logger.error(
        `投稿附件上传失败后的补偿删除失败，存在需清理的孤儿文件 storageReference=${storageReference}`,
        deleteError instanceof Error ? deleteError.stack : String(deleteError),
      );
    }
  }
}
