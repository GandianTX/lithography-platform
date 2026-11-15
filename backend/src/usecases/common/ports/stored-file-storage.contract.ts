// src/usecases/common/ports/stored-file-storage.contract.ts

import type { Readable } from 'node:stream';

/**
 * 共用业务原件私有存储 boundary contract（usecase 层拥有；infrastructure 复用
 * 参考资料文件的本地存储实现与同一存储根，安全能力对齐）。
 *
 * - 存储引用必须由服务端生成：不可猜测、无路径语义，客户端不参与命名；
 * - 服务器绝对路径是实现私有细节，不得作为契约结果暴露给 usecase 或 adapter；
 * - 授权与业务校验必须先于任何 save/open 调用（无权限请求不得先写文件）；
 * - delete 仅用于上传事务失败的补偿清理，不用于业务删除；
 * - verifyIntegrity 供绑定时核对原件未被替换/截断：字节数或 SHA-256 不一致返回 false，
 *   引用非法或存储不可读时抛错；调用方统一收敛为受控错误。
 */
export const STORED_FILE_STORAGE = Symbol('STORED_FILE_STORAGE');

export interface StoredFileStorage {
  /** 保存文件内容，返回服务端生成的存储引用 */
  save(content: Buffer, fileExtension: string): Promise<string>;

  /** 打开引用对应文件的只读流；引用非法、越界或文件不存在时抛错 */
  open(storageReference: string): Promise<Readable>;

  /** 删除引用对应文件；文件不存在时静默成功（幂等）——仅用于上传失败补偿 */
  delete(storageReference: string): Promise<void>;

  /** 核对存储对象实际字节数与 SHA-256；不一致返回 false，不可读时抛错 */
  verifyIntegrity(
    storageReference: string,
    expectedChecksumSha256: string,
    expectedByteSize: number,
  ): Promise<boolean>;
}
