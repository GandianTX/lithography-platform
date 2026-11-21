// src/features/ai-conversation/domain/litho-geometry-v44.spec.ts
//
// V44 原型几何口径的反向验证（任务 05 · 视觉偏差根因修复）
//
// 本文件的每条断言都锁定原型真源（V44 Demo 的 AI33Paint / AI33Scene），
// 且**在修复前的实现上必须失败**——用于证明根因判断成立、修复真实生效：
// - 高度语义：原型 `project(x + dx*w/2, y + dy*h, z + dz*d/2)`，dy ∈ {0,1}
//   → `y` 是**底面**；修复前实现把同一数值当**中心点**（y ± height/2）。
// - 旋转方向：原型水平偏移 `x*cos + z*sin`、深度 `-x*sin + z*cos`；
//   修复前实现写成 `x*cos - z*sin` 与 `x*sin + z*cos`（旋转方向相反）。
// - 支架：原型 `mounts` 有 4 个，修复前实现完全没有。
// - 遮挡：原型按**全局面集合**排序绘制，修复前实现按部件逐个绘制。

import { describe, expect, it } from 'vitest';

import {
  AI_PART_GEOMETRIES,
  AI_PART_MOUNTS,
  AI_SCENE_BASE_GEOMETRY,
  type AiSceneBox,
  buildAiBoxVertices,
  buildAiSceneSurfaces,
  findAiPartGeometry,
  findAiSurfacePartId,
  isPointInAiSurfacePolygon,
  projectAiVertex,
  resolveAiScale,
} from './litho-geometry';

const OPTIONS = { width: 1240, height: 830, angle: 0, zoom: 1 };

function centroid(polygon: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } {
  return polygon.reduce(
    (acc, point) => ({
      x: acc.x + point.x / polygon.length,
      y: acc.y + point.y / polygon.length,
    }),
    { x: 0, y: 0 },
  );
}

