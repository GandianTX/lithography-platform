// src/features/ai-conversation/domain/litho-geometry.ts
// 光刻机维修流程几何示意（任务 05 · S3）
//
// 依据：模型 API 约定「几何、位置、相机及颜色由前端定义」——本文件是前端唯一的
// 几何来源：11 个部件的三维盒体位置/尺寸、10 个维修阶段与部件的默认参考关系、
// 四种展示态与颜色的映射。服务端只给 partId + display，不给几何。
//
// 纯函数：无 React、无 Canvas API，便于单测与 SSR。

import type { MessageKey } from '@/shared/i18n';

import type { AiPartDisplay } from '../infrastructure/ai-conversation.types';

/** 部件三维盒体（底面高度 + 尺寸，单位与原型参考一致） */
export type AiPartGeometry = {
  readonly partId: string;
  readonly labelKey: MessageKey;
  /** 中心点 X（左右） */
  readonly x: number;
  /** 底面高度 Y（向上为正；顶面 = y + height，与 V44 原型一致） */
  readonly y: number;
  /** 中心点 Z（前后） */
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
};

/** 维修阶段（1–10） */
export type AiStageDefinition = {
  readonly stage: number;
  /** 上部 / 下部 */
  readonly section: 'UPPER' | 'LOWER';
  readonly labelKey: MessageKey;
  readonly partIds: readonly string[];
};

/** 阶段区域文案键 */
export type AiStageSection = 'UPPER' | 'LOWER';

/**
 * 11 个部件几何（协议部件白名单的顺序）。
 *
 * 数值沿用 V44 原型参考图的比例关系，几何定义权在本文件（前端）。
 */
export const AI_PART_GEOMETRIES: readonly AiPartGeometry[] = [
  {
    partId: 'controller',
    labelKey: 'ai.part.controller',
    x: -4.2,
    y: 0.15,
    z: -1.55,
    width: 1.32,
    height: 3.75,
    depth: 1.55,
  },
  {
    partId: 'reticle_cassette',
    labelKey: 'ai.part.reticle_cassette',
    x: -2.55,
    y: 0.15,
    z: -1.65,
    width: 1.15,
    height: 1.42,
    depth: 1.35,
  },
  {
    partId: 'reticle_arm',
    labelKey: 'ai.part.reticle_arm',
    x: -0.9,
    y: 1.28,
    z: -1.55,
    width: 2.18,
    height: 0.42,
    depth: 0.63,
  },
  {
    partId: 'reticle_table',
    labelKey: 'ai.part.reticle_table',
    x: 1.1,
    y: 1.52,
    z: -1.52,
    width: 1.56,
    height: 0.33,
    depth: 1.5,
  },
  {
    partId: 'reticle_vacuum',
    labelKey: 'ai.part.reticle_vacuum',
    x: 1.1,
    y: 0.56,
    z: -1.52,
    width: 1.15,
    height: 0.96,
    depth: 1.09,
  },
  {
    partId: 'positioning_laser',
    labelKey: 'ai.part.positioning_laser',
    x: 3.4,
    y: 1.46,
    z: -1.56,
    width: 0.93,
    height: 0.76,
    depth: 0.72,
  },
  {
    partId: 'wafer_cassette',
    labelKey: 'ai.part.wafer_cassette',
    x: -3.1,
    y: 0.15,
    z: 1.68,
    width: 1.38,
    height: 1.28,
    depth: 1.3,
  },
  {
    partId: 'wafer_arm',
    labelKey: 'ai.part.wafer_arm',
    x: -0.71,
    y: 1.03,
    z: 1.72,
    width: 2.77,
    height: 0.37,
    depth: 0.62,
  },
  {
    partId: 'alignment_table',
    labelKey: 'ai.part.alignment_table',
    x: -1.14,
    y: 0.15,
    z: 0.3,
    width: 1.54,
    height: 0.76,
    depth: 1.32,
  },
  {
    partId: 'wafer_stage',
    labelKey: 'ai.part.wafer_stage',
    x: 1.71,
    y: 0.15,
    z: 1.28,
    width: 2.39,
    height: 0.9,
    depth: 2.25,
  },
  {
    partId: 'projection_lens',
    labelKey: 'ai.part.projection_lens',
    x: 2.15,
    y: 2.08,
    z: 1.15,
    width: 1.64,
    height: 1.42,
    depth: 1.39,
  },
];

