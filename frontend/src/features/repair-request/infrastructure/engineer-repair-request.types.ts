import type {
  EngineerResolutionStatus,
  EngineerResponse,
  RepairRequestDetail,
  RepairRequestEquipmentModel,
  RepairRequestListItem,
  RepairRequestListPage,
} from './repair-request-read.types';

/**
 * 工程师维修申请读写的 GraphQL 契约类型（与后端公共读模型 DTO 对齐）
 * 以及 feature 内部消费的干净模型。
 *
 * - 原始 DTO 只停留在 feature infrastructure（docs/infrastructure-rules.md 防腐职责）；
 * - application / ui 只消费下方「内部干净模型」段落的类型；
 * - 唯一真源：
 *   - backend/src/adapters/api/graphql/repair-request/dto/repair-request-read.dto.ts；
 *   - backend/src/types/models/repair-request.types.ts（EngineerResolutionStatus）。
 */

/** 工程师回复处理状态（后端正式 GraphQL enum，值域一致） */
export type EngineerResolutionStatusValue = EngineerResolutionStatus;

/**
 * 工程师列表范围，与后端 REPAIR_REQUEST_ENGINEER_LIST_SCOPES 取值严格一致
 * （ALL / AVAILABLE / MINE / TAKEN_BY_OTHER，缺省 ALL），不创建第三套状态值
 */
export type EngineerRepairListScope = 'ALL' | 'AVAILABLE' | 'MINE' | 'TAKEN_BY_OTHER';

/**
 * 接单状态视角，与后端 RepairRequestAcceptanceViewStatus 枚举取值严格一致。
 * AVAILABLE 仅表示「未接单」事实，不代表当前会话可接单；
 * 可接单/可回复能力由页面按会话单值业务角色（精确 ENGINEER）另行判定。
 */
export type EngineerRepairAcceptanceViewStatus = 'AVAILABLE' | 'MINE' | 'TAKEN_BY_OTHER';

/** 后端正式枚举：五类处理结果 */
export type RepairRequestHandlingResult =
  | 'FIXED'
  | 'PART_PURCHASED'
  | 'PROVIDE_PLAN_SELF_EXECUTE'
  | 'INTERRUPTED'
  | 'UNREPAIRABLE';

/** 后端正式枚举：三态实际处理状态 */
export type RepairRequestHandlingStatus = 'IN_PROGRESS' | 'COMPLETED' | 'UNRESOLVED';

/** 已保存绑定的原件安全展示字段 */
export type RepairProcessEntryFileDTO = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

/** 内部维修过程 DTO（仅接单工程师本人可见） */
export type RepairProcessEntryDTO = {
  id: string;
  entryUuid: string;
  requestId: number;
  operationText: string;
  testResult?: string | null;
  occurredAt?: string | null;
  timeSource: string;
  fileId?: string | null;
  file?: RepairProcessEntryFileDTO | null;
  versionNo: number;
  createdAt: string;
};

/** 列表筛选（feature 内部干净模型，null 表示不筛选；由后端在分页计数前完成过滤） */
export type EngineerRepairListFilter = {
  equipmentModelId: number | null;
  customerNickname: string | null;
};

/* ------------------------------------------------------------------ */
/* 原始 GraphQL DTO（infrastructure 专用，不对外导出消费）             */
/* ------------------------------------------------------------------ */

export type EquipmentModelDTO = {
  id: number;
  modelCode: string;
  modelName: string;
};

/**
 * 工程师维修申请列表项 DTO（与后端 RepairRequestEngineerListItemDTO 对齐）：
 * 在公共列表项上补充客户 / 接单工程师安全展示资料与当前会话视角状态；
 * 后端不返回归属类账号 ID，前端契约同样不引入
 */
export type RepairRequestListItemDTO = {
  id: number;
  requestNo: string;
  equipmentModel: EquipmentModelDTO;
  errorCode: string;
  /** ISO 字符串（后端 Date 标量） */
  createdAt: string;
  isAccepted: boolean;
  acceptedAt?: string | null;
  latestResolutionStatus?: EngineerResolutionStatusValue | null;
  customerNickname: string;
  customerCompanyName?: string | null;
  acceptanceViewStatus: EngineerRepairAcceptanceViewStatus;
  acceptedEngineerNickname?: string | null;
  closureStatus?: string | null;
  /** ISO 字符串（后端 Date 标量） */
  closedAt?: string | null;
  handlingResult?: RepairRequestHandlingResult | null;
  handlingStatus?: RepairRequestHandlingStatus | null;
};

