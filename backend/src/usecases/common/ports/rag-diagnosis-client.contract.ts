// src/usecases/common/ports/rag-diagnosis-client.contract.ts
// RAG 公共诊断客户端的 usecase-owned 边界契约。
//
// 任务 03（客户报修首次分析）与任务 05（工程师 AI 对话）共用同一注入令牌。
// 公共层只负责：白名单请求构造、单次 HTTP 调用、回复解析与错误归类。
// 业务层负责：调用前权限判断、场景与历史选择、请求 ID／执行代次、结果写回。
//
// 契约约束（对应《开发与验收任务书》RAG-A01–A05）：
// - 入参为只读数据，不携带 HTTP/Axios 类型；
// - 结果不包含原始响应、异常或用量，只给出可用正文/图形或可辨识错误码；
// - 取消通过调用方传入的 AbortSignal 表达，客户端不自行重试。

/** 请求协议版本（与 V44 归档样例一致，真实服务确认后同步） */
export const RAG_DIAGNOSIS_SCHEMA_VERSION = 1;

/** 场景标识（光刻维护工作流） */
export const RAG_DIAGNOSIS_SCENE_ID = 'LITHO_WORKFLOW_V1';

/** 历史条数上限（不含本轮问题） */
export const RAG_DIAGNOSIS_HISTORY_LIMIT = 12;

/** 问题正文上限（UTF-16 码元） */
export const RAG_DIAGNOSIS_QUESTION_MAX_UNITS = 2000;

/** 单条历史正文上限（UTF-16 码元） */
export const RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS = 2000;

/** fault 单个字段上限（UTF-16 码元） */
export const RAG_DIAGNOSIS_FAULT_FIELD_MAX_UNITS = 4000;

/** 阶段范围（协议允许 1–10 或 null） */
export const RAG_DIAGNOSIS_STAGE_MIN = 1;
export const RAG_DIAGNOSIS_STAGE_MAX = 10;

/** 请求序列化上限（字节，对应 256 KiB） */
export const RAG_DIAGNOSIS_REQUEST_MAX_BYTES = 256 * 1024;

/** 响应解码后上限（字节，对应 1 MiB，解析前拒绝） */
export const RAG_DIAGNOSIS_RESPONSE_MAX_BYTES = 1024 * 1024;

/** 回复正文上限（UTF-16 码元，超限失败不截断） */
export const RAG_DIAGNOSIS_TEXT_MAX_UNITS = 12000;

/** 图形部件白名单（11 个；几何与配色由前端定义，公共层只校验标识） */
export const RAG_VISUALIZATION_PART_IDS = [
  'controller',
  'reticle_cassette',
  'reticle_arm',
  'reticle_table',
  'reticle_vacuum',
  'positioning_laser',
  'wafer_cassette',
  'wafer_arm',
  'alignment_table',
  'wafer_stage',
  'projection_lens',
] as const;

/** 图形部件展示态（HIDDEN 沿用 05 policy，最终以负责人确认为准） */
export const RAG_VISUALIZATION_DISPLAYS = ['NORMAL', 'WARNING', 'HIGHLIGHT', 'HIDDEN'] as const;

/** 图形必须给齐的部件数（缺失、重复、未知项均判图形非法） */
export const RAG_VISUALIZATION_REQUIRED_PART_COUNT = RAG_VISUALIZATION_PART_IDS.length;

