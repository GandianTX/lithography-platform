// src/usecases/reference-document/reference-document.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PaginationParams } from '@core/pagination/pagination.types';
import type { Readable } from 'node:stream';
import type {
  ReferenceDocumentDetailView,
  ReferenceDocumentListPage,
} from '@src/modules/lithography/lithography.types';

/**
 * 资料可编辑字段补丁（编辑用例的部分提交语义）：
 * - undefined：保持原值
 * - null：清空（仅 equipmentModelId / description 允许；contentText 清空仅在
 *   目标资料已有存储引用时放行，双空防御由编辑用例判定）
 * - 字符串/数字：新值（经 usecase 规范化与校验）
 */
export type ReferenceDocumentEditablePatch = {
  title?: string | null;
  documentType?: string | null;
  equipmentModelId?: number | null;
  description?: string | null;
  contentText?: string | null;
};

/**
 * 案例更正可编辑字段补丁（A-PR0 §S6 专属更正的部分提交语义）：
 * - undefined：保持原值
 * - null：清空/置空（必填字段被置空时在合并后校验拒绝）
 * - 字符串/数字：新值（经 usecase 规范化与校验）
 * - equipmentModelId 与 equipmentModelText 独立合并（口径同投稿草稿补丁），
 *   合并后互斥校验拒绝两者并存；替换机型需在同一补丁「一侧置空 + 一侧设值」
 * - 可读正文（contentText）是派生字段：由合并后的明细字段重新生成，不在补丁白名单中；
 *   类型、归属组织、来源投稿/版本与原附件不在此补丁内（不可改）
 */
export type ReferenceDocumentCaseEditablePatch = {
  title?: string | null;
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  description?: string | null;
  errorCode?: string | null;
  phenomenon?: string | null;
  conditionText?: string | null;
  reproductionSteps?: string | null;
  diagnosis?: string | null;
  actionTaken?: string | null;
  handlingStatus?: string | null;
  resolution?: string | null;
};

export type ListReferenceDocumentsCommand = {
  session: UsecaseSession;
  pagination: PaginationParams;
  filter: {
    title?: string;
    documentType?: string;
    equipmentModelId?: number;
    /** 案例处理状态等值筛选（A-PR0 §4.3；仅命中 FAULT_CASE 资料的案例明细） */
    caseHandlingStatus?: string;
  };
};

export type GetReferenceDocumentDetailCommand = {
  session: UsecaseSession;
  documentId: number;
};

export type CreateReferenceDocumentCommand = {
  session: UsecaseSession;
  title: string;
  documentType: string;
  /** 为空表示通用资料 */
  equipmentModelId?: number | null;
  description?: string | null;
  /** 文本内容来源；可为 null（仅文件创建），但与 file 双空时 usecase 拒绝 */
  contentText: string | null;
  /**
   * 文件来源载荷（REST multipart 上传路径）：存储引用由服务端生成（不可猜测、无路径语义），
   * GraphQL 纯文本创建路径不携带本字段。
   */
  file?: {
    originalFilename: string;
    mimeType: string;
    storageReference: string;
  } | null;
};

export type GetReferenceDocumentFileCommand = {
  session: UsecaseSession;
  documentId: number;
};

/**
 * 带文件创建命令（REST multipart 上传路径，负责人 0910 架构要求）：
 * 文件保存、数据库写入与失败补偿由 CreateReferenceDocumentWithFileUsecase 统一编排，
 * adapter 只负责 multipart 协议解析后组装本命令。
 */
export type CreateReferenceDocumentWithFileCommand = {
  session: UsecaseSession;
  title: string;
  documentType: string;
  /** 为空表示通用资料 */
  equipmentModelId?: number | null;
  description?: string | null;
  /** 文本内容来源；可为 null（仅文件创建），双空拒绝归 CreateReferenceDocumentUsecase */
  contentText: string | null;
  /**
   * multipart 文件载荷（协议解析产物）：原始文件名已由 adapter 完成 latin1 还原与
   * 展示清洗；大小上限以 buffer 实际字节数判定（负责人 0911：不信任声明值）；
   * 扩展名 → MIME 映射、存储保存与补偿归本用例层。
   */
  file: {
    buffer: Buffer;
    originalFilename: string;
  };
};

/**
 * 存储契约接口 re-export（接口定义在相邻 reference-document-storage.contract.ts；
 * adapter 层架构规则：流程类型从 *.types.ts type-only 导入）。
 */
export type { ReferenceDocumentStorage } from './reference-document-storage.contract';

/**
 * 下载用例的内部载荷：content 为存储契约 open() 返回的只读内容流，仅供 adapter
 * 组装响应，不得携带服务器路径等实现细节（负责人 0910 要求；对外 DTO 与错误信息
 * 同样不携带路径）。
 */
export type ReferenceDocumentFilePayload = {
  documentId: number;
  originalFilename: string;
  mimeType: string;
  content: Readable;
};

export type UpdateReferenceDocumentCommand = {
  session: UsecaseSession;
  documentId: number;
  patch: ReferenceDocumentEditablePatch;
};

/**
 * 案例专属更正命令（A-PR0 §S6 / §4.1 `updateReferenceDocumentCase`）：
 * 仅 SUPER_ADMIN、仅本组织、仅未软删、仅 FAULT_CASE 资料可更正；
 * 副补丁经合并与最终态校验后，主资料与案例明细在同一事务内更新。
 */
export type UpdateReferenceDocumentCaseCommand = {
  session: UsecaseSession;
  documentId: number;
  patch: ReferenceDocumentCaseEditablePatch;
};

export type SoftDeleteReferenceDocumentCommand = {
  session: UsecaseSession;
  documentId: number;
};

export type ReferenceDocumentMutationResult = {
  id: number;
};

/** 案例更正结果：正式资料 ID 与更新时间（A-PR0 §4.1「返回正式资料 ID/更新时间」） */
export type ReferenceDocumentCaseMutationResult = {
  id: number;
  updatedAt: Date;
};

export type GetReferenceDocumentDetailResult = ReferenceDocumentDetailView;
export type ListReferenceDocumentsResult = ReferenceDocumentListPage;