describe('litho-geometry · V44 原型几何口径', () => {
  it('高度语义是底面：controller 底面 0.15、顶面 3.90', () => {
    const controller = findAiPartGeometry('controller');
    expect(controller).not.toBeNull();
    const vertices = buildAiBoxVertices(controller!);
    // 原型：底面 y = 0.15，顶面 y = 0.15 + 3.75
    expect(vertices[0].y).toBeCloseTo(0.15, 6);
    expect(vertices[4].y).toBeCloseTo(3.9, 6);
    // 修复前的中心点语义会得到 -1.725 / 2.025
    expect(vertices[0].y).not.toBeCloseTo(-1.725, 3);
    expect(vertices[4].y).not.toBeCloseTo(2.025, 3);
  });

  it('底面高度与原型一致：落地部件站在底座顶面 0.15 上', () => {
    const onBase = AI_PART_GEOMETRIES.filter((part) => part.y === 0.15).map((part) => part.partId);
    expect(onBase).toEqual([
      'controller',
      'reticle_cassette',
      'wafer_cassette',
      'alignment_table',
      'wafer_stage',
    ]);
    // 底座顶面 = -0.18 + 0.33 = 0.15，与部件底面齐平
    expect(AI_SCENE_BASE_GEOMETRY.y + AI_SCENE_BASE_GEOMETRY.height).toBeCloseTo(0.15, 6);
  });

  it('投影水平偏移与原型一致：x*cos + z*sin', () => {
    const angle = 0.5;
    const options = { ...OPTIONS, angle };
    const scale = resolveAiScale(options);
    // 取 z≠0 的不对称点：z=0 时两种公式同值，无法区分符号
    const point = projectAiVertex({ x: 1, y: 0, z: 1 }, options);
    expect(point.x).toBeCloseTo(options.width / 2 + (Math.cos(angle) + Math.sin(angle)) * scale, 6);
    // 修复前写成 x*cos - z*sin，符号相反
    expect(point.x).not.toBeCloseTo(
      options.width / 2 + (Math.cos(angle) - Math.sin(angle)) * scale,
      3,
    );
  });

  it('投影深度与原型一致：depth = -x*sin + z*cos', () => {
    const angle = 0.5;
    const options = { ...OPTIONS, angle };
    const point = projectAiVertex({ x: 1, y: 0, z: 2 }, options);
    const depth = -1 * Math.sin(angle) + 2 * Math.cos(angle);
    const vertical = 0 - 1.18;
    expect(point.depth).toBeCloseTo(depth * Math.cos(0.56) + vertical * Math.sin(0.56), 6);
  });

  it('四个支架齐备、数值与原型一致且归属到正确部件', () => {
    expect(AI_PART_MOUNTS).toHaveLength(4);
    expect(AI_PART_MOUNTS.map((mount) => mount.ownerPartId)).toEqual([
      'reticle_arm',
      'wafer_arm',
      'positioning_laser',
      'projection_lens',
    ]);
    const reticle = AI_PART_MOUNTS.find((mount) => mount.ownerPartId === 'reticle_arm');
    expect(reticle?.geometry.x).toBeCloseTo(-1.68, 6);
    expect(reticle?.geometry.y).toBeCloseTo(0.15, 6);
    expect(reticle?.geometry.width).toBeCloseTo(0.44, 6);
    expect(reticle?.geometry.height).toBeCloseTo(1.13, 6);
    expect(reticle?.geometry.depth).toBeCloseTo(0.55, 6);
    // 支架沿用所属部件的 partId（原型 box([partId,'',...mount], mode)）
    expect(reticle?.geometry.partId).toBe('reticle_arm');
  });

  it('面集合按原型全局排序：底座最先绘制，其余按深度由远及近', () => {
    const boxes: AiSceneBox[] = [
      {
        geometry: AI_SCENE_BASE_GEOMETRY,
        renderState: 'NORMAL',
        ghost: false,
        isBase: true,
      },
      {
        geometry: findAiPartGeometry('controller')!,
        renderState: 'NORMAL',
        ghost: false,
        isBase: false,
      },
      {
        geometry: findAiPartGeometry('wafer_stage')!,
        renderState: 'NORMAL',
        ghost: false,
        isBase: false,
      },
    ];
    const surfaces = buildAiSceneSurfaces(boxes, OPTIONS);
    // 底座最先
    expect(surfaces[0].isBase).toBe(true);
    // 每个盒体 5 个面（4 侧面 + 顶面，不含底面，与原型 faceIndices 一致）
    expect(surfaces).toHaveLength(15);
    // 其余按深度升序（由远及近）
    const rest = surfaces.filter((surface) => !surface.isBase);
    for (let index = 1; index < rest.length; index += 1) {
      expect(rest[index].depth).toBeGreaterThanOrEqual(rest[index - 1].depth);
    }
  });

  it('拾取与绘制共用同一套面：命中的必然是屏幕上更靠前的部件', () => {
    const boxes: AiSceneBox[] = [
      {
        geometry: AI_SCENE_BASE_GEOMETRY,
        renderState: 'NORMAL',
        ghost: false,
        isBase: true,
      },
      {
        geometry: findAiPartGeometry('controller')!,
        renderState: 'NORMAL',
        ghost: false,
        isBase: false,
      },
      {
        geometry: findAiPartGeometry('wafer_stage')!,
        renderState: 'NORMAL',
        ghost: false,
        isBase: false,
      },
    ];
    const surfaces = buildAiSceneSurfaces(boxes, OPTIONS);
    for (let index = 0; index < surfaces.length; index += 1) {
      const surface = surfaces[index];
      if (surface.partId === null) {
        continue;
      }
      const center = centroid(surface.polygon);
      // 背面不参与命中（绕向相反）
      if (!isPointInAiSurfacePolygon(center, surface.polygon)) {
        continue;
      }
      const hit = findAiSurfacePartId(surfaces, center);
      expect(hit).not.toBeNull();
      let hitIndex = -1;
      for (let index = 0; index < surfaces.length; index += 1) {
        if (surfaces[index].partId === hit) {
          hitIndex = index;
        }
      }
      // 命中面不能比被点击的面更靠后（更靠后 = 被遮挡）
      expect(hitIndex).toBeGreaterThanOrEqual(index);
    }
  });

  it('底座只有 5 个面且不参与部件拾取（原型 base 的 partId 为空）', () => {
    const surfaces = buildAiSceneSurfaces(
      [
        {
          geometry: AI_SCENE_BASE_GEOMETRY,
          renderState: 'NORMAL',
          ghost: false,
          isBase: true,
        },
      ],
      OPTIONS,
    );
    expect(surfaces).toHaveLength(5);
    expect(surfaces.every((surface) => surface.partId === null)).toBe(true);
    expect(findAiSurfacePartId(surfaces, centroid(surfaces[0].polygon))).toBeNull();
  });
});
