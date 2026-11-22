// src/core/common/digest/file-digest.ts

/**
 * 文件摘要计算（**唯一实现**）。
 *
 * 此前记录包导入服务与备份还原预检服务各写了一份逐字相同的流式 SHA-256 函数；
 * 两份实现漂移会让"导出时算出的摘要"与"导入时核对的摘要"口径不一致。
 * 这里给出唯一一份，其余调用方一律复用。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** 计算文件内容的 SHA-256（十六进制小写）；按字节流读取，不整读进内存 */
export async function sha256FileDigest(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
