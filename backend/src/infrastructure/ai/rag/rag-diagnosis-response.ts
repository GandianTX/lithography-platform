// src/infrastructure/ai/rag/rag-diagnosis-response.ts
// RAG 诊断回复的 UTF-8 解码与成功结果解析（S2.3 解析前入口，S3 补全反例）。
//
// 只处理已按 1 MiB 截断的响应字节：不做网络 I/O、不读配置。
// 正文不合规返回失败；图形不合规时保留正文并把 visualization 降级为 null。

import {
  RAG_DIAGNOSIS_SCENE_ID,
  RAG_DIAGNOSIS_SCHEMA_VERSION,
  RAG_DIAGNOSIS_STAGE_MAX,
  RAG_DIAGNOSIS_STAGE_MIN,
  RAG_DIAGNOSIS_TEXT_MAX_UNITS,
  RAG_VISUALIZATION_DISPLAYS,
  RAG_VISUALIZATION_PART_IDS,
  RAG_VISUALIZATION_REQUIRED_PART_COUNT,
  type RagDiagnosisDisplay,
  type RagDiagnosisPartId,
  type RagDiagnosisVisualization,
  type RagDiagnosisVisualizationPart,
} from '@usecases/common/ports/rag-diagnosis-client.contract';

export type RagDiagnosisResponseParseResult =
  | Readonly<{
      ok: true;
      text: string;
      visualization: RagDiagnosisVisualization | null;
    }>
  | Readonly<{
      ok: false;
    }>;

const INVALID: RagDiagnosisResponseParseResult = { ok: false };

const PART_ID_SET: ReadonlySet<string> = new Set(RAG_VISUALIZATION_PART_IDS);
const DISPLAY_SET: ReadonlySet<string> = new Set(RAG_VISUALIZATION_DISPLAYS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseStage = (value: unknown): number | null | undefined => {
  if (value === null) {
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

const parseParts = (value: unknown): readonly RagDiagnosisVisualizationPart[] | null => {
  if (!Array.isArray(value) || value.length !== RAG_VISUALIZATION_REQUIRED_PART_COUNT) {
    return null;
  }

  const parts: RagDiagnosisVisualizationPart[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    const { partId, display } = item;
    if (typeof partId !== 'string' || !PART_ID_SET.has(partId) || seen.has(partId)) {
      return null;
    }
    if (typeof display !== 'string' || !DISPLAY_SET.has(display)) {
      return null;
    }
    seen.add(partId);
    parts.push({ partId: partId as RagDiagnosisPartId, display: display as RagDiagnosisDisplay });
  }
  return parts;
};

const parseVisualization = (value: unknown): RagDiagnosisVisualization | null => {
  if (!isRecord(value) || value.sceneId !== RAG_DIAGNOSIS_SCENE_ID) {
    return null;
  }

  const stage = parseStage(value.stage);
  if (stage === undefined) {
    return null;
  }

  const parts = parseParts(value.parts);
  if (parts === null) {
    return null;
  }

  return {
    sceneId: RAG_DIAGNOSIS_SCENE_ID,
    stage,
    parts,
  };
};

/**
 * 解析 2xx 回复：先按 UTF-8 严格解码，再校验协议版本、回显 requestId 与正文。
 */
export function parseRagDiagnosisResponse(input: {
  readonly bytes: Uint8Array;
  readonly requestId: string;
}): RagDiagnosisResponseParseResult {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return INVALID;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INVALID;
  }

  if (!isRecord(parsed)) {
    return INVALID;
  }
  if (parsed.schemaVersion !== RAG_DIAGNOSIS_SCHEMA_VERSION) {
    return INVALID;
  }
  if (parsed.requestId !== input.requestId) {
    return INVALID;
  }

  const content = parsed.content;
  if (!isRecord(content) || typeof content.text !== 'string') {
    return INVALID;
  }
  const text = content.text.trim();
  if (text.length < 1 || text.length > RAG_DIAGNOSIS_TEXT_MAX_UNITS) {
    return INVALID;
  }

  return {
    ok: true,
    text,
    visualization: parseVisualization(content.visualization),
  };
}
