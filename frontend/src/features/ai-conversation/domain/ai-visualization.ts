// src/features/ai-conversation/domain/ai-visualization.ts
// 短时图形信封的前端解析（任务 05 · S3）
//
// 服务端已按协议校验并规范化；前端仍做一次防御性解析：
// - 结构不符 / 未知 partId / 未知展示态 / 部件缺失 → 视为「无有效图形」，
//   回到流程参考图（清旧定位），但保留正文；
// - 图形只存在于内存，不写 localStorage / IndexedDB / PDF。

import type {
  AiPartDisplay,
  AiVisualization,
  AiVisualizationPart,
} from '../infrastructure/ai-conversation.types';

import { AI_PART_GEOMETRIES, buildStageBaselineDisplays } from './litho-geometry';

const DISPLAY_VALUES: readonly AiPartDisplay[] = ['NORMAL', 'HIGHLIGHT', 'WARNING', 'HIDDEN'];

const KNOWN_PART_IDS: readonly string[] = AI_PART_GEOMETRIES.map((part) => part.partId);

export type AiVisualizationParseResult = {
  /** 有效图形；无效时为 null（调用方据此清除旧定位） */
  readonly visualization: AiVisualization | null;
  /** 是否因图形无效而降级 */
  readonly degraded: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePart(value: unknown): AiVisualizationPart | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const partId = value.partId;
  const display = value.display;
  if (typeof partId !== 'string' || !KNOWN_PART_IDS.includes(partId)) {
    return null;
  }
  if (typeof display !== 'string' || !DISPLAY_VALUES.includes(display as AiPartDisplay)) {
    return null;
  }
  return { partId, display: display as AiPartDisplay };
}

/**
 * 解析服务端返回的短时图形。
 *
 * @param value 服务端 `visualization` 字段（可能是 null）
 */
export function parseAiVisualization(value: unknown): AiVisualizationParseResult {
  if (value === null || value === undefined) {
    return { visualization: null, degraded: false };
  }
  if (!isPlainObject(value)) {
    return { visualization: null, degraded: true };
  }
  const sceneId = value.sceneId;
  const stage = value.stage;
  const parts = value.parts;
  if (typeof sceneId !== 'string' || sceneId.length === 0) {
    return { visualization: null, degraded: true };
  }
  if (stage !== null && (typeof stage !== 'number' || !Number.isInteger(stage))) {
    return { visualization: null, degraded: true };
  }
  if (!Array.isArray(parts) || parts.length !== KNOWN_PART_IDS.length) {
    return { visualization: null, degraded: true };
  }
  const parsedParts: AiVisualizationPart[] = [];
  const seen = new Set<string>();
  for (const item of parts) {
    const part = parsePart(item);
    if (part === null || seen.has(part.partId)) {
      return { visualization: null, degraded: true };
    }
    seen.add(part.partId);
    parsedParts.push(part);
  }
  return {
    visualization: { sceneId, stage: stage as number | null, parts: parsedParts },
    degraded: false,
  };
}

/**
 * 合并本轮展示态与流程参考基线。
 *
 * - 有有效图形：以图形为准（HIDDEN 部件不绘制）；
 * - 无有效图形：回到阶段参考图（HIGHLIGHT 该阶段部件，其余 NORMAL）。
 */
export function resolveAiPartDisplays(input: {
  readonly visualization: AiVisualization | null;
  readonly fallbackStage: number | null;
}): Record<string, AiPartDisplay> {
  const displays: Record<string, AiPartDisplay> = {};
  for (const part of AI_PART_GEOMETRIES) {
    displays[part.partId] = 'NORMAL';
  }
  if (input.visualization === null) {
    return buildStageBaselineDisplays(input.fallbackStage);
  }
  for (const part of input.visualization.parts) {
    displays[part.partId] = part.display;
  }
  return displays;
}

/** 需要在图例中提示的部件（HIGHLIGHT / WARNING；NORMAL 与 HIDDEN 无 DOM 表现） */
export function pickAiHighlightedParts(
  displays: Record<string, AiPartDisplay>,
): AiVisualizationPart[] {
  return AI_PART_GEOMETRIES.filter(
    (part) => displays[part.partId] === 'HIGHLIGHT' || displays[part.partId] === 'WARNING',
  ).map((part) => ({ partId: part.partId, display: displays[part.partId] }));
}

/**
 * 主故障目标：按服务端返回顺序取第一个 WARNING。
 *
 * 多 WARNING 时其余部件仍留在图例（不重复定位）；服务端返回顺序即合法稳定顺序，
 * 不用前端字典顺序推导，避免与实际结果不一致。
 */
export function pickAiFaultFocusPart(visualization: AiVisualization | null): string | null {
  if (visualization === null) {
    return null;
  }
  const warning = visualization.parts.find((part) => part.display === 'WARNING');
  return warning?.partId ?? null;
}
