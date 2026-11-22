// src/usecases/reference-document/download-reference-document-source-attachment.usecase.ts

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileDownloadFacts } from '@src/modules/lithography/lithography.types';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';
// 跨 usecase 边界契约（usecases/common 豁免）：原件登记大小单一真源
import { STORED_FILE_UPLOAD_MAX_BYTES } from '@src/usecases/common/stored-file-size.contract';

import type { ReferenceDocumentFilePayload } from './reference-document.types';
import {
  assertDocumentIdValid,
  assertReferenceDocumentDownloadRole,
} from './reference-document-roles';
import { resolveReferenceDocumentReadScope } from './reference-document-read-scope';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export type DownloadReferenceDocumentSourceAttachmentCommand = {
  documentId: number;
  attachmentId: number;
  session: UsecaseSession;
};

/**
 * 来源资料报告原件授权下载用例（任务 07 P2）。
 *
 * 放行对象是「有权查看该正式资料」的读者（R055-02/R056-02/R057-01 口径：
 * 工程师与二级管理员限本公司、一级管理员全公司），不是报告或草稿的新读者：
 * - 任务 06 报告附件入口（/api/stored-files/:fileId/download →
 *   canAccessBoundMaintenanceReport 的作者/管理员口径）零改动；
 * - 授权顺序：角色兜底 → 资料读取范围决议 → findDetail（ONLINE + CONFIRMED +
 *   未软删 + 范围内统一 NOT_FOUND）→ 冻结版本核验 → 冻结版本附件绑定核验 →
 *   原件登记核验与登记副本一致性 → 存储读取；
 * - 只按 `sourceReportId + sourceReportVersionId` 对应的冻结版本附件绑定放行：
 *   不回退报告当前附件列表，不接受单一文件 ID 直取；资料引用旧冻结版本时
 *   只返回该版本关联的原件，不取报告当前版本的原件；
 * - 生命周期（任务 07 P2 核对结论）：审核驳回（RETURNED）后作者更换/移除
 *   原件会把已被冻结版本关联的旧附件行合法退役（stored_file 解绑回
 *   TEMPORARY），退役不撤历史读取权——版本绑定仍在即放行，登记与存储
 *   失效如实拒绝；
 * - 附件绑定缺失/文件引用无效/登记不完整/登记副本不一致/存储读取失败统一
 *   受控错误，不泄露文件存在性、存储引用与路径；
 * - 打开存储一次，按登记字节数有界读取并核对长度与 SHA-256，校验通过后才
 *   把同一份已校验字节交给边界层发送。
 */
