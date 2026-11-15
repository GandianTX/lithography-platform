// src/usecases/stored-file/stored-file-content.policy.ts

import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import { EXTENSION_TO_MIME } from '@src/usecases/common/file-upload.contract';
import {
  isJpegStructureValid,
  isOleStructureValid,
  isOoxmlStructureValid,
  isPdfStructureValid,
  isPngStructureValid,
  type OleKind,
  type OoxmlKind,
} from './stored-file-structure.policy';

/**
 * 原件实际内容类型判定（纯函数，无 I/O）。
 *
 * 任务 11 要求「按实际内容验证类型」，不接受仅凭扩展名或客户端 Content-Type：
 * - 扩展名先映射为规范 MIME，且必须命中服务端白名单；
 * - 再核验真实结构：PDF/PNG/JPEG 的必要结构、ZIP 包声明与主部件（docx/xlsx/pptx）、
 *   OLE 容器与对应文档流（doc/xls/ppt）、严格 UTF-8 文本（txt/md/csv）；
 * - 任一项不匹配即返回 null，由用例统一拒绝为类型不允许。
 */

const TEXT_MIME_TYPES: readonly string[] = ['text/plain', 'text/markdown', 'text/csv'];

const OOXML_KIND_BY_MIME = new Map<string, OoxmlKind>([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation'],
]);

const OLE_KIND_BY_MIME = new Map<string, OleKind>([
  ['application/msword', 'doc'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.ms-powerpoint', 'ppt'],
]);

/** 提取小写扩展名（不含点）；无扩展名返回空串 */
export function extractStoredFileExtension(originalFilename: string): string {
  return path.extname(originalFilename).slice(1).toLowerCase();
}

/**
 * 解析并核对实际内容类型。
 * @returns 规范 MIME；扩展名未知、不在白名单或结构不匹配时返回 null
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
  if (TEXT_MIME_TYPES.includes(mimeType)) {
    return isUtf8Text(buffer);
  }

  switch (mimeType) {
    case 'application/pdf':
      return isPdfStructureValid(buffer);
    case 'image/png':
      return isPngStructureValid(buffer);
    case 'image/jpeg':
      return isJpegStructureValid(buffer);
    default: {
      const ooxmlKind = OOXML_KIND_BY_MIME.get(mimeType);
      if (ooxmlKind) {
        return isOoxmlStructureValid(buffer, ooxmlKind);
      }
      const oleKind = OLE_KIND_BY_MIME.get(mimeType);
      return oleKind ? isOleStructureValid(buffer, oleKind) : false;
    }
  }
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
