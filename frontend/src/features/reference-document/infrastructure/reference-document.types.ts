// src/features/reference-document/infrastructure/reference-document.types.ts

/**
 * AI 参考资料库的前端契约类型（与后端 B-05 读/写 DTO 逐字段对齐）。
 *
 * 契约依据：0907.docx 任务二 + backend/src/adapters/api/graphql/reference-document/dto/。
 * 日期字段后端为 Date 标量，GraphQL JSON 序列化后是 ISO 字符串；
 * 不出现任何账号 ID 与存储引用路径字段（后端 DTO 已在边界剥离）。
 */

/** 案例处理状态（受控字符串）：未解决 / 处理中 / 已解决 */
export type ReferenceDocumentCaseHandlingStatus = 'UNRESOLVED' | 'IN_PROGRESS' | 'RESOLVED';

/** 入库方式来源（受控字符串）：ADMIN_DIRECT=管理员直建；REVIEWED_SUBMISSION=投稿审核发布 */
export type ReferenceDocumentIngestMethod = 'ADMIN_DIRECT' | 'REVIEWED_SUBMISSION';

/** 列表项（列表查询输出；无文本内容，无账号 ID / 存储引用） */
export type ReferenceDocumentListItem = {
  id: number;
  title: string;
  documentType: string;
  /** 为空表示通用资料 */
  equipmentModelId: number | null;
  /** 通用资料为空 */
  equipmentModelName: string | null;
  /** 机型文字（用户手填；与机型 ID 互斥） */
  equipmentModelText: string | null;
  description: string | null;
  /** 有存储引用的资料返回；纯文本资料为空 */
  originalFilename: string | null;
  /** 所属组织展示名（本组织范围内固定为本组织） */
  organizationName: string;
  /** 入库方式来源：管理员直建 / 投稿审核发布 */
  ingestMethod: ReferenceDocumentIngestMethod;
  /** 案例处理状态；普通资料为空 */
  caseHandlingStatus: ReferenceDocumentCaseHandlingStatus | null;
  /** 创建人当前昵称（缺失时后端回落「未知用户」） */
  creatorNickname: string;
  createdAt: string;
};

/** 正式资料案例明细（仅 FAULT_CASE 资料非空；普通资料为 null） */
export type ReferenceDocumentCaseDetail = {
  /** 设备错误码（保留大小写与内部符号） */
  errorCode: string | null;
  handlingStatus: ReferenceDocumentCaseHandlingStatus;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  /** 处理结果；已解决时必填 */
  resolution: string | null;
};

/**
 * 详情（完整元数据 + 文本内容；编辑与软删仅 SUPER_ADMIN 可见，由页面层按角色控制）。
 * 详情不含 caseHandlingStatus（后端 Detail DTO 无此字段，S7 真机样例核验）：
 * 案例状态经 caseDetail.handlingStatus 表达，仅列表使用 caseHandlingStatus。
 */
export type ReferenceDocumentDetail = Omit<ReferenceDocumentListItem, 'caseHandlingStatus'> & {
  mimeType: string | null;
  /** 是否带可下载文件（权威判定 = 后端存储引用非空；下载按钮与编辑放行均以本字段为准，
   *  不从 originalFilename 推断——有文件名但无存储引用的行不承诺可下载） */
  hasFile: boolean;
  contentText: string | null;
  /** 案例明细；普通资料为空（前端需兼容可空 caseDetail） */
  caseDetail: ReferenceDocumentCaseDetail | null;
  updatedAt: string;
};

/** OFFSET 分页请求参数（真实 adapter 内部补齐 mode/withTotal，调用方不感知） */
export type ReferenceDocumentListPagination = {
  page: number;
  pageSize: number;
};

/** 列表筛选（标题模糊搜索 / 类型等值 / 型号等值 / 案例处理状态等值；均可选） */
export type ReferenceDocumentListFilter = {
  titleKeyword?: string;
  documentType?: string;
  equipmentModelId?: number;
  /** 案例处理状态等值筛选（仅命中案例资料） */
  caseHandlingStatus?: ReferenceDocumentCaseHandlingStatus;
};