@Injectable()
export class DownloadReferenceDocumentSourceAttachmentUsecase {
  private readonly logger = new Logger(DownloadReferenceDocumentSourceAttachmentUsecase.name);

  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly storedFileQueryService: StoredFileQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
  ) {}

  async execute(
    command: DownloadReferenceDocumentSourceAttachmentCommand,
  ): Promise<ReferenceDocumentFilePayload> {
    assertReferenceDocumentDownloadRole(command.session.roles);
    assertDocumentIdValid(command.documentId);
    assertSourceAttachmentIdValid(command.attachmentId);

    // 读侧范围先决议：一级 GLOBAL / 其余本公司（工程师与二级管理员仍失败关闭）
    const scope = await resolveReferenceDocumentReadScope({
      session: command.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    // 不存在/下架/归属未确认/已软删/跨范围由 QueryService 统一 NOT_FOUND，不区分原因
    const detail = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope,
    });

    const sourceReportId = detail.sourceReportId;
    const sourceReportVersionId = detail.sourceReportVersionId;
    if (sourceReportId === null || sourceReportVersionId === null) {
      // 非报告来源资料没有来源报告原件入口：与不可访问统一口径
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        documentId: command.documentId,
      });
    }

    // 冻结版本行必须属于该报告（readVersionById 以 reportId + versionId 双键读取）；
    // 缺失属数据定式破坏，失败关闭（与生效正文装配同口径）
    const version = await this.maintenanceReportQueryService.readVersionById(
      sourceReportId,
      sourceReportVersionId,
    );
    if (version === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        documentId: command.documentId,
      });
    }

    // 只信任冻结版本的附件绑定（versionId + reportId 双键），不回退当前附件列表
    const bindings = await this.maintenanceReportQueryService.readVersionAttachments(
      sourceReportVersionId,
      sourceReportId,
    );
    const binding = bindings.find((item) => item.attachmentId === command.attachmentId);
    if (!binding) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        documentId: command.documentId,
      });
    }

    // 附件行必须真实存在且 fileId 非空。RETIRED 不在此拒绝（生命周期核对结论）：
    // 审核驳回（RETURNED）后作者更换/移除原件会把已被冻结版本关联的旧附件行
    // 合法退役，版本-附件复合外键绑定仍在——历史读取权保留（remove
    // usecase 设计注释「已冻结版本通过复合外键仍可回溯历史附件」）；
    // 文件失效由下方登记核验与存储读取如实拒绝
    const snapshots = await this.maintenanceReportQueryService.readAttachmentsByIds(
      sourceReportId,
      [command.attachmentId],
    );
    const attachment = snapshots[0];
    if (!attachment || attachment.fileId === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        documentId: command.documentId,
      });
    }

    // 原件登记核验（MAINTENANCE_REPORT + VALID + 已核验；退役解绑 TEMPORARY 属预期，
    // 仍 BOUND 时归属报告必须一致）；登记缺失/形态不符统一 NOT_FOUND，不泄露原件存在性
    const facts = await this.storedFileQueryService.findReportAttachmentDownloadFacts(
      attachment.fileId,
      sourceReportId,
    );
    if (facts === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        documentId: command.documentId,
      });
    }

    // 附件行与登记行是同一绑定事务的登记副本：存储引用不一致属数据定式破坏，
    // 失败关闭（不按附件行引用直读，也不泄露两行差异）
    if (attachment.storageReference !== facts.storageReference) {
      this.logger.warn(
        `来源报告原件附件行与登记行存储引用不一致: documentId=${command.documentId} fileId=${facts.fileId}`,
      );
      throw this.unavailable(command.documentId);
    }

    if (!this.hasValidRegisteredIntegrity(facts)) {
      throw this.unavailable(command.documentId);
    }

    const verifiedBytes = await this.readVerifiedBytes(facts, command.documentId);

    return {
      documentId: detail.id,
      originalFilename: facts.originalFilename,
      mimeType: facts.mimeType,
      // 只发送本轮已核对过的同一份字节；不重新打开存储
      content: Readable.from([verifiedBytes]),
    };
  }

  /** 登记值必须先可信：大小在 1..业务上限内，SHA-256 为 64 位十六进制 */
  private hasValidRegisteredIntegrity(facts: StoredFileDownloadFacts): boolean {
    return (
      Number.isSafeInteger(facts.byteSize) &&
      facts.byteSize > 0 &&
      facts.byteSize <= STORED_FILE_UPLOAD_MAX_BYTES &&
      typeof facts.checksumSha256 === 'string' &&
      SHA256_HEX_PATTERN.test(facts.checksumSha256)
    );
  }

  /**
   * 打开存储一次，按登记字节数有界读取并核对长度与 SHA-256；
   * 读取超限、内容不匹配、读取失败统一 FILE_NOT_AVAILABLE，不泄露路径与引用。
   */
  private async readVerifiedBytes(
    facts: StoredFileDownloadFacts,
    documentId: number,
  ): Promise<Buffer> {
    let content: Readable;

    try {
      content = await this.storage.open(facts.storageReference);
    } catch (error) {
      this.logger.warn(
        `来源报告原件存储对象不可用: documentId=${documentId} fileId=${facts.fileId} reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw this.unavailable(documentId, error);
    }

    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let totalBytes = 0;
    let completed = false;

    try {
      for await (const chunk of content as AsyncIterable<Buffer | string>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > facts.byteSize) {
          throw this.unavailable(documentId);
        }
        hash.update(buffer);
        chunks.push(buffer);
      }
      completed = true;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw this.unavailable(documentId, error);
    } finally {
      if (!completed) {
        content.destroy();
      }
    }

    if (
      totalBytes !== facts.byteSize ||
      hash.digest('hex') !== facts.checksumSha256.toLowerCase()
    ) {
      throw this.unavailable(documentId);
    }

    return Buffer.concat(chunks, totalBytes);
  }

  private unavailable(documentId: number, cause?: unknown): DomainError {
    return new DomainError(
      REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE,
      '来源报告原件暂时不可用',
      { documentId },
      cause,
    );
  }
}

/** 附件 ID 输入校验：必须为正整数 */
function assertSourceAttachmentIdValid(attachmentId: number): void {
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '附件编号无效', {
      attachmentId,
    });
  }
}
