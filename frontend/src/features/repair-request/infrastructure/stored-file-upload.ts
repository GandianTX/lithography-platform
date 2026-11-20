// src/features/repair-request/infrastructure/stored-file-upload.ts

import {
  fetchRestWithAuthRetry,
  readRestErrorField,
  type RestErrorEnvelope,
  toRestErrorEnvelope,
} from '@/shared/http';

/**
 * 业务原件暂存上传的 REST 边界（任务 11 能力，任务 03 复用）。
 *
 * 只做「表单装配 → 调用 /api/stored-files → 解析固定返回/错误体」，
 * 不做用途级权限裁决（后端 usecase 单一真源）、不做本地文件校验、
 * 不落业务绑定（绑定在提交事务内完成）。
 *
 * 失败形态分为三类，由调用方映射成各自 feature 的拒绝原因：
 * - `network`：请求未送达或连接失败；
 * - `malformed`：非 2xx/2xx 但响应体不可解析或缺少必需字段；
 * - `rejected`：后端返回固定 REST 错误体（含稳定 code，可能被生产隐藏为空）。
 */
export type StoredFileUploadBusinessType = 'REPAIR_PROCESS' | 'REPAIR_REQUEST';

export type StagedStoredFile = {
  fileId: string;
  uploadContextId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

export type UploadStoredFileOutcome =
  | { status: 'uploaded'; file: StagedStoredFile }
  | { status: 'network' }
  | { status: 'malformed' }
  | { status: 'rejected'; code: string | null; message: string | null };

const STORED_FILE_UPLOAD_ENDPOINT = '/api/stored-files';

/** 上传暂存原件；调用方据 `status` 映射文案与是否可重试 */
export async function uploadStagedStoredFile(
  file: File,
  businessType: StoredFileUploadBusinessType,
): Promise<UploadStoredFileOutcome> {
  const formData = new FormData();
  formData.append('businessType', businessType);
  formData.append('file', file, file.name);

  let response: Response;
  try {
    response = await fetchRestWithAuthRetry(STORED_FILE_UPLOAD_ENDPOINT, {
      method: 'POST',
      body: formData,
    });
  } catch {
    return { status: 'network' };
  }

  if (response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: 'malformed' };
    }

    const data = (payload as { data?: Partial<StagedStoredFile> } | null)?.data;
    if (
      data &&
      typeof data.fileId === 'string' &&
      typeof data.uploadContextId === 'string' &&
      typeof data.originalFilename === 'string' &&
      typeof data.mimeType === 'string' &&
      typeof data.byteSize === 'number' &&
      typeof data.checksumSha256 === 'string'
    ) {
      return {
        status: 'uploaded',
        file: {
          fileId: data.fileId,
          uploadContextId: data.uploadContextId,
          originalFilename: data.originalFilename,
          mimeType: data.mimeType,
          byteSize: data.byteSize,
          checksumSha256: data.checksumSha256,
        },
      };
    }

    return { status: 'malformed' };
  }

  let envelope: RestErrorEnvelope = {};
  try {
    envelope = toRestErrorEnvelope(await response.json());
  } catch {
    // 非 JSON 错误体：按 rejected 处理但 code/message 为空，调用方走兜底文案
  }

  return {
    status: 'rejected',
    code: readRestErrorField(envelope, 'code'),
    message: readRestErrorField(envelope, 'message'),
  };
}
