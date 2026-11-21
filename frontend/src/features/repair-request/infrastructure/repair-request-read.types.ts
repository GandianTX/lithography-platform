// src/features/repair-request/infrastructure/repair-request-read.types.ts

/**
 * 维修申请公共读模型的前端契约类型（与后端 PR #A 落地的读 DTO 逐字段对齐）。
 *
 * 契约依据：负责人 20260901 六条裁定 + backend 读侧 DTO
 * （backend/src/adapters/api/graphql/repair-request/dto/repair-request-read.dto.ts）。
 * 双方（薛的客户切片 / 感電的工程师切片）共用本文件，字段名不得单方面改名；
 * 与后端契约冲突时先沟通再动。
 */

/** 处理状态枚举（后端共享层正式 GraphQL 枚举，裁定 4；数据库值仍为 PENDING / RESOLVED） */
export type EngineerResolutionStatus = 'PENDING' | 'RESOLVED';

/** 处理状态显示映射（公共展示口径，不强行共用整张表格） */
export const RESOLUTION_STATUS_LABELS: Record<EngineerResolutionStatus, string> = {
  PENDING: '处理中',
  RESOLVED: '已解决',
};

export type RepairRequestEquipmentModel = {
  id: number;
  modelCode: string;
  modelName: string;
};

/** 首析状态（与工单处理进度分开展示的独立事实组） */
export type IntakeAnalysisStatus = 'WAITING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/**
 * 首析展示状态（服务端判定）。
 * 前端不再自行组合「FAILED + generation」，只按该字段渲染标签。
 * - NOT_STARTED：从未发起过分析（如开发 Seed 样例，中性展示，不视为系统故障）。
 */
export type IntakeAnalysisDisplayState =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_NOT_RETRYABLE'
  | 'NOT_STARTED'
  | 'UNAVAILABLE';

/**
 * 自助重试资格的稳定原因码（服务端判定，不含内部异常或任务标识）：
 * - OWNER_RETRY_AVAILABLE：第 0 代明确模型失败，仍保留唯一一次普通重试；
 * - ANALYSIS_IN_PROGRESS / ANALYSIS_SUCCEEDED / ANALYSIS_NOT_INITIATED：
 *   后台仍在处理、已成功或从未发起（Seed 样例，中性文案）；
 * - RETRY_ALREADY_USED：唯一一次重试已用掉；
 * - FAILURE_NOT_CONFIRMED / LEDGER_INTENT_MISSING / OWNERSHIP_CONFLICT /
 *   NOT_CONVERTED / NO_INTAKE / INTAKE_DELETED / STATUS_UNKNOWN：记录不可信或异常，
 *   暂不可用（前端只据此提示，不做二次判定）。
 */
export type IntakeAnalysisRetryReason =
  | 'OWNER_RETRY_AVAILABLE'
  | 'ANALYSIS_IN_PROGRESS'
  | 'ANALYSIS_SUCCEEDED'
  | 'ANALYSIS_NOT_INITIATED'
  | 'RETRY_ALREADY_USED'
  | 'FAILURE_NOT_CONFIRMED'
  | 'LEDGER_INTENT_MISSING'
  | 'OWNERSHIP_CONFLICT'
  | 'NOT_CONVERTED'
  | 'NO_INTAKE'
  | 'INTAKE_DELETED'
  | 'STATUS_UNKNOWN';

/** 首析自助重试资格（服务端唯一判定源） */
export type IntakeAnalysisRetryEligibility = {
  eligible: boolean;
  reason: IntakeAnalysisRetryReason;
};

/** 工单实际处理状态（三态，由服务端固定映射维护；与首析状态相互独立） */
export type RepairRequestHandlingStatusFE = 'COMPLETED' | 'IN_PROGRESS' | 'UNRESOLVED';

/** 工单处理结果（五类稳定枚举） */
export type RepairRequestHandlingResultFE =
  | 'FIXED'
  | 'PART_PURCHASED'
  | 'PROVIDE_PLAN_SELF_EXECUTE'
  | 'INTERRUPTED'
  | 'UNREPAIRABLE';

/** 客户可见首析视图（正文仅成功态返回；失败不暴露受控原因细节） */
export type IntakeAnalysisCustomerView = {
  status: IntakeAnalysisStatus;
  /** 0=初次；1=唯一重试 */
  generation: number;
  outputText: string | null;
  finishedAt: string | null;
  /** 展示状态与重试资格均由服务端判定，前端不再自行组合 FAILED + generation */
  displayState: IntakeAnalysisDisplayState;
  retryEligibility: IntakeAnalysisRetryEligibility;
};

/** 客户报修原件安全字段（不暴露存储引用与校验和） */
export type RepairRequestOriginalFile = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
};

/** 维修厂家展示字段 */
export type ServiceOrganizationBrief = {
  id: number;
  name: string;
};