/** 10 个维修阶段与默认参考部件（协议「部件默认参考阶段」） */
export const AI_STAGE_DEFINITIONS: readonly AiStageDefinition[] = [
  {
    stage: 1,
    section: 'UPPER',
    labelKey: 'ai.stage.1',
    partIds: ['reticle_arm', 'reticle_cassette'],
  },
  {
    stage: 2,
    section: 'UPPER',
    labelKey: 'ai.stage.2',
    partIds: ['reticle_arm', 'reticle_table'],
  },
  {
    stage: 3,
    section: 'UPPER',
    labelKey: 'ai.stage.3',
    partIds: ['reticle_table', 'reticle_vacuum'],
  },
  {
    stage: 4,
    section: 'UPPER',
    labelKey: 'ai.stage.4',
    partIds: ['reticle_table', 'positioning_laser'],
  },
  {
    stage: 5,
    section: 'LOWER',
    labelKey: 'ai.stage.5',
    partIds: ['wafer_cassette', 'wafer_arm', 'alignment_table'],
  },
  {
    stage: 6,
    section: 'LOWER',
    labelKey: 'ai.stage.6',
    partIds: ['wafer_arm', 'alignment_table'],
  },
  {
    stage: 7,
    section: 'LOWER',
    labelKey: 'ai.stage.7',
    partIds: ['wafer_arm', 'alignment_table', 'wafer_stage'],
  },
  {
    stage: 8,
    section: 'LOWER',
    labelKey: 'ai.stage.8',
    partIds: ['wafer_stage', 'projection_lens'],
  },
  {
    stage: 9,
    section: 'LOWER',
    labelKey: 'ai.stage.9',
    partIds: ['wafer_stage', 'wafer_arm', 'wafer_cassette'],
  },
  {
    stage: 10,
    section: 'UPPER',
    labelKey: 'ai.stage.10',
    partIds: ['reticle_arm', 'reticle_table', 'reticle_cassette'],
  },
];

/** 协议白名单部件 ID（与后端解析白名单一致） */
export const AI_PART_IDS: readonly string[] = AI_PART_GEOMETRIES.map((part) => part.partId);

/** 展示态 → 语义色键（实际取色由 CSS 变量提供，组件内不写死颜色） */
export const AI_PART_DISPLAY_TOKENS: Record<AiPartDisplay, string> = {
  NORMAL: '--ai-geo-part-normal',
  HIGHLIGHT: '--ai-geo-part-highlight',
  WARNING: '--ai-geo-part-warning',
  HIDDEN: '--ai-geo-part-hidden',
};

/** 展示态 → 描边色键 */
export const AI_PART_OUTLINE_TOKENS: Record<AiPartDisplay, string> = {
  NORMAL: '--ai-geo-outline',
  HIGHLIGHT: '--ai-geo-outline-highlight',
  WARNING: '--ai-geo-outline-warning',
  HIDDEN: '--ai-geo-outline',
};

/** 故障动画目标态（WARNING 部件定位后升级为故障锁定） */
export type AiPartRenderState = AiPartDisplay | 'FAULT';

export const AI_PART_RENDER_TOKENS: Record<AiPartRenderState, string> = {
  NORMAL: '--ai-geo-part-normal',
  HIGHLIGHT: '--ai-geo-part-highlight',
  WARNING: '--ai-geo-part-warning',
  HIDDEN: '--ai-geo-part-hidden',
  FAULT: '--ai-geo-part-fault',
};

