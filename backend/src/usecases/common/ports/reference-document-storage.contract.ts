// src/usecases/common/ports/reference-document-storage.contract.ts

import type { Readable } from 'node:stream';

/**
 * 参考资料文件存储 boundary contract（usecase 层拥有，infrastructure 提供本地实现）。
 *
 * - 存储引用必须由服务端生成：不可猜测且无路径语义，客户端不参与命名（负责人 0909 第二轮要求）；
 * - 引用格式白名单与越界防护属于实现细节，契约只承诺「安全引用 ↔ 字节内容」；
 *   实现细节（含服务器绝对路径）不得作为契约结果暴露给 usecase 或 adapter（负责人 0910 要求）；
 * - 带文件创建的原子性编排（save → 事务落库 → 失败补偿 delete）归
 *   CreateReferenceDocumentWithFileUsecase 统一持有，adapter 不参与编排；
 * - 软删除只标记数据库记录，本契约的 delete 仅用于上传/落库失败的补偿清理，不用于业务删除。
 *
 * 接口类型同步 re-export 于相邻 reference-document.types.ts（adapter 层架构规则：
 * 运行时 token 从本契约导入，流程类型从 *.types.ts type-only 导入）。
 */
export const REFERENCE_DOCUMENT_STORAGE = Symbol('REFERENCE_DOCUMENT_STORAGE');

export interface ReferenceDocumentStorage {
  /**
   * 保存文件内容，返回服务端生成的存储引用。
   * 引用由密码学随机字节生成并写前查重，同名覆盖不可能发生。
   */
  save(content: Buffer, fileExtension: string): Promise<string>;

  /**
   * 打开引用对应文件的只读流（内容安全读取能力）。
   * 引用格式非法、解析越出存储目录或文件不存在时抛错，绝不返回路径或暴露实现细节；
   * 调用方（下载用例）负责把失败收敛为受控错误。
   */
  open(storageReference: string): Promise<Readable>;

  /** 删除引用对应文件；文件不存在时静默成功（幂等） */
  delete(storageReference: string): Promise<void>;
}
