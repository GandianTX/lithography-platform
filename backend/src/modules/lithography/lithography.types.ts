import {
  EngineerResolutionStatus,
  RepairRequestAcceptanceViewStatus,
} from '@app-types/models/repair-request.types';

/**
 * AI 会话共享枚举兼容出口。
 *
 * 正本（唯一行为真源）在共享类型层 `@app-types/models/ai-conversation.types`：
 * adapter / DTO / enum registry 直接引用它，避免 adapter 运行时依赖 modules 实现。
 * 此处仅做转发，使既有 Entity 的 `'../lithography.types'` import 路径保持不变
 * （PR3 不修改 AI Entity 文件范围），不复制任何字符串值。
 */
export { AiConversationStatus, AiMessageRole } from '@app-types/models/ai-conversation.types';

/**
 * 设备型号读侧稳定视图（客户端可见字段）
 */
export type EquipmentModelView = {
  id: number;
  modelCode: string;
  modelName: string;
};

/**
 * 设备型号详情快照（含启用状态，供写流程启用状态校验）
 */
export type EquipmentModelDetailSnapshot = EquipmentModelView & {
  enabled: boolean;
};

/**
 * 维修申请写入数据（由 usecase 完成全部业务判定后传入）
 */
export type RepairRequestInsertData = {
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
};

/**
 * 维修申请写入完成后的稳定快照（不暴露 ORM Entity）
 */
export type RepairRequestSnapshot = {
  id: number;
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  createdAt: Date;
  isAccepted: boolean;
};

/**
 * 维修申请原子接单写入数据。
 * engineerAccountId 仅来自后端 Session，acceptedAt 仅来自后端系统事件时间，
 * 两者均不得由客户端传入（由 UseCase 保证）。
 */
export type RepairRequestAcceptData = {
  requestId: number;
  engineerAccountId: number;
  acceptedAt: Date;
};

/**
 * 维修申请原子接单写入结果：仅表达 UseCase 裁决所需信息，不暴露 ORM Entity。
 * affected = 1 代表条件更新命中并写入成功；0 代表无可接单行，
 * 由 UseCase 结合最小状态读取区分“不存在/已删除”与“已接单”。
 */
export type RepairRequestAcceptWriteResult = {
  affected: number;
};

/**
 * 接单最小状态快照：仅供接单 UseCase 在条件更新未命中时裁决错误类别，
 * 不得流入 Adapter 或前端。
 */
export type RepairRequestAcceptanceStatusSnapshot = {
  id: number;
  isAccepted: boolean;
  deprecated: boolean;
};

/**
 * 回复目标最小状态快照：仅供回复 UseCase 在事务内做回复资格裁决，
 * 不得流入 Adapter 或前端。
 * 仅状态事实，不含权限决策；customerAccountId 与 acceptedByEngineerAccountId
 * 供 UseCase 派生归属与判断接单人身份，不直接对外输出。
 */
export type EngineerResponseTargetSnapshot = {
  id: number;
  customerAccountId: number;
  isAccepted: boolean;
  acceptedByEngineerAccountId: number | null;
  deprecated: boolean;
};

/**
 * 工程师回复追加写入数据（由 UseCase 完成资格裁决后传入）。
 * engineerAccountId 仅来自可信 Session，customerAccountId 仅来自目标申请快照，
 * 两者均不得由客户端传入；responseText 已完成业务判定。
 */
export type EngineerResponseInsertData = {
  requestId: number;
  engineerAccountId: number;
  customerAccountId: number;
  resolutionStatus: EngineerResolutionStatus;
  responseText: string;
};

/**
 * 工程师回复写入完成后的稳定快照（不暴露 ORM Entity）。
 * createdAt 为服务端系统事件时间。
 */
export type EngineerResponseWriteSnapshot = {
  id: number;
  requestId: number;
  engineerAccountId: number;
  resolutionStatus: EngineerResolutionStatus;
  responseText: string;
  createdAt: Date;
};

/**
 * 工程师列表范围枚举（四态，默认 ALL）：
 * - ALL：全部未删除申请；
 * - AVAILABLE：未接单（待接单池）；
 * - MINE：当前工程师已接单；
 * - TAKEN_BY_OTHER：其他工程师已接单。
 * GraphQL 层以字符串表达，由 Usecase 校验，adapter 不导入本常量。
 */
export const REPAIR_REQUEST_ENGINEER_LIST_SCOPES = [
  'ALL',
  'AVAILABLE',
  'MINE',
  'TAKEN_BY_OTHER',
] as const;

export type RepairRequestEngineerListScope = (typeof REPAIR_REQUEST_ENGINEER_LIST_SCOPES)[number];

