// src/usecases/reference-document/reference-document.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import type { PaginationParams } from '@core/pagination/pagination.types';
import type { Readable } from 'node:stream';
import type {
  ReferenceDocumentLibraryDetailView,
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

/**
 * 归属待核实清单命令（任务 07 R061-01）：仅一级管理员可调用；
 * 输入仅分页（无筛选维度），范围恒为 GLOBAL（全公司 PENDING 条目）。
 */
export type ListPendingOwnershipReferenceDocumentsCommand = {
  session: UsecaseSession;
  pagination: PaginationParams;
};

/**
 * 归属待核实详情命令（任务 07 R061-01）：仅一级管理员；
 * 仅 ownership_status = PENDING 条目可读，普通正式资料走普通资料库详情。
 */
export type GetPendingOwnershipReferenceDocumentDetailCommand = {
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
 * 存储契约接口 re-export（接口定义在 usecases/common/ports/reference-document-storage.contract.ts；
 * adapter 层架构规则：流程类型从 *.types.ts type-only 导入）。
 */
export type { ReferenceDocumentStorage } from '@src/usecases/common/ports/reference-document-storage.contract';

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
  /**
   * 任务 07 R053：expected_version = 资料 current_revision_no。
   * 过期即拒绝（VERSION_CONFLICT），防止并发管理操作被旧版本覆盖。
   */
  expectedVersion: number;
};

export type ReferenceDocumentMutationResult = {
  id: number;
};

/** 管理操作结果：资料 ID 与本次生成的新生效版本号（R053/R058–R061） */
export type ReferenceDocumentManagedMutationResult = {
  id: number;
  revisionNo: number;
};

/**
 * 管理操作 expected_version 输入校验：必须为非负整数。
 *
 * 版本语义（任务 07 R053/R058–R061）：expected_version 是
 * reference_document.current_revision_no 的乐观并发令牌，而该列默认 0
 * （= 仅原始冻结报告/原始正文，尚无管理修订）。因此存量资料与新建资料的
 * 首次管理操作合法令牌就是 0，只有负数（以及非整数）属于非法输入。
 */
export function assertExpectedVersionInput(expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      'expected_version 必须为非负整数',
      { expectedVersion },
    );
  }
}

/**
 * 管理修订命令（任务 07 R058）：仅一级管理员可修订有权正式资料的当前生效内容。
 * 补丁为全量值语义（提交的字段即为新值）；正文清空仅允许已有存储引用的资料；
 * 结构化正式资料（报告来源或已结构化修订）的正文改写被拒绝，须走结构化入口。
 */
export type ReviseReferenceDocumentCommand = {
  session: UsecaseSession;
  documentId: number;
  expectedVersion: number;
  reason: string;
  patch: {
    title?: string;
    description?: string | null;
    contentText?: string | null;
  };
};

/** 管理修订编辑初值读侧命令（独立管理修订页，仅一级管理员） */
export type ReferenceDocumentEditableContentCommand = {
  session: UsecaseSession;
  documentId: number;
};

/**
 * 结构化管理修订输入载荷（任务 07，报告来源正式资料）：与 GraphQL InputDTO
 * 结构对齐；规范化与分支一致性由 usecase 层严格裁决（normalizeStructuredRevisionContent）。
 * 机型字段不在载荷内：改选目标按 patch.equipmentModelId 单独提交，
 * 服务端按 ID 校验存在且启用并从字典取名称，不信任客户端自报名称。
 */
export type ReferenceDocumentStructuredRevisionPayload = {
  schemaVersion: number;
  maintenanceDate: string;
  maintenanceEngineerName: string;
  /** 客户厂家文本（本轮确认需求：一级管理员可修订；按报告字段规则校验） */
  customerFactoryName: string;
  resetResult: string;
  faults: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  handlingResult?: string | null;
  closureReason?: string | null;
  actualCause?: string | null;
  repairActions?: string | null;
  verificationResult?: string | null;
  supplementaryNote?: string | null;
};

/**
 * 结构化管理修订命令（任务 07，仅一级管理员）：结构化内容为全量值语义；
 * 厂家文本可修订；equipmentModelId 未提交＝保持原值，显式 null＝拒绝（不允许清空）。
 */
export type ReviseReferenceDocumentStructuredCommand = {
  session: UsecaseSession;
  documentId: number;
  expectedVersion: number;
  reason: string;
  patch: {
    title?: string;
    description?: string | null;
    structured?: ReferenceDocumentStructuredRevisionPayload;
    /** 机型改选：undefined=保持原关联；null=显式清空（拒绝）；数字=改选目标 */
    equipmentModelId?: number | null;
  };
};

/** 下架命令（任务 07 R059）：发布状态置 OFFLINE，保留业务历史，不写关键审计 */
export type OfflineReferenceDocumentCommand = {
  session: UsecaseSession;
  documentId: number;
  expectedVersion: number;
  reason: string;
};

/** 管理删除命令（任务 07 R060）：软删除 + 生效版本 + 历史 + 关键审计，同事务 */
export type AdminDeleteReferenceDocumentCommand = {
  session: UsecaseSession;
  documentId: number;
  expectedVersion: number;
  reason: string;
};

/**
 * 归属更正命令（任务 07 R061-02）：仅提交需要更正的字段，未提交字段保留原值；
 * 更换上传者不自动采用其当前公司；ownership_status 只依据核实证据更新。
 */
export type CorrectReferenceDocumentOwnershipCommand = {
  session: UsecaseSession;
  documentId: number;
  expectedVersion: number;
  verificationReason: string;
  createdByAccountId?: number;
  ownerOrganizationId?: number;
};

/** 案例更正结果：正式资料 ID 与更新时间（A-PR0 §4.1「返回正式资料 ID/更新时间」） */
export type ReferenceDocumentCaseMutationResult = {
  id: number;
  updatedAt: Date;
};

export type GetReferenceDocumentDetailResult = ReferenceDocumentLibraryDetailView;
export type ListReferenceDocumentsResult = ReferenceDocumentListPage;

/** 历史版本读取命令（与详情共用同一可见性判定） */
export type ListReferenceDocumentRevisionsCommand = {
  session: UsecaseSession;
  documentId: number;
};

/** 历史版本条目：不返回 before/after 大快照，只给可展示摘要 */
export type ReferenceDocumentRevisionView = {
  revisionNo: number;
  reason: string;
  actorNickname: string;
  createdAt: Date;
  /** 该修订版本的生效正文（after_snapshot.contentText；授权追溯旧版本内容） */
  contentText: string | null;
};

/**
 * 历史版本读取结果：原始冻结版本以 sourceReportVersionId 表达（版本号由任务 06
 * 冻结版本自身维护），管理修订以 revisions 表达。
 */
export type ListReferenceDocumentRevisionsResult = {
  documentId: number;
  currentRevisionNo: number;
  sourceKind: string;
  sourceReportVersionId: number | null;
  revisions: ReferenceDocumentRevisionView[];
};
