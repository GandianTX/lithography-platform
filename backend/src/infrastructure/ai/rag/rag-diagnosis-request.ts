// src/infrastructure/ai/rag/rag-diagnosis-request.ts
// RAG 诊断请求的白名单构造与本地校验（S2.2 / RAG-A01）。
//
// 只做纯函数处理：不读配置、不发请求、不写日志。
// 线上信封固定补齐 schemaVersion 与 sceneId，fault 按八字段键序给齐并补 null。

import {
  RAG_DIAGNOSIS_ERROR_CODES,
  RAG_DIAGNOSIS_FAULT_FIELD_MAX_UNITS,
  RAG_DIAGNOSIS_FAULT_KEYS,
  RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS,
  RAG_DIAGNOSIS_HISTORY_LIMIT,
  RAG_DIAGNOSIS_QUESTION_MAX_UNITS,
  RAG_DIAGNOSIS_REQUEST_MAX_BYTES,
  RAG_DIAGNOSIS_SCENE_ID,
  RAG_DIAGNOSIS_SCHEMA_VERSION,
  RAG_DIAGNOSIS_STAGE_MAX,
  RAG_DIAGNOSIS_STAGE_MIN,
  type RagDiagnosisContextMode,
  type RagDiagnosisErrorCode,
  type RagDiagnosisHistoryItem,
  type RagDiagnosisInput,
} from '@usecases/common/ports/rag-diagnosis-client.contract';

/** fault 八字段固定键序 */
export type RagDiagnosisFaultKey = (typeof RAG_DIAGNOSIS_FAULT_KEYS)[number];

export type RagDiagnosisWireFault = Readonly<Record<RagDiagnosisFaultKey, string | null>>;

export type RagDiagnosisRequestEnvelope = Readonly<{
  schemaVersion: typeof RAG_DIAGNOSIS_SCHEMA_VERSION;
  requestId: string;
  sceneId: typeof RAG_DIAGNOSIS_SCENE_ID;
  question: string;
  history: readonly RagDiagnosisHistoryItem[];
  context: Readonly<{
    mode: RagDiagnosisContextMode;
    equipmentModelCode: string | null;
    stage: number | null;
    fault: RagDiagnosisWireFault | null;
  }>;
}>;

export type RagDiagnosisRequestBuildResult =
  | Readonly<{
      ok: true;
      envelope: RagDiagnosisRequestEnvelope;
      body: string;
      byteLength: number;
    }>
  | Readonly<{
      ok: false;
      code: RagDiagnosisErrorCode;
    }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVALID_INPUT: RagDiagnosisRequestBuildResult = {
  ok: false,
  code: RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeOptionalText = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeHistory = (value: unknown): readonly RagDiagnosisHistoryItem[] | null => {
  if (!Array.isArray(value) || value.length > RAG_DIAGNOSIS_HISTORY_LIMIT) {
    return null;
  }
  const history: RagDiagnosisHistoryItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    const role: unknown = item.role;
    if (role !== 'USER' && role !== 'ASSISTANT') {
      return null;
    }
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content.length < 1 || content.length > RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS) {
      return null;
    }
    history.push({ role, content });
  }
  return history;
};

const normalizeStage = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < RAG_DIAGNOSIS_STAGE_MIN ||
    value > RAG_DIAGNOSIS_STAGE_MAX
  ) {
    return undefined;
  }
  return value;
};

const normalizeFault = (value: unknown): RagDiagnosisWireFault | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const fault: Record<string, string | null> = {};
  for (const key of RAG_DIAGNOSIS_FAULT_KEYS) {
    const normalized = normalizeOptionalText(value[key]);
    if (normalized === undefined) {
      return undefined;
    }
    if (normalized !== null && normalized.length > RAG_DIAGNOSIS_FAULT_FIELD_MAX_UNITS) {
      return undefined;
    }
    fault[key] = normalized;
  }
  return fault as RagDiagnosisWireFault;
};

const normalizeContext = (value: unknown): RagDiagnosisRequestEnvelope['context'] | null => {
  if (!isRecord(value)) {
    return null;
  }
  const mode: unknown = value.mode;
  if (mode !== 'INDEPENDENT' && mode !== 'WORK_ORDER') {
    return null;
  }
  const stage = normalizeStage(value.stage);
  if (stage === undefined) {
    return null;
  }
  const equipmentModelCode = normalizeOptionalText(value.equipmentModelCode);
  if (equipmentModelCode === undefined) {
    return null;
  }
  const fault = normalizeFault(value.fault);
  if (fault === undefined) {
    return null;
  }
  return { mode, equipmentModelCode, stage, fault };
};

/**
 * 构造线上请求信封并序列化。
 *
 * 校验失败返回 `INVALID_INPUT`，调用方据此保证零网络请求。
 */
export function buildRagDiagnosisRequest(input: RagDiagnosisInput): RagDiagnosisRequestBuildResult {
  const requestId = typeof input?.requestId === 'string' ? input.requestId.trim() : '';
  if (!UUID_PATTERN.test(requestId)) {
    return INVALID_INPUT;
  }

  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (question.length < 1 || question.length > RAG_DIAGNOSIS_QUESTION_MAX_UNITS) {
    return INVALID_INPUT;
  }

  const history = normalizeHistory(input.history);
  if (history === null) {
    return INVALID_INPUT;
  }

  const context = normalizeContext(input.context);
  if (context === null) {
    return INVALID_INPUT;
  }

  const envelope: RagDiagnosisRequestEnvelope = {
    schemaVersion: RAG_DIAGNOSIS_SCHEMA_VERSION,
    requestId,
    sceneId: RAG_DIAGNOSIS_SCENE_ID,
    question,
    history,
    context,
  };

  const body = JSON.stringify(envelope);
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength > RAG_DIAGNOSIS_REQUEST_MAX_BYTES) {
    return INVALID_INPUT;
  }

  return { ok: true, envelope, body, byteLength };
}
