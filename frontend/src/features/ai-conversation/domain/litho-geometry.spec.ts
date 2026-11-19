// src/features/ai-conversation/domain/litho-geometry.spec.ts

import { describe, expect, it } from 'vitest';

import {
  AI_PART_GEOMETRIES,
  AI_PART_IDS,
  AI_STAGE_DEFINITIONS,
  buildStageBaselineDisplays,
  findAiPartGeometry,
  findAiStageDefinition,
  isPointInAiPolygon,
  projectAiVertex,
  resolveAiScale,
} from './litho-geometry';

describe('litho-geometry', () => {
  it('定义 11 个部件且 partId 唯一', () => {
    expect(AI_PART_GEOMETRIES).toHaveLength(11);
    expect(new Set(AI_PART_IDS).size).toBe(11);
  });

  it('定义 10 个阶段且覆盖协议部件白名单', () => {
    expect(AI_STAGE_DEFINITIONS).toHaveLength(10);
    expect(AI_STAGE_DEFINITIONS.map((stage) => stage.stage)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const referenced = new Set(
      AI_STAGE_DEFINITIONS.flatMap((stage) => [...stage.partIds]),
    );
    for (const partId of referenced) {
      expect(AI_PART_IDS).toContain(partId);
    }
  });

  it('阶段基线：仅该阶段部件为 HIGHLIGHT，其余 NORMAL', () => {
    const displays = buildStageBaselineDisplays(2);
    expect(displays.reticle_arm).toBe('HIGHLIGHT');
    expect(displays.reticle_table).toBe('HIGHLIGHT');
    expect(displays.wafer_stage).toBe('NORMAL');
    expect(Object.keys(displays)).toHaveLength(11);
  });

  it('阶段基线：未知阶段回落到全部 NORMAL', () => {
    const displays = buildStageBaselineDisplays(null);
    expect(Object.values(displays).every((display) => display === 'NORMAL')).toBe(true);
  });

  it('正交投影：角度为 0 时横纵坐标按比例缩放', () => {
    const options = { width: 1240, height: 830, angle: 0, zoom: 1 };
    const scale = resolveAiScale(options);
    expect(scale).toBeCloseTo(100, 5);
    const projected = projectAiVertex({ x: 1, y: 1, z: 0 }, options);
    expect(projected.x).toBeCloseTo(620 + scale, 5);
    expect(projected.y).toBeCloseTo(415 - Math.cos(0.56) * scale, 5);
  });

  it('部件几何可按 partId 查找，未知部件返回 null', () => {
    expect(findAiPartGeometry('wafer_stage')?.labelKey).toBe('ai.part.wafer_stage');
    expect(findAiPartGeometry('unknown-part')).toBeNull();
    expect(findAiStageDefinition(8)?.section).toBe('LOWER');
    expect(findAiStageDefinition(99)).toBeNull();
  });

  it('多边形命中测试：内部点命中、外部点不命中', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(isPointInAiPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(isPointInAiPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });
});