/** OFFSET 分页结果（列表统一 createdAt DESC + id DESC） */
export type ReferenceDocumentListPage = {
  items: ReferenceDocumentListItem[];
  total: number;
  page: number;
  pageSize: number;
};

/** 设备型号下拉选项（复用后端 equipmentModels 查询的形状） */
export type ReferenceDocumentEquipmentModelOption = {
  id: number;
  modelCode: string;
  modelName: string;
};

/**
 * 文档类型下拉选项（documentType 为后端自由字符串等值筛选，前端提供固定候选集）。
 * 候选值与 backend/scripts/seed-mock.ts 的种子语义对齐；新增候选需同步种子。
 */
export const REFERENCE_DOCUMENT_TYPE_OPTIONS = [
  'ERROR_CODE_MANUAL',
  'MAINTENANCE_GUIDE',
  'SAFETY_STANDARD',
  'CHECKLIST',
] as const;

export type ReferenceDocumentTypeOption = (typeof REFERENCE_DOCUMENT_TYPE_OPTIONS)[number];

/** 文档类型显示映射（未知类型原样展示，不强行归类） */
export const REFERENCE_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  CHECKLIST: '检查表',
  ERROR_CODE_MANUAL: '错误代码手册',
  MAINTENANCE_GUIDE: '维护指南',
  SAFETY_STANDARD: '安全规范',
};

/**
 * 字段长度上限与上传策略（本切片内唯一前端真源，表单与 Mock adapter 共用）。
 *
 * 权威在服务端，本处仅为输入 / 选文件时的即时反馈镜像：
 * - 字段上限见 backend dto/reference-document-write.dto.ts；
 * - 上传大小与类型白名单见后端 env（REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES /
 *   REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES，类型判定以扩展名为主）。
 *
 * 因此本地预检不得被当作权威判定：服务端拒绝必须能覆盖本地放行结果
 * （例如服务端上限更小时，本地预检通过仍会被服务端拒绝并展示后端消息）。
 * 后端默认值变化时需同步本处常量。
 */
export const REFERENCE_DOCUMENT_TITLE_MAX_LENGTH = 255;
export const REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH = 100;

/** 单文件大小上限（字节）与提示文案 */
export const REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES_TEXT = '20MB';

/**
 * 允许上传的扩展名 → MIME（键集合即白名单，插入顺序即表单提示的展示顺序）。
 * Mock adapter 取 MIME 做文件元数据模拟，表单由此派生扩展名白名单与提示文案。
 */
export const REFERENCE_DOCUMENT_UPLOAD_EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};

/** 创建输入（contentText 本周必填：仅文本来源；双来源约束由后端兜底） */
export type CreateReferenceDocumentInput = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  description: string | null;
  contentText: string;
};

/**
 * 编辑补丁（PATCH 语义）：undefined 保持原值。
 * 形状与后端 UpdateReferenceDocumentInput 对齐：title/documentType 在 GraphQL 层可传
 * null，但语义上属必填字段，显式 null 会被后端直接拒绝（前端 adapter 同口径）。
 * - equipmentModelId / description 允许显式 null 清空；
 * - contentText 空白视为清空：后端编辑防御已放宽，仅当资料已有文件时放行
 *   （双空拦截由表单预检承担，adapter 不做二次判定）。
 */
export type UpdateReferenceDocumentPatch = {
  title?: string | null;
  documentType?: string | null;
  equipmentModelId?: number | null;
  description?: string | null;
  contentText?: string;
};

/**
 * 详情读取结果（domain failure 显式结果）：
 * 不存在 / 已软删由后端统一 NOT_FOUND（防探测，不区分原因），前端归并为 not-found；
 * transport / auth / network 失败不上抛为该结果，仍抛 GraphQLIngressError。
 */
