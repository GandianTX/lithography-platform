// src/adapters/api/rest/shared/upload-boundary.util.ts

import * as path from 'node:path';

import { HttpException } from '@nestjs/common';

import { DomainError } from '@core/common/errors/domain-error';
import { resolveRestStatus } from '@core/common/errors/rest-error-status';

/**
 * REST multipart 上传/下载边界的共享运输层工具（参考资料与投稿附件共用）。
 *
 * - 只做协议层职责：latin1 误码还原、展示用文件名清洗、文件结构校验、
 *   DomainError → REST 统一错误体映射、下载响应头组装；
 * - 不含业务规则（大小/类型/双空等判定归各域 usecase 单一真源）；
 * - multer 硬上限属于传输层防御，业务上限以 usecase 配置为准并给出业务错误码。
 */

/** 上传边界防御性硬上限：multer 先挡住极端超大请求；业务上限以下方 usecase 配置为准 */
export const UPLOAD_HARD_LIMIT_BYTES = 64 * 1024 * 1024;

/** REST 边界的 multipart 文件最小结构（不依赖 multer 类型包，仅取用到的字段） */
export type UploadedFilePayload = {
  buffer: Buffer;
  originalname: string;
};

/**
 * 还原 multer/busboy 对 multipart filename 的 latin1 误码：浏览器发送的 UTF-8 文件名字节
 * 会被逐字节映射为 U+0080..U+00FF（中文文件名在此处已是乱码）。当且仅当全部字符落在
 * latin1 范围时做一次 latin1→UTF-8 还原：纯 ASCII 恒等；已正确解码的高码位字符（含中文）
 * 不受影响。还原结果含 U+FFFD（非 UTF-8 字节）时放弃还原保持原值。
 */
export function decodeUtf8FileName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- latin1 范围检测是本函数的既定职责（识别 multer 误码字节），与 sanitizeOriginalFilename 同理
  if (!/^[\u0000-\u00ff]+$/.test(raw)) {
    return raw;
  }
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? raw : decoded;
}

/**
 * 清洗客户端文件名：只取 basename、剔除控制字符与首尾空白；
 * 仅作展示用途存入 original_filename，不参与存储命名与路径组装。
 */
export function sanitizeOriginalFilename(raw: string): string {
  const cleaned = path
    .basename(raw)
    // eslint-disable-next-line no-control-regex -- 剔除控制字符是本函数的既定安全职责（清洗客户端文件名）
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 255) : '未命名文件';
}

/**
 * 校验 multipart 文件结构并转换；文件缺失/格式不合法时以调用域的错误码拒绝
 * （各域保持自己的错误码边界，不共享单一错误码）。
 */
export function toUploadedFilePayload(file: unknown, errorCode: string): UploadedFilePayload {
  if (
    typeof file !== 'object' ||
    file === null ||
    !Buffer.isBuffer((file as { buffer?: unknown }).buffer) ||
    typeof (file as { originalname?: unknown }).originalname !== 'string'
  ) {
    throw new DomainError(errorCode, '上传文件缺失或格式不合法');
  }

  return file as UploadedFilePayload;
}

/** DomainError → REST 统一错误体；函数签名返回 never，便于在 catch 中直接调用后 throw */
export function toRestError(error: DomainError): never {
  const status = resolveRestStatus(error.code);

  throw new HttpException({ statusCode: status, code: error.code, message: error.message }, status);
}

/**
 * 组装下载响应头（MIME + RFC 5987 文件名编码）：
 * encodeURIComponent 不转义 ' * ( )，它们均不在 RFC 5987 attr-char 内
 * （' 还是 ext-value 分隔符），需补编码，防乱码与头注入。
 */
export function applyDownloadHeaders(
  response: { setHeader(name: string, value: string): unknown },
  params: { mimeType: string; originalFilename: string },
): void {
  const encodedFilename = encodeURIComponent(params.originalFilename).replace(
    /['*()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  response.setHeader('Content-Type', params.mimeType);
  response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);
}