/** 可辨识错误码；调用方据此决定提示、重试与是否影响业务状态 */
export const RAG_DIAGNOSIS_ERROR_CODES = {
  /** 配置缺失、非法或调用被禁用 */
  CONFIG_ERROR: 'CONFIG_ERROR',
  /** 本地请求校验失败，或远端明确拒绝输入（413／422） */
  INVALID_INPUT: 'INVALID_INPUT',
  /** 模型服务 401 */
  SERVICE_UNAUTHORIZED: 'SERVICE_UNAUTHORIZED',
  /** 模型服务 403 */
  SERVICE_FORBIDDEN: 'SERVICE_FORBIDDEN',
  /** 网络异常、429、503、重定向及其他未约定非成功响应 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** 调用截止或远端 504 */
  TIMEOUT: 'TIMEOUT',
  /** 调用方主动取消（发起前取消发出零次请求） */
  CANCELLED: 'CANCELLED',
  /** 成功响应超限，或 JSON／版本／requestId／正文／图形不合规 */
  INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const;

export type RagDiagnosisErrorCode =
  (typeof RAG_DIAGNOSIS_ERROR_CODES)[keyof typeof RAG_DIAGNOSIS_ERROR_CODES];

export type RagDiagnosisContextMode = 'INDEPENDENT' | 'WORK_ORDER';

export type RagDiagnosisHistoryRole = 'USER' | 'ASSISTANT';

export type RagDiagnosisPartId = (typeof RAG_VISUALIZATION_PART_IDS)[number];

export type RagDiagnosisDisplay = (typeof RAG_VISUALIZATION_DISPLAYS)[number];

export type RagDiagnosisHistoryItem = Readonly<{
  role: RagDiagnosisHistoryRole;
  content: string;
}>;

/** 故障事实八字段。
 *
 * - 允许缺省或 null；序列化时未知值补 null；
 * - 保留字符串 "0"（例如 gpibStatus），不得当作空值丢弃；
 * - 不默认把业务故障码映射为 mainError。
 */
export type RagDiagnosisFaultFacts = Readonly<{
  mainError?: string | null;
  unitError?: string | null;
  source?: string | null;
  errorType?: string | null;
  gpibStatus?: string | null;
  description?: string | null;
  action?: string | null;
  status?: string | null;
}>;

/** 线上信封 fault 的固定键序：八字段全部出现，未知值填 null，保留字符串 "0" */
export const RAG_DIAGNOSIS_FAULT_KEYS = [
  'mainError',
  'unitError',
  'source',
  'errorType',
  'gpibStatus',
  'description',
  'action',
  'status',
] as const satisfies readonly (keyof RagDiagnosisFaultFacts)[];

export type RagDiagnosisContext = Readonly<{
  mode: RagDiagnosisContextMode;
  /** 可信机型编码或 null；业务层不得编造 */
  equipmentModelCode: string | null;
  /** 1–10 或 null */
  stage: number | null;
  fault: RagDiagnosisFaultFacts | null;
}>;

/**
 * 调用入参。
 *
 * - requestId 为调用方提供的标准 UUID，客户端原样发送并核对回显；
 * - 不承担业务幂等、执行代次或 traceId 职责（05 代次由业务层单独维护）；
 * - question 由客户端去首尾空白后校验，不做截断。
 */
export type RagDiagnosisInput = Readonly<{
  requestId: string;
  question: string;
  history: readonly RagDiagnosisHistoryItem[];
  context: RagDiagnosisContext;
}>;

export type RagDiagnosisVisualizationPart = Readonly<{
  partId: RagDiagnosisPartId;
  display: RagDiagnosisDisplay;
}>;

export type RagDiagnosisVisualization = Readonly<{
  sceneId: string;
  /** 本轮推测阶段；模型证据不足时为 null */
  stage: number | null;
  parts: readonly RagDiagnosisVisualizationPart[];
}>;

export type RagDiagnosisSuccess = Readonly<{
  ok: true;
  requestId: string;
  text: string;
  /** 图形缺失或非法降级时为 null；正文仍可用 */
  visualization: RagDiagnosisVisualization | null;
}>;

export type RagDiagnosisFailure = Readonly<{
  ok: false;
  requestId: string;
  code: RagDiagnosisErrorCode;
}>;

export type RagDiagnosisResult = RagDiagnosisSuccess | RagDiagnosisFailure;

export type RagDiagnosisOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** 注入令牌：业务 usecase／测试替身通过同一令牌装配 */
export const RAG_DIAGNOSIS_CLIENT = Symbol('RAG_DIAGNOSIS_CLIENT');

export interface RagDiagnosisClient {
  /**
   * 发起一次诊断调用（每次调用最多一次请求，不重试）。
   *
   * @returns 成功返回正文与可选图形；失败返回可辨识错误码，不抛出原始传输异常。
   */
  diagnose(input: RagDiagnosisInput, options?: RagDiagnosisOptions): Promise<RagDiagnosisResult>;
}