export type EngineerResponseDTO = {
  id: number;
  engineerNickname: string;
  resolutionStatus: EngineerResolutionStatusValue;
  responseText: string;
  /** ISO 字符串（后端 Date 标量） */
  createdAt: string;
};

/** 已保存绑定的维修原件（与通用原件安全展示字段一致） */
export type RepairMaintenanceAttachmentDTO = RepairProcessEntryFileDTO;

/** 结构化维修记录 DTO（repair-maintenance.dto.ts） */
export type RepairMaintenanceRecordDTO = {
  maintenanceDate?: string | null;
  engineerName?: string | null;
  resetResult?: string | null;
  supplementaryNote?: string | null;
  versionNo: number;
  attachment?: RepairMaintenanceAttachmentDTO | null;
};

export type RepairMaintenanceStepDTO = {
  id: string;
  stepNo: number;
  errorCode?: string | null;
  partName?: string | null;
  actionText: string;
  resultCode: string;
};

export type RepairMaintenanceFaultPanelDTO = {
  id: string;
  panelType: string;
  stepId?: string | null;
  phaseCode?: string | null;
  mainError?: string | null;
  unitError?: string | null;
  source?: string | null;
  errorType?: string | null;
  gpibStatus?: string | null;
  faultStatus?: string | null;
  description: string;
  action?: string | null;
};

export type RepairIntakeAnalysisDTO = {
  status: string;
  generation: number;
  outputText?: string | null;
  failureReason?: string | null;
  /** ISO 字符串（后端 Date 标量） */
  finishedAt?: string | null;
};

export type RepairIntakeSourceDTO = {
  intakeId: string;
  faultDescription?: string | null;
  customerFile?: RepairProcessEntryFileDTO | null;
  analysis?: RepairIntakeAnalysisDTO | null;
};

export type RepairRequestDetailDTO = {
  id: number;
  requestNo: string;
  equipmentModel: EquipmentModelDTO;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  /** ISO 字符串（后端 Date 标量） */
  createdAt: string;
  isAccepted: boolean;
  acceptedAt?: string | null;
  latestResolutionStatus?: EngineerResolutionStatusValue | null;
  responses: EngineerResponseDTO[];
  /** 以下为工程师入口富集字段（后端约定客户入口为空；本切片只消费工程师入口） */
  customerNickname?: string | null;
  customerCompanyName?: string | null;
  acceptanceViewStatus?: EngineerRepairAcceptanceViewStatus | null;
  acceptedEngineerNickname?: string | null;
  closureStatus?: string | null;
  closedAt?: string | null;
  closureReason?: string | null;
  handlingResult?: RepairRequestHandlingResult | null;
  handlingStatus?: RepairRequestHandlingStatus | null;
  processEntries?: RepairProcessEntryDTO[];
  /** 任务 04：结构化内部维修记录（仅接单工程师本人可见） */
  maintenance?: RepairMaintenanceRecordDTO | null;
  maintenanceSteps?: RepairMaintenanceStepDTO[] | null;
  maintenanceFaultPanels?: RepairMaintenanceFaultPanelDTO[] | null;
  /** 客户原始报修与首次 AI 分析（工程师详情入口富集；客户入口为空） */
  intake?: RepairIntakeSourceDTO | null;
  /** 当前会话是否可编辑结构化维修记录（后端权威判定） */
  canEditMaintenance?: boolean | null;
};

export type RepairRequestPaginatedDTO = {
  items: RepairRequestListItemDTO[];
  total: number;
  page: number;
  pageSize: number;
};

/** PaginationArgs 入参（工程师列表仅允许 mode = 'OFFSET'，后端 usecase 强制） */
export type RepairRequestPaginationVariables = {
  mode: 'OFFSET';
  page: number;
  pageSize: number;
  withTotal: boolean;
};

/* ------------------------------------------------------------------ */
/* 内部干净模型（mapper 归一后可空字段收拢为 null，供 application / ui 消费） */
/* ------------------------------------------------------------------ */

/**
 * 设备型号内部模型：由 DTO 显式映射而来，
 * application / ui 不直接引用任何原始 DTO 类型。
 */
export type EngineerRepairRequestEquipmentModel = RepairRequestEquipmentModel;

/**
 * 工程师列表项内部模型：公共列表项 + 后端富集的安全展示字段（DTO 显式映射而来）。
 * 客户昵称/视角状态由后端保证非空；可空展示字段收拢为 null。
 */
