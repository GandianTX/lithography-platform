// src/usecases/reference-document/create-reference-document-with-file.usecase.ts

import * as path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { CreateReferenceDocumentUsecase } from './create-reference-document.usecase';
import { assertReferenceDocumentWriteRole } from './reference-document-roles';
import {
  EXTENSION_TO_MIME,
  REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES,
  REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES,
} from './reference-document-upload.contract';
import { REFERENCE_DOCUMENT_STORAGE } from './reference-document-storage.contract';
import {
  CreateReferenceDocumentWithFileCommand,
  ReferenceDocumentMutationResult,
  ReferenceDocumentStorage,
} from './reference-document.types';

/**
 * 带文件创建参考资料用例（仅 SUPER_ADMIN，REST multipart 上传路径）。
 *
 * 负责人 0910 架构要求：文件保存 → 数据库落库 → 失败补偿的完整写编排归 usecase 层
 * 统一持有，REST adapter 只做 multipart 协议解析与命令组装，不注入存储契约。
 *
 * 业务流程（顺序即安全边界，不得重排）
 * 1. 流程级授权最外层兜底：assertReferenceDocumentWriteRole 必须发生在任何文件 I/O
 *    之前（负责人 0911 要求）——否则非管理员入口可先触发磁盘写入再依赖补偿删除；
 * 2. 上传策略单一真源：大小上限（以 buffer 实际字节数为准，不信任声明值）
 *    （UPLOAD_FILE_TOO_LARGE）与扩展名 → MIME 白名单（UPLOAD_FILE_TYPE_NOT_ALLOWED）；
 * 3. 事务内先做可信组织前置校验（G1/F03）：无有效成员、组织停用或成员歧义在
 *    文件 I/O 之前拒绝，storage.save 不得被调用；解析结果同时作为落库归属事实
 *    （同一事务快照，不取客户端自报）；
 * 4. 全部授权通过后才写存储文件（服务端随机引用），save 失败不触库（CREATION_FAILED）；
 * 5. 委托 CreateReferenceDocumentUsecase.executeWithOrganizationInTransaction 在同一
 *    事务内完成业务校验与落库（字段规范化、双空拒绝、型号存在性保持其单一真源地位）；
 * 6. 事务失败补偿不做「抛错 = 已回滚」假设（G1/F02）：以本层回调完成标记区分
 *    「COMMIT 未发出」（必然回滚）与「COMMIT 结果不明」，再以独立读取按本次精确
 *    存储引用核查正式资料占用（含已软删资料）——确认回滚且未被引用才精确删除本次
 *    新文件，其余情况保留并记录精确引用供人工核查；补偿过程不覆盖原错误，不自动重发。
 */
@Injectable()
export class CreateReferenceDocumentWithFileUsecase {
  private readonly logger = new Logger(CreateReferenceDocumentWithFileUsecase.name);
  private readonly allowedMimeTypes: readonly string[];
  private readonly uploadMaxBytes: number;

  constructor(
    private readonly createReferenceDocumentUsecase: CreateReferenceDocumentUsecase,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(REFERENCE_DOCUMENT_STORAGE)
    private readonly storage: ReferenceDocumentStorage,
    @Inject(REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES)
    uploadMaxBytes: number,
    @Inject(REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES)
    allowedMimeTypes: string[],
  ) {
    this.uploadMaxBytes = uploadMaxBytes;
    this.allowedMimeTypes = allowedMimeTypes;
  }

  async execute(
    command: CreateReferenceDocumentWithFileCommand,
  ): Promise<ReferenceDocumentMutationResult> {
    // 流程级授权最外层兜底：先于任何文件 I/O，复用既有角色断言不另设第二套判断（负责人 0911）
    assertReferenceDocumentWriteRole(command.session.roles);

    // 大小上限以服务端实际字节数为准（不信任客户端声明的 size）
    if (command.file.buffer.byteLength > this.uploadMaxBytes) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TOO_LARGE, '上传文件超过大小限制');
    }

    // 类型以扩展名为主判定（不信任客户端 MIME 头），MIME 白名单来自配置
    const extension = path.extname(command.file.originalFilename).slice(1).toLowerCase();
    const mimeType = EXTENSION_TO_MIME[extension];

    if (mimeType === undefined || !this.allowedMimeTypes.includes(mimeType)) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED,
        '不允许上传该类型的文件',
      );
    }

    let storageReference: string | null = null;
    // 事务回调完成标记（F02）：回调完成后抛错，错误只能来自 COMMIT 阶段
    // （提交确认丢失/连接异常），数据库是否提交不明；回调未完成即抛错时
    // COMMIT 从未发出，事务必然回滚（rollback 成功或连接断开由数据库自动回滚）。
    let callbackCompleted = false;
    try {
      return await this.transactionRunner.run(async (transactionContext) => {
        // 可信组织前置（G1/F03）：无有效成员/组织停用/成员歧义在此拒绝——
        // storage.save 不得被调用；解析结果同时用于落库归属（与落库同快照）
        const membership = await this.organizationContextService.resolveForAccount({
          accountId: command.session.accountId,
          transactionContext,
        });

        // 授权全部通过后才触盘（A-PR0 §2.1：无权限文件请求不得先写文件）
        let savedReference: string;
        try {
          savedReference = await this.storage.save(command.file.buffer, extension);
        } catch {
          throw new DomainError(
            REFERENCE_DOCUMENT_ERROR.CREATION_FAILED,
            '文件保存失败，请稍后重试',
          );
        }
        storageReference = savedReference;

        const result =
          await this.createReferenceDocumentUsecase.executeWithOrganizationInTransaction(
            {
              session: command.session,
              title: command.title,
              documentType: command.documentType,
              equipmentModelId: command.equipmentModelId,
              description: command.description,
              contentText: command.contentText,
              file: {
                originalFilename: command.file.originalFilename,
                mimeType,
                storageReference: savedReference,
              },
            },
            transactionContext,
            membership.organizationId,
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
   * 事务失败后的补偿（G1/F02）：不假设「事务抛错必然已回滚」。
   *
   * 通过独立读取（非失败事务，由查询服务默认 manager 读取）按本次精确
   * storageReference 核查正式资料占用（不过滤软删——软删资料仍保留文件引用，
   * 行存在即视为被引用）：
   *
   * - 已被引用：提交已落库（提交确认丢失场景），保留文件；客户端可重新
   *   查询恢复状态，不做自动重复写入
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
        await this.referenceDocumentQueryService.isStorageReferenceReferenced(storageReference);
    } catch (probeError) {
      this.logger.error(
        `参考资料上传失败后核查存储引用失败，事务终局不明，保留文件待人工核查 storageReference=${storageReference}`,
        probeError instanceof Error ? probeError.stack : String(probeError),
      );
      return;
    }

    if (referenced === true) {
      this.logger.warn(
        `参考资料上传事务抛错但文件已被正式资料引用（提交确认丢失），保留文件 storageReference=${storageReference}`,
      );
      return;
    }

    if (callbackCompleted) {
      this.logger.error(
        `参考资料上传事务提交结果不确定，核查暂无引用，保留文件待人工核查 storageReference=${storageReference}`,
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
        `参考资料上传落库失败后的补偿删除失败，存在需清理的孤儿文件 storageReference=${storageReference}`,
        deleteError instanceof Error ? deleteError.stack : String(deleteError),
      );
    }
  }
}