/**
 * 详情读入口的角色范围：客户入口与工程师入口按角色分开（负责人 20260901 裁定），
 * 同一 DTO 由 QueryService 按 scope 限定有效身份判定数据范围。
 */
export type RepairRequestDetailReadScope = 'CUSTOMER' | 'ENGINEER';

/**
 * 维修申请列表项稳定读视图。
 * 客户列表、工程师待接单列表、工程师已接单列表复用同一结构（对接方案第一节）；
 * 不暴露归属类账号 ID（customerAccountId / acceptedByEngineerAccountId）。
 */
export type RepairRequestListItemView = {
  id: number;
  requestNo: string;
  equipmentModel: EquipmentModelView;
  errorCode: string;
  createdAt: Date;
  isAccepted: boolean;
  acceptedAt: Date | null;
  /** 最新回复处理状态；尚无回复时为 null */
  latestResolutionStatus: EngineerResolutionStatus | null;
};

/**
 * 工程师回复稳定读视图（对外契约）。
 * engineerNickname 为实时关联账号安全昵称（负责人裁定 3：不存快照，读时关联返回，
 * 缺失回落「工程师」由 usecase 保证）；不返回工程师账号 ID。
 */
export type EngineerResponseView = {
  id: number;
  engineerNickname: string;
  resolutionStatus: EngineerResolutionStatus;
  responseText: string;
  createdAt: Date;
};

/**
 * 工程师回复 QueryService 内部装配结果：含归属工程师账号 ID，
 * 仅供 usecase 跨域富集昵称使用，不对外输出。
 */
export type EngineerResponseQueryResult = Omit<EngineerResponseView, 'engineerNickname'> & {
  engineerAccountId: number;
};

/**
 * 列表分页参数（仅 OFFSET；第一版排序由契约固定，不提供客户端自定义排序）
 */
export type RepairRequestListPagination = {
  page: number;
  pageSize: number;
  withTotal: boolean;
};

/**
 * 列表分页结果
 */
