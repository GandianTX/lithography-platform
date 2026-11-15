// src/infrastructure/file-storage/local-stored-file-storage.ts

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';

import type { StoredFileStorage } from '@src/usecases/common/ports/stored-file-storage.contract';

import { LocalReferenceDocumentStorage } from './local-reference-document-storage';

/**
 * 共用业务原件本地存储实现。
 *
 * 复用参考资料文件的同一安全实现与同一存储根（referenceDocumentStorage.dir）：
 * - save/open/delete 直接委托，防穿越白名单、随机引用与原子写入完全一致；
 * - 新增 verifyIntegrity：流式重算字节数与 SHA-256，供绑定前核对原件未被替换/截断；
 * - 不在本类暴露或记录服务器绝对路径。
 */
@Injectable()
export class LocalStoredFileStorage implements StoredFileStorage {
  constructor(private readonly base: LocalReferenceDocumentStorage) {}

  save(content: Buffer, fileExtension: string): Promise<string> {
    return this.base.save(content, fileExtension);
  }

  open(storageReference: string): Promise<Readable> {
    return this.base.open(storageReference);
  }

  delete(storageReference: string): Promise<void> {
    return this.base.delete(storageReference);
  }

  async verifyIntegrity(
    storageReference: string,
    expectedChecksumSha256: string,
    expectedByteSize: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedByteSize) || expectedByteSize <= 0) {
      return false;
    }

    const stream = await this.base.open(storageReference);
    const hash = createHash('sha256');
    let actualByteSize = 0;

    try {
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        actualByteSize += buffer.byteLength;
        // 超出登记大小即判定不一致，提前终止读取
        if (actualByteSize > expectedByteSize) {
          stream.destroy();
          return false;
        }
        hash.update(buffer);
      }
    } catch {
      stream.destroy();
      return false;
    }

    if (actualByteSize !== expectedByteSize) {
      return false;
    }

    return hash.digest('hex') === expectedChecksumSha256.toLowerCase();
  }
}