export type ReferenceDocumentDetailResult =
  | { ok: true; detail: ReferenceDocumentDetail }
  | { ok: false; reason: 'not-found'; message: string };

/**
 * 创建结果（domain failure 显式结果）：
 * - model-not-found：所选设备型号不存在
 * - invalid-input：字段非法（必填空白 / 超长 / 型号 ID 非法）
 * - creation-failed：其余业务失败
 */
export type CreateReferenceDocumentResult =
  | { ok: true; id: number }
  | {
      ok: false;
      reason: 'model-not-found' | 'invalid-input' | 'creation-failed';
      message: string;
    };

/**
 * REST multipart 创建输入（文件来源路径；0909 第二轮阻塞项 1）。
 * contentText 可空（仅文件创建），但与文件双空时后端拒绝（CONTENT_SOURCE_EMPTY）。
 */
export type CreateReferenceDocumentWithFileInput = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  description: string | null;
  contentText: string | null;
  file: File;
};

/**
 * REST multipart 创建结果（domain failure 显式结果）。
 * 文件边界专属失败：file-too-large（超大小上限）、file-type-not-allowed（白名单外类型）。
 */
export type CreateReferenceDocumentWithFileResult =
  | { ok: true; id: number }
  | {
      ok: false;
      reason:
        | 'model-not-found'
        | 'invalid-input'
        | 'file-too-large'
        | 'file-type-not-allowed'
        | 'creation-failed';
      message: string;
    };

/**
 * REST 下载结果（domain failure 显式结果）。
 * - not-found：资料不存在 / 已软删（统一防探测口径）
 * - file-not-available：纯文本资料无文件，或存储对象缺失（受控错误）
 * - download-failed：其余失败（transport / auth / 服务器错误）
 */
export type ReferenceDocumentFileDownloadResult =
  | { ok: true; blob: Blob; filename: string }
  | {
      ok: false;
      reason: 'not-found' | 'file-not-available' | 'download-failed';
      message: string;
    };

/**
 * 编辑结果（domain failure 显式结果；已软删 / 不存在统一 not-found）
 */
export type UpdateReferenceDocumentResult =
  | { ok: true; id: number }
  | {
      ok: false;
      reason: 'not-found' | 'model-not-found' | 'invalid-input' | 'update-failed';
      message: string;
    };

/**
 * 案例专属更正补丁（与后端 UpdateReferenceDocumentCaseInput 对齐；仅案例资料）。
 * 部分提交语义：undefined 保持原值；可读正文为派生字段不在补丁中；
 * 类型 / 归属组织 / 来源与原附件不可通过本接口修改；
 * 必填字段（故障现象 / 复现步骤 / 处理状态）不可清空，已解决必须给出处理结果。
 */
export type UpdateReferenceDocumentCasePatch = {
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
  handlingStatus?: ReferenceDocumentCaseHandlingStatus | null;
  resolution?: string | null;
};

/**
 * 案例更正结果（domain failure 显式结果）：
 * - not-found：不存在 / 已软删 / 跨组织（统一防探测口径）；
 * - invalid-input：非案例资料走本接口 / 必填校验失败（后端口径，非 not-found）；
 * - model-not-found：型号不存在经 errorCode 细化；
 * - update-failed：明细缺失等定式破坏。
 */
export type UpdateReferenceDocumentCaseResult =
  | { ok: true; id: number; updatedAt: string }
  | {
      ok: false;
      reason: 'not-found' | 'model-not-found' | 'invalid-input' | 'update-failed';
      message: string;
    };

/**
 * 软删除结果（domain failure 显式结果）。
 * 注意与维修申请的差异：本模块重复软删不幂等——已软删 / 不存在统一 NOT_FOUND
 * （backend e2e 已钉住该口径），前端归并 not-found。
 */
export type DeleteReferenceDocumentResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'delete-failed'; message: string };