export const AI_PART_OUTLINE_RENDER_TOKENS: Record<AiPartRenderState, string> = {
  NORMAL: '--ai-geo-outline',
  HIGHLIGHT: '--ai-geo-outline-highlight',
  WARNING: '--ai-geo-outline-warning',
  HIDDEN: '--ai-geo-outline',
  FAULT: '--ai-geo-outline-fault',
};

/** 查找部件几何 */
export function findAiPartGeometry(partId: string): AiPartGeometry | null {
  return AI_PART_GEOMETRIES.find((part) => part.partId === partId) ?? null;
}

/** 查找阶段定义 */
export function findAiStageDefinition(stage: number): AiStageDefinition | null {
  return AI_STAGE_DEFINITIONS.find((item) => item.stage === stage) ?? null;
}

/**
 * 阶段基线：选中阶段时该阶段部件为 HIGHLIGHT，其余为 NORMAL。
 *
 * 用于「流程参考图」——没有本轮有效图形时的默认示意。
 */
export function buildStageBaselineDisplays(stage: number | null): Record<string, AiPartDisplay> {
  const displays: Record<string, AiPartDisplay> = {};
  for (const part of AI_PART_GEOMETRIES) {
    displays[part.partId] = 'NORMAL';
  }
  const definition = stage === null ? null : findAiStageDefinition(stage);
  for (const partId of definition?.partIds ?? []) {
    displays[partId] = 'HIGHLIGHT';
  }
  return displays;
}

/** 正交投影参数 */
export type AiProjectionOptions = {
  /** 画布宽高（像素） */
  readonly width: number;
  readonly height: number;
  /** 绕竖轴旋转角（弧度） */
  readonly angle: number;
  /** 缩放倍率 */
  readonly zoom: number;
  /** 俯仰角（弧度） */
  readonly tilt?: number;
};

export type AiProjectedVertex = {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
};

/**
 * 模型在场景中的垂直落位（V44 原型实测口径）
 *
 * 原型把几何原点放在场景高度的 56%，并按基准高度 1.18 上移，
 * 使底座落在场景中下部、部件位于中上部，场景顶部不出现大片空白。
 */
const MODEL_ORIGIN_Y_RATIO = 0.56;
const MODEL_BASE_HEIGHT = 1.18;

/**
 * 正交投影：绕竖轴旋转后按俯仰角压扁，输出屏幕坐标
 *
 * 公式与 V44 原型逐项对齐（原型 `project(x, y, z)`）：
 * - 水平：`x*cos + z*sin`（早期实现误写成 `x*cos - z*sin`，旋转方向与原型相反）；
 * - 深度：`depth = -x*sin + z*cos`（早期实现误写成 `x*sin + z*cos`）；
 * - 垂直：`depth*sin(tilt) - (y - 1.18)*cos(tilt)`，并以 `depth*cos(tilt) + (y-1.18)*sin(tilt)`
 *   作为深度排序量（早期实现把 `y` 直接乘进深度，导致前后关系错乱）。
 */
export function projectAiVertex(
  vertex: { x: number; y: number; z: number },
  options: AiProjectionOptions,
): AiProjectedVertex {
  const tilt = options.tilt ?? 0.56;
  const cos = Math.cos(options.angle);
  const sin = Math.sin(options.angle);
  const depth = -vertex.x * sin + vertex.z * cos;
  const scale = resolveAiScale(options);
  const vertical = vertex.y - MODEL_BASE_HEIGHT;
  return {
    x: options.width / 2 + (vertex.x * cos + vertex.z * sin) * scale,
    y:
      options.height * MODEL_ORIGIN_Y_RATIO +
      (depth * Math.sin(tilt) - vertical * Math.cos(tilt)) * scale,
    depth: depth * Math.cos(tilt) + vertical * Math.sin(tilt),
  };
}

/** 视图缩放：使几何基准尺寸（12.4 × 8.3）刚好铺满画布 */
export function resolveAiScale(options: AiProjectionOptions): number {
  const base = Math.min(options.width / 12.4, options.height / 8.3);
  return base * options.zoom;
}