/** 公共列表项（列表查询输出；无任何账号 ID 字段，裁定 3） */
export type RepairRequestListItem = {
  id: number;
  requestNo: string;
  errorCode: string;
  createdAt: string;
  isAccepted: boolean;
  /** 未接单时为 null */
  acceptedAt: string | null;
  /** 最新一条回复的处理状态；无回复时为 null */
  latestResolutionStatus: EngineerResolutionStatus | null;
  equipmentModel: RepairRequestEquipmentModel;
  /** 首析状态；无原稿关联的旧单为 null（可选省略对齐后端 DTO 可空风格） */
  analysisStatus?: IntakeAnalysisStatus | null;
  /** 首析代次；无原稿关联的旧单为 null */
  analysisGeneration?: number | null;
};

/** 工程师回复（实时昵称；昵称缺失由后端回落「工程师」） */
export type EngineerResponse = {
  id: number;
  engineerNickname: string;
  resolutionStatus: EngineerResolutionStatus;
  responseText: string;
  createdAt: string;
};

/** 公共详情（详情查询输出；回复按 createdAt ASC + id ASC） */
export type RepairRequestDetail = {
  id: number;
  requestNo: string;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  createdAt: string;
  isAccepted: boolean;
  acceptedAt: string | null;
  latestResolutionStatus: EngineerResolutionStatus | null;
  equipmentModel: RepairRequestEquipmentModel;
  responses: EngineerResponse[];
  /** 客户可见首析状态与正文；无原稿关联的旧单为 null（可选省略对齐后端 DTO 可空风格） */
  intakeAnalysis?: IntakeAnalysisCustomerView | null;
  /** 客户报修原件；未绑定或无效原件为 null */
  originalFile?: RepairRequestOriginalFile | null;
  /** 维修厂家；旧行无服务公司为 null */
  serviceOrganization?: ServiceOrganizationBrief | null;
  /** 工单处理事实（与首析状态分开展示；尚未处理/旧行缺失为 null） */
  handlingStatus?: RepairRequestHandlingStatusFE | null;
  handlingResult?: RepairRequestHandlingResultFE | null;
  closureStatus?: string | null;
  closedAt?: string | null;
  closureReason?: string | null;
};

/** OFFSET 分页请求参数（真实 adapter 内部补齐 mode/withTotal，调用方不感知） */
export type RepairRequestListPagination = {
  page: number;
  pageSize: number;
};

/** OFFSET 分页结果（列表统一 createdAt DESC + id DESC） */
export type RepairRequestListPage = {
  items: RepairRequestListItem[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 详情读取结果（domain failure 显式结果）：
 * 不存在 / 非本人 / 已删除由后端统一 NOT_FOUND（防探测，裁定口径），前端归并为 not-found；
 * transport / auth / network 失败不上抛为该结果，仍抛 GraphQLIngressError。
 */
export type MyRepairRequestDetailResult =
  | { ok: true; detail: RepairRequestDetail }
  | { ok: false; reason: 'not-found'; message: string };

/**
 * 删除结果（domain failure 显式结果，裁定 5）：
 * - not-found：不存在 / 非本人（避免泄露他人申请存在性）
 * - already-accepted：已接单不能删（CONFLICT + REPAIR_REQUEST_ALREADY_ACCEPTED）
 * - forbidden：非客户调用（角色 Guard）
 * - invalid-input：参数非法
 * - delete-failed：其余业务失败
 * 同一客户重复删除幂等成功（ok: true）。
 */
export type DeleteMyRepairRequestFailureReason =
  | 'not-found'
  | 'already-accepted'
  | 'forbidden'
  | 'invalid-input'
  | 'delete-failed';

export type DeleteMyRepairRequestResult =
  | { ok: true }
  | {
      ok: false;
      reason: DeleteMyRepairRequestFailureReason;
      message: string;
    };

/**
 * 首析重试结果（domain failure 显式结果）：
 * - not-found：不存在 / 非本人 / 已删除（防探测，与删除同一口径）
 * - retry-unavailable：非失败态、并发或重复重试（CONFLICT；后端原子裁决，前端防重复只是辅助）
 * - forbidden / invalid-input / retry-failed：其余失败
 */
export type RetryIntakeAnalysisFailureReason =
  | 'not-found'
  | 'retry-unavailable'
  | 'forbidden'
  | 'invalid-input'
  | 'retry-failed';

export type RetryIntakeAnalysisResult =
  | { ok: true; analysisStatus: IntakeAnalysisStatus; analysisGeneration: number }
  | { ok: false; reason: RetryIntakeAnalysisFailureReason; message: string };

/** 客户报修原件下载结果（REST 授权下载，blob 不落盘缓存） */
export type DownloadMyRepairRequestFileFailureReason =
  | 'not-found'
  | 'file-not-available'
  | 'insufficient-permission'
  | 'download-failed';

export type DownloadMyRepairRequestFileResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; reason: DownloadMyRepairRequestFileFailureReason; message: string };