export type EngineerRepairRequestListItem = RepairRequestListItem & {
  customerNickname: string;
  customerCompanyName: string | null;
  acceptanceViewStatus: EngineerRepairAcceptanceViewStatus;
  acceptedEngineerNickname: string | null;
  /**
   * 工单真实进度：结单事实与处理结果，供列表与详情同口径展示。
   * undefined 表示响应缺少字段（不可确认），null 表示字段存在且明确为空。
   */
  closureStatus: string | null | undefined;
  closedAt: string | null | undefined;
  handlingResult: RepairRequestHandlingResult | null;
  handlingStatus: RepairRequestHandlingStatus | null;
};

/** 工程师详情内部模型：公共详情 + 工程师入口富集字段（可空字段收拢为 null） */
export type EngineerRepairRequestDetail = RepairRequestDetail & {
  customerNickname: string | null;
  customerCompanyName: string | null;
  acceptanceViewStatus: EngineerRepairAcceptanceViewStatus | null;
  acceptedEngineerNickname: string | null;
  /** undefined = 响应缺少字段；null = 字段存在且明确为空 */
  closureStatus: string | null | undefined;
  closedAt: string | null | undefined;
  closureReason: string | null;
  handlingResult: RepairRequestHandlingResult | null;
  handlingStatus: RepairRequestHandlingStatus | null;
  processEntries: EngineerRepairProcessEntry[];
  /** 任务 04：可缺省以兼容既有响应/测试夹具，UI 按空值兜底 */
  maintenance?: EngineerRepairMaintenanceRecord | null;
  maintenanceSteps?: EngineerRepairMaintenanceStep[];
  maintenanceFaultPanels?: EngineerRepairMaintenanceFaultPanel[];
  intake?: EngineerRepairIntake | null;
  canEditMaintenance?: boolean;
};

/** 结构化维修记录内部模型（可空字段收拢为 null） */
export type EngineerRepairMaintenanceRecord = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  versionNo: number;
  attachment: RepairProcessEntryFileDTO | null;
};