/**
 * 盒体 8 个顶点（顺序固定：底面 4 点 + 顶面 4 点）
 *
 * 高度语义与 V44 原型一致：`part.y` 是**底面**高度，顶面为 `part.y + part.height`。
 * 原型按 `project(x + dx*w/2, y + dy*h, z + dz*d/2)`（dy ∈ {0,1}）取顶点，
 * 早期实现误把同一数值当中心点，导致所有柱体下沉、顶部明显偏低。
 */
export function buildAiBoxVertices(part: AiPartGeometry): Array<{
  x: number;
  y: number;
  z: number;
}> {
  const halfWidth = part.width / 2;
  const halfDepth = part.depth / 2;
  return [
    { x: part.x - halfWidth, y: part.y, z: part.z - halfDepth },
    { x: part.x + halfWidth, y: part.y, z: part.z - halfDepth },
    { x: part.x + halfWidth, y: part.y, z: part.z + halfDepth },
    { x: part.x - halfWidth, y: part.y, z: part.z + halfDepth },
    { x: part.x - halfWidth, y: part.y + part.height, z: part.z - halfDepth },
    { x: part.x + halfWidth, y: part.y + part.height, z: part.z - halfDepth },
    { x: part.x + halfWidth, y: part.y + part.height, z: part.z + halfDepth },
    { x: part.x - halfWidth, y: part.y + part.height, z: part.z + halfDepth },
  ];
}

/**
 * 盒体的 5 个可见面（4 侧面 + 顶面，不含底面）及其顶点索引
 *
 * 顺序与 V44 原型 `faceIndices` 完全一致：索引 4 是顶面，分面明暗档位依赖该顺序。
 */
export const AI_BOX_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
  [4, 5, 6, 7],
];

