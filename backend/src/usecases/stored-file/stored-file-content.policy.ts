// src/usecases/stored-file/stored-file-content.policy.ts

import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import { EXTENSION_TO_MIME } from '@src/usecases/common/file-upload.contract';

/**
 * 原件实际内容类型判定（纯函数，无 I/O）。
 *
 * 任务 11 要求「按实际内容验证类型」，不接受仅凭扩展名或客户端 Content-Type：
 * - 扩展名先映射为规范 MIME，且必须命中服务端白名单；
 * - 再按文件头魔数核对内容族：PDF / PNG / JPEG / ZIP 容器（docx/xlsx/pptx）/
 *   OLE 容器（doc/xls/ppt）/ UTF-8 文本（txt/md/csv）；
 * - 任一项不匹配即返回 null，由用例统一拒绝为类型不允许。
 */

const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const TEXT_MIME_TYPES: readonly string[] = ['text/plain', 'text/markdown', 'text/csv'];

/** 提取小写扩展名（不含点）；无扩展名返回空串 */
export function extractStoredFileExtension(originalFilename: string): string {
  return path.extname(originalFilename).slice(1).toLowerCase();
}

/**
 * 解析并核对实际内容类型。
 * @returns 规范 MIME；扩展名未知、不在白名单或内容族不匹配时返回 null
 */
export function resolveVerifiedStoredFileMimeType(params: {
  buffer: Buffer;
  originalFilename: string;
  allowedMimeTypes: readonly string[];
}): string | null {
  if (!Buffer.isBuffer(params.buffer) || params.buffer.byteLength === 0) {
    return null;
  }

  const extension = extractStoredFileExtension(params.originalFilename);
  const mimeType = EXTENSION_TO_MIME[extension];
  if (mimeType === undefined || !params.allowedMimeTypes.includes(mimeType)) {
    return null;
  }

  return contentMatchesMimeType(params.buffer, mimeType) ? mimeType : null;
}

function contentMatchesMimeType(buffer: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case 'application/pdf':
      return startsWith(buffer, PDF_SIGNATURE);
    case 'image/png':
      return startsWith(buffer, PNG_SIGNATURE);
    case 'image/jpeg':
      return startsWith(buffer, JPEG_SIGNATURE);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return startsWith(buffer, ZIP_SIGNATURE);
    case 'application/msword':
    case 'application/vnd.ms-excel':
    case 'application/vnd.ms-powerpoint':
      return startsWith(buffer, OLE_SIGNATURE);
    default:
      return TEXT_MIME_TYPES.includes(mimeType) && isUtf8Text(buffer);
  }
}

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  return (
    buffer.byteLength >= signature.byteLength &&
    buffer.subarray(0, signature.byteLength).equals(signature)
  );
}

/** 文本类：无 NUL 字节且可按 UTF-8 严格解码（拒绝二进制内容冒充文本） */
function isUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