export type EngineerRepairMaintenanceStep = {
  id: string;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

export type EngineerRepairMaintenanceFaultPanel = {
  id: string;
  panelType: string;
  stepId: string | null;
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

export type EngineerRepairIntakeAnalysis = {
  status: string;
  generation: number;
  outputText: string | null;
  failureReason: string | null;
  finishedAt: string | null;
};

export type EngineerRepairIntake = {
  intakeId: string;
  faultDescription: string | null;
  customerFile: RepairProcessEntryFileDTO | null;
  analysis: EngineerRepairIntakeAnalysis | null;
};

/** 内部维修过程内部模型（DTO 显式映射；可空字段收拢为 null） */
export type EngineerRepairProcessEntry = {
  id: string;
  entryUuid: string;
  requestId: number;
  operationText: string;
  testResult: string | null;
  occurredAt: string | null;
  timeSource: string;
  fileId: string | null;
  file: RepairProcessEntryFileDTO | null;
  versionNo: number;
  createdAt: string;
};

export type EngineerRepairRequestPage = Omit<RepairRequestListPage, 'items'> & {
  items: EngineerRepairRequestListItem[];
};

export type EngineerRepairRequestResponseItem = EngineerResponse;

/** 列表查询参数（scope/filter 与 GraphQL 参数一一对应，分页为 OFFSET 页码口径） */
export type EngineerRepairListQuery = {
  scope: EngineerRepairListScope;
  filter: EngineerRepairListFilter;
  page: number;
  pageSize: number;
};

/**
 * 详情读取的显式失败原因（业务拒绝，非 transport）：
 * - not-accessible：不存在、已删除或无权读取的统一不可访问反馈
 *   （后端对越权统一拒绝且不泄露存在性，前端不再区分）；
 * - load-failed：其他业务大类失败。
 * transport / auth 错误仍按共享错误模型上抛 GraphQLIngressError。
 */
export type EngineerRepairRequestDetailFailureReason = 'not-accessible' | 'load-failed';

export type EngineerRepairRequestDetailResult =
  | { ok: true; detail: EngineerRepairRequestDetail }
  | { ok: false; reason: EngineerRepairRequestDetailFailureReason; message: string };

/**
 * 接单业务拒绝原因（domain failure 显式结果）：
 * 主映射只依赖契约保证稳定的 GraphQL 大类码 extensions.code；
 * REPAIR_REQUEST_ALREADY_ACCEPTED 细节码仅用于可选细化提示，生产隐藏时自动回退。
 */
export type AcceptRepairRequestFailureReason =
  | 'already-accepted'
  | 'not-accessible'
  | 'insufficient-permission'
  | 'accept-failed';

export type AcceptRepairRequestResult =
  | { ok: true; detail: EngineerRepairRequestDetail }
  | { ok: false; reason: AcceptRepairRequestFailureReason; message: string };

/**
 * 工程师追加处理回复命令输入（feature 内部干净输入）。
 * 归属账号由后端 Session 派生，客户端不可也不需要传入任何归属字段（Plan §7.1）。
 * responseText 的空白语义与 resolutionStatus 值域语义由后端收敛；
 * 前端不自行虚构长度上限与默认状态（与后端输入口径一致）。
 */
export type CreateEngineerResponseInput = {
  requestId: number;
  responseText: string;
  resolutionStatus: EngineerResolutionStatusValue;
};

/**
 * 回复业务拒绝原因（domain failure 显式结果）：
 * 主映射只依赖契约保证稳定的 GraphQL 大类码 extensions.code；
 * 生产分支不依赖 extensions.errorCode（Plan §7.5）。
 * - not-accessible：不存在/已删除/已由其他工程师接单的统一不可访问结果，不泄露归属；
 * - not-accepted：申请存在但尚未接单（提示先接单后回复）；
 * - insufficient-permission：已认证但非精确工程师写身份；
 * - invalid-input：requestId/正文/状态非法（后端结构或语义校验拒绝）；
 * - response-failed：后端落库失败或 transport/系统故障 —— 结果不确定（可能已写入），
 *   由编排层只重查确认，绝不自动重发 Mutation（Plan §7.1）。
 */
export type CreateEngineerResponseFailureReason =
  | 'not-accessible'
  | 'not-accepted'
  | 'insufficient-permission'
  | 'invalid-input'
  | 'response-failed';

export type CreateEngineerResponseResult =
  | { ok: true; response: EngineerRepairRequestResponseItem }
  | { ok: false; reason: CreateEngineerResponseFailureReason; message: string };

/* ------------------------------------------------------------------ */
/* 内部维修过程 / 结单 / 原件（任务 04 第一轮）                        */
/* ------------------------------------------------------------------ */

/** 创建过程输入；file 为已上传暂存原件（保存时同一事务绑定） */
export type CreateRepairProcessEntryInput = {
  requestId: number;
  operationText: string;
  testResult: string | null;
  occurredAt: string | null;
  file: { fileId: string; uploadContextId: string } | null;
};

/**
 * 编辑过程输入。
 * 仅当前过程无原件时可补传一份暂存原件；省略或传 null 表示保持原绑定不变，
 * 已有原件时不允许通过编辑替换或移除。
 */
export type UpdateRepairProcessEntryInput = {
  requestId: number;
  entryId: string;
  expectedVersion: number;
  operationText: string;
  testResult: string | null;
  occurredAt: string | null;
  file?: { fileId: string; uploadContextId: string } | null;
};

export type CloseRepairRequestInput = {
  requestId: number;
  handlingResult: RepairRequestHandlingResult;
  closureReason: string | null;
};

export type RepairRequestClosure = {
  requestId: number;
  closureStatus: string;
  closedAt: string;
  closureReason: string | null;
  handlingResult: RepairRequestHandlingResult;
  handlingStatus: RepairRequestHandlingStatus;
  handlingEndedAt: string | null;
};

/** 过程写入业务拒绝原因（主映射只依赖 GraphQL 大类码） */
export type RepairProcessWriteFailureReason =
  | 'not-accessible'
  | 'conflict'
  | 'insufficient-permission'
  | 'invalid-input'
  | 'write-failed';

export type RepairProcessWriteResult =
  | { ok: true; entry: EngineerRepairProcessEntry }
  | { ok: false; reason: RepairProcessWriteFailureReason; message: string };

export type InterruptRepairRequestInput = {
  requestId: number;
  reason: string;
};

export type RepairRequestInterruption = {
  requestId: number;
  closureStatus: string | null;
  closedAt: string | null;
  closureReason: string | null;
  handlingResult: RepairRequestHandlingResult;
  handlingStatus: RepairRequestHandlingStatus;
  handlingEndedAt: string | null;
};

export type InterruptRepairRequestResult =
  | { ok: true; interruption: RepairRequestInterruption }
  | { ok: false; reason: CloseRepairRequestFailureReason; message: string };

export type CloseRepairRequestFailureReason =
  | 'not-accessible'
  | 'closed'
  | 'insufficient-permission'
  | 'invalid-input'
  | 'close-failed';

export type CloseRepairRequestResult =
  | { ok: true; closure: RepairRequestClosure }
  | { ok: false; reason: CloseRepairRequestFailureReason; message: string };

/** 已上传暂存原件（尚未绑定业务） */
export type StagedRepairProcessFile = {
  fileId: string;
  uploadContextId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

export type UploadRepairProcessFileFailureReason =
  | 'invalid-input'
  | 'file-too-large'
  | 'file-type-not-allowed'
  | 'insufficient-permission'
  | 'upload-failed';

export type UploadRepairProcessFileResult =
  | { ok: true; file: StagedRepairProcessFile }
  | { ok: false; reason: UploadRepairProcessFileFailureReason; message: string };

export type DownloadRepairProcessFileResult =
  | { ok: true; blob: Blob; filename: string }
  | {
      ok: false;
      reason: 'not-found' | 'file-not-available' | 'insufficient-permission' | 'download-failed';
      message: string;
    };

/* ------------------------------------------------------------------ */
/* 结构化内部维修记录（任务 04）                                       */
/* ------------------------------------------------------------------ */

export type RepairMaintenanceStepInput = {
  id: string | null;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

export type RepairMaintenanceFaultPanelInput = {
  id: string | null;
  panelType: string;
  stepNo: number | null;
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

/**
 * 保存维修记录输入。
 * expectedVersion 取当前详情 maintenance.versionNo ?? 0（乐观并发）；
 * attachment 为已上传暂存原件，仅在尚未绑定原件时提交。
 */
export type SaveRepairRequestMaintenanceInput = {
  requestId: number;
  expectedVersion: number;
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  attachment: { fileId: string; uploadContextId: string } | null;
  steps: RepairMaintenanceStepInput[];
  panels: RepairMaintenanceFaultPanelInput[];
};

export type RepairMaintenanceWriteResult =
  | { ok: true; record: EngineerRepairMaintenanceRecord }
  | { ok: false; reason: RepairProcessWriteFailureReason; message: string };

/* ------------------------------------------------------------------ */
/* 工程师侧修订历史（只读）                                            */
/* ------------------------------------------------------------------ */

/** 修订对比不可用原因码（后端稳定码，前端本地化） */
export type EngineerRepairRevisionCompareUnavailableReason =
  | 'NO_COMPARABLE_SNAPSHOT'
  | 'NO_VISIBLE_MAINTENANCE_CHANGE';

/** 工程师可见的修订维修快照（不含附件、处理结果与结单信息） */
export type EngineerRepairRevisionSnapshotDTO = {
  maintenanceDate?: string | null;
  engineerName?: string | null;
  resetResult?: string | null;
  supplementaryNote?: string | null;
  steps?: RepairMaintenanceStepDTO[];
  panels?: RepairMaintenanceFaultPanelDTO[];
};

export type EngineerRepairRevisionHistoryItemDTO = {
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorNickname: string;
  /** ISO 字符串（后端 Date 标量） */
  createdAt: string;
  hasComparableSnapshot: boolean;
  hasVisibleMaintenanceChange: boolean;
  compareUnavailableReason?: EngineerRepairRevisionCompareUnavailableReason | null;
};

export type EngineerRepairRevisionDetailDTO = {
  requestId: number;
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorNickname: string;
  /** ISO 字符串（后端 Date 标量） */
  createdAt: string;
  hasComparableSnapshot: boolean;
  hasVisibleMaintenanceChange: boolean;
  compareUnavailableReason?: EngineerRepairRevisionCompareUnavailableReason | null;
  before?: EngineerRepairRevisionSnapshotDTO | null;
  after?: EngineerRepairRevisionSnapshotDTO | null;
};

/** 工程师侧快照内部模型（可空字段收拢为 null） */
export type EngineerRepairRevisionSnapshot = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  steps: EngineerRepairMaintenanceStep[];
  panels: EngineerRepairMaintenanceFaultPanel[];
};

export type EngineerRepairRevisionHistoryItem = {
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorNickname: string;
  createdAt: string;
  hasComparableSnapshot: boolean;
  hasVisibleMaintenanceChange: boolean;
  compareUnavailableReason: EngineerRepairRevisionCompareUnavailableReason | null;
};

export type EngineerRepairRevisionDetail = {
  requestId: number;
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorNickname: string;
  createdAt: string;
  hasComparableSnapshot: boolean;
  hasVisibleMaintenanceChange: boolean;
  compareUnavailableReason: EngineerRepairRevisionCompareUnavailableReason | null;
  before: EngineerRepairRevisionSnapshot | null;
  after: EngineerRepairRevisionSnapshot | null;
};

export type EngineerRepairRevisionHistoryResult =
  | { ok: true; items: EngineerRepairRevisionHistoryItem[] }
  | { ok: false; message: string };

export type EngineerRepairRevisionDetailResult =
  | { ok: true; detail: EngineerRepairRevisionDetail }
  | { ok: false; message: string };