export type RepairRequestListPage = {
  items: RepairRequestListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 工程师列表可选筛选（对外契约）：
 * - equipmentModelId：设备型号等值筛选；
 * - customerNickname：客户昵称关键词（Usecase 完成 trim 归一，空白视为未提供；
 *   LIKE 通配符转义在账号域 QueryService 内完成）。
 */
export type RepairRequestEngineerListFilter = {
  equipmentModelId?: number;
  customerNickname?: string;
};

/**
 * 工程师列表筛选（QueryService 内部口径）：客户昵称已由 usecase 经账号域
 * 批量解析为客户账号 ID 集合，分页与 total 计算前即完成筛选（禁止先分页后过滤）。
 */
export type RepairRequestEngineerListFilterInternal = {
  equipmentModelId?: number;
  customerAccountIds?: number[];
};

/**
 * 工程师列表项 QueryService 内部装配结果：含归属类账号 ID，
 * 仅供 usecase 跨域富集客户/接单工程师展示资料使用，不对外输出。
 */
export type RepairRequestEngineerListItemQueryResult = RepairRequestListItemView & {
  customerAccountId: number;
  acceptedByEngineerAccountId: number | null;
};

/**
 * 工程师列表项稳定读视图：在基础列表项上补充客户/接单工程师安全展示资料
 * 与当前会话视角状态；昵称实时关联（缺失回落「客户」/「工程师」），不返回账号 ID。
 */
export type RepairRequestEngineerListItemView = RepairRequestListItemView & {
  customerNickname: string;
  customerCompanyName: string | null;
  acceptanceViewStatus: RepairRequestAcceptanceViewStatus;
  /** 接单工程师当前昵称；未接单为 null */
  acceptedEngineerNickname: string | null;
};

/**
 * 工程师列表分页结果（昵称富集后）
 */
export type RepairRequestEngineerListPage = {
  items: RepairRequestEngineerListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 工程师列表分页 QueryService 装配结果（昵称富集前）
 */
export type RepairRequestEngineerListQueryPage = {
  items: RepairRequestEngineerListItemQueryResult[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 维修申请详情稳定读视图（客户与工程师入口共用结构，读权限由 QueryService 按身份判定）。
 * responses 按 createdAt ASC + id ASC 排序；不暴露归属类账号 ID。
 */
export type RepairRequestDetailView = {
  id: number;
  requestNo: string;
  equipmentModel: EquipmentModelView;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  createdAt: Date;
  isAccepted: boolean;
  acceptedAt: Date | null;
  /** 最新回复处理状态（按 createdAt DESC + id DESC 取末条）；尚无回复时为 null */
  latestResolutionStatus: EngineerResolutionStatus | null;
  responses: EngineerResponseView[];
};

/**
 * 详情 QueryService 装配结果（昵称富集前）：回复含工程师账号 ID，
 * 另含归属类账号 ID，均由 usecase 跨域富集为安全展示字段后才对外输出，
 * 不得直接流入 Adapter。
 */
export type RepairRequestDetailQueryResult = Omit<RepairRequestDetailView, 'responses'> & {
  responses: EngineerResponseQueryResult[];
  customerAccountId: number;
  acceptedByEngineerAccountId: number | null;
};

/**
 * 工程师详情稳定读视图：在共用详情上补充客户/接单工程师安全展示资料
 * 与当前会话视角状态（TAKEN_BY_OTHER 只读，MINE 可回复，AVAILABLE 可接单）。
 */
export type RepairRequestEngineerDetailView = RepairRequestDetailView & {
  customerNickname: string;
  customerCompanyName: string | null;
  acceptanceViewStatus: RepairRequestAcceptanceViewStatus;
  /** 接单工程师当前昵称；未接单为 null */
  acceptedEngineerNickname: string | null;
};

/**
 * 维修申请软删除条件更新结果（模块内细粒度写操作产物，仅报告状态事实）。
 * 错误映射与幂等成功决策归 usecase（负责人 20260901 裁定 5）：
 * - DELETED：条件更新命中，软删除完成
 * - ALREADY_DELETED：本人已删除（幂等成功语义由 usecase 决定）
 * - NOT_FOUND_OR_NOT_OWNER：行不存在或非本人归属（统一口径，不泄露存在性）
 * - ALREADY_ACCEPTED：本人已接单（接单/删除互斥）
 */
export type RepairRequestDeleteOutcome =
  | { kind: 'DELETED'; id: number; requestNo: string }
  | { kind: 'ALREADY_DELETED'; id: number; requestNo: string }
  | { kind: 'NOT_FOUND_OR_NOT_OWNER'; id: number }
  | { kind: 'ALREADY_ACCEPTED'; id: number; requestNo: string };

// ---------- AI 参考资料库（0907.docx 任务二） ----------

/** 资料列表分页参数（仅 OFFSET；排序由契约固定：创建时间倒序 + 主键倒序） */
export type ReferenceDocumentListPagination = {
  page: number;
  pageSize: number;
  withTotal: boolean;
};

/** 资料列表筛选条件（标题模糊 + 文档类型等值 + 设备型号等值 + 案例处理状态等值，均可选） */
export type ReferenceDocumentListFilter = {
  title?: string;
  documentType?: string;
  equipmentModelId?: number;
  /** 案例处理状态等值筛选（UNRESOLVED/IN_PROGRESS/RESOLVED）；仅命中 FAULT_CASE 资料的案例明细 */
  caseHandlingStatus?: string;
};

/**
 * 正式资料案例明细稳定读视图（仅 FAULT_CASE 资料存在，普通资料为 null）。
 * 不返回 casePayloadJson / schemaVersion 等内部扩展字段。
 */
export type ReferenceDocumentCaseDetailView = {
  errorCode: string | null;
  handlingStatus: string;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
};

/**
 * 资料列表项稳定读视图。
 * 默认仅返回未软删资料；创建人展示经 creatorNickname（实时关联，缺失回落），
 * 不返回 createdByAccountId；不返回 storageBackend/storageReference 与服务器路径；
 * 不携带 contentText 大字段（仅详情返回）。
 *
 * A-PR0 §4.3 新增字段：organizationName（组织展示名）、ingestMethod（来源信息，
 * ADMIN_DIRECT/REVIEWED_SUBMISSION）、equipmentModelText（机型文字）、
 * caseHandlingStatus（案例处理状态，普通资料为 null；列表不返回案例大段正文）。
 */
export type ReferenceDocumentListItemView = {
  id: number;
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  description: string | null;
  originalFilename: string | null;
  organizationName: string;
  ingestMethod: string;
  caseHandlingStatus: string | null;
  creatorNickname: string;
  createdAt: Date;
};

/** 列表项 QueryService 内部装配结果：创建人昵称富集前含账号 ID，仅供 usecase 跨域富集，不对外输出 */
export type ReferenceDocumentListItemQueryResult = Omit<
  ReferenceDocumentListItemView,
  'creatorNickname'
> & { createdByAccountId: number };

/**
 * 资料详情稳定读视图（元数据 + 文本内容）。
 * 不返回账号 ID、存储后端/存储引用与服务器路径（0907.docx：不能把服务器本地路径返回给浏览器）；
 * 「是否有文件」以衍生布尔 hasFile 对外（权威判定 = storageReference 非空，与下载/编辑防御真源一致）。
 *
 * A-PR0 §4.3 新增字段：organizationName（组织展示名）、ingestMethod（来源信息）、
 * equipmentModelText（机型文字）、caseDetail（案例明细，普通资料为 null，兼容旧组件）。
 */
export type ReferenceDocumentDetailView = {
  id: number;
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  description: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  hasFile: boolean;
  contentText: string | null;
  organizationName: string;
  ingestMethod: string;
  caseDetail: ReferenceDocumentCaseDetailView | null;
  creatorNickname: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 资料详情 QueryService 装配结果：含 storageReference 内部字段。
 * storageReference 仅供下载用例定位存储对象，不进入对外 DTO（DetailView 保持剥离）。
 */
export type ReferenceDocumentDetailQueryResult = Omit<
  ReferenceDocumentDetailView,
  'creatorNickname'
> & { createdByAccountId: number; storageReference: string | null };

/** 资料列表分页结果 */
export type ReferenceDocumentListPage = {
  items: ReferenceDocumentListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 资料创建写入数据（由 usecase 完成全部业务判定后传入）。
 * createdByAccountId 仅来自可信 Session，不得由客户端传入；
 * ownerOrganizationId 由可信组织上下文解析（A-PR0 §2.1），不得由客户端传入；
 * ingestMethod 固定 ADMIN_DIRECT（管理员直建；审核发布路径由 S5 写 REVIEWED_SUBMISSION）；
 * 内容来源为正文或文件至少一个（chk_reference_document_content_source 兜底）：
 * 纯文本创建时存储四字段为 null；文件创建时存储引用由服务端生成（不可猜测、无路径语义）。
 */
export type ReferenceDocumentInsertData = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelText?: string | null;
  description: string | null;
  contentText: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  storageBackend: string | null;
  storageReference: string | null;
  createdByAccountId: number;
  ownerOrganizationId: number;
  ingestMethod: string;
  // 审核发布（REVIEWED_SUBMISSION）来源回链；管理员直建不传
  // （同空或同有与「正式资料与来源投稿同组织」由 CHECK/外键与用例事务内核验保证）
  sourceSubmissionId?: number | null;
  sourceRevisionId?: number | null;
  extensionJson?: Record<string, unknown> | null;
  schemaVersion?: number;
};

/**
 * 正式故障案例明细写入数据（审核发布插入时由发布用例从冻结快照组装）。
 * 满足实体 chk_reference_document_case_detail_status / resolution：
 * handling_status 受控值域；RESOLVED 时 resolution 必填非空。
 */
export type ReferenceDocumentCaseDetailInsertData = {
  documentId: number;
  errorCode: string | null;
  handlingStatus: string;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
  casePayloadJson?: Record<string, unknown> | null;
};

/**
 * 正式故障案例明细更正写入数据（A-PR0 §S6 专属更正，全量覆盖式更新）。
 * 由 usecase 在合并后的最终态上完成校验（必填存在性、RESOLVED 必填结果）后传入；
 * casePayloadJson / schemaVersion / 创建时间不在更正文范围内（维持原值）。
 */
export type ReferenceDocumentCaseDetailUpdateData = {
  documentId: number;
  errorCode: string | null;
  handlingStatus: string;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
};

/**
 * 资料编辑写入数据（由 usecase 完成字段合并与校验后传入，全量覆盖式更新）。
 * 满足实体 chk_reference_document_content_source：正文与已有存储引用至少存在一个；
 * 编辑不支持替换/移除文件，存储四列维持原值。
 */
export type ReferenceDocumentUpdateData = {
  documentId: number;
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  description: string | null;
  contentText: string | null;
  /**
   * 机型文字（S6 案例更正扩展）：未传（undefined）时不更新该列（通用编辑不参与）；
   * 显式 null 表示清空（与 chk_reference_document_model_exclusive 互补）
   */
  equipmentModelText?: string | null;
  /** 最后修改人（S6 案例更正扩展，正式更正必写）：未传时不更新该列（历史来源行保持可空） */
  updatedByAccountId?: number;
};

/**
 * 资料软删除条件更新结果（仅状态事实，不表决策；错误映射归 usecase）。
 * - DELETED：条件更新命中，软删除完成
 * - NOT_FOUND：行不存在或已软删（负责人 docx 口径统一 NOT_FOUND，不泄露删除状态）
 */
export type ReferenceDocumentDeleteOutcome =
  { kind: 'DELETED'; id: number } | { kind: 'NOT_FOUND'; id: number };
