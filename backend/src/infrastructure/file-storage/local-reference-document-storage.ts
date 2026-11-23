// src/infrastructure/file-storage/local-reference-document-storage.ts

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

import { ReferenceDocumentStorage } from '@src/usecases/common/ports/reference-document-storage.contract';

/** 存储引用格式白名单：32 位随机 hex + 1~8 位小写字母数字扩展名（不含路径分隔符，天然无路径语义） */
const STORAGE_REFERENCE_PATTERN = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/;
/** 扩展名白名单（引用的组成部分）；扩展名与业务 MIME 的映射归 REST 边界层，本实现只管安全字节存取 */
const FILE_EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

/**
 * 参考资料本地文件存储实现。
 *
 * - 存储目录来自配置 referenceDocumentStorage.dir（相对路径相对 backend 运行目录解析），
 *   目录内容为运行时上传产物，不入 Git（backend/.gitignore 的 /var 与 env 示例注释）；
 * - 防穿越双保险：引用必须匹配白名单格式（已排除分隔符与 ..），resolve 后仍断言
 *   结果路径位于存储目录内；两道检查都先于任何磁盘访问；
 * - 不接受客户端提供的任何路径成分；
 * - 服务器绝对路径是实现私有细节（0910 裁定）：契约仅暴露 open() 只读流能力，
 *   路径不作为结果返回给 usecase 或 adapter。
 */
@Injectable()
export class LocalReferenceDocumentStorage implements ReferenceDocumentStorage {
  private readonly baseDir: string;

  constructor(configService: ConfigService) {
    const configured = configService.get<string>(
      'referenceDocumentStorage.dir',
      'var/reference-documents',
    );
    this.baseDir = path.resolve(process.cwd(), configured);
  }

  async save(content: Buffer, fileExtension: string): Promise<string> {
    const normalizedExtension = fileExtension.toLowerCase();

    if (!FILE_EXTENSION_PATTERN.test(normalizedExtension)) {
      throw new Error(`Rejected unsafe file extension: ${JSON.stringify(fileExtension)}`);
    }

    // 随机引用写前查重：杜绝同名覆盖（碰撞概率可忽略，仍防御性检查）
    let reference: string;

    do {
      reference = `${randomBytes(16).toString('hex')}.${normalizedExtension}`;
    } while (fs.existsSync(path.join(this.baseDir, reference)));

    await fsp.mkdir(this.baseDir, { recursive: true });
    await fsp.writeFile(this.resolve(reference), content, { flag: 'wx' });

    return reference;
  }

  async open(storageReference: string): Promise<Readable> {
    // 白名单 + 越界断言先于任何磁盘访问；文件缺失由 access 拦截，调用方收敛为受控错误
    const resolved = this.resolve(storageReference);
    await fsp.access(resolved);
    // **不跟随符号链接**：`createReadStream` 默认跟随链接，链接可把读取指向
    // 存储目录之外的任意文件（业务同步会把这些字节当原件送出去）。
    // 与云备份上云链路同一口径：先 lstat（不跟随）判定是不是链接。
    const stat = await fsp.lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error('Rejected symbolic link storage reference');
    }
    // 真实路径复核：解析后的真实路径仍必须在存储目录内（防目录被换成链接）
    const realBase = await fsp.realpath(this.baseDir);
    const realFile = await fsp.realpath(resolved);
    if (!realFile.startsWith(realBase + path.sep)) {
      throw new Error('Rejected storage reference escaping storage directory');
    }

    return fs.createReadStream(resolved);
  }

  /** 私有实现细节：绝不把路径返回给契约调用方，仅内部 save/open/delete 使用 */
  private resolve(storageReference: string): string {
    if (!STORAGE_REFERENCE_PATTERN.test(storageReference)) {
      throw new Error('Rejected invalid storage reference format');
    }

    const resolved = path.resolve(this.baseDir, storageReference);

    // 白名单格式已排除越界可能，仍断言解析结果在存储目录内（双保险）
    if (!resolved.startsWith(this.baseDir + path.sep)) {
      throw new Error('Rejected storage reference escaping storage directory');
    }

    return resolved;
  }

  async delete(storageReference: string): Promise<void> {
    try {
      await fsp.unlink(this.resolve(storageReference));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
