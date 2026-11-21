// src/usecases/maintenance-report/maintenance-report-attachment-freeze.helpers.ts
//
// 附件「挂接后复核」助手：正式提交冻结与导出共用。
//
// 挂接（add-maintenance-report-attachment）时校验过的事实不会永远成立：
// 存储对象可能被移动/删除、字节或校验和可能变化。因此在冻结版本与导出前
// 统一重新核验：
// - 归属未改变：附件登记的 uploadedByAccountId 仍是报告作者本人；
// - 状态有效：仅支持当前装配的 LOCAL 存储后端；
// - 文件仍然存在且完整：有校验和时用 verifyIntegrity（字节 + SHA-256），
//   无校验和时打开只读流并核对实际字节数。
//
// 任一事实不成立即失败关闭（ATTACHMENT_UNAVAILABLE），不静默剔除、
// 不伪造提交或导出成功；提交场景由外层事务整体回滚。

import type { Readable } from 'node:stream';

import { MaintenanceAttachmentStorageBackend } from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportAttachmentSnapshot } from '@src/modules/lithography/maintenance-report.types';
import type { StoredFileStorage } from '@src/usecases/common/ports/stored-file-storage.contract';

/** 打开只读流并统计实际字节数（流按契约自动消费完毕后关闭） */
async function countStreamBytes(stream: Readable): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
    });
    stream.on('end', () => resolve(total));
    stream.on('error', reject);
  });
}

function unavailable(attachmentId: number, message: string, cause?: unknown): never {
  throw new DomainError(
    MAINTENANCE_REPORT_ERROR.ATTACHMENT_UNAVAILABLE,
    message,
    { attachmentId },
    cause,
  );
}

/** 单个附件的挂接后复核：归属、存储后端、文件存在与完整性 */
export async function assertAttachmentUsableAfterBinding(params: {
  attachment: MaintenanceReportAttachmentSnapshot;
  authorAccountId: number;
  storage: StoredFileStorage;
}): Promise<void> {
  const { attachment, authorAccountId, storage } = params;
  if (attachment.uploadedByAccountId !== authorAccountId) {
    unavailable(attachment.id, '附件归属与报告作者不一致，请移除该附件后重新上传');
  }
  if (attachment.storageBackend !== MaintenanceAttachmentStorageBackend.LOCAL) {
    unavailable(attachment.id, '附件存储后端不受支持，请移除该附件后重新上传');
  }
  try {
    if (attachment.checksumSha256 !== null) {
      const intact = await storage.verifyIntegrity(
        attachment.storageReference,
        attachment.checksumSha256,
        attachment.byteSize,
      );
      if (!intact) {
        unavailable(attachment.id, '附件文件已缺失或内容发生变化，请移除该附件后重新上传');
      }
      return;
    }
    const stream = await storage.open(attachment.storageReference);
    const actualBytes = await countStreamBytes(stream);
    if (actualBytes !== attachment.byteSize) {
      unavailable(attachment.id, '附件文件已缺失或内容发生变化，请移除该附件后重新上传');
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    unavailable(attachment.id, '附件文件已不可读，请移除该附件后重新上传', error);
  }
}

/** 附件集合逐个复核；任一不可用即整体失败 */
export async function assertAttachmentsUsableAfterBinding(params: {
  attachments: readonly MaintenanceReportAttachmentSnapshot[];
  authorAccountId: number;
  storage: StoredFileStorage;
}): Promise<void> {
  for (const attachment of params.attachments) {
    await assertAttachmentUsableAfterBinding({
      attachment,
      authorAccountId: params.authorAccountId,
      storage: params.storage,
    });
  }
}