/** 命中测试：屏幕点是否落在投影后的部件多边形内（射线法） */
export function isPointInAiPolygon(
  point: { x: number; y: number },
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

/* ------------------------------------------------------------------ *
 * 场景面集合：绘制、拾取与遮挡判定共用同一套面（V44 原型 AI33Paint）
 * ------------------------------------------------------------------ */

/** 底座几何（原型 `box(['base','',0,-.18,0,9.9,.33,5.45],'BASE')`） */
export const AI_SCENE_BASE_GEOMETRY: AiPartGeometry = {
  partId: 'base',
  labelKey: 'ai.part.controller',
  x: 0,
  y: -0.18,
  z: 0,
  width: 9.9,
  height: 0.33,
  depth: 5.45,
};

/** 支架几何（原型 `mounts`）：显示态与拾取归属都跟随所属部件 */
export type AiMountGeometry = {
  readonly ownerPartId: string;
  readonly geometry: AiPartGeometry;
};

/**
 * 四个支架（原型 `mounts` 表）
 *
 * 原型在绘制每个部件时先画其支架再画主体，且支架沿用所属部件的 partId，
 * 因此悬停与拾取都归属到该部件。
 */
export const AI_PART_MOUNTS: readonly AiMountGeometry[] = [
  {
    ownerPartId: 'reticle_arm',
    geometry: {
      partId: 'reticle_arm',
      labelKey: 'ai.part.reticle_arm',
      x: -1.68,
      y: 0.15,
      z: -1.55,
      width: 0.44,
      height: 1.13,
      depth: 0.55,
    },
  },
  {
    ownerPartId: 'wafer_arm',
    geometry: {
      partId: 'wafer_arm',
      labelKey: 'ai.part.wafer_arm',
      x: -1.83,
      y: 0.15,
      z: 1.72,
      width: 0.42,
      height: 0.88,
      depth: 0.54,
    },
  },
  {
    ownerPartId: 'positioning_laser',
    geometry: {
      partId: 'positioning_laser',
      labelKey: 'ai.part.positioning_laser',
      x: 3.4,
      y: 0.15,
      z: -1.56,
      width: 0.4,
      height: 1.31,
      depth: 0.44,
    },
  },
  {
    ownerPartId: 'projection_lens',
    geometry: {
      partId: 'projection_lens',
      labelKey: 'ai.part.projection_lens',
      x: 2.63,
      y: 1.05,
      z: 1.38,
      width: 0.57,
      height: 1.03,
      depth: 0.63,
    },
  },
];

/** 参与场景绘制的盒体（部件、支架或底座） */
export type AiSceneBox = {
  readonly geometry: AiPartGeometry;
  readonly renderState: AiPartRenderState;
  /** 聚焦期间淡出（原型 ghost） */
  readonly ghost: boolean;
  readonly isBase: boolean;
};

/** 场景面片（盒体的一个可见面） */
export type AiSceneSurface = {
  /** 所属部件；底座为 null（原型 base 面没有 partId） */
  readonly partId: string | null;
  readonly renderState: AiPartRenderState | null;
  readonly ghost: boolean;
  readonly isBase: boolean;
  /** 面序号（原型 faceIndices 顺序，索引 4 为顶面；分面明暗档位依赖它） */
  readonly faceIndex: number;
  /** 面深度（面内 4 点平均，原型同口径），用于全局遮挡排序 */
  readonly depth: number;
  readonly polygon: ReadonlyArray<{ x: number; y: number }>;
};

/**
 * 构建场景面集合并做全局深度排序
 *
 * 与原型 `AI33Paint` 一致：底座最先绘制，其余面片按深度由远及近绘制，
 * 保证「后画的盖住先画的」，遮挡关系与原型逐面一致。
 */
export function buildAiSceneSurfaces(
  boxes: readonly AiSceneBox[],
  options: AiProjectionOptions,
): AiSceneSurface[] {
  const surfaces: AiSceneSurface[] = [];
  for (const box of boxes) {
    const projected = buildAiBoxVertices(box.geometry).map((vertex) =>
      projectAiVertex(vertex, options),
    );
    for (const [faceIndex, face] of AI_BOX_FACES.entries()) {
      const polygon = face.map((index) => projected[index]);
      surfaces.push({
        partId: box.isBase ? null : box.geometry.partId,
        renderState: box.isBase ? null : box.renderState,
        ghost: box.ghost,
        isBase: box.isBase,
        faceIndex,
        depth: polygon.reduce((sum, point) => sum + point.depth, 0) / Math.max(1, polygon.length),
        polygon: polygon.map((point) => ({ x: point.x, y: point.y })),
      });
    }
  }
  return surfaces.sort(
    (left, right) => (left.isBase ? 0 : 1) - (right.isBase ? 0 : 1) || left.depth - right.depth,
  );
}

/**
 * 命中测试：从最后绘制（最前）的面开始逆序查找
 *
 * 与原型 `AI36PartAt` 一致 —— 拾取与绘制共用同一套面集合，命中的一定是
 * 屏幕上最靠前的部件，不会出现「点到的不是看到的」。
 */
export function findAiSurfacePartId(
  surfaces: readonly AiSceneSurface[],
  point: { x: number; y: number },
): string | null {
  for (let index = surfaces.length - 1; index >= 0; index -= 1) {
    const surface = surfaces[index];
    if (surface.partId === null) {
      continue;
    }
    if (isPointInAiSurfacePolygon(point, surface.polygon)) {
      return surface.partId;
    }
  }
  return null;
}

/**
 * 面内点判定（原型 `AI36PartAt` 绕向口径）
 *
 * 顶点绕向一致时为真；背面与侧面的绕向相反，天然被排除，
 * 因此命中结果与绘制顺序一致。
 */
export function isPointInAiSurfacePolygon(
  point: { x: number; y: number },
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (polygon.length === 0) {
    return false;
  }
  return polygon.every((current, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return (
      (next.x - current.x) * (point.y - current.y) - (next.y - current.y) * (point.x - current.x) >=
      -0.01
    );
  });
}
