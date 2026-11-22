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

/** 来源类型：独立历史报告 / 工单总结 / 普通资料 */
export type ReferenceDocumentSourceKind = 'INDEPENDENT_REPORT' | 'WORK_ORDER_SUMMARY' | 'MATERIAL';

/** 生效正文来源：原始正文 / 原始冻结报告 / 管理修订后正文 */
export type ReferenceDocumentContentSource = 'ORIGINAL' | 'FROZEN_REPORT' | 'CURRENT_REVISION';

/** 冻结报告初始报警（只读） */
export type ReferenceDocumentFrozenAlarm = {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: string;
  resetResult: string;
};

/** 冻结报告排查步骤（只读） */
export type ReferenceDocumentFrozenStep = {
  stepNo: number;
  stepCode: string;
  phaseCode: string;
  partName: string | null;
  actionText: string;
  resultText: string | null;
  newAlarmCode: string | null;
  isValidNewBranch: boolean;
};

/** 冻结报告故障面板（任务 07 加法扩展：任务 06 快照扩展键；任务 04 旧快照为空数组） */
export type ReferenceDocumentFrozenFault = {
  branchKind: string;
  stepCode: string | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

/** 冻结报告内容（报告来源且无管理修订时的生效内容） */
export type ReferenceDocumentFrozenReport = {
  versionId: number;
  versionNo: number;
  schemaVersion: number;
  submittedAt: string;
  sourceType: string;
  repairRequestId: number | null;
  title: string;
  customerFactoryName: string;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string;
  maintenanceEngineerName: string;
  alarms: ReferenceDocumentFrozenAlarm[];
  steps: ReferenceDocumentFrozenStep[];
  /** 任务 07 加法扩展：任务 06 快照扩展键展示视图；任务 04 旧快照为空值 */
  faults: ReferenceDocumentFrozenFault[];
  handlingResult: string | null;
  closureReason: string | null;
  resetResult: string | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
  ai: {
    usage: string;
    sourceType: string | null;
    sourceId: string | null;
    sourceVersion: string | null;
    score: number | null;
    correctness: string | null;
    helpfulness: number | null;
    note: string | null;
  };
};

/** 资料结构化故障面板（管理修订读/写契约；分支枚举与任务 06 冻结快照一致） */
export type ReferenceDocumentStructuredFault = {
  branchKind: 'INITIAL' | 'RESET_NEW_FAULT' | 'STEP_NEW_FAULT';
  stepCode: string | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

/** 资料结构化排查步骤（管理修订读/写契约；stepCode 为稳定关联键） */
export type ReferenceDocumentStructuredStep = {
  stepCode: string;
  stepNo: number;
  phaseCode: string | null;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: 'RESOLVED' | 'UNRESOLVED' | 'NEW_FAULT';
};

/** 资料生效结构化内容（任务 07 管理修订；机型文字由服务端从字典取名称写入快照） */
export type ReferenceDocumentStructuredContent = {
  schemaVersion: number;
  maintenanceDate: string;
  maintenanceEngineerName: string;
  customerFactoryName: string;
  equipmentModelText: string | null;
  resetResult: 'NORMAL' | 'SAME_FAULT' | 'NEW_FAULT';
  faults: ReferenceDocumentStructuredFault[];
  steps: ReferenceDocumentStructuredStep[];
  handlingResult: string | null;
  closureReason: string | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
};

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
  /** 来源类型：独立报告 / 工单总结 / 普通资料 */
  sourceKind: ReferenceDocumentSourceKind;
  /** 生效管理修订号；0 表示原始冻结内容或原始正文 */
  effectiveRevisionNo: number;
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
  /** 生效正文：管理修订后正文 > 原始冻结报告拼装文本 > 资料自身正文 */
  contentText: string | null;
  /** 生效正文来源 */
  contentSource: ReferenceDocumentContentSource;
  /** 来源报告 ID（报告来源资料返回） */
  sourceReportId: number | null;
  /** 原始冻结报告版本 ID（永久保留，供历史版本说明） */
  sourceReportVersionId: number | null;
  /** 冻结报告内容；仅报告来源且无管理修订时返回 */
  frozenReport: ReferenceDocumentFrozenReport | null;
  /** 生效管理修订的结构化内容（任务 07；生效修订快照携带 structuredReport 键时返回） */
  structuredContent: ReferenceDocumentStructuredContent | null;
  /** 案例明细；普通资料为空（前端需兼容可空 caseDetail） */
  caseDetail: ReferenceDocumentCaseDetail | null;
  /** 当前会话账号是否为本条资料的原作者（任务 07 R053：作者删除入口唯一依据；不返回账号 ID） */
  viewerIsOriginalAuthor: boolean;
  updatedAt: string;
};

/** 历史版本条目（管理修订摘要 + 该版本生效正文，供授权追溯旧版本内容） */
export type ReferenceDocumentRevision = {
  revisionNo: number;
  reason: string;
  actorNickname: string;
  createdAt: string;
  /** 该修订版本的生效正文（快照缺内容键时为 null） */
  contentText: string | null;
};

/** 历史版本读取结果 */
export type ReferenceDocumentRevisions = {
  documentId: number;
  currentRevisionNo: number;
  sourceKind: ReferenceDocumentSourceKind;
  sourceReportVersionId: number | null;
  revisions: ReferenceDocumentRevision[];
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

/**
 * 管理修订补丁（任务 07 R058，仅一级管理员）：编辑当前生效内容，原因必填。
 * PATCH 语义：undefined 保持原值；FAULT_CASE 正文须走案例更正接口（后端拒绝）；
 * 结构化正式资料的正文改写被拒绝，须走结构化管理修订入口；
 * expected_version 过期返回 version-conflict（CONFLICT），须重新读取当前版本后重试。
 */
export type ReviseReferenceDocumentPatch = {
  title?: string;
  description?: string | null;
  contentText?: string | null;
};

/**
 * 管理修订提交的排查步骤（与后端 input ReferenceDocumentStructuredStepInput
 * 字段一一对应；stepNo 不提交——服务端按数组序生成，保持提交顺序语义）。
 */
export type ReferenceDocumentStructuredStepSubmit = {
  stepCode: string;
  phaseCode: string | null;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: 'RESOLVED' | 'UNRESOLVED' | 'NEW_FAULT';
};

/** 结构化管理修订内容（任务 07；全量值语义；厂家文本可修订，机型按 ID 单独提交） */
export type ReferenceDocumentStructuredRevisionPayload = {
  schemaVersion: number;
  maintenanceDate: string;
  maintenanceEngineerName: string;
  /** 客户厂家文本（本轮确认需求：一级管理员可修订） */
  customerFactoryName: string;
  resetResult: string;
  faults: ReferenceDocumentStructuredFault[];
  steps: ReferenceDocumentStructuredStepSubmit[];
  handlingResult: string | null;
  closureReason: string | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
};

/** 管理修订编辑初值（独立管理修订页专用，仅一级管理员） */
export type ReferenceDocumentEditableContent = {
  documentId: number;
  title: string;
  description: string | null;
  documentType: string;
  /** 编辑提交的乐观令牌初始值（current_revision_no） */
  expectedVersion: number;
  sourceKind: ReferenceDocumentSourceKind;
  mode: 'STRUCTURED' | 'FLAT';
  /** 结构化模式初值；扁平模式为 null */
  structured: ReferenceDocumentStructuredContent | null;
  /** 扁平模式初值（当前生效正文） */
  contentText: string | null;
  /** 资料自身机型关联初值（改选 Select 当前值；null 表示通用资料） */
  equipmentModelId: number | null;
  /** 机型名称（按关联 ID 实时取字典名，用于当前值展示） */
  equipmentModelName: string | null;
  /** 案例资料正文保护提示（FAULT_CASE 正文须走案例更正接口） */
  faultCaseProtected: boolean;
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
 * 管理操作结果（R058/R059/R060/R061-02，domain failure 显式结果）：
 * - version-conflict：expected_version 过期（资料已被并发管理操作推进）；
 * - invalid-input：原因缺失 / 补丁为空 / 目标账号或公司不存在等输入拒绝；
 * - not-found：资料不存在 / 已下架 / 跨范围（统一防探测口径）；
 * - management-failed：修订历史或推进写入失败（事务回滚）。
 */
export type ReferenceDocumentManagedMutationResult =
  | { ok: true; id: number; revisionNo: number }
  | {
      ok: false;
      reason: 'version-conflict' | 'not-found' | 'invalid-input' | 'management-failed';
      message: string;
    };

/**
 * REST 下载结果（domain failure 显式结果）。
 * - not-found：资料不存在 / 已软删（统一防探测口径）
 * - file-not-available：纯文本资料无文件，或存储对象缺失（受控错误）
 * - forbidden：授权拒绝（REST 守卫 403，如客户身份直调下载）
 * - download-failed：其余失败（transport / auth / 服务器错误）
 */
export type ReferenceDocumentFileDownloadResult =
  | { ok: true; blob: Blob; filename: string }
  | {
      ok: false;
      reason: 'not-found' | 'file-not-available' | 'forbidden' | 'download-failed';
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
  | {
      ok: false;
      reason: 'not-found' | 'version-conflict' | 'delete-failed';
      message: string;
    };
